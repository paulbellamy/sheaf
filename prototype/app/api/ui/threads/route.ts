import { z } from "zod";

import { getBackend } from "@/lib/mcp/backend/stub";
import { respondError } from "@/lib/mcp/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Request body shape. We accept both the legacy `{ path, targets: [{ char_range }] }`
 * form (one path shared across all targets) and the wider `{ targets: [{ path,
 * char_range }] }` form (one path per target) so the UI can submit multi-doc
 * threads that the backend has always supported. The union is normalized below
 * before the backend call.
 */
const charRangeSchema = z.object({
  from: z.number().int().min(0),
  to: z.number().int().min(0),
});

const wideTargetSchema = z.object({
  path: z.string().min(1).max(512),
  char_range: charRangeSchema,
});

const narrowTargetSchema = z.object({
  char_range: charRangeSchema,
});

const postBodySchema = z.union([
  z.object({
    targets: z.array(wideTargetSchema).min(1).max(16),
    message: z.string().min(1).max(10_000),
    draft: z.object({ new_md: z.string().max(1_000_000) }).optional(),
  }),
  z.object({
    path: z.string().min(1).max(512),
    targets: z.array(narrowTargetSchema).min(1).max(16),
    message: z.string().min(1).max(10_000),
    draft: z.object({ new_md: z.string().max(1_000_000) }).optional(),
  }),
]);

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.searchParams.get("path") ?? undefined;
  const ref = url.searchParams.get("ref") ?? "main";
  // Threads only live on drafts. GET against main is a read; respond with an
  // empty list so callers don't need to special-case it.
  if (ref === "main") {
    return Response.json({ path: p, ref: "main", threads: [] });
  }
  try {
    const backend = getBackend();
    const summaries = await backend.listThreads({ path: p, ref });
    const threads = await Promise.all(
      summaries.map((s) => backend.readThread(s.id)),
    );
    return Response.json({ path: p, ref, threads });
  } catch (e) {
    return respondError(e);
  }
}

export async function POST(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const ref = url.searchParams.get("ref") ?? "main";
  if (ref === "main") {
    return Response.json(
      { error: "threads cannot be created on main; start a draft first" },
      { status: 400 },
    );
  }
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const parsed = postBodySchema.safeParse(json);
  if (!parsed.success) {
    return Response.json(
      {
        error: "invalid body",
        details: parsed.error.issues.map((i) => ({
          path: i.path,
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }
  const body = parsed.data;
  // Normalize: wide form keeps per-target paths; narrow form repeats `path`.
  const targets =
    "path" in body
      ? body.targets.map((t) => ({ path: body.path, char_range: t.char_range }))
      : body.targets.map((t) => ({ path: t.path, char_range: t.char_range }));
  try {
    const id = await getBackend().addThread({
      ref,
      author: "user",
      message: body.message,
      draft: body.draft,
      targets,
    });
    return Response.json({ thread_id: id }, { status: 201 });
  } catch (e) {
    return respondError(e);
  }
}

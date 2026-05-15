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

/**
 * Each target is either doc-level (`scope: "doc"`) or anchored to a char
 * range (`scope: "range"` + char_range). For backward compatibility, a
 * target with `char_range` but no `scope` is treated as `scope: "range"`.
 */
const wideTargetSchema = z.union([
  z.object({
    path: z.string().min(1).max(512),
    scope: z.literal("doc"),
  }),
  z.object({
    path: z.string().min(1).max(512),
    scope: z.literal("range").optional(),
    char_range: charRangeSchema,
  }),
]);

const narrowTargetSchema = z.union([
  z.object({ scope: z.literal("doc") }),
  z.object({
    scope: z.literal("range").optional(),
    char_range: charRangeSchema,
  }),
]);

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
  // Targets are then mapped into the ThreadAnchor discriminated union.
  const targets =
    "path" in body
      ? body.targets.map((t) =>
          t.scope === "doc"
            ? ({ path: body.path, scope: "doc" as const })
            : ({
                path: body.path,
                scope: "range" as const,
                char_range: t.char_range,
              }),
        )
      : body.targets.map((t) =>
          t.scope === "doc"
            ? ({ path: t.path, scope: "doc" as const })
            : ({
                path: t.path,
                scope: "range" as const,
                char_range: t.char_range,
              }),
        );
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

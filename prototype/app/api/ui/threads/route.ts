import { z } from "zod";

import { getBackend } from "@/lib/mcp/backend/stub";
import { respondError } from "@/lib/mcp/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const postBodySchema = z.object({
  path: z.string().min(1).max(512),
  targets: z
    .array(
      z.object({
        char_range: z.object({
          from: z.number().int().min(0),
          to: z.number().int().min(0),
        }),
      }),
    )
    .min(1)
    .max(16),
  message: z.string().min(1).max(10_000),
  draft: z
    .object({
      new_md: z.string().max(1_000_000),
    })
    .optional(),
});

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.searchParams.get("path") ?? undefined;
  const ref = url.searchParams.get("ref") ?? "main";
  try {
    const threads = await getBackend().listThreads({ path: p, ref });
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
  try {
    const id = await getBackend().addThread({
      ref,
      author: "user",
      message: body.message,
      draft: body.draft,
      targets: body.targets.map((t) => ({
        path: body.path,
        char_range: t.char_range,
      })),
    });
    return Response.json({ thread_id: id }, { status: 201 });
  } catch (e) {
    return respondError(e);
  }
}

import { z } from "zod";

import { getBackend } from "@/lib/mcp/backend/stub";
import { respondError } from "@/lib/mcp/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const backend = getBackend();
  const drafts = await backend.listDrafts();
  return Response.json({ drafts });
}

const charRangeSchema = z.object({
  from: z.number().int().min(0),
  to: z.number().int().min(0),
});

const targetSchema = z.object({
  path: z.string().min(1).max(512),
  char_range: charRangeSchema,
});

const initialThreadSchema = z.object({
  targets: z.array(targetSchema).min(1).max(16),
  message: z.string().min(1).max(10_000),
  draft: z.object({ new_md: z.string().max(1_000_000) }).optional(),
});

const postBodySchema = z.object({
  base_path: z.string().min(1).max(512),
  base_ref: z.literal("main"),
  base_version: z.number().int().nonnegative(),
  name: z.string().min(1).max(256),
  initial_threads: z.array(initialThreadSchema).max(64),
});

export async function POST(req: Request): Promise<Response> {
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
    const result = await getBackend().forkAndAttachThreads({
      base_path: body.base_path,
      base_version: body.base_version,
      name: body.name,
      author: "user",
      initial_threads: body.initial_threads.map((t) => ({
        targets: t.targets,
        message: t.message,
        draft: t.draft,
      })),
    });
    return Response.json(result, { status: 201 });
  } catch (e) {
    return respondError(e);
  }
}

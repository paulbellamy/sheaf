import { z } from "zod";

import { getBackend } from "@/lib/mcp/backend/stub";
import { McpError } from "@/lib/mcp/errors";
import { assertThreadId } from "@/lib/mcp/paths";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  message: z.string().min(1).max(10_000),
  draft: z
    .object({
      new_md: z.string().max(1_000_000),
    })
    .optional(),
});

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  try {
    assertThreadId(id);
  } catch (e) {
    if (e instanceof McpError) {
      return Response.json({ error: e.message, code: e.code }, { status: 400 });
    }
    throw e;
  }
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
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
  try {
    await getBackend().replyThread(id, parsed.data.message, {
      author: "user",
      draft: parsed.data.draft,
    });
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof McpError && e.code === "thread_not_found") {
      return Response.json({ error: e.message }, { status: 404 });
    }
    if (e instanceof McpError && e.code === "invalid_thread_id") {
      return Response.json({ error: e.message, code: e.code }, { status: 400 });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}

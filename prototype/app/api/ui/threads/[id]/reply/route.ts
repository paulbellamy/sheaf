import { getBackend } from "@/lib/mcp/backend/stub";
import { McpError } from "@/lib/mcp/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };
type Body = { message: string; draft?: { new_md: string } };

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.message) {
    return Response.json({ error: "message required" }, { status: 400 });
  }
  try {
    await getBackend().replyThread(id, body.message, {
      author: "user",
      draft: body.draft,
    });
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof McpError && e.code === "thread_not_found") {
      return Response.json({ error: e.message }, { status: 404 });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}

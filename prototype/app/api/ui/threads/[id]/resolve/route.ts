import { getBackend } from "@/lib/mcp/backend/stub";
import { McpError } from "@/lib/mcp/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  try {
    await getBackend().resolveThread(id);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof McpError && e.code === "thread_not_found") {
      return Response.json({ error: e.message }, { status: 404 });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}

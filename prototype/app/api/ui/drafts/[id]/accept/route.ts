import { getBackend } from "@/lib/mcp/backend/stub";
import { McpError } from "@/lib/mcp/errors";
import { assertDraftId } from "@/lib/mcp/paths";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  try {
    assertDraftId(id);
    const result = await getBackend().merge(id);
    return Response.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof McpError) {
      const status =
        e.code === "draft_not_found"
          ? 404
          : e.code === "invalid_ref" || e.code === "invalid_path"
            ? 400
            : 400;
      return Response.json({ error: e.message, code: e.code }, { status });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}

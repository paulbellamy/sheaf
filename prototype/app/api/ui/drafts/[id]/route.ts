import { getBackend } from "@/lib/mcp/backend/stub";
import { McpError } from "@/lib/mcp/errors";
import { assertDraftId } from "@/lib/mcp/paths";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  const backend = getBackend();
  try {
    assertDraftId(id);
    const drafts = await backend.listDrafts();
    const meta = drafts.find((d) => d.draft_id === id);
    if (!meta) return Response.json({ error: "not found" }, { status: 404 });
    const changes = await backend.draftChanges(id);
    return Response.json({ meta, changes });
  } catch (e) {
    if (e instanceof McpError) {
      const status =
        e.code === "draft_not_found"
          ? 404
          : e.code === "invalid_ref" || e.code === "invalid_path"
            ? 400
            : 500;
      return Response.json({ error: e.message, code: e.code }, { status });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}

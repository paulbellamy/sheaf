import { getBackend } from "@/lib/mcp/backend/stub";
import { respondError } from "@/lib/mcp/errors";
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
    return respondError(e);
  }
}

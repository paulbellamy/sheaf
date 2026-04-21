import { getBackend } from "@/lib/mcp/backend/stub";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  const backend = getBackend();
  try {
    const drafts = await backend.listDrafts();
    const meta = drafts.find((d) => d.draft_id === id);
    if (!meta) return Response.json({ error: "not found" }, { status: 404 });
    const changes = await backend.draftChanges(id);
    return Response.json({ meta, changes });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}

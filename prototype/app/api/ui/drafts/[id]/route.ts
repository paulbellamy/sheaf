import { getBackend } from "@/lib/mcp/backend/stub";
import { respondError } from "@/lib/mcp/errors";
import { assertDraftId } from "@/lib/mcp/paths";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Phase D: the response shape is flattened to expose the fields the
 * draft-mode banner reads (`draft_id`, `display_name`, `base_version`,
 * `touches`, `open_count`, `state`). Legacy `meta` + `changes` are kept
 * for callers that still iterate the per-doc diff (e.g. `DocRail`).
 *
 * `open_count` is server-derived from `listThreads({ref: draft_id})`
 * filtered to `status === "open"`. Re-derived on every GET — the UI
 * refetches on `thread_changed` SSE.
 */
export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  const backend = getBackend();
  try {
    assertDraftId(id);
    const drafts = await backend.listDrafts();
    const meta = drafts.find((d) => d.draft_id === id);
    if (!meta) return Response.json({ error: "not found" }, { status: 404 });
    const [changes, threads] = await Promise.all([
      backend.draftChanges(id),
      backend.listThreads({ ref: id }),
    ]);
    const open_count = threads.filter((t) => t.status === "open").length;
    return Response.json({
      draft_id: meta.draft_id,
      display_name: meta.display_name ?? meta.name ?? meta.draft_id,
      base_version: meta.base_version,
      touches: meta.touches,
      open_count,
      state: meta.state,
      versions_behind: meta.versions_behind,
      meta,
      changes,
    });
  } catch (e) {
    return respondError(e);
  }
}

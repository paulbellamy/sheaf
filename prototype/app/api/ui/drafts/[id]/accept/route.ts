import { getBackend } from "@/lib/mcp/backend/stub";
import { respondError } from "@/lib/mcp/errors";
import { assertDraftId } from "@/lib/mcp/paths";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Phase I: atomic accept. Propose-if-needed, then merge in one shot.
 *
 * On success: 200 with `{commit, versions: [{path, from, to}]}`. The UI
 * renders per-doc bumps from `versions` and navigates to `?ref=main`.
 *
 * On conflict: 409 with `{conflicts: [{path, base_version, main_version}]}`.
 * The merge is atomic — nothing was committed, the draft stays open, and the
 * UI renders the conflict banner without navigating.
 *
 * Race retry is intentionally not wired here. The stub has no real
 * concurrency between requests, so a single attempt is enough; production
 * backends with real CRDT/git contention can add a transparent retry layer
 * around this call.
 */
export async function POST(_req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  try {
    assertDraftId(id);
    const backend = getBackend();
    // The banner-driven accept skips the agent-only Propose step. Move
    // through `submitted` here so `merge()`'s gating accepts the call.
    const drafts = await backend.listDrafts();
    const meta = drafts.find((d) => d.draft_id === id);
    if (meta && meta.state === "open") {
      await backend.propose(id);
    }
    const result = await backend.merge(id);
    return Response.json({ ok: true, ...result });
  } catch (e) {
    return respondError(e);
  }
}

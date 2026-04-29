import { getBackend } from "@/lib/mcp/backend/stub";
import { respondError } from "@/lib/mcp/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ path: string[] }> };

/**
 * Phase K: per-doc version history for the version dropdown. Returns one
 * entry per landed version. The current `version_counter` value is always
 * present even when no draft produced it (e.g. the initial v1) so the
 * dropdown can render `vN (initial)` without an associated draft id.
 */
export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const { path } = await ctx.params;
  const p = path.join("/");
  const backend = getBackend();
  try {
    const [{ version_counter }, history] = await Promise.all([
      backend.readDoc(p),
      backend.listVersionHistory(p),
    ]);
    const byVersion = new Map<number, { draft_id: string; accepted_at: number }>();
    for (const e of history) {
      byVersion.set(e.version, { draft_id: e.draft_id, accepted_at: e.accepted_at });
    }
    const versions: {
      version: number;
      draft_id?: string;
      accepted_at?: number;
    }[] = [];
    const top = Math.max(version_counter, 1);
    for (let v = 1; v <= top; v++) {
      const entry = byVersion.get(v);
      versions.push(
        entry
          ? { version: v, draft_id: entry.draft_id, accepted_at: entry.accepted_at }
          : { version: v },
      );
    }
    return Response.json({ path: p, versions });
  } catch (e) {
    return respondError(e);
  }
}

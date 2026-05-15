import { z } from "zod";

import { getBackend } from "@/lib/mcp/backend/stub";
import { respondError } from "@/lib/mcp/errors";
import { assertThreadId } from "@/lib/mcp/paths";
import type { ThreadDraftBody, ThreadMessage } from "@/lib/mcp/backend";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const optionIndexSchema = z.coerce.number().int().min(0).max(7).optional();

/**
 * Walk the thread message log newest-first and pick the latest message that
 * carries `draft_options` or a single `draft`. Returns the leaf to apply, or
 * null if the thread has no payload to apply (e.g. a plain comment thread).
 *
 * Phase F: this is how the resolve route resolves "the chosen leaf" without
 * needing the client to round-trip the new_md. Single-leaf threads default
 * to applying the only `draft` body if present.
 */
function pickLeaf(
  messages: ThreadMessage[],
  optionIndex: number | undefined,
): ThreadDraftBody | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.draft_options && m.draft_options.length > 0) {
      const idx = optionIndex ?? 0;
      return m.draft_options[idx] ?? m.draft_options[0];
    }
    if (m.draft) {
      return m.draft;
    }
  }
  return null;
}

/**
 * Phase F: extended to optionally apply a chosen `draft_options[option_index]`
 * (or a single `draft` body) to the thread's draft ref before resolving.
 *
 * The application step is best-effort: if no payload is present (plain
 * comment thread) or the anchored text no longer matches (the doc was edited
 * out from under the thread), the route still resolves the thread.
 */
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  try {
    assertThreadId(id);
  } catch (e) {
    return respondError(e);
  }
  const url = new URL(req.url);
  const optionParam = url.searchParams.get("option_index");
  const optionParsed = optionIndexSchema.safeParse(
    optionParam ?? undefined,
  );
  if (!optionParsed.success) {
    return Response.json({ error: "invalid option_index" }, { status: 400 });
  }
  const optionIndex = optionParsed.data;

  try {
    const backend = getBackend();
    // Apply the chosen leaf's `new_md` to the thread's draft ref before
    // resolving. Done in this order so a failure on apply leaves the thread
    // open for retry rather than silently resolving without the edit.
    const thread = await backend.readThread(id);
    if (thread.draft_id) {
      const leaf = pickLeaf(thread.messages, optionIndex);
      if (leaf && thread.targets.length > 0) {
        // Apply each target's anchored_text → leaf.new_md. For Phase F we
        // assume the same `new_md` applies across all targets (cross-cutting
        // multi-target threads aren't in scope until Phase H). Doc-level
        // targets (scope=doc) have no anchored_text to replace; the agent
        // applies the change directly to main and the leaf is informational.
        for (const target of thread.targets) {
          if (target.scope !== "range") continue;
          const oldString = target.anchor.anchored_text;
          if (oldString.length === 0) continue;
          try {
            await backend.editDoc(
              target.path,
              thread.draft_id,
              oldString,
              leaf.new_md,
              false,
            );
          } catch {
            // Anchored text drifted (someone else edited the same range).
            // Leave the apply to whatever overlap-detection lands in Phase J;
            // for now, fall through to the resolve so the thread doesn't get
            // stuck on a stale anchor.
          }
        }
      }
    }
    await backend.resolveThread(id);
    return Response.json({ ok: true });
  } catch (e) {
    return respondError(e);
  }
}

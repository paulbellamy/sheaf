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
 * Phase F: optionally apply a chosen `draft_options[option_index]` (or a single
 * `draft` body) before resolving — but only for **draft-mode** threads, where
 * the chosen leaf lands on the draft ref the human still reviews before merge.
 *
 * Thread-on-doc threads (no `draft_id`) never auto-apply: an option is a
 * *choice routed back to the agent* (AskUserQuestion-style), and the agent
 * makes the real edit. The option `new_md` may be an illustrative sample, not
 * a literal replacement, so applying it verbatim would clobber the doc.
 *
 * The application step is best-effort: if no payload is present (plain comment
 * thread) or the anchored text no longer matches (the doc was edited out from
 * under the thread), the route still resolves the thread.
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
  // `?apply=false` resolves without applying any variant. Lets the plugin
  // expose a plain "Resolve" button on threads that have variants but the
  // user wants to dismiss without taking any of them.
  const skipApply = url.searchParams.get("apply") === "false";

  try {
    const backend = getBackend();
    // Apply the chosen leaf's `new_md` before resolving. Done in this order
    // so a failure on apply leaves the thread open for retry rather than
    // silently resolving without the edit.
    //
    // Draft mode only: the leaf lands on the thread's draft ref, which the
    // human reviews before merge. Thread-on-doc threads (no `draft_id`) never
    // auto-apply — the pick is routed back to the agent, which makes the real
    // edit (see resolve-route doc comment). Range targets get an `Edit`
    // (anchored_text → leaf.new_md); doc-level targets get a full `Write`.
    const thread = await backend.readThread(id);
    const applyRef = thread.draft_id;
    const leaf = skipApply || !applyRef ? null : pickLeaf(thread.messages, optionIndex);
    if (leaf && applyRef && thread.targets.length > 0) {
      for (const target of thread.targets) {
        try {
          if (target.scope === "range") {
            const oldString = target.anchor.anchored_text;
            if (oldString.length === 0) continue;
            await backend.editDoc(
              target.path,
              applyRef,
              oldString,
              leaf.new_md,
              false,
            );
          } else {
            // scope=doc: rewrite the whole doc with the leaf's new_md.
            await backend.writeDoc(target.path, applyRef, leaf.new_md);
          }
        } catch {
          // Anchored text drifted, or the write conflicted. Fall through to
          // resolve so the thread doesn't get stuck on a stale anchor.
        }
      }
    }
    await backend.resolveThread(id);
    return Response.json({ ok: true });
  } catch (e) {
    return respondError(e);
  }
}

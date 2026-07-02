import { describe, expect, it } from "vitest";

import { parseReviewDoc, serializeReviewDoc } from "./review-doc";
import type { Thread } from "./index";

const HOME = "d.md";
const A = "thrd_aaaaaa";
const B = "thrd_bbbbbb";

function encodeRelPos(from: number, to: number): string {
  return Buffer.from(JSON.stringify({ from, to }), "utf8").toString("base64");
}

function decodeRelPos(b64: string): { from: number; to: number } {
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

/** A minimal range-anchored comment thread homed in `d.md`. */
function thread(id: string, from: number, to: number, anchored: string): Thread {
  return {
    id,
    created: 1,
    status: "open",
    targets: [
      {
        path: HOME,
        scope: "range",
        anchor: {
          rel_pos: encodeRelPos(from, to),
          content_hash: "h",
          anchored_text: anchored,
          context_before: "",
          context_after: "",
        },
      },
    ],
    messages: [{ author: "user", ts: 1, body: `note ${id}` }],
  };
}

/** The rebased offsets parseReviewDoc reads back for `id`'s range target. */
function anchorOffsets(threads: Thread[], id: string): { from: number; to: number } {
  const t = threads.find((x) => x.id === id);
  const tgt = t?.targets.find((x) => x.scope === "range");
  if (!tgt || tgt.scope !== "range") throw new Error(`no range anchor for ${id}`);
  return decodeRelPos(tgt.anchor.rel_pos);
}

describe("serializeReviewDoc anchor rebasing", () => {
  it("round-trips two threads on a repeated phrase without collision", () => {
    const prose = "the cat sat on the cat mat";
    const ts = [thread(A, 0, 7, "the cat"), thread(B, 15, 22, "the cat")];
    const raw = serializeReviewDoc(prose, ts, HOME);
    expect(raw.startsWith(`{==the cat==}{>>note ${A}<<}{#${A}} sat on `)).toBe(true);
    expect(raw).toContain(`{==the cat==}{>>note ${B}<<}{#${B}} mat`);

    const parsed = parseReviewDoc(raw);
    expect(parsed.prose).toBe(prose);
    expect(parsed.threads).toHaveLength(2);
  });

  it("does not perturb one thread's anchor when the prose shifts (nearest + rebase)", () => {
    // Threads were created against "the cat sat on the cat mat"; the prose has
    // since gained a 4-char "big " prefix, so both stored offsets have drifted.
    const shifted = "big the cat sat on the cat mat";
    const ts = [
      thread(A, 0, 7, "the cat"), // stale: nearest to 0 → first occ (now at 4)
      thread(B, 15, 22, "the cat"), // stale: nearest to 15 → second occ (at 19)
    ];
    const raw = serializeReviewDoc(shifted, ts, HOME);
    // First-occurrence relocation would put both on index 4 and drop thread B.
    expect(raw).toContain(`{#${A}}`);
    expect(raw).toContain(`{#${B}}`);

    const { threads } = parseReviewDoc(raw);
    // Offsets are rebased onto where each span actually landed, so the next read
    // hits the fast rel_pos path instead of re-searching.
    expect(anchorOffsets(threads, A)).toEqual({ from: 4, to: 11 });
    expect(anchorOffsets(threads, B)).toEqual({ from: 19, to: 26 });
  });

  it("re-saving a no-drift doc is idempotent (stable bytes)", () => {
    const prose = "alpha beta gamma";
    // Normalize once (zod re-emits records in schema key order), then two
    // no-drift saves off the normalized form must produce identical bytes.
    const norm = parseReviewDoc(
      serializeReviewDoc(prose, [thread(A, 6, 10, "beta")], HOME),
    ).threads;
    const once = serializeReviewDoc(prose, norm, HOME);
    const twice = serializeReviewDoc(prose, parseReviewDoc(once).threads, HOME);
    expect(twice).toBe(once);
    expect(anchorOffsets(parseReviewDoc(once).threads, A)).toEqual({ from: 6, to: 10 });
  });

  it("keeps last-known offsets for an orphaned (unlocatable) thread", () => {
    const prose = "the anchor text is gone now";
    const ts = [thread(A, 3, 9, "absent phrase")];
    const raw = serializeReviewDoc(prose, ts, HOME);
    expect(raw).not.toContain(`{#${A}}`); // no inline span placed
    // Record is still stored, offsets untouched (not rebased to nonsense).
    expect(anchorOffsets(parseReviewDoc(raw).threads, A)).toEqual({ from: 3, to: 9 });
  });

  it("rebases only the rendered target, not a second range target on the same doc", () => {
    // The inline span is rendered from the FIRST home-path range target; a
    // second range target on the same doc has no placement of its own, so its
    // rel_pos must be left alone (rewriting it would stamp the first span's
    // offsets over an anchor that still points elsewhere).
    const prose = "keep foo and bar please"; // foo@[5,8), bar@[13,16)
    const t: Thread = {
      id: A,
      created: 1,
      status: "open",
      targets: [
        { path: HOME, scope: "range", anchor: { rel_pos: encodeRelPos(5, 8), content_hash: "h", anchored_text: "foo", context_before: "", context_after: "" } },
        { path: HOME, scope: "range", anchor: { rel_pos: encodeRelPos(13, 16), content_hash: "h", anchored_text: "bar", context_before: "", context_after: "" } },
      ],
      messages: [{ author: "user", ts: 1, body: "note" }],
    };
    const parsed = parseReviewDoc(serializeReviewDoc(prose, [t], HOME)).threads[0];
    const [t0, t1] = parsed.targets;
    if (t0.scope !== "range" || t1.scope !== "range") throw new Error("shape");
    expect(decodeRelPos(t0.anchor.rel_pos)).toEqual({ from: 5, to: 8 }); // foo, rebased (no drift)
    expect(decodeRelPos(t1.anchor.rel_pos)).toEqual({ from: 13, to: 16 }); // bar, untouched
  });
});

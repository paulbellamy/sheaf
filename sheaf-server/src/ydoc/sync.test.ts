import { describe, expect, it } from "vitest";

import {
  applyMarkdown,
  createAnchor,
  decodeYDoc,
  encodeYDoc,
  markdownToYDoc,
  renderYDoc,
  resolveAnchor,
} from "./sync";

describe("ydoc sync — render / reconcile", () => {
  it("round-trips markdown through a fresh doc", () => {
    expect(renderYDoc(markdownToYDoc(""))).toBe("");
    expect(renderYDoc(markdownToYDoc("# title\n\nbody"))).toBe("# title\n\nbody");
  });

  it("is a no-op when the markdown is unchanged", () => {
    const doc = markdownToYDoc("unchanged");
    const before = encodeYDoc(doc);
    applyMarkdown(doc, "unchanged");
    expect(renderYDoc(doc)).toBe("unchanged");
    // No structural change: state vector identical (no new items).
    expect(encodeYDoc(doc)).toEqual(before);
  });

  it.each([
    ["insert in the middle", "hello world", "hello brave world"],
    ["delete from the middle", "hello brave world", "hello world"],
    ["replace the middle", "hello X world", "hello Y world"],
    ["prepend", "world", "hello world"],
    ["append", "hello", "hello world"],
    ["delete a prefix", "hello world", "world"],
    ["delete a suffix", "hello world", "hello"],
    ["full replace, no common affix", "abc", "xyz"],
    ["empty to content", "", "now has text"],
    ["content to empty", "had text", ""],
    ["repeated chars grow", "aa", "aaa"],
    ["repeated chars shrink", "aaa", "aa"],
    // Astral / surrogate-pair cases: neighbouring emoji share a high surrogate,
    // so a naive code-unit boundary splits the pair (regression guard).
    ["swap one emoji for a neighbour", "x😀y", "x😁y"],
    ["edit between two astral chars", "😀x😀", "😀y😀"],
    ["astral math alphanumeric swap", "𝕏=1", "𝕐=1"],
    ["insert an emoji next to one", "a😀b", "a😀😁b"],
    ["delete one of adjacent emoji", "a😀😁b", "a😁b"],
    ["empty to emoji", "", "😀"],
    ["emoji to empty", "😀", ""],
  ])("reconciles (%s): render === newMd", (_label, oldMd, newMd) => {
    const doc = markdownToYDoc(oldMd);
    applyMarkdown(doc, newMd);
    expect(renderYDoc(doc)).toBe(newMd);
  });

  it("keeps an anchor intact when an adjacent emoji is swapped", () => {
    const doc = markdownToYDoc("😀 TARGET");
    const anchor = createAnchor(doc, renderYDoc(doc).indexOf("TARGET"));
    applyMarkdown(doc, "😁 TARGET"); // edit the emoji before the anchor
    const resolved = resolveAnchor(doc, anchor);
    expect(resolved).not.toBeNull();
    expect(renderYDoc(doc).slice(resolved!)).toBe("TARGET");
  });

  it("touches only the differing span (prefix/suffix items are reused)", () => {
    // An edit confined to the middle must not rewrite the whole text. We prove
    // it via anchor survival: anchors in the untouched regions still resolve.
    const doc = markdownToYDoc("AAAA BBBB CCCC");
    const headAnchor = createAnchor(doc, 0); // start of "AAAA"
    const tailAnchor = createAnchor(doc, 10); // start of "CCCC"

    applyMarkdown(doc, "AAAA xxxx CCCC"); // only "BBBB" -> "xxxx"

    expect(renderYDoc(doc)).toBe("AAAA xxxx CCCC");
    expect(resolveAnchor(doc, headAnchor)).toBe(0);
    expect(resolveAnchor(doc, tailAnchor)).toBe(10);
  });
});

describe("ydoc sync — anchors survive edits elsewhere (invariant 3)", () => {
  it("keeps a tail anchor pinned to the same text when the prefix grows", () => {
    const doc = markdownToYDoc("intro paragraph. TARGET sentence.");
    const at = renderYDoc(doc).indexOf("TARGET");
    const anchor = createAnchor(doc, at);

    // Expand the intro (a region before the anchor); the absolute offset shifts.
    applyMarkdown(doc, "a much longer intro paragraph here. TARGET sentence.");

    const resolved = resolveAnchor(doc, anchor);
    expect(resolved).not.toBeNull();
    expect(renderYDoc(doc).slice(resolved!, resolved! + 6)).toBe("TARGET");
  });

  it("returns null for a corrupt anchor blob", () => {
    const doc = markdownToYDoc("anything");
    expect(resolveAnchor(doc, "!!!not-base64-valid-relpos!!!")).toBeNull();
  });
});

describe("ydoc sync — snapshot encode/decode", () => {
  it("survives a full encode → decode round trip", () => {
    const doc = markdownToYDoc("snapshot me");
    applyMarkdown(doc, "snapshot me, please");
    const restored = decodeYDoc(encodeYDoc(doc));
    expect(renderYDoc(restored)).toBe("snapshot me, please");
  });

  it("preserves anchors across a snapshot round trip", () => {
    const doc = markdownToYDoc("keep ANCHOR here");
    const anchor = createAnchor(doc, renderYDoc(doc).indexOf("ANCHOR"));

    const restored = decodeYDoc(encodeYDoc(doc));
    const resolved = resolveAnchor(restored, anchor);

    expect(resolved).toBe("keep ".length);
    expect(renderYDoc(restored).slice(resolved!, resolved! + 6)).toBe("ANCHOR");
  });
});

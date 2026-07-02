import { describe, expect, it } from "vitest";

import { minimalEdit } from "./minimal-edit";

/** Apply an edit the way a CodeMirror change would, to check it reproduces `next`. */
function apply(old: string, edit: { from: number; to: number; text: string }) {
  return old.slice(0, edit.from) + edit.text + old.slice(edit.to);
}

describe("minimalEdit", () => {
  it("returns null when the strings are identical", () => {
    expect(minimalEdit("same", "same")).toBeNull();
    expect(minimalEdit("", "")).toBeNull();
  });

  it("touches only the changed middle, leaving a shared prefix and suffix", () => {
    // The agent rewrites one word deep in the doc; offsets before and after it
    // are untouched, so a cursor sitting elsewhere maps straight through.
    const old = "the quick brown fox jumps";
    const next = "the quick red fox jumps";
    const edit = minimalEdit(old, next)!;
    expect(edit).toEqual({ from: 10, to: 15, text: "red" });
    expect(apply(old, edit)).toBe(next);
  });

  it("handles a pure insertion in the middle (empty replaced range)", () => {
    const old = "abcdef";
    const next = "abcXYZdef";
    const edit = minimalEdit(old, next)!;
    expect(edit.from).toBe(edit.to); // nothing deleted
    expect(edit).toEqual({ from: 3, to: 3, text: "XYZ" });
    expect(apply(old, edit)).toBe(next);
  });

  it("handles a pure deletion in the middle (empty replacement text)", () => {
    const old = "abcXYZdef";
    const next = "abcdef";
    const edit = minimalEdit(old, next)!;
    expect(edit).toEqual({ from: 3, to: 6, text: "" });
    expect(apply(old, edit)).toBe(next);
  });

  it("handles append (shared prefix is the whole old string)", () => {
    const old = "hello";
    const next = "hello world";
    const edit = minimalEdit(old, next)!;
    expect(edit).toEqual({ from: 5, to: 5, text: " world" });
    expect(apply(old, edit)).toBe(next);
  });

  it("handles prepend (shared suffix is the whole old string)", () => {
    const old = "world";
    const next = "hello world";
    const edit = minimalEdit(old, next)!;
    expect(edit).toEqual({ from: 0, to: 0, text: "hello " });
    expect(apply(old, edit)).toBe(next);
  });

  it("handles growth from empty and shrink to empty", () => {
    expect(minimalEdit("", "abc")).toEqual({ from: 0, to: 0, text: "abc" });
    expect(minimalEdit("abc", "")).toEqual({ from: 0, to: 3, text: "" });
  });

  it("does not let the shared suffix overlap the shared prefix on repeats", () => {
    // "aaa" → "aa": prefix consumes two a's; the suffix must not also claim the
    // third, or from/to would be inverted. One deletion of a single char.
    const edit = minimalEdit("aaa", "aa")!;
    expect(edit.from).toBeLessThanOrEqual(edit.to);
    expect(edit).toEqual({ from: 2, to: 3, text: "" });
    expect(apply("aaa", edit)).toBe("aa");

    const grow = minimalEdit("aa", "aaa")!;
    expect(grow.from).toBeLessThanOrEqual(grow.to);
    expect(apply("aa", grow)).toBe("aaa");
  });

  it("reconstructs next for a multi-line paragraph rewrite", () => {
    const old = "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n";
    const next = "# Title\n\nFirst paragraph, revised.\n\nSecond paragraph.\n";
    const edit = minimalEdit(old, next)!;
    expect(apply(old, edit)).toBe(next);
    // The change is localized to the first paragraph — the trailing content
    // (including "Second paragraph.") stays outside the replaced range.
    expect(old.slice(edit.to)).toContain("Second paragraph.");
  });
});

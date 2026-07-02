import { describe, expect, it } from "vitest";

import { locateSelection } from "./anchor-text";

describe("locateSelection", () => {
  const doc = "The quick brown fox jumps over the lazy dog.";

  it("pins a unique selection to its exact char range", () => {
    const r = locateSelection(doc, "brown fox", "");
    expect(r).toEqual({ from: 10, to: 19 });
    expect(doc.slice(r!.from, r!.to)).toBe("brown fox");
  });

  it("tolerates whitespace differences between the render and the source", () => {
    // The rendered selection collapses the source's double space / newline.
    const source = "alpha   beta\ngamma delta";
    const r = locateSelection(source, "beta gamma", "");
    expect(r).not.toBeNull();
    expect(source.slice(r!.from, r!.to)).toBe("beta\ngamma");
  });

  it("returns null when the text isn't present as a contiguous run", () => {
    expect(locateSelection(doc, "fox dog", "")).toBeNull();
    expect(locateSelection(doc, "   ", "")).toBeNull();
  });

  it("uses preceding context to pick among repeated phrases", () => {
    const repeated = "see the note here, and also see the note there.";
    // "see the note" occurs twice; the preceding "also" should select the 2nd.
    const r = locateSelection(repeated, "see the note", "and also ");
    expect(r).not.toBeNull();
    expect(r!.from).toBe(repeated.indexOf("see the note", 5));
  });

  it("falls back to the first match when there's no disambiguating context", () => {
    const repeated = "see the note here, and also see the note there.";
    const r = locateSelection(repeated, "see the note", "");
    expect(r!.from).toBe(repeated.indexOf("see the note"));
  });
});

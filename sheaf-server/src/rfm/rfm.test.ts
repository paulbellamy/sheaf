import { describe, expect, it } from "vitest";

import {
  composeDoc,
  renderInlineMarkers,
  splitEndmatter,
  stripInlineMarkup,
  stripReviewMarkup,
  type InlineMarker,
} from "./index";

describe("stripInlineMarkup", () => {
  it("strips each CriticMarkup marker to its as-is projection", () => {
    expect(stripInlineMarkup("a {==anchor==} b")).toBe("a anchor b");
    expect(stripInlineMarkup("a {>>note<<} b")).toBe("a  b");
    expect(stripInlineMarkup("a {++ins++} b")).toBe("a  b");
    expect(stripInlineMarkup("a {--del--} b")).toBe("a del b");
    expect(stripInlineMarkup("a {~~old~>new~~} b")).toBe("a old b");
    expect(stripInlineMarkup("a {#thrd_x} b")).toBe("a  b");
  });

  it("strips an anchored comment with id reference to the anchor text", () => {
    const md = "Please revisit {==this sentence==}{>>Needs a source.<<}{#thrd_a1} now.";
    expect(stripInlineMarkup(md)).toBe("Please revisit this sentence now.");
  });

  it("leaves markers inside inline code and fences literal", () => {
    expect(stripInlineMarkup("use `{==x==}` here")).toBe("use `{==x==}` here");
    const fenced = "```\n{>>not a comment<<}\n```\ntext {>>real<<}";
    expect(stripInlineMarkup(fenced)).toBe("```\n{>>not a comment<<}\n```\ntext ");
  });

  it("leaves unrelated braces untouched", () => {
    expect(stripInlineMarkup("interface X { a: 1 }")).toBe("interface X { a: 1 }");
  });
});

describe("splitEndmatter", () => {
  it("detects a trailing comments/suggestions endmatter", () => {
    const md = "Body here.\n\n---\ncomments:\n  thrd_a:\n    status: open\n";
    const split = splitEndmatter(md);
    expect(split.body).toBe("Body here.\n");
    expect(split.endmatter).not.toBeNull();
    expect(split.endmatter).toHaveProperty("comments");
  });

  it("ignores an ordinary trailing --- section that is not an endmatter", () => {
    const md = "Intro\n\n---\n\nA closing section, not YAML review state.\n";
    const split = splitEndmatter(md);
    expect(split.endmatter).toBeNull();
    expect(split.body).toBe(md);
  });

  it("picks the last endmatter when several --- dividers exist", () => {
    const md = "A\n\n---\n\nmiddle\n\n---\nsuggestions:\n  thrd_b:\n    status: open\n";
    const split = splitEndmatter(md);
    expect(split.endmatter).toHaveProperty("suggestions");
    expect(split.body).toBe("A\n\n---\n\nmiddle\n");
  });
});

describe("composeDoc / round trips", () => {
  it("composes body + endmatter and strips back to clean prose", () => {
    const prose = "Hello world.\n";
    const endmatter = { comments: { thrd_a: { status: "open" } } };
    const doc = composeDoc(prose, endmatter);
    expect(doc).toContain("\n---\ncomments:");
    expect(stripReviewMarkup(doc)).toBe("Hello world.\n");
  });

  it("emits no trailing --- for an empty endmatter", () => {
    expect(composeDoc("Hello.\n", null)).toBe("Hello.\n");
    expect(composeDoc("Hello.\n", { comments: {} })).toBe("Hello.\n");
  });
});

describe("renderInlineMarkers", () => {
  const strip = stripInlineMarkup;

  it("wraps an anchored comment and round-trips via strip", () => {
    const prose = "Please revisit this sentence now.";
    const markers: InlineMarker[] = [
      {
        id: "thrd_a",
        from: 15,
        to: 28,
        anchoredText: "this sentence",
        kind: "comment",
        commentBody: "Needs a source.",
      },
    ];
    const out = renderInlineMarkers(prose, markers);
    expect(out).toBe(
      "Please revisit {==this sentence==}{>>Needs a source.<<}{#thrd_a} now.",
    );
    expect(strip(out)).toBe(prose);
  });

  it("renders a substitution change and strips back to the old text", () => {
    const prose = "Use rough wording.";
    const markers: InlineMarker[] = [
      {
        id: "thrd_b",
        from: 4,
        to: 9,
        anchoredText: "rough",
        kind: "substitution",
        newText: "specific",
      },
    ];
    const out = renderInlineMarkers(prose, markers);
    expect(out).toBe("Use {~~rough~>specific~~}{#thrd_b} wording.");
    expect(strip(out)).toBe(prose);
  });

  it("relocates a marker whose offsets drifted, by anchored text", () => {
    const prose = "alpha beta gamma";
    const markers: InlineMarker[] = [
      { id: "t", from: 0, to: 4, anchoredText: "gamma", kind: "comment", commentBody: "x" },
    ];
    const out = renderInlineMarkers(prose, markers);
    expect(out).toBe("alpha beta {==gamma==}{>>x<<}{#t}");
    expect(strip(out)).toBe(prose);
  });

  it("places multiple non-overlapping markers and round-trips", () => {
    const prose = "one two three four";
    const markers: InlineMarker[] = [
      { id: "a", from: 0, to: 3, anchoredText: "one", kind: "comment", commentBody: "c1" },
      { id: "b", from: 8, to: 13, anchoredText: "three", kind: "comment", commentBody: "c2" },
    ];
    const out = renderInlineMarkers(prose, markers);
    expect(out).toContain("{==one==}{>>c1<<}{#a}");
    expect(out).toContain("{==three==}{>>c2<<}{#b}");
    expect(strip(out)).toBe(prose);
  });

  it("skips an unlocatable anchor (left in endmatter only)", () => {
    const prose = "nothing matches here";
    const markers: InlineMarker[] = [
      { id: "a", from: 0, to: 5, anchoredText: "absent", kind: "comment", commentBody: "c" },
    ];
    expect(renderInlineMarkers(prose, markers)).toBe(prose);
  });

  it("skips a second overlapping marker", () => {
    const prose = "shared overlap span";
    const markers: InlineMarker[] = [
      { id: "a", from: 0, to: 14, anchoredText: "shared overlap", kind: "comment", commentBody: "c1" },
      { id: "b", from: 7, to: 19, anchoredText: "overlap span", kind: "comment", commentBody: "c2" },
    ];
    const out = renderInlineMarkers(prose, markers);
    const count = (out.match(/\{#/g) ?? []).length;
    expect(count).toBe(1);
    expect(strip(out)).toBe(prose);
  });

  it("sanitizes a comment body containing a close delimiter", () => {
    const prose = "word";
    const markers: InlineMarker[] = [
      { id: "a", from: 0, to: 4, anchoredText: "word", kind: "comment", commentBody: "danger <<} here" },
    ];
    const out = renderInlineMarkers(prose, markers);
    expect(strip(out)).toBe(prose);
  });
});

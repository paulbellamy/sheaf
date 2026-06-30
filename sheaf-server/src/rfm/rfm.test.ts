import { describe, expect, it } from "vitest";

import {
  cleanOffset,
  composeDoc,
  renderInlineMarkers,
  splitEndmatter,
  stripInlineMarkup,
  stripReviewMarkup,
  type InlineMarker,
} from "./index";

describe("stripInlineMarkup", () => {
  it("strips id-terminated marker groups to their as-is projection", () => {
    expect(stripInlineMarkup("a {==anchor==}{#c1} b")).toBe("a anchor b");
    expect(stripInlineMarkup("a {++ins++}{#s1} b")).toBe("a  b");
    expect(stripInlineMarkup("a {--del--}{#s2} b")).toBe("a del b");
    expect(stripInlineMarkup("a {~~old~>new~~}{#s3} b")).toBe("a old b");
    expect(stripInlineMarkup("a {==anchor==}{>>note<<}{#c1} b")).toBe("a anchor b");
  });

  it("strips an anchored comment with id reference to the anchor text", () => {
    const md = "Please revisit {==this sentence==}{>>Needs a source.<<}{#thrd_a1} now.";
    expect(stripInlineMarkup(md)).toBe("Please revisit this sentence now.");
  });

  it("leaves hand-typed CriticMarkup with no id reference literal", () => {
    expect(stripInlineMarkup("a {==anchor==} b")).toBe("a {==anchor==} b");
    expect(stripInlineMarkup("a {>>note<<} b")).toBe("a {>>note<<} b");
    expect(stripInlineMarkup("a {~~old~>new~~} b")).toBe("a {~~old~>new~~} b");
    expect(stripInlineMarkup("a {#thrd_x} b")).toBe("a {#thrd_x} b");
  });

  it("leaves markers inside inline code and fences literal", () => {
    expect(stripInlineMarkup("use `{==x==}{#c1}` here")).toBe("use `{==x==}{#c1}` here");
    const fenced = "```\n{>>not a comment<<}{#c1}\n```\ntext {==real==}{>>c<<}{#x}";
    expect(stripInlineMarkup(fenced)).toBe(
      "```\n{>>not a comment<<}{#c1}\n```\ntext real",
    );
  });

  it("leaves unrelated braces untouched", () => {
    expect(stripInlineMarkup("interface X { a: 1 }")).toBe("interface X { a: 1 }");
  });
});

describe("splitEndmatter", () => {
  it("detects a trailing comments/suggestions endmatter", () => {
    const md =
      "Body here.\n\n---\ncomments:\n  thrd_a:\n    status: open\n    messages:\n      - body: hi\n";
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

  it("ignores a trailing comments:/suggestions: block that holds no thread records", () => {
    // A config tutorial (or a doc documenting RFM itself) whose last section is
    // a YAML map with a `comments:` key must not be mistaken for an endmatter.
    const md =
      "# Config guide\n\nSettings live under a final block:\n\n---\ncomments:\n  show: always\n";
    const split = splitEndmatter(md);
    expect(split.endmatter).toBeNull();
    expect(split.body).toBe(md);
    expect(stripReviewMarkup(md)).toBe(md);
  });

  it("picks the last real endmatter when several --- dividers exist", () => {
    const md =
      "A\n\n---\n\nmiddle\n\n---\nsuggestions:\n  thrd_b:\n    status: open\n    messages:\n      - body: hi\n";
    const split = splitEndmatter(md);
    expect(split.endmatter).toHaveProperty("suggestions");
    expect(split.body).toBe("A\n\n---\n\nmiddle\n");
  });
});

describe("composeDoc / round trips", () => {
  it("composes body + endmatter and strips back to clean prose", () => {
    const prose = "Hello world.\n";
    const endmatter = {
      comments: { thrd_a: { status: "open", messages: [{ body: "hi" }] } },
    };
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

  it("does not inject a marker inside a fenced code block (strip honors fences)", () => {
    const prose = "Example:\n```\nconst x = 1;\n```\nDone.\n";
    const from = prose.indexOf("const x = 1;");
    const markers: InlineMarker[] = [
      { id: "t", from, to: from + 12, anchoredText: "const x = 1;", kind: "comment", commentBody: "note" },
    ];
    const out = renderInlineMarkers(prose, markers);
    expect(out).toBe(prose); // skipped — would survive strip inside the fence
    expect(strip(out)).toBe(prose);
  });

  it("does not inject a marker inside an inline code span", () => {
    const prose = "see `code` here";
    const from = prose.indexOf("code");
    const markers: InlineMarker[] = [
      { id: "t", from, to: from + 4, anchoredText: "code", kind: "comment", commentBody: "n" },
    ];
    expect(renderInlineMarkers(prose, markers)).toBe(prose);
  });

  it("does not inject a marker when the anchor contains a backtick", () => {
    const prose = "x ` y z";
    const markers: InlineMarker[] = [
      { id: "t", from: 2, to: 7, anchoredText: "` y z", kind: "comment", commentBody: "n" },
    ];
    expect(renderInlineMarkers(prose, markers)).toBe(prose);
  });
});

describe("stripReviewMarkup leaves plain prose untouched", () => {
  it("preserves literal CriticMarkup in a doc with no review endmatter", () => {
    const md = "Use {==this==} and {>>that<<} and {~~a~>b~~} literally.\n";
    expect(stripReviewMarkup(md)).toBe(md);
  });
});

describe("cleanOffset", () => {
  const raw =
    "The {==quick==}{>>note<<}{#thrd_x} brown fox.\n---\ncomments:\n  thrd_x:\n    status: open\n    messages:\n      - body: note\n";

  it("maps an offset before any marker unchanged", () => {
    expect(cleanOffset(raw, 3)).toBe(3); // 'The'
  });

  it("maps offsets that land inside a highlight marker to its clean text", () => {
    const q = raw.indexOf("quick"); // inside {==quick==}
    expect(cleanOffset(raw, q)).toBe(4); // start of 'quick' in clean prose
    expect(cleanOffset(raw, q + 5)).toBe(9); // end of 'quick'
  });

  it("maps an offset after the marker block back to clean coordinates", () => {
    expect(cleanOffset(raw, raw.indexOf("brown"))).toBe(10); // 'The quick '
  });
});

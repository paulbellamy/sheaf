import { describe, expect, it } from "vitest";

import {
  cleanOffset,
  composeDoc,
  renderInlineMarkers,
  scanReviewMarkup,
  splitEndmatter,
  stripInlineMarkup,
  stripReviewMarkup,
  type Endmatter,
  type InlineMarker,
} from "./index";

/** A minimal endmatter record. `looksLikeEndmatter` demands both a `messages`
 *  and a `targets` array (the invariants of every real sheaf thread), so the
 *  fixtures below carry both. */
function record(body = "hi"): Record<string, unknown> {
  return {
    status: "open",
    created: 1,
    targets: [{ path: "d.md", scope: "doc" }],
    messages: [{ body }],
  };
}

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

  it("strips a pathological backtick run without O(n^2) blowup (F8)", () => {
    // A long non-fenced backtick run in the prose: the old scanner re-scanned
    // the whole run at every offset (seconds at 64 KB); the tokenizer skips it
    // in one step, so this finishes in milliseconds.
    const bigTicks = "x" + "`".repeat(100_000);
    const start = Date.now();
    const out = stripInlineMarkup(bigTicks);
    const elapsed = Date.now() - start;
    expect(out).toBe(bigTicks); // no markers -> unchanged
    expect(elapsed).toBeLessThan(2000);
  });

  it("strips a doc of many tiny inline-code spans in linear time (F8)", () => {
    // Newline/brace-free input where every `\`a\`` is its own segment: a
    // per-segment scan-to-EOF would be O(n^2) (~seconds by 1 MB). The bounded
    // per-char skip keeps it linear.
    const many = "`a".repeat(500_000); // ~1 MB, no newlines, no braces
    const start = Date.now();
    const out = stripInlineMarkup(many);
    const elapsed = Date.now() - start;
    expect(out).toBe(many); // no {#id} groups -> preserved verbatim
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("scanReviewMarkup", () => {
  it("locates a comment group with its anchor, note, and id", () => {
    const md = "Please revisit {==this sentence==}{>>Needs a source.<<}{#c1} now.";
    const [g, ...rest] = scanReviewMarkup(md);
    expect(rest).toHaveLength(0);
    expect(g.kind).toBe("comment");
    expect(g.id).toBe("c1");
    expect(md.slice(g.keptStart, g.keptEnd)).toBe("this sentence");
    expect(g.comment).toBe("Needs a source.");
    expect(md.slice(g.start, g.end)).toBe(
      "{==this sentence==}{>>Needs a source.<<}{#c1}",
    );
  });

  it("handles a bare anchor whose body lives in the endmatter", () => {
    const [g] = scanReviewMarkup("a {==anchor==}{#c1} b");
    expect(g.kind).toBe("comment");
    expect(g.comment).toBe("");
    expect(g.id).toBe("c1");
  });

  it("joins multiple inline note blocks on one anchor", () => {
    const [g] = scanReviewMarkup("x {==a==}{>>one<<}{>>two<<}{#c1} y");
    expect(g.comment).toBe("one\n\ntwo");
  });

  it("reports the proposed text range for insertions and substitutions", () => {
    const ins = scanReviewMarkup("a {++new++}{#s1} b")[0];
    expect(ins.kind).toBe("insertion");
    expect(ins.keptStart).toBe(ins.keptEnd); // nothing kept yet
    expect("a {++new++}{#s1} b".slice(ins.newStart!, ins.newEnd!)).toBe("new");

    const sub = scanReviewMarkup("a {~~old~>new~~}{#s2} b")[0];
    expect(sub.kind).toBe("substitution");
    const md = "a {~~old~>new~~}{#s2} b";
    expect(md.slice(sub.keptStart, sub.keptEnd)).toBe("old");
    expect(md.slice(sub.newStart!, sub.newEnd!)).toBe("new");
  });

  it("marks a deletion's kept (still-in-doc) text", () => {
    const g = scanReviewMarkup("a {--gone--}{#s3} b")[0];
    expect(g.kind).toBe("deletion");
    expect("a {--gone--}{#s3} b".slice(g.keptStart, g.keptEnd)).toBe("gone");
    expect(g.newStart).toBeNull();
  });

  it("skips markup inside code spans and fences, and hand-typed markup", () => {
    expect(scanReviewMarkup("use `{==x==}{#c1}` here")).toEqual([]);
    expect(
      scanReviewMarkup("```\n{==x==}{>>c<<}{#c1}\n```"),
    ).toEqual([]);
    expect(scanReviewMarkup("a {==anchor==} b")).toEqual([]); // no {#id}
  });

  it("offsets round-trip against stripInlineMarkup's kept projection", () => {
    const md = "keep {==A==}{>>c<<}{#c1} and {~~x~>y~~}{#s1} end";
    const kept = scanReviewMarkup(md)
      .map((g) => md.slice(g.keptStart, g.keptEnd))
      .join("|");
    expect(kept).toBe("A|x");
  });
});

describe("splitEndmatter", () => {
  it("detects a trailing comments/suggestions endmatter", () => {
    const md =
      "Body here.\n\n---\ncomments:\n  thrd_a:\n    status: open\n    targets:\n      - path: d.md\n        scope: doc\n    messages:\n      - body: hi\n";
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

  it("ignores a trailing comments block whose records have no targets (F1)", () => {
    // A doc documenting the format, ending in an (unfenced) example with a
    // `messages:` array but no `targets:` — not a real record, so it must not
    // be detected as review state and stripped/erased on the next write.
    const md =
      "# Notes\n\nExample record shape:\n\n---\ncomments:\n  thrd_a:\n    messages:\n      - body: illustrative only\n";
    const split = splitEndmatter(md);
    expect(split.endmatter).toBeNull();
    expect(split.body).toBe(md);
    expect(stripReviewMarkup(md)).toBe(md);
  });

  it("picks the last real endmatter when several --- dividers exist", () => {
    const md =
      "A\n\n---\n\nmiddle\n\n---\nsuggestions:\n  thrd_b:\n    status: open\n    targets:\n      - path: d.md\n        scope: doc\n    messages:\n      - body: hi\n";
    const split = splitEndmatter(md);
    expect(split.endmatter).toHaveProperty("suggestions");
    expect(split.body).toBe("A\n\n---\n\nmiddle\n");
  });

  it("recovers a body that ends in a --- horizontal rule (F6)", () => {
    // composeDoc appends `\n---\n`; a body ending `…\n---` (an hr, no trailing
    // newline) used to share the divider's newline, so the real boundary was
    // missed and the prose `---` swallowed.
    const body = "# Doc\n\ntext\n\n---";
    const doc = composeDoc(body, { comments: { thrd_a: record() } });
    const split = splitEndmatter(doc);
    expect(split.body).toBe(body);
    expect(split.endmatter).toHaveProperty("comments");
  });

  it("detects the real endmatter even with a block pasted after it (F10)", () => {
    // Pasting a second unindented `---` block after the endmatter used to make
    // its region parse as multi-document YAML → throw → fail *open*, dumping
    // every comment body into clean prose. Bounding each candidate to the next
    // divider keeps the real endmatter parseable and the bodies hidden.
    const body = "Please revisit {==this sentence==}{>>SECRET note<<}{#thrd_x} now.";
    const doc =
      composeDoc(body, {
        comments: { thrd_x: record("SECRET note") },
      }) + "\n---\nappended by hand\n";
    const clean = stripReviewMarkup(doc);
    expect(clean).toBe("Please revisit this sentence now.");
    expect(clean).not.toContain("SECRET");
  });

  it("fails closed: strips inline spans when a corrupted endmatter won't parse (F10)", () => {
    // The endmatter YAML itself is broken (unparseable), but the doc carries an
    // injected `{#id}` group and a trailing divider — so hide the inline body
    // rather than returning raw bytes with the comment in them.
    const md =
      "See {==this==}{>>SECRET<<}{#thrd_x} here.\n---\ncomments:\n  thrd_x: [oops: : :\n";
    const clean = stripReviewMarkup(md);
    expect(clean).not.toContain("SECRET");
    expect(clean).toContain("See this here.");
  });
});

describe("composeDoc / round trips", () => {
  it("composes body + endmatter and strips back to clean prose", () => {
    const prose = "Hello world.\n";
    const endmatter: Endmatter = { comments: { thrd_a: record() } };
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

  it("does not leak marker syntax when the comment body has a backtick (F3)", () => {
    // An unmatched backtick sits before the anchor and the comment body also
    // has backticks; un-neutralized they would pair into a code span that
    // swallows the injected `{==`.
    const prose = "a ` b anchorword c";
    const at = prose.indexOf("anchorword");
    const markers: InlineMarker[] = [
      {
        id: "t",
        from: at,
        to: at + "anchorword".length,
        anchoredText: "anchorword",
        kind: "comment",
        commentBody: "see `foo` for context",
      },
    ];
    const out = renderInlineMarkers(prose, markers);
    expect(out).not.toContain("`foo`");
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
    "The {==quick==}{>>note<<}{#thrd_x} brown fox.\n---\ncomments:\n  thrd_x:\n    status: open\n    targets:\n      - path: d.md\n        scope: doc\n    messages:\n      - body: note\n";

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

  it("is identity on a doc with a {#id} group but no endmatter (F2)", () => {
    // No endmatter → the server returns the bytes verbatim, so an editor offset
    // already is a clean-prose offset. Compressing it here would mis-anchor the
    // first comment on such a doc.
    const noEnd = "ab {==cd==}{#thrd_x} ef";
    for (const off of [0, 3, 6, 10, noEnd.length]) {
      expect(cleanOffset(noEnd, off)).toBe(off);
    }
  });
});

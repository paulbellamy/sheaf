import { describe, expect, it } from "vitest";
import {
  parseCommentTail,
  parseSubTail,
  textToParts,
  type RenderPart,
} from "./reading-markup";

describe("parseCommentTail", () => {
  it("parses the `}{>>note<<}{#id}` tail after an anchor", () => {
    const r = parseCommentTail("}{>>fix this<<}{#c1} and more prose");
    expect(r).toEqual({ note: "fix this", id: "c1", consumed: 20 });
  });

  it("joins multiple inline notes the way the scanner does", () => {
    const r = parseCommentTail("}{>>one<<}{>>two<<}{#c2}");
    expect(r?.note).toBe("one\n\ntwo");
    expect(r?.id).toBe("c2");
  });

  it("handles a comment whose body lives only in the endmatter (no note)", () => {
    const r = parseCommentTail("}{#c3} rest");
    expect(r).toEqual({ note: "", id: "c3", consumed: 6 });
  });

  it("returns null when the text isn't a comment tail", () => {
    expect(parseCommentTail("}{#c3")).toBeNull(); // unterminated id
    expect(parseCommentTail("plain text")).toBeNull();
    expect(parseCommentTail("}{#1bad}")).toBeNull(); // id must start with a letter
  });
});

describe("parseSubTail", () => {
  it("parses the `}{#id}` tail after a strikethrough", () => {
    expect(parseSubTail("}{#s1} tail")).toEqual({ id: "s1", consumed: 6 });
  });

  it("returns null when it isn't a substitution tail", () => {
    expect(parseSubTail("}{>>note<<}{#s1}")).toBeNull();
    expect(parseSubTail("no brace")).toBeNull();
  });
});

describe("textToParts", () => {
  const kinds = (parts: RenderPart[]): string[] => parts.map((p) => p.kind);

  it("leaves markup-free text as a single text part", () => {
    expect(textToParts("just some prose")).toEqual([
      { kind: "text", text: "just some prose" },
    ]);
  });

  it("decorates a literal insertion", () => {
    const parts = textToParts("before {++added++}{#i1} after");
    expect(parts).toEqual([
      { kind: "text", text: "before " },
      { kind: "ins", text: "added" },
      { kind: "text", text: " after" },
    ]);
  });

  it("decorates a literal deletion", () => {
    const parts = textToParts("keep {--gone--}{#d1} end");
    expect(parts).toEqual([
      { kind: "text", text: "keep " },
      { kind: "del", text: "gone" },
      { kind: "text", text: " end" },
    ]);
  });

  it("decorates a fully-literal substitution as struck-old + underlined-new", () => {
    const parts = textToParts("{~~old~>new~~}{#s1}");
    expect(parts).toEqual([
      { kind: "del", text: "old" },
      { kind: "ins", text: "new" },
    ]);
  });

  it("decorates a fully-literal comment as anchor + chip", () => {
    const parts = textToParts("{==anchor==}{>>note<<}{#c1}");
    expect(kinds(parts)).toEqual(["anchor", "chip"]);
    expect(parts[0]).toEqual({ kind: "anchor", text: "anchor" });
    expect(parts[1]).toEqual({ kind: "chip", id: "c1", note: "note" });
  });

  it("handles several groups in one string", () => {
    const parts = textToParts("a {++x++}{#i1} b {--y--}{#d1} c");
    expect(kinds(parts)).toEqual(["text", "ins", "text", "del", "text"]);
  });

  it("leaves hand-typed CriticMarkup without an id terminator alone", () => {
    expect(textToParts("{==bare==} no id")).toEqual([
      { kind: "text", text: "{==bare==} no id" },
    ]);
  });
});

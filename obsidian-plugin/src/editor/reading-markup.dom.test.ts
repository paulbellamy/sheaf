// @vitest-environment jsdom
//
// DOM-level tests for the reading-mode post-processor. These need a document,
// so they run in vitest's jsdom environment (the pure string helpers are
// covered in reading-markup.test.ts under the default node env). The inputs are
// the HTML Obsidian's reader produces for each RFM shape — crucially, its own
// inline markdown fires first, so `==anchor==` arrives as <mark> and
// `~~old~>new~~` as <del>/<s>.
import { describe, expect, it } from "vitest";
import { decorateReadingReviewMarkup } from "./reading-markup";

function render(html: string, ctx?: Parameters<typeof decorateReadingReviewMarkup>[1]): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  decorateReadingReviewMarkup(el, ctx);
  return el;
}

describe("decorateReadingReviewMarkup", () => {
  it("renders a comment (Obsidian <mark> split) as anchor + chip", () => {
    const el = render(`<p>Prose {<mark>the anchor</mark>}{>>please fix<<}{#c1} on.</p>`);
    const anchor = el.querySelector(".sheaf-rfm-anchor");
    const chip = el.querySelector<HTMLElement>(".sheaf-rfm-chip");
    expect(anchor?.textContent).toBe("the anchor");
    expect(chip?.textContent).toBe("💬");
    expect(chip?.title).toBe("please fix");
    expect(el.querySelector("mark")).toBeNull();
    expect(el.textContent).toBe("Prose the anchor💬 on.");
  });

  it("renders a comment whose note carried inline markdown (split tail)", () => {
    // Obsidian splits the note across nodes: `}{>>make it ` + <em>pop</em> + `<<}{#c1}`.
    const el = render(`<p>{<mark>anchor</mark>}{>>make it <em>pop</em><<}{#c1} rest</p>`);
    expect(el.querySelector(".sheaf-rfm-anchor")?.textContent).toBe("anchor");
    const chip = el.querySelector<HTMLElement>(".sheaf-rfm-chip");
    expect(chip).not.toBeNull();
    expect(chip?.title).toBe("make it pop");
    expect(el.querySelector("em")).toBeNull(); // the note element was consumed
    expect(el.textContent).toBe("anchor💬 rest");
  });

  it("renders the writer's empty-note shape {>><<}{#id}", () => {
    const el = render(`<p>{<mark>anchor</mark>}{>><<}{#c9} rest</p>`);
    expect(el.querySelector(".sheaf-rfm-anchor")?.textContent).toBe("anchor");
    const chip = el.querySelector<HTMLElement>(".sheaf-rfm-chip");
    expect(chip?.title).toBe("Sheaf comment · c9"); // id fallback when no note
    expect(el.textContent).toBe("anchor💬 rest");
  });

  it("renders a substitution from <del>", () => {
    const el = render(`<p>He said {<del>teh~>the</del>}{#s1} word.</p>`);
    expect(el.querySelector(".sheaf-rfm-del")?.textContent).toBe("teh");
    expect(el.querySelector(".sheaf-rfm-ins")?.textContent).toBe("the");
    expect(el.textContent).toBe("He said tehthe word.");
  });

  it("renders a substitution from <s> too (alternate strikethrough tag)", () => {
    const el = render(`<p>{<s>teh~>the</s>}{#s1}</p>`);
    expect(el.querySelector(".sheaf-rfm-del")?.textContent).toBe("teh");
    expect(el.querySelector(".sheaf-rfm-ins")?.textContent).toBe("the");
    expect(el.querySelector("s")).toBeNull();
  });

  it("renders a literal insertion", () => {
    const el = render(`<p>Add {++a clause++}{#i1} here.</p>`);
    expect(el.querySelector(".sheaf-rfm-ins")?.textContent).toBe("a clause");
    expect(el.textContent).toBe("Add a clause here.");
  });

  it("renders a literal deletion", () => {
    const el = render(`<p>Remove {--this bit--}{#d1} now.</p>`);
    expect(el.querySelector(".sheaf-rfm-del")?.textContent).toBe("this bit");
    expect(el.textContent).toBe("Remove this bit now.");
  });

  it("handles two groups (wrapper + literal) in one block", () => {
    const el = render(`<p>{<mark>a</mark>}{>>n<<}{#c1} and {++more++}{#i2}.</p>`);
    expect(el.querySelector(".sheaf-rfm-anchor")).not.toBeNull();
    expect(el.querySelector(".sheaf-rfm-chip")).not.toBeNull();
    expect(el.querySelector(".sheaf-rfm-ins")?.textContent).toBe("more");
    expect(el.textContent).toBe("a💬 and more.");
  });

  it("leaves a genuine highlight alone", () => {
    const el = render(`<p>Just a <mark>real highlight</mark> here.</p>`);
    expect(el.querySelector("mark")).not.toBeNull();
    expect(el.querySelector(".sheaf-rfm-anchor")).toBeNull();
  });

  it("leaves a genuine strikethrough (no ~>) alone", () => {
    const el = render(`<p>Just <del>struck out</del> text.</p>`);
    expect(el.querySelector("del")).not.toBeNull();
    expect(el.querySelector(".sheaf-rfm-ins")).toBeNull();
  });

  it("leaves markup inside inline code literal", () => {
    const el = render(`<p>Type <code>{++x++}{#i9}</code> literally.</p>`);
    expect(el.querySelector(".sheaf-rfm-ins")).toBeNull();
    expect(el.querySelector("code")?.textContent).toBe("{++x++}{#i9}");
  });

  describe("endmatter exclusion", () => {
    // A doc whose body is 2 lines, then the `\n---\n` review endmatter.
    const doc = [
      "Body prose here.",
      "",
      "---",
      "comments:",
      "  c1:",
      "    messages: []",
      "    targets: []",
    ].join("\n");
    const ctxAt = (lineStart: number) => ({
      getSectionInfo: () => ({ text: doc, lineStart, lineEnd: lineStart }),
    });

    it("decorates a block in the body", () => {
      const el = render(`<p>see {++foo++}{#i1}</p>`, ctxAt(0));
      expect(el.querySelector(".sheaf-rfm-ins")?.textContent).toBe("foo");
    });

    it("skips a block rendered from the endmatter", () => {
      // Line 3 is inside the YAML endmatter — must be left untouched.
      const el = render(`<p>see {++foo++}{#i1}</p>`, ctxAt(3));
      expect(el.querySelector(".sheaf-rfm-ins")).toBeNull();
      expect(el.textContent).toBe("see {++foo++}{#i1}");
    });

    it("still decorates when section info is unavailable", () => {
      const el = render(`<p>see {++foo++}{#i1}</p>`, { getSectionInfo: () => null });
      expect(el.querySelector(".sheaf-rfm-ins")?.textContent).toBe("foo");
    });
  });
});

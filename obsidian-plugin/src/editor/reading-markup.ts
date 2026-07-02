import { scanReviewMarkup, type ReviewMarkerGroup } from "sheaf-server/types";

/**
 * Reading-mode (preview) rendering for sheaf's inline RFM review markup.
 *
 * Live Preview decorates the markup with a CodeMirror 6 extension
 * (`review-markup.ts`), but reading mode has no editor — Obsidian renders the
 * note to HTML through markdown post-processors, so the CM6 decorations never
 * run and the raw `{==anchor==}{>>note<<}{#id}` delimiters show as noise. This
 * module is the post-processor half: it walks the rendered DOM and paints the
 * same parts the editor does — anchor highlighted with a 💬 chip, insertions
 * underlined, deletions struck — reusing the shared `.sheaf-rfm-*` CSS.
 *
 * The wrinkle reading mode adds is that Obsidian's own inline markdown fires
 * first, so two of the four shapes arrive already half-transformed:
 *   - a comment's `==anchor==` became a `<mark>` (Obsidian highlight), leaving
 *     the surrounding `{` … `}{>>note<<}{#id}` as its text siblings;
 *   - a substitution's `~~old~>new~~` became a `<del>` (strikethrough), leaving
 *     `{` … `}{#id}` around it.
 * Insertions (`{++…++}`) and deletions (`{--…--}`) use no Obsidian syntax, so
 * they survive as literal text. We handle the two wrapper shapes by matching
 * against the `<mark>`/`<del>` and their delimiter siblings, then sweep the
 * remaining text nodes for the literal shapes with the server's own scanner.
 *
 * Anything that doesn't match cleanly is left untouched — the worst case is the
 * raw markup showing, exactly as it did before this processor existed.
 */

/** The trailing `{#id}` id grammar, mirrored from the RFM scanner. */
const ID = "[A-Za-z][A-Za-z0-9_-]*";

/**
 * A styled fragment of a decorated marker group. Pure data (no DOM) so the
 * mapping from a parsed group to its rendering is unit-testable; `partToNode`
 * turns each into a DOM node.
 */
export type RenderPart =
  | { kind: "text"; text: string }
  | { kind: "anchor"; text: string }
  | { kind: "ins"; text: string }
  | { kind: "del"; text: string }
  | { kind: "chip"; id: string; note: string };

/** Styled parts for one marker group — mirrors `decorateGroup` in review-markup.ts. */
function groupParts(g: ReviewMarkerGroup, text: string): RenderPart[] {
  switch (g.kind) {
    case "comment":
      return [
        { kind: "anchor", text: text.slice(g.keptStart, g.keptEnd) },
        { kind: "chip", id: g.id, note: g.comment },
      ];
    case "deletion":
      return [{ kind: "del", text: text.slice(g.keptStart, g.keptEnd) }];
    case "insertion":
      return [
        {
          kind: "ins",
          text: text.slice(g.newStart ?? g.keptStart, g.newEnd ?? g.keptEnd),
        },
      ];
    case "substitution":
      return [
        { kind: "del", text: text.slice(g.keptStart, g.keptEnd) },
        {
          kind: "ins",
          text: text.slice(g.newStart ?? g.keptEnd, g.newEnd ?? g.keptEnd),
        },
      ];
  }
}

/**
 * Split a text node's string into render parts, decorating any *literal* marker
 * groups it contains (insertions, deletions, and any comment/substitution that
 * escaped Obsidian's inline transforms). Returns a single text part when the
 * string carries no complete group, so the caller can cheaply skip it.
 */
export function textToParts(text: string): RenderPart[] {
  const groups = scanReviewMarkup(text);
  if (groups.length === 0) return [{ kind: "text", text }];
  const parts: RenderPart[] = [];
  let pos = 0;
  for (const g of groups) {
    if (g.start > pos) parts.push({ kind: "text", text: text.slice(pos, g.start) });
    parts.push(...groupParts(g, text));
    pos = g.end;
  }
  if (pos < text.length) parts.push({ kind: "text", text: text.slice(pos) });
  return parts;
}

/**
 * Parse a comment's post-anchor tail — the `}{>>note<<}…{#id}` that trails the
 * `<mark>` Obsidian made from `==anchor==`. Returns the joined note text (as the
 * scanner joins multiple `{>>…<<}` notes), the id, and how many characters the
 * tail consumed, or null when the text doesn't begin one.
 */
export function parseCommentTail(
  text: string,
): { note: string; id: string; consumed: number } | null {
  const m = new RegExp(`^\\}((?:\\{>>[\\s\\S]*?<<\\})*)\\{#(${ID})\\}`).exec(text);
  if (!m) return null;
  const notes = [...m[1].matchAll(/\{>>([\s\S]*?)<<\}/g)].map((x) => x[1]);
  return { note: notes.join("\n\n"), id: m[2], consumed: m[0].length };
}

/**
 * Parse a substitution's post-`<del>` tail — the `}{#id}` that trails the
 * strikethrough Obsidian made from `~~old~>new~~`.
 */
export function parseSubTail(
  text: string,
): { id: string; consumed: number } | null {
  const m = new RegExp(`^\\}\\{#(${ID})\\}`).exec(text);
  return m ? { id: m[1], consumed: m[0].length } : null;
}

/** The shared 💬 chip standing in for a comment's `==}{>>…<<}{#id}` tail. */
export function buildCommentChip(
  id: string,
  note: string,
  doc: Document,
): HTMLSpanElement {
  const el = doc.createElement("span");
  el.className = "sheaf-rfm-chip";
  el.textContent = "💬";
  // The inline note is only a preview; the real thread body lives in the
  // endmatter. Fall back to the id so a body-in-endmatter comment still names
  // itself. (Kept byte-identical to the Live Preview chip.)
  el.setAttribute("aria-label", note ? `Comment: ${note}` : `Comment ${id}`);
  el.title = note || `Sheaf comment · ${id}`;
  return el;
}

function styledSpan(doc: Document, cls: string, text: string): HTMLSpanElement {
  const el = doc.createElement("span");
  el.className = cls;
  el.textContent = text;
  return el;
}

function partToNode(part: RenderPart, doc: Document): Node {
  switch (part.kind) {
    case "text":
      return doc.createTextNode(part.text);
    case "anchor":
      return styledSpan(doc, "sheaf-rfm-anchor", part.text);
    case "ins":
      return styledSpan(doc, "sheaf-rfm-ins", part.text);
    case "del":
      return styledSpan(doc, "sheaf-rfm-del", part.text);
    case "chip":
      return buildCommentChip(part.id, part.note, doc);
  }
}

function isText(node: Node | null): node is Text {
  return node?.nodeType === Node.TEXT_NODE;
}

/**
 * Comment shape: `{`<mark>anchor</mark>`}{>>note<<}{#id}`. Replace the `<mark>`
 * with the anchor span the editor uses and swap the delimiter tail for a chip.
 */
function decorateMarkComment(mark: HTMLElement): void {
  const prev = mark.previousSibling;
  const next = mark.nextSibling;
  if (!isText(prev) || !isText(next) || !prev.data.endsWith("{")) return;
  const tail = parseCommentTail(next.data);
  if (!tail) return;
  const doc = mark.ownerDocument;
  prev.data = prev.data.slice(0, -1); // drop the opening `{`
  const anchor = doc.createElement("span");
  anchor.className = "sheaf-rfm-anchor";
  while (mark.firstChild) anchor.appendChild(mark.firstChild);
  mark.replaceWith(anchor);
  next.data = next.data.slice(tail.consumed); // drop `}{>>note<<}{#id}`
  anchor.after(buildCommentChip(tail.id, tail.note, doc));
}

/**
 * Substitution shape: `{`<del>old~>new</del>`}{#id}`. Split the strikethrough
 * on the `~>` separator into a struck old side and an underlined new side.
 */
function decorateDelSub(del: HTMLElement): void {
  const prev = del.previousSibling;
  const next = del.nextSibling;
  if (!isText(prev) || !isText(next) || !prev.data.endsWith("{")) return;
  const content = del.textContent ?? "";
  const sep = content.indexOf("~>");
  if (sep === -1) return; // a plain `~~strikethrough~~`, not a sheaf substitution
  const tail = parseSubTail(next.data);
  if (!tail) return;
  const doc = del.ownerDocument;
  prev.data = prev.data.slice(0, -1); // drop the opening `{`
  del.replaceWith(
    styledSpan(doc, "sheaf-rfm-del", content.slice(0, sep)),
    styledSpan(doc, "sheaf-rfm-ins", content.slice(sep + 2)),
  );
  next.data = next.data.slice(tail.consumed); // drop `}{#id}`
}

/** Rewrite text nodes carrying literal marker groups into styled fragments. */
function decorateTextNodes(root: HTMLElement): void {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
  for (const t of texts) {
    // Markup inside code is literal to the scanner (and to the strip pass), so
    // never inject there — it'd desync from the clean prose the server anchors.
    if (!t.data.includes("{") || t.parentElement?.closest("code, pre")) continue;
    const parts = textToParts(t.data);
    if (parts.length === 1 && parts[0].kind === "text") continue;
    const frag = doc.createDocumentFragment();
    for (const p of parts) frag.appendChild(partToNode(p, doc));
    t.replaceWith(frag);
  }
}

/**
 * Decorate one rendered markdown block (the element a markdown post-processor is
 * handed). Wrapper shapes first — they consume the `<mark>`/`<del>` siblings —
 * then the literal-text sweep over what remains. `querySelectorAll` snapshots,
 * so mutating as we go is safe.
 */
export function decorateReadingReviewMarkup(root: HTMLElement): void {
  root.querySelectorAll("mark").forEach((m) => decorateMarkComment(m));
  root.querySelectorAll("del").forEach((d) => decorateDelSub(d));
  decorateTextNodes(root);
}

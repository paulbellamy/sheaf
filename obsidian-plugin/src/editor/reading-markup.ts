import {
  scanReviewMarkup,
  splitEndmatter,
  type ReviewMarkerGroup,
} from "sheaf-server/types";

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
 *
 * Known limitations (all degrade to raw markup, never crash):
 *   - Resolved/dismissed threads keep their anchor highlight here; Live Preview
 *     drops it (it has the resolved-set plumbed in, this post-processor can't
 *     know thread status from the rendered element).
 *   - A *literal* insertion/deletion (`{++…++}`/`{--…--}`) whose text carries
 *     inline markdown splits across nodes and stays raw. Sheaf's writer only
 *     emits comments and substitutions inline, so these are hand-typed only.
 *   - Smart-punctuation/typography settings that rewrite `--` etc. can stop a
 *     literal shape from matching. Again, hand-typed only.
 */

/** The trailing `{#id}` id grammar, mirrored from the RFM scanner. */
const ID = "[A-Za-z][A-Za-z0-9_-]*";

/** Anchored, compiled once: a comment's `}{>>note<<}…{#id}` and a sub's `}{#id}`. */
const COMMENT_TAIL_RE = new RegExp(`^\\}((?:\\{>>[\\s\\S]*?<<\\})*)\\{#(${ID})\\}`);
const SUB_TAIL_RE = new RegExp(`^\\}\\{#(${ID})\\}`);
const NOTE_RE = /\{>>([\s\S]*?)<<\}/g;

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
  const m = COMMENT_TAIL_RE.exec(text);
  if (!m) return null;
  const notes = [...m[1].matchAll(NOTE_RE)].map((x) => x[1]);
  return { note: notes.join("\n\n"), id: m[2], consumed: m[0].length };
}

/**
 * Parse a substitution's post-`<del>` tail — the `}{#id}` that trails the
 * strikethrough Obsidian made from `~~old~>new~~`.
 */
export function parseSubTail(
  text: string,
): { id: string; consumed: number } | null {
  const m = SUB_TAIL_RE.exec(text);
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
 *
 * The tail can span several sibling nodes: if the note carried inline markdown
 * (`*em*`, a link) Obsidian rendered it into child elements, splitting the text
 * node. Accumulate following siblings' text until the tail parses — bailing the
 * instant the run can't be a comment tail, so a genuine `==highlight==` (whose
 * `<mark>` is followed by ordinary prose, not `}…{#id}`) is left alone.
 */
function decorateMarkComment(mark: Element): void {
  const prev = mark.previousSibling;
  if (!isText(prev) || !prev.data.endsWith("{")) return;
  const sibs: ChildNode[] = [];
  let acc = "";
  let tail: ReturnType<typeof parseCommentTail> = null;
  for (let s = mark.nextSibling; s; s = s.nextSibling) {
    sibs.push(s);
    acc += s.textContent ?? "";
    if (acc.length > 0 && !acc.startsWith("}")) return; // not a comment tail
    tail = parseCommentTail(acc);
    if (tail) break;
  }
  if (!tail) return;
  const doc = mark.ownerDocument;
  prev.data = prev.data.slice(0, -1); // drop the opening `{`
  const anchor = doc.createElement("span");
  anchor.className = "sheaf-rfm-anchor";
  while (mark.firstChild) anchor.appendChild(mark.firstChild);
  mark.replaceWith(anchor);
  // Drop the consumed tail: fully-consumed siblings go; the boundary node (a
  // text node — the tail's delimiters are plain text) keeps its post-tail rest.
  let consumed = tail.consumed;
  for (const s of sibs) {
    const len = s.textContent?.length ?? 0;
    if (consumed >= len) {
      consumed -= len;
      s.remove();
    } else {
      if (isText(s)) s.data = s.data.slice(consumed);
      else s.remove();
      break;
    }
  }
  anchor.after(buildCommentChip(tail.id, tail.note, doc));
}

/**
 * Substitution shape: `{`<del>old~>new</del>`}{#id}` (the strikethrough element
 * is `<del>` or, depending on the renderer, `<s>`). Split it on the `~>`
 * separator into a struck old side and an underlined new side. Reading
 * `textContent` flattens any inline markdown in the old/new text, so a
 * formatted replacement still resolves (it renders as plain text).
 */
function decorateDelSub(del: Element): void {
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

/** Minimal shape of Obsidian's `MarkdownPostProcessorContext` we consume. */
export interface SectionInfoProvider {
  getSectionInfo(
    el: HTMLElement,
  ): { text: string; lineStart: number; lineEnd: number } | null;
}

// The endmatter boundary is a whole-doc computation; consecutive blocks in a
// render pass share the same source string, so memoize the last one.
let memoText: string | null = null;
let memoBodyLines = 0;
function bodyLineCount(text: string): number {
  if (text !== memoText) {
    memoText = text;
    memoBodyLines = splitEndmatter(text).body.split("\n").length;
  }
  return memoBodyLines;
}

/**
 * Decorate one rendered markdown block (the element a markdown post-processor is
 * handed). Wrapper shapes first — they consume the `<mark>`/`<del>`/`<s>`
 * siblings — then the literal-text sweep over what remains. `querySelectorAll`
 * snapshots, so mutating as we go is safe.
 *
 * `ctx` lets us skip blocks that render the doc's `\n---\n<yaml>` review
 * endmatter — its thread bodies aren't prose to decorate. Mirrors the CM6 path,
 * which scans only `splitEndmatter(doc).body`. When section info is missing
 * (some render contexts return null) we decorate anyway — no worse than before.
 */
export function decorateReadingReviewMarkup(
  root: HTMLElement,
  ctx?: SectionInfoProvider,
): void {
  const info = ctx?.getSectionInfo(root);
  if (info && info.lineStart >= bodyLineCount(info.text)) return;
  root.querySelectorAll("mark").forEach((m) => decorateMarkComment(m));
  root.querySelectorAll("del, s").forEach((d) => decorateDelSub(d));
  decorateTextNodes(root);
}

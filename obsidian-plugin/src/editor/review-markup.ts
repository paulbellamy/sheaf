import { editorLivePreviewField } from "obsidian";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
} from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import type { Range } from "@codemirror/state";
import {
  scanReviewMarkup,
  splitEndmatter,
  type ReviewMarkerGroup,
} from "sheaf-server/types";

/**
 * Live-Preview rendering for sheaf's inline RFM review markup. A sheaf note
 * stores comments and suggested changes as CriticMarkup spans right in the
 * prose — `{==anchor==}{>>note<<}{#c1}`, `{~~old~>new~~}{#s1}`, and friends
 * (see `docs/roughdraft-review-markup.md`). Raw, those delimiters are noise;
 * this CM6 extension hides the syntax and paints the parts:
 *
 *   - comment  → the anchor text highlighted, a 💬 chip standing in for the
 *                `{>>…<<}{#id}` tail (its title previews the inline note).
 *   - insertion/substitution → proposed text underlined; replaced text struck.
 *   - deletion → struck-through.
 *
 * The whole group reveals its raw bytes the moment the selection touches it, so
 * the markup stays directly editable — the same affordance Obsidian's own Live
 * Preview gives links and formatting. Source mode is left untouched.
 *
 * The parse (`scanReviewMarkup`) is the server's own RFM scanner, so what we
 * decorate is exactly what the backend treats as a marker group — markup inside
 * code spans/fences stays literal, and hand-typed CriticMarkup with no `{#id}`
 * terminator is left alone.
 */

/** Stand-in chip for a comment's `==}{>>…<<}{#id}` tail. */
class CommentChipWidget extends WidgetType {
  constructor(
    private readonly id: string,
    private readonly note: string,
  ) {
    super();
  }

  eq(other: CommentChipWidget): boolean {
    return other.id === this.id && other.note === this.note;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "sheaf-rfm-chip";
    el.textContent = "💬";
    // The inline note is only a preview; the real thread body lives in the
    // endmatter and is shown in the threads panel. Fall back to the id so a
    // body-in-endmatter comment (sheaf's own writer) still names itself.
    el.setAttribute(
      "aria-label",
      this.note ? `Comment: ${this.note}` : `Comment ${this.id}`,
    );
    el.title = this.note || `Sheaf comment · ${this.id}`;
    return el;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

const HIDDEN = Decoration.replace({});

/**
 * Decorations for one marker group, or null to skip it. Order within the array
 * doesn't matter — the caller sorts.
 *
 * `doc` is the full document text: a *replacing* decoration provided by a view
 * plugin may not span a line break (CM6 throws), so any group whose hidden
 * (delimiter/tail) range crosses a newline — e.g. a hand-authored multi-line
 * `{>>note<<}` — is skipped and left raw. Marks (the anchor/edit text) may span
 * lines freely, so a highlight over a multi-paragraph anchor still renders.
 */
function decorateGroup(
  g: ReviewMarkerGroup,
  doc: string,
): Range<Decoration>[] | null {
  const out: Range<Decoration>[] = [];
  let crossesLine = false;
  const hide = (from: number, to: number, deco: Decoration = HIDDEN): void => {
    if (to <= from) return;
    if (doc.lastIndexOf("\n", to - 1) >= from) crossesLine = true;
    out.push(deco.range(from, to));
  };
  const mark = (from: number, to: number, cls: string): void => {
    if (to > from) out.push(Decoration.mark({ class: cls }).range(from, to));
  };

  switch (g.kind) {
    case "comment":
      hide(g.start, g.keptStart); // `{==`
      mark(g.keptStart, g.keptEnd, "sheaf-rfm-anchor");
      hide(
        g.keptEnd,
        g.end, // `==}{>>…<<}{#id}` → 💬
        Decoration.replace({ widget: new CommentChipWidget(g.id, g.comment) }),
      );
      break;
    case "deletion":
      hide(g.start, g.keptStart); // `{--`
      mark(g.keptStart, g.keptEnd, "sheaf-rfm-del");
      hide(g.keptEnd, g.end); // `--}{#id}`
      break;
    case "insertion":
      hide(g.start, g.newStart ?? g.keptStart); // `{++`
      mark(g.newStart ?? g.keptEnd, g.newEnd ?? g.keptEnd, "sheaf-rfm-ins");
      hide(g.newEnd ?? g.keptEnd, g.end); // `++}{#id}`
      break;
    case "substitution":
      hide(g.start, g.keptStart); // `{~~`
      mark(g.keptStart, g.keptEnd, "sheaf-rfm-del"); // old side
      hide(g.keptEnd, g.newStart ?? g.keptEnd); // `~>`
      mark(g.newStart ?? g.keptEnd, g.newEnd ?? g.keptEnd, "sheaf-rfm-ins");
      hide(g.newEnd ?? g.keptEnd, g.end); // `~~}{#id}`
      break;
  }
  return crossesLine ? null : out;
}

function buildDecorations(view: EditorView): DecorationSet {
  // Live Preview only — Source mode is the user's escape hatch to raw bytes.
  // `field(…, false)` returns undefined when the field is absent (non-Obsidian
  // hosts / tests); treat that as "not live preview" and decorate nothing.
  if (!view.state.field(editorLivePreviewField, false)) return Decoration.none;

  const doc = view.state.doc.toString();
  // Marker groups only ever live in the body; skip the YAML endmatter tail so
  // its `comments:`/`suggestions:` text is never mistaken for prose to style.
  const bodyLen = splitEndmatter(doc).body.length;

  const sel = view.state.selection;
  const touchesSelection = (from: number, to: number): boolean =>
    sel.ranges.some((r) => r.from <= to && r.to >= from);

  const ranges: Range<Decoration>[] = [];
  for (const g of scanReviewMarkup(doc.slice(0, bodyLen))) {
    // Reveal the raw markup while the caret/selection is on it, so the group
    // stays editable — same as Obsidian LP unfolding a link you click into.
    if (touchesSelection(g.start, g.end)) continue;
    const decos = decorateGroup(g, doc);
    if (decos) ranges.push(...decos);
  }
  // `true` = let CM sort; replace + mark ranges are disjoint but interleaved.
  return Decoration.set(ranges, true);
}

/**
 * The editor extension. Register once (see main.ts) alongside the flash field.
 * Rebuilds on edits, viewport moves, and selection changes (the last so the
 * reveal-on-caret behaviour tracks the cursor).
 */
export const reviewMarkupExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(u: ViewUpdate): void {
      if (
        u.docChanged ||
        u.viewportChanged ||
        u.selectionSet ||
        u.startState.field(editorLivePreviewField, false) !==
          u.state.field(editorLivePreviewField, false)
      ) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/**
 * Inject the review-markup CSS. Mirrors `mountFlashStyles` (flash.ts): the
 * plugin ships as a drop-in `main.js` + `manifest.json` with no separate
 * `styles.css`, so styles are mounted from code. Returns a disposer.
 */
export function mountReviewMarkupStyles(): () => void {
  const style = document.createElement("style");
  style.textContent = `
.sheaf-rfm-anchor {
  background-color: var(--text-highlight-bg, rgba(255, 208, 0, 0.28));
  border-radius: 2px;
  padding: 0 1px;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
}
.sheaf-rfm-chip {
  font-size: 0.85em;
  vertical-align: baseline;
  margin: 0 1px 0 2px;
  cursor: help;
  opacity: 0.85;
  user-select: none;
}
.sheaf-rfm-chip:hover {
  opacity: 1;
}
.sheaf-rfm-ins {
  color: var(--color-green, #2e7d32);
  text-decoration: underline;
  text-decoration-color: var(--color-green, #2e7d32);
  text-underline-offset: 2px;
}
.sheaf-rfm-del {
  color: var(--color-red, #c62828);
  text-decoration: line-through;
  text-decoration-color: var(--color-red, #c62828);
  opacity: 0.85;
}`;
  document.head.appendChild(style);
  return () => style.remove();
}

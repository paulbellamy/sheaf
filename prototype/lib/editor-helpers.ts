import { Extension } from "@tiptap/core";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { MarkType, Node as PMNode } from "@tiptap/pm/model";
import { liftListItem, sinkListItem } from "@tiptap/pm/schema-list";

export type MarkdownTrigger =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6 }
  | { kind: "bulletList" }
  | { kind: "orderedList" }
  | { kind: "blockquote" }
  | { kind: "codeBlock"; language: string | null };

export function detectMarkdownTrigger(
  doc: PMNode,
  from: number,
  text: string,
): MarkdownTrigger | null {
  if (text !== " ") return null;

  const $from = doc.resolve(from);
  const block = $from.parent;
  if (block.type.name !== "paragraph") return null;

  const blockStart = $from.start();
  const before = block.textBetween(0, from - blockStart, "\n", "\n");

  const hashes = before.match(/^(#{1,6})$/);
  if (hashes) {
    const level = hashes[1].length as 1 | 2 | 3 | 4 | 5 | 6;
    return { kind: "heading", level };
  }
  if (/^[-*+]$/.test(before)) return { kind: "bulletList" };
  if (/^\d+\.$/.test(before)) return { kind: "orderedList" };
  if (/^>$/.test(before)) return { kind: "blockquote" };
  const code = before.match(/^```([a-z]*)$/i);
  if (code) {
    return { kind: "codeBlock", language: code[1] ? code[1].toLowerCase() : null };
  }
  return null;
}

export function structuralLabelFor(trigger: MarkdownTrigger): string {
  switch (trigger.kind) {
    case "heading":
      return `¶ → H${trigger.level}`;
    case "bulletList":
      return "¶ → bullet list";
    case "orderedList":
      return "¶ → numbered list";
    case "blockquote":
      return "¶ → blockquote";
    case "codeBlock":
      return `¶ → code block${trigger.language ? ` (${trigger.language})` : ""}`;
  }
}

export const MAX_INDENT = 6;

export const BlockIndent = Extension.create({
  name: "blockIndent",
  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: {
          indent: {
            default: 0,
            parseHTML: (el) =>
              parseInt(el.getAttribute("data-indent") ?? "0", 10) || 0,
            renderHTML: (attrs) => {
              const v = (attrs as { indent?: number }).indent ?? 0;
              return v > 0 ? { "data-indent": String(v) } : {};
            },
          },
        },
      },
    ];
  },
});

export function tryIndent(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  direction: "in" | "out",
): boolean {
  const li = state.schema.nodes.listItem;
  if (li) {
    const cmd = direction === "out" ? liftListItem(li) : sinkListItem(li);
    if (cmd(state, dispatch)) return true;
  }
  const $from = state.selection.$from;
  const block = $from.parent;
  if (!["paragraph", "heading"].includes(block.type.name)) return false;
  const current = (block.attrs.indent as number | undefined) ?? 0;
  const next =
    direction === "out"
      ? Math.max(0, current - 1)
      : Math.min(MAX_INDENT, current + 1);
  if (next === current) return false;
  if (dispatch) {
    const before = $from.before();
    const tr = state.tr.setNodeMarkup(before, null, {
      ...block.attrs,
      indent: next,
    });
    dispatch(tr);
  }
  return true;
}

// Walk outward from `pos` in each direction. A mark is "contiguous" if we
// encounter it before we cross any unmarked text. Block boundaries (closing
// </p>, opening <li>, etc.) are transparent — they do not break contiguity,
// so edits spanning adjacent paragraphs or list items collapse into one
// thread.
export function findContiguousThreadId(
  doc: PMNode,
  pos: number,
  types: MarkType[],
): string | null {
  const walk = (direction: -1 | 1): string | null => {
    let p = pos;
    const limit = direction === -1 ? 0 : doc.content.size;
    while (p !== limit) {
      const $p = doc.resolve(p);
      const node = direction === -1 ? $p.nodeBefore : $p.nodeAfter;
      if (node && node.isText) {
        for (const m of node.marks) {
          if (types.includes(m.type) && typeof m.attrs.threadId === "string") {
            return m.attrs.threadId;
          }
        }
        return null;
      }
      p += direction;
    }
    return null;
  };
  return walk(-1) ?? walk(1);
}

// Formatting marks tracked as structural diffs against the baseline document.
// Keyed by the mark's schema name; value is the label shown in the margin.
// Order matters — it's the bit position used by the Uint8Array encoding.
export const TRACKED_FORMATTING_MARKS: Record<string, string> = {
  bold: "bold",
  italic: "italic",
  underline: "underline",
  strike: "strikethrough",
  code: "inline code",
};

const TRACKED_MARK_NAMES = Object.keys(TRACKED_FORMATTING_MARKS);
const TRACKED_MARK_BITS: Record<string, number> = Object.fromEntries(
  TRACKED_MARK_NAMES.map((name, i) => [name, 1 << i]),
);

export type MarkDiff = { label: string; range: { from: number; to: number } };

/**
 * Flatten a doc into a per-character Uint8Array where each byte is a bitmask
 * of the tracked formatting marks active at that character. Bit positions
 * line up with TRACKED_MARK_NAMES. When `skipProposedInsertion` is true,
 * characters belonging to a proposedInsertion are dropped entirely — this
 * lets us line up the baseline (original) doc against the current doc even
 * after the user has typed new text.
 */
export function collectFormattingTokens(
  doc: PMNode,
  skipProposedInsertion: boolean,
): Uint8Array {
  // Upper bound: total character count in the doc.
  const capacity = doc.textContent.length || doc.content.size;
  const buf = new Uint8Array(capacity);
  let n = 0;
  doc.descendants((node) => {
    if (!node.isText) return true;
    let mask = 0;
    let skip = false;
    for (const m of node.marks) {
      if (skipProposedInsertion && m.type.name === "proposedInsertion") {
        skip = true;
        break;
      }
      const bit = TRACKED_MARK_BITS[m.type.name];
      if (bit !== undefined) mask |= bit;
    }
    if (skip) return true;
    const text = node.text ?? "";
    const len = text.length;
    if (n + len > buf.length) {
      // defensive resize — shouldn't happen given `capacity`, but safe
      const next = new Uint8Array((n + len) * 2);
      next.set(buf);
      (buf as Uint8Array).set(next.subarray(0, buf.length));
    }
    for (let i = 0; i < len; i++) buf[n + i] = mask;
    n += len;
    return true;
  });
  return buf.subarray(0, n);
}

// Diff two token streams (baseline vs. current without pending insertions).
// Ranges are token-index positions; used purely to uniquely key the diff for
// the margin rail, not to anchor to DOM positions.
export function diffFormattingTokens(
  baseline: Uint8Array,
  current: Uint8Array,
): MarkDiff[] {
  const diffs: MarkDiff[] = [];
  const len = Math.min(baseline.length, current.length);
  for (let i = 0; i < TRACKED_MARK_NAMES.length; i++) {
    const markName = TRACKED_MARK_NAMES[i];
    const bit = 1 << i;
    const label = TRACKED_FORMATTING_MARKS[markName];
    let start: number | null = null;
    let prev: number | null = null;
    for (let p = 0; p < len; p++) {
      const differ = (baseline[p] & bit) !== (current[p] & bit);
      if (differ) {
        if (start === null) {
          start = p;
          prev = p;
        } else if (p === (prev as number) + 1) {
          prev = p;
        } else {
          diffs.push({ label, range: { from: start, to: (prev as number) + 1 } });
          start = p;
          prev = p;
        }
      }
    }
    if (start !== null) {
      diffs.push({ label, range: { from: start, to: (prev as number) + 1 } });
    }
  }
  return diffs;
}

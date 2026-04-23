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
export const TRACKED_FORMATTING_MARKS: Record<string, string> = {
  bold: "bold",
  italic: "italic",
  underline: "underline",
  strike: "strikethrough",
  code: "inline code",
};

export type MarkDiff = { label: string; range: { from: number; to: number } };

// Flatten a doc into a per-character array where each entry carries the set
// of tracked formatting marks active at that character. When
// `skipProposedInsertion` is true, characters belonging to a proposedInsertion
// are dropped entirely — this lets us line up the baseline (original) doc
// against the current doc even after the user has typed new text: what's left
// after stripping insertions should have the same length as the baseline.
export function collectFormattingTokens(
  doc: PMNode,
  skipProposedInsertion: boolean,
): Array<Set<string>> {
  const tokens: Array<Set<string>> = [];
  doc.descendants((node) => {
    if (!node.isText) return true;
    const isProposedIns = node.marks.some(
      (m) => m.type.name === "proposedInsertion",
    );
    if (skipProposedInsertion && isProposedIns) return true;
    const markSet = new Set<string>();
    for (const m of node.marks) {
      if (TRACKED_FORMATTING_MARKS[m.type.name]) markSet.add(m.type.name);
    }
    const text = node.text ?? "";
    for (let i = 0; i < text.length; i++) tokens.push(new Set(markSet));
    return true;
  });
  return tokens;
}

// Diff two equal-length token streams (baseline vs. current without pending
// insertions). Ranges are token-index positions; they're used purely to
// uniquely key the diff for the margin rail, not to anchor to DOM positions.
export function diffFormattingTokens(
  baseline: Array<Set<string>>,
  current: Array<Set<string>>,
): MarkDiff[] {
  const diffs: MarkDiff[] = [];
  const len = Math.min(baseline.length, current.length);
  for (const markName of Object.keys(TRACKED_FORMATTING_MARKS)) {
    const label = TRACKED_FORMATTING_MARKS[markName];
    const changed: number[] = [];
    for (let i = 0; i < len; i++) {
      if (baseline[i].has(markName) !== current[i].has(markName)) changed.push(i);
    }
    let start: number | null = null;
    let prev: number | null = null;
    for (const p of changed) {
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
    if (start !== null) {
      diffs.push({ label, range: { from: start, to: (prev as number) + 1 } });
    }
  }
  return diffs;
}

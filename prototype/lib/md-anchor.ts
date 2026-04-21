import type { Editor } from "@tiptap/react";

/**
 * Map a ProseMirror selection to a char range in the source markdown.
 *
 * The manuscript is loaded as md -> HTML (via marked) -> PM; we don't have a
 * reverse serializer, so we anchor by text content: pull the PM text between
 * `from` and `to`, locate it in the original md, and return that range.
 *
 * When the selected text appears multiple times in the md, we pick the
 * occurrence closest to the PM position (measured in text length up to
 * `from`). That's an approximation — PM positions include node boundaries
 * that md doesn't — but it's stable enough for anchoring threads.
 *
 * Returns null when the selection is empty or the text can't be located.
 */
export type Anchor = {
  char_range: { from: number; to: number };
  anchored_text: string;
};

export function rangeToAnchor(
  editor: Editor,
  md: string,
  from: number,
  to: number,
): Anchor | null {
  if (from >= to) return null;
  const text = editor.state.doc.textBetween(from, to, "\n", "\n");
  if (!text) return null;
  const hint = editor.state.doc.textBetween(0, from, "\n", "\n").length;
  const occurrences: number[] = [];
  for (let i = md.indexOf(text); i !== -1; i = md.indexOf(text, i + 1)) {
    occurrences.push(i);
  }
  if (occurrences.length === 0) return null;
  const best = occurrences.reduce((a, b) =>
    Math.abs(a - hint) <= Math.abs(b - hint) ? a : b,
  );
  return {
    char_range: { from: best, to: best + text.length },
    anchored_text: text,
  };
}

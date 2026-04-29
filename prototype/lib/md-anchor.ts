import type { Editor } from "@tiptap/react";

/**
 * Map a ProseMirror selection to a char range in the source markdown.
 *
 * The manuscript is loaded md -> HTML (via marked) -> PM; we have no reverse
 * serializer, so we anchor by text content. The selection's text content
 * rarely matches the md exactly — list markers, fence languages, and
 * blockquote prefixes live in md but not in PM — so we fall back through
 * progressively shorter snippets before giving up and anchoring by estimated
 * position.
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
): Anchor {
  const hint = editor.state.doc.textBetween(0, from, "\n", "\n").length;
  if (from >= to) {
    const clamp = Math.min(hint, md.length);
    return { char_range: { from: clamp, to: clamp }, anchored_text: "" };
  }

  const selection = editor.state.doc.textBetween(from, to, "\n", "\n");
  const candidates = buildCandidates(selection);

  for (const needle of candidates) {
    const hit = findNearest(md, needle, hint);
    if (hit >= 0) {
      return {
        char_range: { from: hit, to: hit + needle.length },
        anchored_text: needle,
      };
    }
  }

  // Nothing matched — anchor a zero-width range at the estimated offset so
  // the thread still persists. The backend stores the note body regardless.
  const clamp = Math.min(hint, md.length);
  return { char_range: { from: clamp, to: clamp }, anchored_text: "" };
}

function buildCandidates(selection: string): string[] {
  const out = new Set<string>();
  const trimmed = selection.trim();
  if (trimmed) out.add(trimmed);
  const firstLine = trimmed.split("\n")[0]?.trim();
  if (firstLine) out.add(firstLine);
  const firstSentence = firstLine?.match(/^[^.!?]+[.!?]?/)?.[0]?.trim();
  if (firstSentence) out.add(firstSentence);
  return [...out].filter((s) => s.length >= 2);
}

function findNearest(md: string, needle: string, hint: number): number {
  const positions: number[] = [];
  for (let i = md.indexOf(needle); i !== -1; i = md.indexOf(needle, i + 1)) {
    positions.push(i);
  }
  if (positions.length === 0) return -1;
  return positions.reduce((a, b) =>
    Math.abs(a - hint) <= Math.abs(b - hint) ? a : b,
  );
}

/**
 * Inverse of {@link rangeToAnchor}: locate `anchoredText` inside the live PM
 * doc and return PM positions for it. Used when hydrating server-persisted
 * threads, whose stored char offsets are MD-relative and cannot be used
 * directly with `editor.view.coordsAtPos`.
 *
 * `hintCharPos` is the MD char offset stored on the server; we project it
 * into a PM-position hint by scaling against doc lengths and pick the match
 * closest to that hint when there are multiple occurrences of the text.
 */
export function anchorToRange(
  editor: Editor,
  anchoredText: string,
  hintCharPos: number,
): { from: number; to: number } | null {
  if (!anchoredText) return null;
  const doc = editor.state.doc;
  const fullText = doc.textBetween(0, doc.content.size, "\n", "\n");
  if (!fullText.length) return null;
  const ratio = fullText.length > 0 ? hintCharPos / fullText.length : 0;
  const hintPmPos = Math.round(ratio * doc.content.size);

  const matches: { from: number; to: number }[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const text = node.text;
    let idx = text.indexOf(anchoredText);
    while (idx !== -1) {
      matches.push({
        from: pos + idx,
        to: pos + idx + anchoredText.length,
      });
      idx = text.indexOf(anchoredText, idx + 1);
    }
  });
  if (matches.length === 0) return null;
  return matches.reduce((a, b) =>
    Math.abs(a.from - hintPmPos) <= Math.abs(b.from - hintPmPos) ? a : b,
  );
}

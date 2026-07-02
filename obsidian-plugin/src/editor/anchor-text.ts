/**
 * Text-based anchoring for reading (preview) mode. Reading mode has no
 * CodeMirror editor to hand us character offsets, so we take the rendered DOM
 * selection and locate it back in the doc's clean prose. Pure string helpers,
 * no DOM — so they're unit-testable and shared out of `main.ts`.
 */

const RE_SPECIAL = /[.*+?^${}()|[\]\\]/g;

function escapeRegExp(s: string): string {
  return s.replace(RE_SPECIAL, "\\$&");
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function commonSuffixLen(a: string, b: string): number {
  let i = 0;
  while (
    i < a.length &&
    i < b.length &&
    a[a.length - 1 - i] === b[b.length - 1 - i]
  ) {
    i++;
  }
  return i;
}

/**
 * Locate `text` (a rendered selection) in `clean` (clean prose), tolerant of
 * whitespace differences between the rendered DOM and the source. Returns a
 * clean-prose char range, or null if the text isn't found as one contiguous run
 * (e.g. the selection crossed a block boundary). When it occurs more than once,
 * `before` — the rendered text preceding the selection in its block — picks the
 * closest match.
 */
export function locateSelection(
  clean: string,
  text: string,
  before: string,
): { from: number; to: number } | null {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const re = new RegExp(tokens.map(escapeRegExp).join("\\s+"), "g");
  const matches: { from: number; to: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    matches.push({ from: m.index, to: m.index + m[0].length });
    if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width
  }
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  const nb = normalizeWs(before);
  let best = matches[0];
  let bestScore = -1;
  for (const mt of matches) {
    const pre = normalizeWs(
      clean.slice(Math.max(0, mt.from - nb.length - 8), mt.from),
    );
    const score = commonSuffixLen(pre, nb);
    if (score > bestScore) {
      bestScore = score;
      best = mt;
    }
  }
  return best;
}

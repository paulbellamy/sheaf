/**
 * The smallest single-range replacement that turns `old` into `next`, found by
 * trimming the shared prefix and suffix. Returns null when they're identical.
 *
 * Applied to a CodeMirror editor as one change, this leaves every offset
 * *outside* `[from, to)` untouched, so a cursor or scroll position elsewhere in
 * the doc maps straight through — the whole point of using it instead of a
 * full-buffer replace, which would collapse the cursor onto the change and yank
 * the viewport to it (the agent-edit scroll jump this fixes).
 */
export interface TextEdit {
  /** Start offset of the replaced range in `old`. */
  from: number;
  /** End offset of the replaced range in `old`. */
  to: number;
  /** Text to insert in place of `[from, to)`. */
  text: string;
}

export function minimalEdit(old: string, next: string): TextEdit | null {
  if (old === next) return null;

  // Longest shared prefix.
  const maxScan = Math.min(old.length, next.length);
  let prefix = 0;
  while (prefix < maxScan && old[prefix] === next[prefix]) prefix++;

  // Longest shared suffix, capped so it can't reach back past the prefix on
  // either string (matters when the same char repeats around the change, e.g.
  // "aaa" → "aa").
  const maxSuffix = maxScan - prefix;
  let suffix = 0;
  while (
    suffix < maxSuffix &&
    old[old.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix++;
  }

  return {
    from: prefix,
    to: old.length - suffix,
    text: next.slice(prefix, next.length - suffix),
  };
}

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * Roughdraft Flavored Markdown (RFM) — a pure, domain-agnostic codec for the
 * review-markup style sheaf borrows from Lex-Inc/roughdraft (see
 * `docs/roughdraft-review-markup.md`). It knows nothing about sheaf threads:
 * the backend treats the YAML endmatter as the authoritative store and the
 * inline CriticMarkup spans as a regenerated projection, so this layer never
 * parses data back out of the markers.
 */

/* ----------------------------------------------------------- code scanning -- */

interface FenceState {
  marker: "`" | "~";
  length: number;
}

function isLineStart(md: string, offset: number): boolean {
  return offset === 0 || md[offset - 1] === "\n";
}

function nextLineOffset(md: string, offset: number): number {
  const nl = md.indexOf("\n", offset);
  return nl === -1 ? md.length : nl + 1;
}

function matchFence(
  md: string,
  offset: number,
  fence: FenceState | null,
): { fence: FenceState } | null {
  const lineEnd = nextLineOffset(md, offset);
  const line = md.slice(offset, lineEnd).replace(/\r?\n$/, "");
  const m = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
  if (!m) return null;
  const markerText = m[1] ?? "";
  const marker = markerText[0] as "`" | "~";
  if (!fence) return { fence: { marker, length: markerText.length } };
  if (fence.marker !== marker || markerText.length < fence.length) return null;
  return { fence };
}

/** Closing backtick run must match the opener's length (CommonMark). */
function matchInlineCodeSpan(md: string, offset: number): number | null {
  if (md[offset] !== "`") return null;
  let length = 1;
  while (md[offset + length] === "`") length += 1;
  const closing = md.indexOf("`".repeat(length), offset + length);
  return closing === -1 ? null : closing + length;
}

const ID_REF_RE = /^\{#[A-Za-z][A-Za-z0-9_-]*\}/;

function matchIdRef(md: string, offset: number): number | null {
  if (md[offset] !== "{" || md[offset + 1] !== "#") return null;
  const m = md.slice(offset, offset + 96).match(ID_REF_RE);
  return m ? offset + m[0].length : null;
}

/** The four sheaf-injected marker shapes, keyed by their opening delimiter. */
export type ReviewMarkerKind =
  | "comment" // {==anchor==}{>>note<<}…{#id}
  | "insertion" // {++new++}{#id}
  | "deletion" // {--old--}{#id}
  | "substitution"; // {~~old~>new~~}{#id}

/**
 * A fully-parsed marker group — the structure a renderer needs to hide the
 * delimiters and style the parts. All fields are byte offsets into the same
 * body string. `[keptStart, keptEnd)` is the clean-prose projection (what
 * `stripInlineMarkup` keeps); `[newStart, newEnd)` is the proposed text an
 * insertion/substitution introduces (null for comment/deletion). `comment` is
 * the joined inline `{>>…<<}` note text (empty when a comment's body lives only
 * in the endmatter, as sheaf's own writer emits).
 */
export interface ReviewMarkerGroup {
  kind: ReviewMarkerKind;
  /** Offset of the opening `{`. */
  start: number;
  /** Offset just past the closing `{#id}`. */
  end: number;
  /** Document-local id from the trailing `{#id}`. */
  id: string;
  keptStart: number;
  keptEnd: number;
  comment: string;
  newStart: number | null;
  newEnd: number | null;
}

/**
 * Parse a complete sheaf-injected marker group at `offset` into its full
 * structure, or return null if `offset` doesn't begin one. Every marker sheaf
 * renders ends in a `{#id}`; requiring that terminator is what leaves
 * hand-typed CriticMarkup (a bare `{==x==}` with no id) literal.
 */
function parseMarkerGroup(
  body: string,
  offset: number,
): ReviewMarkerGroup | null {
  const idAt = (pos: number): { id: string; end: number } | null => {
    const end = matchIdRef(body, pos);
    // `{#id}` → strip the `{#` prefix and `}` suffix to get the bare id.
    return end === null ? null : { id: body.slice(pos + 2, end - 1), end };
  };

  if (body.startsWith("{==", offset)) {
    const close = body.indexOf("==}", offset + 3);
    if (close === -1) return null;
    let pos = close + 3;
    const notes: string[] = [];
    while (body.startsWith("{>>", pos)) {
      const c = body.indexOf("<<}", pos + 3);
      if (c === -1) return null;
      notes.push(body.slice(pos + 3, c));
      pos = c + 3;
    }
    const ref = idAt(pos);
    if (!ref) return null;
    return {
      kind: "comment",
      start: offset,
      end: ref.end,
      id: ref.id,
      keptStart: offset + 3,
      keptEnd: close,
      comment: notes.join("\n\n"),
      newStart: null,
      newEnd: null,
    };
  }
  if (body.startsWith("{~~", offset)) {
    const sep = body.indexOf("~>", offset + 3);
    const close = sep === -1 ? -1 : body.indexOf("~~}", sep + 2);
    if (sep === -1 || close === -1) return null;
    const ref = idAt(close + 3);
    if (!ref) return null;
    // keep the old side; the new side is the proposed replacement
    return {
      kind: "substitution",
      start: offset,
      end: ref.end,
      id: ref.id,
      keptStart: offset + 3,
      keptEnd: sep,
      comment: "",
      newStart: sep + 2,
      newEnd: close,
    };
  }
  if (body.startsWith("{++", offset)) {
    const close = body.indexOf("++}", offset + 3);
    if (close === -1) return null;
    const ref = idAt(close + 3);
    if (!ref) return null;
    // drop: a pending insertion isn't in the doc yet (empty kept range)
    return {
      kind: "insertion",
      start: offset,
      end: ref.end,
      id: ref.id,
      keptStart: offset + 3,
      keptEnd: offset + 3,
      comment: "",
      newStart: offset + 3,
      newEnd: close,
    };
  }
  if (body.startsWith("{--", offset)) {
    const close = body.indexOf("--}", offset + 3);
    if (close === -1) return null;
    const ref = idAt(close + 3);
    if (!ref) return null;
    // keep: a pending deletion is still in the doc
    return {
      kind: "deletion",
      start: offset,
      end: ref.end,
      id: ref.id,
      keptStart: offset + 3,
      keptEnd: close,
      comment: "",
      newStart: null,
      newEnd: null,
    };
  }
  return null;
}

/**
 * Match a complete sheaf-injected marker group at `offset`, returning just the
 * clean-text (`[keptStart, keptEnd)`, the "as-is" projection) and the group's
 * end — the minimal shape the strip/offset-mapping pass needs. Delegates to
 * `parseMarkerGroup` so the delimiter grammar has a single definition.
 */
function matchMarkerGroup(
  body: string,
  offset: number,
): { keptStart: number; keptEnd: number; end: number } | null {
  const g = parseMarkerGroup(body, offset);
  return g ? { keptStart: g.keptStart, keptEnd: g.keptEnd, end: g.end } : null;
}

/**
 * One contiguous run of the body. `[start, end)` is the raw span; `[keptStart,
 * keptEnd)` is its clean-prose projection (the whole span for text/code, the
 * kept sub-range for a marker group). `code` marks inline/fenced code, which
 * `renderInlineMarkers` must never inject into.
 *
 * A single left-to-right pass tokenizes the body once; strip, code-range, and
 * offset-mapping all consume the same segments, so those three views can't
 * drift out of agreement and re-break the round-trip. The scan bulk-skips
 * ordinary prose and jumps past an unclosable backtick run in one step, so a
 * doc that is mostly backticks no longer costs O(n²).
 */
interface Segment {
  start: number;
  end: number;
  keptStart: number;
  keptEnd: number;
  code: boolean;
}

function scanSegments(body: string): Segment[] {
  const segs: Segment[] = [];
  const n = body.length;
  let offset = 0;
  let textStart = 0;
  let fence: FenceState | null = null;
  let fenceStart = 0;

  const flushText = (upto: number): void => {
    if (upto > textStart) {
      segs.push({
        start: textStart,
        end: upto,
        keptStart: textStart,
        keptEnd: upto,
        code: false,
      });
    }
  };

  while (offset < n) {
    if (isLineStart(body, offset)) {
      const fm = matchFence(body, offset, fence);
      if (fm) {
        const end = nextLineOffset(body, offset);
        if (fence) {
          // Closing fence: emit the whole run as one code segment.
          segs.push({
            start: fenceStart,
            end,
            keptStart: fenceStart,
            keptEnd: end,
            code: true,
          });
          textStart = end;
          fence = null;
        } else {
          flushText(offset);
          fence = fm.fence;
          fenceStart = offset;
        }
        offset = end;
        continue;
      }
    }
    if (fence) {
      offset = nextLineOffset(body, offset);
      continue;
    }
    if (body[offset] === "`") {
      const cs = matchInlineCodeSpan(body, offset);
      if (cs !== null) {
        flushText(offset);
        segs.push({ start: offset, end: cs, keptStart: offset, keptEnd: cs, code: true });
        textStart = cs;
        offset = cs;
        continue;
      }
      // No matching close — the whole maximal backtick run is literal text.
      // Skip it in one step (not char-by-char) so we never re-scan the run.
      let run = offset + 1;
      while (run < n && body[run] === "`") run += 1;
      offset = run;
      continue;
    }
    if (body[offset] === "{") {
      const group = matchMarkerGroup(body, offset);
      if (group) {
        flushText(offset);
        segs.push({
          start: offset,
          end: group.end,
          keptStart: group.keptStart,
          keptEnd: group.keptEnd,
          code: false,
        });
        textStart = group.end;
        offset = group.end;
        continue;
      }
      offset += 1;
      continue;
    }
    // Ordinary prose: advance to the next char that could begin a segment (a
    // backtick or brace) or the first char of the next line (a fence candidate).
    // A manual scan visits each prose char at most once, so the whole tokenize
    // stays O(n). `indexOf` here would re-scan to EOF on every newline-free
    // line, turning a doc full of tiny inline-code spans into an O(n^2) read.
    let next = offset + 1;
    while (next < n) {
      const c = body[next];
      if (c === "`" || c === "{" || body[next - 1] === "\n") break;
      next += 1;
    }
    offset = next;
  }
  if (fence) {
    segs.push({ start: fenceStart, end: n, keptStart: fenceStart, keptEnd: n, code: true });
  } else {
    flushText(n);
  }
  return segs;
}

/**
 * Byte ranges of inline/fenced code. `stripInlineMarkup` leaves CriticMarkup
 * literal inside code, so `renderInlineMarkers` must not inject markers there —
 * injected markup would otherwise survive the strip and leak into clean prose.
 */
function codeRanges(md: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const seg of scanSegments(md)) {
    if (seg.code) ranges.push([seg.start, seg.end]);
  }
  return ranges;
}

/* ------------------------------------------------------------- strip markup -- */

/**
 * Project an RFM body back to clean prose — the "as-is" view of the current
 * canonical text, never the as-proposed text. Only complete `{#id}`-terminated
 * groups are stripped; hand-typed CriticMarkup and anything inside code is left
 * exactly as written (see `matchMarkerGroup`).
 */
export function stripInlineMarkup(body: string): string {
  // Collect + join rather than `out += …`: over a doc with hundreds of
  // thousands of tiny segments, repeated concatenation risks quadratic
  // rope-flattening; an array join is unambiguously linear.
  const parts: string[] = [];
  for (const seg of scanSegments(body)) {
    parts.push(body.slice(seg.keptStart, seg.keptEnd));
  }
  return parts.join("");
}

/**
 * Locate every sheaf-injected marker group in a body, in document order, with
 * full structure (see `ReviewMarkerGroup`). Shares `scanSegments`' code/fence
 * awareness, so a marker inside inline code or a fence is skipped exactly as
 * `stripInlineMarkup` skips it — a renderer keying off this can't decorate
 * (and so visually "activate") literal example markup. Offsets are into `body`
 * as given; pass `splitEndmatter(md).body` to avoid scanning the YAML tail.
 */
export function scanReviewMarkup(body: string): ReviewMarkerGroup[] {
  const groups: ReviewMarkerGroup[] = [];
  for (const seg of scanSegments(body)) {
    // `scanSegments` emits each marker group as one non-code segment spanning
    // exactly [start, group.end); re-parse it for the full structure.
    if (seg.code || body[seg.start] !== "{") continue;
    const g = parseMarkerGroup(body, seg.start);
    if (g && g.end === seg.end) groups.push(g);
  }
  return groups;
}

/**
 * Map a byte offset in a marked-up document to the offset in the clean prose
 * `stripInlineMarkup` produces — so an editor selection made against the
 * on-disk markup lands in the clean-prose coordinates the server anchors
 * against, correctly even when the offset is inside a marker.
 */
export function cleanOffset(rawMd: string, rawOffset: number): number {
  const split = splitEndmatter(rawMd);
  // A doc with no sheaf endmatter carries no injected markup, so `readDoc`
  // returns its bytes verbatim (see `stripReviewMarkup`) — the editor offset is
  // already a clean-prose offset. Mapping unconditionally would compress a
  // hand-typed `{#id}` group the server never stripped, mis-anchoring the very
  // first comment on such a doc.
  if (!split.endmatter) {
    return Math.max(0, Math.min(rawOffset, rawMd.length));
  }
  const body = split.body;
  const target = Math.max(0, Math.min(rawOffset, body.length));
  let clean = 0;
  for (const seg of scanSegments(body)) {
    if (target >= seg.end) {
      clean += seg.keptEnd - seg.keptStart;
      continue;
    }
    if (target <= seg.keptStart) return clean;
    if (target >= seg.keptEnd) return clean + (seg.keptEnd - seg.keptStart);
    return clean + (target - seg.keptStart);
  }
  return clean;
}

/* ---------------------------------------------------------------- endmatter -- */

export type Endmatter = Record<string, unknown>;

interface SplitDoc {
  /** Body with inline markup still present (only the endmatter is removed). */
  body: string;
  endmatter: Endmatter | null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/**
 * A real sheaf record carries both a `messages` array and a `targets` array —
 * the two invariants every stored thread has (and `threadOnDiskSchema` requires
 * to parse). Demanding both is the provenance signal that tells an endmatter
 * apart from prose that merely ends with a `comments:`/`suggestions:` YAML
 * mapping — a config doc, or a doc documenting the RFM format itself. Detecting
 * such prose as review state would strip it at read and delete it on the next
 * write, so the bar is deliberately high.
 */
function hasThreadRecord(bucket: unknown): boolean {
  if (!isPlainObject(bucket)) return false;
  return Object.values(bucket).some(
    (v) =>
      isPlainObject(v) && Array.isArray(v.messages) && Array.isArray(v.targets),
  );
}

function looksLikeEndmatter(parsed: unknown): parsed is Endmatter {
  return (
    isPlainObject(parsed) &&
    (hasThreadRecord(parsed.comments) || hasThreadRecord(parsed.suggestions))
  );
}

/** True when the doc carries at least one sheaf-injected `{#id}`-terminated
 *  marker group. Used to fail *closed* when endmatter detection fails. */
function hasInjectedMarkerGroup(md: string): boolean {
  let i = md.indexOf("{");
  while (i !== -1) {
    if (matchMarkerGroup(md, i)) return true;
    i = md.indexOf("{", i + 1);
  }
  return false;
}

/**
 * Split off the final RFM endmatter — the *last* `\n---\n` block whose YAML
 * carries a thread record. Any other trailing `---` block is document content.
 *
 * The `---` matcher keeps the divider's trailing newline out of the match (a
 * lookahead) so two adjacent dividers are both found; otherwise a body ending
 * in a `---` line would share that newline with the endmatter divider and the
 * real boundary would be missed, corrupting the round-trip.
 *
 * Each candidate's YAML is bounded to the *next* divider, not to EOF, so a
 * block pasted after a real endmatter can't turn the endmatter's text into
 * unparseable multi-document YAML — which used to fail open and dump every
 * comment body into `readDoc`/`grep`.
 */
export function splitEndmatter(md: string): SplitDoc {
  const matches = [...md.matchAll(/\n---[ \t]*(?=\r?\n)/g)];
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    if (match.index === undefined) continue;
    const nextIndex = i + 1 < matches.length ? matches[i + 1].index : undefined;
    const region =
      nextIndex === undefined
        ? md.slice(match.index)
        : md.slice(match.index, nextIndex);
    const yamlText = region.replace(/^\n---[ \t]*\r?\n/, "");
    let parsed: unknown;
    try {
      parsed = parseYaml(yamlText);
    } catch {
      continue;
    }
    if (looksLikeEndmatter(parsed)) {
      return { body: md.slice(0, match.index), endmatter: parsed };
    }
  }
  return { body: md, endmatter: null };
}

/**
 * Clean projection of the whole doc. Only a doc with a real review endmatter
 * carries sheaf-injected markup, so any other doc is returned untouched — prose
 * that legitimately contains CriticMarkup-like text is preserved verbatim.
 *
 * Fail-closed guard: if endmatter detection fails on a doc that nonetheless
 * carries injected `{#id}` marker groups *and* a trailing `---` block (i.e. a
 * corrupted endmatter, not plain prose), strip the inline spans anyway so a
 * comment body can never leak into clean prose. A doc with only hand-typed
 * CriticMarkup — and no trailing divider — is still left verbatim.
 *
 * Residual (write path can't produce either; both need hand-edited files):
 *   - A thread with no inline span (its span was skipped) whose endmatter YAML
 *     is *also* hand-corrupted into unparseable YAML falls through the guard
 *     (no marker group to key on), so its body stays visible in the raw bytes.
 *   - Two valid endmatter blocks pasted back-to-back: only the last is treated
 *     as review state, so the earlier block's body reads as prose. `composeDoc`
 *     only ever writes one block.
 */
export function stripReviewMarkup(md: string): string {
  const split = splitEndmatter(md);
  if (split.endmatter) return stripInlineMarkup(split.body);
  if (/\n---[ \t]*\r?\n/.test(md) && hasInjectedMarkerGroup(md)) {
    return stripInlineMarkup(md);
  }
  return md;
}

/**
 * Compose a body with an endmatter object. The `\n---\n` divider is an exact
 * inverse of `splitEndmatter` (`splitEndmatter(composeDoc(body, em)).body ===
 * body`), so adding or editing review state never mutates a byte of the prose.
 */
export function composeDoc(body: string, endmatter: Endmatter | null): string {
  const hasContent =
    endmatter !== null &&
    Object.values(endmatter).some(
      (v) => isPlainObject(v) && Object.keys(v).length > 0,
    );
  if (!hasContent) return body;
  // stringifyYaml ends with a newline.
  return `${body}\n---\n${stringifyYaml(endmatter)}`;
}

/* --------------------------------------------------------- inline projection -- */

type InlineMarkerKind = "comment" | "substitution";

export interface InlineMarker {
  id: string;
  /** Clean-prose offsets of the span this marker anchors to. */
  from: number;
  to: number;
  /** Expected text at [from, to); used to relocate if the offsets drifted. */
  anchoredText: string;
  kind: InlineMarkerKind;
  /** Comment preview (`comment` kind). Dropped by `stripInlineMarkup`. */
  commentBody?: string;
  /** Proposed replacement (`substitution` kind). Dropped by strip (old wins). */
  newText?: string;
}

/** Inline previews are cosmetic — the endmatter holds the real text. */
function previewText(text: string, max = 280): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** A close delimiter inside a comment body would terminate the span early; a
 *  backtick could pair with a stray backtick in the prose to form a code span
 *  that swallows the injected markup. Both leak marker syntax into clean prose
 *  on strip, so neutralize them (previews are cosmetic). */
function safeCommentBody(text: string): string {
  return previewText(text).replace(/`/g, "").split("<<}").join("<< }");
}

/** Keep the substitution's `new` side from prematurely closing the span. */
function safeNewText(text: string): string {
  return previewText(text, 2000)
    .replace(/`/g, "")
    .split("~~}")
    .join("~~ }")
    .split("~>")
    .join("~ >");
}

/** Anchored text containing a marker's own close (or, for a substitution, the
 *  `~>` separator) can't be wrapped without corrupting the strip round-trip. */
function anchorIsWrappable(text: string, kind: InlineMarkerKind): boolean {
  if (text.length === 0) return false;
  if (kind === "comment") return !text.includes("==}");
  return !text.includes("==}") && !text.includes("~>") && !text.includes("~~}");
}

function renderMarker(text: string, m: InlineMarker): string {
  if (m.kind === "substitution") {
    return `{~~${text}~>${safeNewText(m.newText ?? "")}~~}{#${m.id}}`;
  }
  return `{==${text}==}{>>${safeCommentBody(m.commentBody ?? "")}<<}{#${m.id}}`;
}

/**
 * Markers whose anchor can't be located (or would corrupt the round-trip) are
 * skipped — they still live in the endmatter, just without an inline span.
 * Guarantees `stripInlineMarkup(renderInlineMarkers(prose, …)) === prose` for
 * any prose that contained no review markup to begin with.
 */
export function renderInlineMarkers(
  prose: string,
  markers: InlineMarker[],
): string {
  type Placed = { from: number; to: number; text: string; m: InlineMarker };
  const placed: Placed[] = [];
  const code = codeRanges(prose);
  for (const m of markers) {
    let from = m.from;
    let to = m.to;
    if (prose.slice(from, to) !== m.anchoredText) {
      // Offsets drifted (or were never resolved against this prose). Relocate
      // by the first verbatim occurrence of the anchored text.
      const at = m.anchoredText.length > 0 ? prose.indexOf(m.anchoredText) : -1;
      if (at === -1) continue;
      from = at;
      to = at + m.anchoredText.length;
    }
    if (!anchorIsWrappable(m.anchoredText, m.kind)) continue;
    // A backtick in the anchor (or an anchor overlapping a code region) would
    // make `stripInlineMarkup` treat the injected markup as code and leave it
    // literal — breaking the round-trip. Leave such threads endmatter-only.
    if (m.anchoredText.includes("`")) continue;
    if (code.some(([s, e]) => from < e && s < to)) continue;
    placed.push({ from, to, text: m.anchoredText, m });
  }
  // Insert right-to-left so earlier offsets stay valid; drop any overlap with a
  // span already accepted (nested markers would break the strip round-trip).
  placed.sort((a, b) => b.from - a.from);
  const accepted: Placed[] = [];
  let out = prose;
  for (const p of placed) {
    if (accepted.some((q) => p.from < q.to && q.from < p.to)) continue;
    accepted.push(p);
    out = out.slice(0, p.from) + renderMarker(p.text, p.m) + out.slice(p.to);
  }
  return out;
}

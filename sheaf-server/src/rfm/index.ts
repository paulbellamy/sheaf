import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * Roughdraft Flavored Markdown (RFM) — markup layer.
 *
 * A pure, domain-agnostic codec for the review-markup *style* sheaf borrows
 * from Lex-Inc/roughdraft (see `docs/roughdraft-review-markup.md`): inline
 * CriticMarkup spans for the anchored comment / proposed change, plus a YAML
 * **endmatter** block — everything after the file's final `---` divider —
 * carrying `comments:` / `suggestions:` maps keyed by review id.
 *
 * This module knows nothing about sheaf threads. It only:
 *   - splits a doc into (body, endmatter object),
 *   - strips inline CriticMarkup back to clean prose,
 *   - renders an inline-marker projection of anchored review items, and
 *   - composes a body + endmatter back into one document.
 *
 * The backend (`backend/stub.ts`) owns the Thread <-> endmatter mapping; the
 * endmatter is the authoritative store and the inline markers are a regenerated
 * projection, so this layer never has to parse data back out of the markers.
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

/** Match a ``` / ~~~ fence line. Mirrors CommonMark fence open/close rules. */
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

/** If an inline code span opens at `offset`, return the offset just past its
 *  close; otherwise null. Backtick runs must match in length. */
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

/* ------------------------------------------------------------- strip markup -- */

/**
 * Project an RFM body (no endmatter) back to clean prose by removing inline
 * CriticMarkup. The projection is the "as-is" view — pending insertions are
 * dropped and pending deletions kept, so the result is the current canonical
 * text, never the as-proposed text:
 *
 *   {==text==}        -> text         (highlight: keep the anchored run)
 *   {>>note<<}        -> ""           (comment: drop)
 *   {++text++}        -> ""           (insertion: not yet in the doc)
 *   {--text--}        -> text         (deletion: still in the doc)
 *   {~~old~>new~~}    -> old          (substitution: old side is canonical)
 *   {#id}             -> ""           (id reference: drop)
 *
 * Markers inside inline code spans and fenced code blocks are left literal.
 */
export function stripInlineMarkup(body: string): string {
  let out = "";
  let offset = 0;
  let fence: FenceState | null = null;
  const n = body.length;
  while (offset < n) {
    if (isLineStart(body, offset)) {
      const fm = matchFence(body, offset, fence);
      if (fm) {
        fence = fence ? null : fm.fence;
        const end = nextLineOffset(body, offset);
        out += body.slice(offset, end);
        offset = end;
        continue;
      }
    }
    if (fence) {
      const end = nextLineOffset(body, offset);
      out += body.slice(offset, end);
      offset = end;
      continue;
    }
    const cs = matchInlineCodeSpan(body, offset);
    if (cs !== null) {
      out += body.slice(offset, cs);
      offset = cs;
      continue;
    }
    if (body.startsWith("{==", offset)) {
      const end = body.indexOf("==}", offset + 3);
      if (end !== -1) {
        out += body.slice(offset + 3, end);
        offset = end + 3;
        continue;
      }
    }
    if (body.startsWith("{>>", offset)) {
      const end = body.indexOf("<<}", offset + 3);
      if (end !== -1) {
        offset = end + 3;
        continue;
      }
    }
    if (body.startsWith("{++", offset)) {
      const end = body.indexOf("++}", offset + 3);
      if (end !== -1) {
        offset = end + 3;
        continue;
      }
    }
    if (body.startsWith("{--", offset)) {
      const end = body.indexOf("--}", offset + 3);
      if (end !== -1) {
        out += body.slice(offset + 3, end);
        offset = end + 3;
        continue;
      }
    }
    if (body.startsWith("{~~", offset)) {
      const sep = body.indexOf("~>", offset + 3);
      const end = sep === -1 ? -1 : body.indexOf("~~}", sep + 2);
      if (sep !== -1 && end !== -1) {
        out += body.slice(offset + 3, sep);
        offset = end + 3;
        continue;
      }
    }
    const idEnd = matchIdRef(body, offset);
    if (idEnd !== null) {
      offset = idEnd;
      continue;
    }
    out += body[offset];
    offset += 1;
  }
  return out;
}

/* ---------------------------------------------------------------- endmatter -- */

export type Endmatter = Record<string, unknown>;

interface SplitDoc {
  /** Document body with inline markup still present, endmatter removed. */
  body: string;
  /** Parsed endmatter object, or null when the doc has no RFM endmatter. */
  endmatter: Endmatter | null;
  /** Byte offset where the endmatter's `\n---\n` begins, or null. */
  endmatterOffset: number | null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/** True when a parsed trailing block is a sheaf/RFM review endmatter (vs. an
 *  ordinary `---` section that merely happens to be the last one). */
function looksLikeEndmatter(parsed: unknown): parsed is Endmatter {
  return isPlainObject(parsed) && ("comments" in parsed || "suggestions" in parsed);
}

/**
 * Split off the final RFM endmatter. The endmatter is the *last* `\n---\n`
 * whose YAML body parses to an object carrying `comments:`/`suggestions:`. Any
 * other trailing `---` block is treated as document content.
 */
export function splitEndmatter(md: string): SplitDoc {
  const matches = [...md.matchAll(/\n---[ \t]*\r?\n/g)];
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    if (match.index === undefined) continue;
    const raw = md.slice(match.index);
    const yamlText = raw.replace(/^\n---[ \t]*\r?\n/, "");
    let parsed: unknown;
    try {
      parsed = parseYaml(yamlText);
    } catch {
      continue;
    }
    if (looksLikeEndmatter(parsed)) {
      return {
        body: md.slice(0, match.index),
        endmatter: parsed,
        endmatterOffset: match.index,
      };
    }
  }
  return { body: md, endmatter: null, endmatterOffset: null };
}

/**
 * Full clean projection: strip the RFM endmatter and all inline CriticMarkup,
 * leaving the canonical prose. This is what `readDoc` returns and what grep,
 * the style corpus, and the diff/merge paths see.
 */
export function stripReviewMarkup(md: string): string {
  return stripInlineMarkup(splitEndmatter(md).body);
}

/**
 * Compose a body (inline markup already rendered) with an endmatter object into
 * one document. A null/empty endmatter yields the body alone, with no stray
 * trailing `---`.
 *
 * The `\n---\n` divider is an exact inverse of `splitEndmatter`, so
 * `splitEndmatter(composeDoc(body, em)).body === body` for any body — adding or
 * editing review state never mutates a single byte of the prose. (A body that
 * already ends in a newline therefore gets a blank line before `---`; one that
 * doesn't sits flush against it.)
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

/** Collapse to one line and bound length — inline previews are cosmetic. */
function previewText(text: string, max = 280): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** A close delimiter inside a comment body would terminate the span early. */
function safeCommentBody(text: string): string {
  return previewText(text).split("<<}").join("<< }");
}

/** Keep the substitution's `new` side from prematurely closing the span. */
function safeNewText(text: string): string {
  return previewText(text, 2000).split("~~}").join("~~ }").split("~>").join("~ >");
}

/**
 * Anchored text that itself contains a marker's own close (or, for a
 * substitution, the `~>` separator) can't be wrapped without corrupting the
 * round-trip, so such a marker is dropped to endmatter-only.
 */
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
 * Render anchored review markers into clean prose as a CriticMarkup projection.
 * Markers whose anchor can't be located (or would corrupt the round-trip) are
 * skipped — they still live in the endmatter, just without an inline span.
 *
 * Guarantees `stripInlineMarkup(renderInlineMarkers(prose, …)) === prose` for
 * any prose that contained no review markup to begin with.
 */
export function renderInlineMarkers(
  prose: string,
  markers: InlineMarker[],
): string {
  type Placed = { from: number; to: number; text: string; m: InlineMarker };
  const placed: Placed[] = [];
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

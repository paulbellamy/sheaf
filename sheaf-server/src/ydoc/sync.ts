import * as Y from "yjs";

/**
 * The markdown ↔ Y.Doc bridge — the merge-truth substrate from the sheaf
 * design doc (§4). A doc is a single `Y.Text` ("content") holding the literal
 * markdown; `.md` is always `render(ydoc)` (invariant 1: consistency at rest).
 *
 * This is the core the client-write path runs on: when an agent proposes new
 * markdown (ACP `fs/write_text_file`), the client reconciles it into the ydoc
 * here rather than stomping the file, so comment anchors survive (invariant 3)
 * and concurrent edits merge by construction (yjs).
 *
 * Pure and runtime-agnostic (no fs, no obsidian) so it's shared by the web
 * product and the plugin, and unit-testable on its own.
 */

const TEXT_KEY = "content";

const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/**
 * The CRDT document handle. Re-exported so consumers (e.g. the plugin) can type
 * against it without taking a direct `yjs` dependency — Yjs stays an internal
 * detail of this module.
 */
export type YDoc = Y.Doc;

/** A fresh Y.Doc whose `content` Y.Text holds `md`. */
export function markdownToYDoc(md: string): Y.Doc {
  const doc = new Y.Doc();
  if (md.length > 0) doc.getText(TEXT_KEY).insert(0, md);
  return doc;
}

/** The doc's canonical markdown — what gets written to `<doc>.md`. */
export function renderYDoc(doc: Y.Doc): string {
  return doc.getText(TEXT_KEY).toString();
}

/**
 * Reconcile a doc to `newMd` by applying the MINIMAL edit (design §4.2, the
 * agent-pushes-markdown write path): trim the common prefix and suffix, then
 * replace only the differing middle span as Y.Text delete+insert in one
 * transaction.
 *
 * Minimal ops are load-bearing: the untouched prefix/suffix keep their CRDT
 * item identities, so relative-position anchors there survive the edit
 * (invariant 3). A naive full replace would tombstone every anchor.
 *
 * No-op when the markdown is unchanged. Throws if the post-apply render doesn't
 * equal `newMd` (invariant 1 — should be impossible, guards against a bug).
 */
export function applyMarkdown(
  doc: Y.Doc,
  newMd: string,
  origin?: unknown,
): void {
  const text = doc.getText(TEXT_KEY);
  const oldMd = text.toString();
  if (oldMd === newMd) return;

  // Longest common prefix.
  const maxPrefix = Math.min(oldMd.length, newMd.length);
  let prefix = 0;
  while (prefix < maxPrefix && oldMd[prefix] === newMd[prefix]) prefix++;

  // Longest common suffix that doesn't overlap the prefix on either side.
  const maxSuffix = Math.min(oldMd.length - prefix, newMd.length - prefix);
  let suffix = 0;
  while (
    suffix < maxSuffix &&
    oldMd[oldMd.length - 1 - suffix] === newMd[newMd.length - 1 - suffix]
  ) {
    suffix++;
  }

  // Keep surrogate pairs whole. The scan above compares UTF-16 code units and
  // can stop *between* a high and low surrogate; yjs also indexes by code unit,
  // so splitting a pair orphans half of it and corrupts the character (any
  // emoji / astral char — they share high surrogates, so swapping one for a
  // neighbour trips this). Nudge each boundary outward so a whole pair always
  // lands inside the changed span.
  if (
    prefix > 0 &&
    prefix < oldMd.length &&
    isHighSurrogate(oldMd.charCodeAt(prefix - 1)) &&
    isLowSurrogate(oldMd.charCodeAt(prefix))
  ) {
    prefix--;
  }
  if (
    suffix > 0 &&
    oldMd.length - suffix - 1 >= prefix &&
    isLowSurrogate(oldMd.charCodeAt(oldMd.length - suffix)) &&
    isHighSurrogate(oldMd.charCodeAt(oldMd.length - suffix - 1))
  ) {
    suffix--;
  }

  const deleteLen = oldMd.length - prefix - suffix;
  const insert = newMd.slice(prefix, newMd.length - suffix);

  Y.transact(
    doc,
    () => {
      if (deleteLen > 0) text.delete(prefix, deleteLen);
      if (insert.length > 0) text.insert(prefix, insert);
    },
    origin,
  );

  const rendered = text.toString();
  if (rendered !== newMd) {
    // Invariant 1 broken — bail rather than persist an inconsistent state.
    throw new Error(
      "ydoc reconciliation failed: render(doc) !== newMd after applyMarkdown",
    );
  }
}

/** Encode the doc's full state — the `<doc>.ycrdt` snapshot bytes. */
export function encodeYDoc(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(doc);
}

/** Reconstruct a Y.Doc from snapshot bytes produced by {@link encodeYDoc}. */
export function decodeYDoc(bytes: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes);
  return doc;
}

/**
 * A durable anchor (base64 `RelativePosition`) at a character offset — tier 1
 * of the design's comment anchoring (§5). Survives edits elsewhere in the doc:
 * it pins to CRDT item identities, not absolute offsets.
 */
export function createAnchor(doc: Y.Doc, offset: number): string {
  const rel = Y.createRelativePositionFromTypeIndex(
    doc.getText(TEXT_KEY),
    offset,
  );
  return Buffer.from(Y.encodeRelativePosition(rel)).toString("base64");
}

/**
 * Resolve a base64 `RelativePosition` to a character offset against the doc's
 * current state, or null if it no longer resolves (e.g. bytes corrupt, or the
 * doc was rebuilt and the position's item is gone).
 */
export function resolveAnchor(doc: Y.Doc, b64: string): number | null {
  try {
    // Both steps can throw on a malformed blob (Buffer.from is lenient about
    // bad base64, so a garbage position can survive decode and only blow up
    // when resolved) — treat any failure as "no longer resolves".
    const rel = Y.decodeRelativePosition(Buffer.from(b64, "base64"));
    const abs = Y.createAbsolutePositionFromRelativePosition(rel, doc);
    return abs ? abs.index : null;
  } catch {
    return null;
  }
}

/**
 * StyleProfile — the cached, compact representation of "how the user writes",
 * derived from their vault and consumed by the agent at write time.
 *
 * Two halves with different refresh semantics:
 *   - `metrics`  — deterministic stylometry (see `metrics.ts`). Cheap; the
 *                  backend recomputes it silently whenever the corpus drifts.
 *   - `guide_md` — a short prose style guide distilled *by the agent* (the only
 *                  LLM step). Refreshed on demand (the settings button) or when
 *                  the corpus has grown past a threshold, never automatically.
 *
 * The whole thing is cached under the hidden `.sheaf/` dir so it never appears
 * as a vault doc. Invalidation is keyed by a cheap corpus fingerprint (stat
 * only, no content reads) plus a hash of the config that produced it.
 */

import { createHash } from "node:crypto";

import type { StyleMetrics } from "./metrics";

export const STYLE_PROFILE_VERSION = 1 as const;

/** Below this many corpus words the metrics are too thin to steer on; the agent
 *  is told to fall back to a neutral voice. */
export const LOW_CORPUS_WORDS = 400;

/** Don't read more than this much prose when (re)computing metrics, so a huge
 *  vault keeps `GetStyle` fast. Most-recent docs win; `sampled` is flagged. */
export const METRICS_BYTE_CAP = 2 * 1024 * 1024;
export const METRICS_DOC_CAP = 300;

export type StyleConfig = {
  /** User master switch. Voice matching only applies when this is true. */
  enabled: boolean;
  /** Globs excluded from the corpus. Everything else under the vault that ends
   *  in `.md` is treated as the user's own writing. */
  exclude_globs: string[];
  /** Recency weighting for exemplar selection. */
  recency_half_life_days: number;
  /** Regenerate the distilled guide once the corpus has grown by this many
   *  docs since the guide was written. */
  refresh_after_doc_changes: number;
  /** How many exemplar passages `GetStyle` returns (clamped 1..4). */
  exemplar_count: number;
};

export type CorpusFingerprint = {
  doc_count: number;
  total_bytes: number;
  newest_mtime: number;
  /** sha over sorted `(path + mtimeMs + size)` — order-independent, O(stat). */
  digest: string;
};

/**
 * The cached profile holds *only* the deterministic metrics. The prose guide
 * lives in the visible, user-editable `Sheaf/Voice Guide.md` doc (single source
 * of truth) — there's no copy here.
 */
export type StyleProfile = {
  version: typeof STYLE_PROFILE_VERSION;
  fingerprint: CorpusFingerprint;
  config_hash: string;
  metrics: StyleMetrics;
  computed_at: number;
};

/** The voice-guide doc, surfaced as a normal (visible, user-editable) vault
 *  doc. Excluded from the corpus by default so the guide can't feed itself. */
export const VOICE_GUIDE_PATH = "Sheaf/Voice Guide.md";

/** Marker that opens a build-voice-guide request thread. The agent recognizes
 *  this prefix (see the MCP ReadMe) and runs the bootstrap flow (StyleSamples →
 *  SaveStyleGuide) instead of treating the thread as an edit brief. */
export const BUILD_VOICE_GUIDE_MARKER = "[sheaf:build-voice-guide]";

/** Placeholder written to the visible guide doc when the build is kicked off
 *  before the agent has produced the real guide. */
export const VOICE_GUIDE_PLACEHOLDER = [
  "# Voice Guide",
  "",
  "_Sheaf is learning how you write from your notes. Once the connected agent",
  "finishes, this file will describe your voice — sentence rhythm, diction,",
  "punctuation habits, and what to avoid. Edit it freely; sheaf reads your",
  "edits back the next time it refreshes._",
  "",
].join("\n");

/** The in-band request message that drives the agent's bootstrap flow. */
export function buildVoiceGuideRequestMessage(): string {
  return [
    BUILD_VOICE_GUIDE_MARKER,
    "Build (or refresh) my voice guide. This is not an edit brief — don't rewrite this doc directly. Instead:",
    "1. Call StyleSamples to get my writing metrics and a spread of sample passages.",
    "2. Write a compact (≤400 word) prose style guide describing how I write — sentence rhythm, diction, punctuation habits, structure, and what to avoid. Refine the existing guide rather than discard it.",
    "3. Save it by writing the doc `Sheaf/Voice Guide.md` (the Write tool).",
    "Then reply here with a one-line summary and resolve this thread.",
  ].join("\n");
}

export function defaultStyleConfig(): StyleConfig {
  return {
    enabled: true,
    exclude_globs: [
      "Sheaf/**",
      "**/Templates/**",
      "**/templates/**",
      "**/Daily/**",
      "**/Clippings/**",
      "**/Excalidraw/**",
    ],
    recency_half_life_days: 120,
    refresh_after_doc_changes: 25,
    exemplar_count: 3,
  };
}

export function clampExemplarCount(n: number | undefined): number {
  if (n === undefined || Number.isNaN(n)) return 3;
  return Math.max(1, Math.min(4, Math.floor(n)));
}

/** Stable hash of the config fields that affect metric/exemplar output, so a
 *  config change (new excludes, new banned phrases) invalidates the cache. */
export function configHash(config: StyleConfig): string {
  const canonical = JSON.stringify({
    exclude_globs: [...config.exclude_globs].sort(),
    recency_half_life_days: config.recency_half_life_days,
    exemplar_count: clampExemplarCount(config.exemplar_count),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export type CorpusFile = { path: string; mtime_ms: number; size: number };

export function computeFingerprint(files: CorpusFile[]): CorpusFingerprint {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const h = createHash("sha256");
  let totalBytes = 0;
  let newest = 0;
  for (const f of sorted) {
    h.update(`${f.path}${f.mtime_ms}${f.size}\n`);
    totalBytes += f.size;
    if (f.mtime_ms > newest) newest = f.mtime_ms;
  }
  return {
    doc_count: sorted.length,
    total_bytes: totalBytes,
    newest_mtime: newest,
    digest: h.digest("hex").slice(0, 24),
  };
}

export function fingerprintsEqual(
  a: CorpusFingerprint | undefined,
  b: CorpusFingerprint | undefined,
): boolean {
  if (!a || !b) return false;
  return a.digest === b.digest && a.doc_count === b.doc_count;
}

/**
 * The guide is stale when there is no guide doc, or the corpus has grown by
 * `refresh_after_doc_changes` notes (by mtime) since the guide was last written.
 * Mtime-based ⇒ no stored bookkeeping: (re)writing the guide resets the count.
 */
export function isGuideStale(
  guideMtimeMs: number | null,
  corpus: { mtime_ms: number }[],
  refreshAfterDocChanges: number,
): boolean {
  if (guideMtimeMs === null) return true;
  const newer = corpus.filter((f) => f.mtime_ms > guideMtimeMs).length;
  return newer >= refreshAfterDocChanges;
}

/** True when the guide doc still holds only the build-time placeholder (the
 *  agent hasn't written the real guide yet). Treated as "no guide". */
export function isPlaceholderGuide(md: string): boolean {
  return md.trim() === VOICE_GUIDE_PLACEHOLDER.trim();
}

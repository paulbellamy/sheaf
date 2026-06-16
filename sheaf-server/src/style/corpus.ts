/**
 * Corpus selection + exemplar retrieval.
 *
 * Orchestration over the backend's existing primitives (stat / read / grep) —
 * no embeddings, no extra traversal. Two jobs:
 *   1. Keep the cached `StyleProfile` metrics fresh, recomputing only when the
 *      corpus fingerprint or config drifts, and only reading content then.
 *   2. Pick a *small* set of relevant or diverse exemplar passages so the agent
 *      gets the user's voice in ~1-2k tokens instead of the whole vault.
 *
 * `StyleIO` is the narrow slice of `Backend` these functions need, so they're
 * unit-testable against a fake.
 */

import type { GrepOptions, GrepResult, Ref } from "../backend/index";
import { globToRegex } from "../glob";
import {
  FUNCTION_WORDS,
  computeMetrics,
  splitParagraphs,
  splitSentences,
  stripMarkdown,
} from "./metrics";
import {
  type CorpusFile,
  type StyleConfig,
  type StyleProfile,
  LOW_CORPUS_WORDS,
  METRICS_BYTE_CAP,
  METRICS_DOC_CAP,
  STYLE_PROFILE_VERSION,
  VOICE_GUIDE_PATH,
  clampExemplarCount,
  computeFingerprint,
  configHash,
  fingerprintsEqual,
} from "./profile";

export interface StyleIO {
  /** Visible `*.md` docs with mtime + size, no content read (cheap). */
  statCorpus(): Promise<CorpusFile[]>;
  readDoc(path: string, ref?: Ref): Promise<{ md: string }>;
  grep(opts: GrepOptions): Promise<GrepResult>;
  readStyleProfile(): Promise<StyleProfile | null>;
  writeStyleProfile(p: StyleProfile): Promise<void>;
}

const STOPWORDS = new Set<string>(FUNCTION_WORDS);
const EXCERPT_MAX_WORDS = 120;

/** Apply the config's exclude globs (the voice guide is always excluded). */
export function selectCorpus(
  files: CorpusFile[],
  config: StyleConfig,
): CorpusFile[] {
  const excludes = [VOICE_GUIDE_PATH, ...config.exclude_globs].map((g) =>
    globToRegex(g),
  );
  return files.filter(
    (f) => f.path.endsWith(".md") && !excludes.some((re) => re.test(f.path)),
  );
}

export type ProfileLoad = {
  profile: StyleProfile;
  corpus: CorpusFile[];
  low_corpus: boolean;
  sampled: boolean;
  recomputed: boolean;
};

/**
 * Return the cached profile if its fingerprint + config_hash still match the
 * current corpus; otherwise recompute the deterministic metrics (reading at
 * most METRICS_BYTE_CAP of the most-recent prose), preserve any agent-distilled
 * guide, persist, and return it.
 */
export async function loadOrRefreshProfile(
  io: StyleIO,
  config: StyleConfig,
): Promise<ProfileLoad> {
  const corpus = selectCorpus(await io.statCorpus(), config);
  const fp = computeFingerprint(corpus);
  const ch = configHash(config);
  const cached = await io.readStyleProfile();

  if (
    cached &&
    cached.version === STYLE_PROFILE_VERSION &&
    cached.config_hash === ch &&
    fingerprintsEqual(cached.fingerprint, fp)
  ) {
    return {
      profile: cached,
      corpus,
      low_corpus: cached.metrics.word_count < LOW_CORPUS_WORDS,
      sampled: false,
      recomputed: false,
    };
  }

  // Recompute. Read the most-recent docs up to the byte/doc cap.
  const byRecency = [...corpus].sort((a, b) => b.mtime_ms - a.mtime_ms);
  const toRead: CorpusFile[] = [];
  let bytes = 0;
  for (const f of byRecency) {
    if (toRead.length >= METRICS_DOC_CAP) break;
    if (bytes + f.size > METRICS_BYTE_CAP && toRead.length > 0) break;
    toRead.push(f);
    bytes += f.size;
  }
  const sampled = toRead.length < corpus.length;

  const mds: string[] = [];
  for (const f of toRead) {
    try {
      const { md } = await io.readDoc(f.path);
      mds.push(md);
    } catch {
      // A doc vanished between stat and read — skip it.
    }
  }
  const metrics = computeMetrics(mds);
  // Report the full corpus size, not just the analyzed slice.
  metrics.doc_count = corpus.length;

  const profile: StyleProfile = {
    version: STYLE_PROFILE_VERSION,
    fingerprint: fp,
    config_hash: ch,
    metrics,
    guide_md: cached?.guide_md ?? null,
    guide_generated_at: cached?.guide_generated_at ?? null,
    guide_doc_count: cached?.guide_doc_count ?? null,
    computed_at: Date.now(),
  };
  await io.writeStyleProfile(profile);

  return {
    profile,
    corpus,
    low_corpus: metrics.word_count < LOW_CORPUS_WORDS,
    sampled,
    recomputed: true,
  };
}

export type Exemplar = { path: string; excerpt: string };

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Up to 3 content keywords from a free-text topic (drops stopwords/short). */
function topicKeywords(topic: string): string[] {
  const words = topic
    .toLowerCase()
    .match(/[\p{L}][\p{L}'-]*/gu);
  if (!words) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    if (w.length < 3 || STOPWORDS.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= 3) break;
  }
  return out;
}

function recencyWeight(mtimeMs: number, halfLifeDays: number, now: number): number {
  const ageDays = Math.max(0, (now - mtimeMs) / 86_400_000);
  return 0.5 ** (ageDays / Math.max(1, halfLifeDays));
}

/** Cap an excerpt to ~maxWords, preferring to end on a sentence boundary. */
function capWords(text: string, maxWords: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const words = flat.split(" ");
  if (words.length <= maxWords) return flat;
  const head = words.slice(0, maxWords).join(" ");
  const sentences = splitSentences(head);
  if (sentences.length > 1) {
    const joined = sentences.slice(0, -1).join(" ");
    if (joined.split(" ").length >= maxWords * 0.6) return joined;
  }
  return head + "…";
}

/** A representative paragraph from a doc: the one nearest a keyword hit, else
 *  the first substantive (≥12-word) paragraph. Returns "" if none qualifies. */
function pickParagraph(md: string, keywords: string[]): string {
  const { prose } = stripMarkdown(md);
  const paras = splitParagraphs(prose).filter(
    (p) => p.split(/\s+/).length >= 12,
  );
  if (paras.length === 0) return "";
  if (keywords.length > 0) {
    const re = new RegExp(keywords.map(escapeRegExp).join("|"), "i");
    const hit = paras.find((p) => re.test(p));
    if (hit) return hit;
  }
  return paras[0];
}

function trigramSet(text: string): Set<string> {
  const words = text.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  const set = new Set<string>();
  for (let i = 0; i + 3 <= words.length; i++) {
    set.add(words.slice(i, i + 3).join(" "));
  }
  return set;
}

function tooSimilar(a: string, b: string): boolean {
  const sa = trigramSet(a);
  const sb = trigramSet(b);
  if (sa.size === 0 || sb.size === 0) return false;
  let overlap = 0;
  for (const g of sa) if (sb.has(g)) overlap++;
  const jaccard = overlap / (sa.size + sb.size - overlap);
  return jaccard > 0.5;
}

/**
 * Pick exemplar passages biased toward `topic` (via grep) and recency. Reads at
 * most `exemplar_count` docs and returns one word-capped paragraph each.
 */
export async function selectExemplars(
  io: StyleIO,
  config: StyleConfig,
  corpus: CorpusFile[],
  topic: string | undefined,
  now: number = Date.now(),
): Promise<Exemplar[]> {
  const count = clampExemplarCount(config.exemplar_count);
  if (corpus.length === 0) return [];

  const inCorpus = new Set(corpus.map((f) => f.path));
  const keywords = topic ? topicKeywords(topic) : [];

  let topicHits = new Set<string>();
  if (keywords.length > 0) {
    try {
      const res = await io.grep({
        pattern: keywords.map(escapeRegExp).join("|"),
        output_mode: "files_with_matches",
        case_insensitive: true,
        head_limit: 40,
      });
      if (res.mode === "files_with_matches") {
        topicHits = new Set(res.paths.filter((p) => inCorpus.has(p)));
      }
    } catch {
      // grep_timeout or bad pattern — fall back to recency-only ranking.
    }
  }

  const W_TOPIC = 1;
  const W_RECENCY = 0.6;
  const ranked = [...corpus]
    .map((f) => ({
      file: f,
      score:
        (topicHits.has(f.path) ? W_TOPIC : 0) +
        W_RECENCY * recencyWeight(f.mtime_ms, config.recency_half_life_days, now),
    }))
    .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));

  const out: Exemplar[] = [];
  for (const { file } of ranked) {
    if (out.length >= count) break;
    let md: string;
    try {
      ({ md } = await io.readDoc(file.path));
    } catch {
      continue;
    }
    const para = pickParagraph(md, keywords);
    if (!para) continue;
    const excerpt = capWords(para, EXCERPT_MAX_WORDS);
    if (out.some((e) => tooSimilar(e.excerpt, excerpt))) continue;
    out.push({ path: file.path, excerpt });
  }
  return out;
}

/**
 * Diverse sample passages for the bootstrap flow: round-robin across distinct
 * folders, recency-weighted, so the agent sees range rather than topic focus.
 */
export async function selectSamples(
  io: StyleIO,
  config: StyleConfig,
  corpus: CorpusFile[],
  maxSamples = 8,
  maxWords = 130,
  now: number = Date.now(),
): Promise<Exemplar[]> {
  if (corpus.length === 0) return [];
  const folderOf = (p: string) => {
    const i = p.lastIndexOf("/");
    return i === -1 ? "" : p.slice(0, i);
  };
  const byFolder = new Map<string, CorpusFile[]>();
  for (const f of corpus) {
    const list = byFolder.get(folderOf(f.path)) ?? [];
    list.push(f);
    byFolder.set(folderOf(f.path), list);
  }
  for (const list of byFolder.values()) {
    list.sort(
      (a, b) =>
        recencyWeight(b.mtime_ms, config.recency_half_life_days, now) -
        recencyWeight(a.mtime_ms, config.recency_half_life_days, now),
    );
  }
  // Round-robin one per folder until we have enough candidates.
  const folders = [...byFolder.keys()].sort();
  const order: CorpusFile[] = [];
  for (let round = 0; order.length < corpus.length; round++) {
    let added = false;
    for (const folder of folders) {
      const f = byFolder.get(folder)![round];
      if (f) {
        order.push(f);
        added = true;
      }
    }
    if (!added) break;
  }

  const out: Exemplar[] = [];
  for (const f of order) {
    if (out.length >= maxSamples) break;
    let md: string;
    try {
      ({ md } = await io.readDoc(f.path));
    } catch {
      continue;
    }
    const para = pickParagraph(md, []);
    if (!para) continue;
    const excerpt = capWords(para, maxWords);
    if (out.some((e) => tooSimilar(e.excerpt, excerpt))) continue;
    out.push({ path: f.path, excerpt });
  }
  return out;
}

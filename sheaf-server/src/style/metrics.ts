/**
 * Deterministic stylometry.
 *
 * Pure functions over plain strings — no filesystem, no LLM, no randomness, no
 * locale-dependent collation. Given the same corpus this always produces the
 * same metrics, which is what lets us cache a profile keyed by a corpus
 * fingerprint (see `profile.ts`).
 *
 * The metrics capture the signal stylometry says distinguishes one writer from
 * another: sentence-length distribution + burstiness, function-word
 * frequencies, punctuation habits, contraction use, vocabulary richness, and
 * idiosyncratic n-grams. `StyleCheck` (the "humanize" lint) reuses the very
 * same functions on a candidate passage and diffs it against the profile.
 */

/** Closed-class words whose *relative frequency* is a strong author signal
 *  (the "upon"-identifies-Hamilton trick, generalized). Frozen + sorted so the
 *  function-word vector is stable across runs. */
export const FUNCTION_WORDS: readonly string[] = [
  "a", "about", "all", "an", "and", "are", "as", "at", "be", "been", "but",
  "by", "can", "for", "from", "had", "has", "have", "he", "her", "his", "i",
  "if", "in", "is", "it", "its", "me", "my", "not", "of", "on", "or", "our",
  "out", "she", "so", "than", "that", "the", "their", "them", "then", "there",
  "these", "they", "this", "to", "up", "was", "we", "were", "what", "when",
  "which", "who", "will", "with", "would", "you", "your",
];

/** Words too common to be interesting inside an n-gram; filtered so the top
 *  bigrams/trigrams surface the writer's phrasing, not "of the". */
const NGRAM_STOPWORDS = new Set<string>(FUNCTION_WORDS);

/** Phrases the post-trained "blurry-JPEG" voice over-produces. Counts are
 *  reported per 1k words so they're comparable across passage lengths. The
 *  user's own words-to-avoid live in their voice guide, which the agent reads
 *  separately — this list is the generic, always-on baseline. */
export const AI_TELL_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: "delve", re: /\bdelve(?:s|d|ing)?\b/gi },
  { name: "leverage", re: /\bleverage(?:s|d|ing)?\b/gi },
  { name: "tapestry", re: /\btapestry\b/gi },
  { name: "testament to", re: /\b(?:a|is a)\s+testament to\b/gi },
  { name: "it's not X, it's Y", re: /\bit['’]?s not\b[^.?!]{1,50}?,\s*it['’]?s\b/gi },
  { name: "in today's", re: /\bin today['’]?s\b/gi },
  { name: "ever-evolving", re: /\bever[- ]evolving\b/gi },
  { name: "landscape", re: /\blandscape\b/gi },
  { name: "realm", re: /\brealm\b/gi },
  { name: "seamless", re: /\bseamless(?:ly)?\b/gi },
  { name: "robust", re: /\brobust\b/gi },
  { name: "dive into", re: /\b(?:deep )?dive into\b/gi },
  { name: "navigating", re: /\bnavigating the\b/gi },
  { name: "moreover", re: /\bmoreover\b/gi },
  { name: "furthermore", re: /\bfurthermore\b/gi },
  { name: "underscore", re: /\bunderscore(?:s|d)?\b/gi },
  { name: "crucial", re: /\bcrucial\b/gi },
  { name: "pivotal", re: /\bpivotal\b/gi },
  { name: "it's worth noting", re: /\bit['’]?s worth noting\b/gi },
  { name: "when it comes to", re: /\bwhen it comes to\b/gi },
  { name: "in conclusion", re: /\bin conclusion\b/gi },
];

const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "e.g", "i.e",
  "fig", "no", "vol", "approx", "inc", "ltd", "co", "u.s", "u.k",
]);

export type MarkdownStructure = {
  total_lines: number;
  heading_lines: number;
  bullet_lines: number;
  numbered_lines: number;
  code_fences: number;
};

export type StyleMetrics = {
  doc_count: number;
  word_count: number;
  sentence: { mean_len: number; stdev_len: number; burstiness: number };
  paragraph: { mean_len_words: number; stdev_len_words: number };
  type_token_ratio: number;
  function_words: Record<string, number>;
  punctuation: {
    em_dash: number;
    en_dash: number;
    semicolon: number;
    colon: number;
    parens: number;
    exclamation: number;
    question: number;
    ellipsis: number;
    oxford_comma_rate: number;
  };
  contraction_rate: number;
  markdown: {
    heading_rate: number;
    bullet_rate: number;
    numbered_rate: number;
    code_fence_rate: number;
  };
  top_bigrams: [string, number][];
  top_trigrams: [string, number][];
  ai_tells: Record<string, number>;
};

/**
 * Strip markdown to plain prose for linguistic measurement, recording the
 * structural counts (headings, bullets, …) *before* they're removed.
 *
 * Frontmatter, code, tables, and link/image plumbing are dropped because they
 * are not the author's prose voice and would skew sentence/word stats; link
 * *text* is preserved.
 */
export function stripMarkdown(md: string): {
  prose: string;
  structure: MarkdownStructure;
} {
  // Strip a leading YAML frontmatter block first (before line counting).
  let body = md.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n/, "");

  const allLines = body.split(/\r?\n/);
  const structure: MarkdownStructure = {
    total_lines: allLines.filter((l) => l.trim().length > 0).length,
    heading_lines: 0,
    bullet_lines: 0,
    numbered_lines: 0,
    code_fences: 0,
  };
  let inFence = false;
  for (const line of allLines) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      structure.code_fences++;
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^\s{0,3}#{1,6}\s/.test(line)) structure.heading_lines++;
    else if (/^\s*[-*+]\s+/.test(line)) structure.bullet_lines++;
    else if (/^\s*\d+[.)]\s+/.test(line)) structure.numbered_lines++;
  }

  // Remove fenced code blocks wholesale, then inline plumbing.
  body = body.replace(/(?:```|~~~)[\s\S]*?(?:```|~~~)/g, "\n\n");
  body = body.replace(/`[^`]*`/g, " "); // inline code
  body = body.replace(/^\s*\|.*\|\s*$/gm, " "); // table rows
  body = body.replace(/!\[[^\]]*\]\([^)]*\)/g, " "); // images
  body = body.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"); // links -> text
  body = body.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, a, b) => b || a); // wikilinks
  body = body.replace(/https?:\/\/\S+/g, " "); // bare URLs
  body = body.replace(/^\s{0,3}#{1,6}\s+/gm, ""); // heading markers
  body = body.replace(/^\s{0,3}>\s?/gm, ""); // blockquote markers
  body = body.replace(/^\s*[-*+]\s+/gm, ""); // bullet markers
  body = body.replace(/^\s*\d+[.)]\s+/gm, ""); // numbered markers
  body = body.replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1"); // emphasis

  return { prose: body, structure };
}

export function splitParagraphs(prose: string): string[] {
  return prose
    .split(/\n\s*\n+/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);
}

/**
 * Split prose into sentences. Splits on `.!?` followed by whitespace, guarding
 * against common abbreviations and decimal points so "e.g. foo" and "v3.2"
 * don't fragment.
 */
export function splitSentences(text: string): string[] {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return [];
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < flat.length; i++) {
    const c = flat[i];
    if (c !== "." && c !== "!" && c !== "?") continue;
    // Consume a run of terminal punctuation ("?!", "...").
    let j = i;
    while (j + 1 < flat.length && ".!?".includes(flat[j + 1])) j++;
    const next = flat[j + 1];
    if (next !== undefined && next !== " ") {
      i = j;
      continue;
    }
    // Decimal number: "3.14" — the char before and after the dot are digits.
    if (c === "." && /\d/.test(flat[i - 1] ?? "") && /\d/.test(flat[j + 2] ?? "")) {
      continue;
    }
    // Abbreviation guard: the token immediately before the dot.
    if (c === ".") {
      const before = flat.slice(0, i + 1);
      const m = before.match(/([A-Za-z][A-Za-z.]*)\.$/);
      const tok = m?.[1]?.toLowerCase().replace(/\.$/, "");
      if (tok && ABBREVIATIONS.has(tok)) continue;
    }
    out.push(flat.slice(start, j + 1).trim());
    start = j + 1;
    i = j;
  }
  const tail = flat.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

export function tokenizeWords(text: string): string[] {
  const matches = text.toLowerCase().match(/[\p{L}][\p{L}'’-]*/gu);
  return matches ?? [];
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length;
  return Math.sqrt(v);
}

/** Moving-average type-token ratio — vocabulary richness that, unlike plain
 *  TTR, is stable as the corpus grows (plain TTR falls with length). */
function mattr(tokens: string[], window = 100): number {
  if (tokens.length === 0) return 0;
  if (tokens.length <= window) {
    return new Set(tokens).size / tokens.length;
  }
  let sum = 0;
  let n = 0;
  for (let i = 0; i + window <= tokens.length; i++) {
    const slice = tokens.slice(i, i + window);
    sum += new Set(slice).size / window;
    n++;
  }
  return n === 0 ? 0 : sum / n;
}

function round(n: number, places = 4): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function countMatches(text: string, re: RegExp): number {
  const m = text.match(re);
  return m ? m.length : 0;
}

function topNgrams(tokens: string[], n: number, top: number): [string, number][] {
  const counts = new Map<string, number>();
  for (let i = 0; i + n <= tokens.length; i++) {
    const gram = tokens.slice(i, i + n);
    // Skip grams made entirely of stopwords — keep the writer's phrasing.
    if (gram.every((w) => NGRAM_STOPWORDS.has(w))) continue;
    const key = gram.join(" ");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, c]) => c > 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, top);
}

const EXPANDED_FORMS_RE =
  /\b(?:do not|does not|did not|is not|are not|was not|were not|will not|would not|could not|should not|cannot|can not|have not|has not|had not|it is|that is|they are|we are|you are|i am|let us)\b/gi;
const CONTRACTION_RE = /\b[a-z]+['’](?:t|s|re|ve|ll|d|m)\b/gi;

/**
 * Compute the full metric set over one or more documents' raw markdown.
 * Empty / whitespace-only input yields an all-zero profile (every per-1k
 * normalization guards against divide-by-zero).
 */
export function computeMetrics(docs: string[]): StyleMetrics {
  const stripped = docs.map((d) => stripMarkdown(d));
  const prose = stripped.map((s) => s.prose).join("\n\n");

  const paragraphs = stripped.flatMap((s) => splitParagraphs(s.prose));
  const sentences = splitSentences(prose);
  const tokens = tokenizeWords(prose);
  const wordCount = tokens.length;
  const per1k = (n: number) => (wordCount > 0 ? round((n / wordCount) * 1000) : 0);

  const sentenceLens = sentences.map((s) => tokenizeWords(s).length).filter((n) => n > 0);
  const paragraphLens = paragraphs.map((p) => tokenizeWords(p).length).filter((n) => n > 0);

  const sMean = mean(sentenceLens);
  const sStdev = stdev(sentenceLens);

  // Function-word vector (per 1k words).
  const tokenCounts = new Map<string, number>();
  for (const t of tokens) tokenCounts.set(t, (tokenCounts.get(t) ?? 0) + 1);
  const functionWords: Record<string, number> = {};
  for (const w of FUNCTION_WORDS) functionWords[w] = per1k(tokenCounts.get(w) ?? 0);

  // Punctuation over the prose (markers already stripped, so these are the
  // author's, not markdown's).
  const punctuation = {
    em_dash: per1k(countMatches(prose, /—|--/g)),
    en_dash: per1k(countMatches(prose, /–/g)),
    semicolon: per1k(countMatches(prose, /;/g)),
    colon: per1k(countMatches(prose, /:/g)),
    parens: per1k(countMatches(prose, /\(/g)),
    exclamation: per1k(countMatches(prose, /!/g)),
    question: per1k(countMatches(prose, /\?/g)),
    ellipsis: per1k(countMatches(prose, /\.\.\.|…/g)),
    oxford_comma_rate: oxfordCommaRate(prose),
  };

  const contractions = countMatches(prose, CONTRACTION_RE);
  const expanded = countMatches(prose, EXPANDED_FORMS_RE);
  const contractionRate =
    contractions + expanded > 0 ? round(contractions / (contractions + expanded)) : 0;

  const aiTells: Record<string, number> = {};
  for (const { name, re } of AI_TELL_PATTERNS) {
    aiTells[name] = per1k(countMatches(prose, new RegExp(re.source, re.flags)));
  }

  const totalStructLines =
    stripped.reduce((a, s) => a + s.structure.total_lines, 0) || 1;
  const sum = (pick: (s: MarkdownStructure) => number) =>
    stripped.reduce((a, s) => a + pick(s.structure), 0);
  const markdown = {
    heading_rate: round(sum((s) => s.heading_lines) / totalStructLines),
    bullet_rate: round(sum((s) => s.bullet_lines) / totalStructLines),
    numbered_rate: round(sum((s) => s.numbered_lines) / totalStructLines),
    code_fence_rate: round(sum((s) => s.code_fences) / totalStructLines),
  };

  return {
    doc_count: docs.length,
    word_count: wordCount,
    sentence: {
      mean_len: round(sMean, 2),
      stdev_len: round(sStdev, 2),
      burstiness: sMean > 0 ? round(sStdev / sMean) : 0,
    },
    paragraph: {
      mean_len_words: round(mean(paragraphLens), 2),
      stdev_len_words: round(stdev(paragraphLens), 2),
    },
    type_token_ratio: round(mattr(tokens)),
    function_words: functionWords,
    punctuation,
    contraction_rate: contractionRate,
    markdown,
    top_bigrams: topNgrams(tokens, 2, 20),
    top_trigrams: topNgrams(tokens, 3, 20),
    ai_tells: aiTells,
  };
}

/** Rough serial-comma proxy: fraction of coordinating conjunctions immediately
 *  preceded by a comma. Higher ⇒ the writer tends to use the Oxford comma. */
function oxfordCommaRate(prose: string): number {
  const conjunctions = countMatches(prose, /\b(?:and|or|nor)\b/gi);
  if (conjunctions === 0) return 0;
  const serial = countMatches(prose, /,\s+(?:and|or|nor)\b/gi);
  return round(serial / conjunctions);
}

// --- StyleCheck (deterministic "humanize" lint) ---------------------------

export type StyleCheckReport = {
  has_profile: boolean;
  deviations: {
    sentence_mean_delta: number;
    sentence_burstiness_delta: number;
    contraction_delta: number;
    function_word_drift: number;
  };
  hits: {
    em_dash: number;
    ai_tells: { phrase: string; count: number }[];
  };
  verdict: "close" | "drifting" | "off";
  suggestions: string[];
};

/** Cosine distance (0 = identical direction, 1 = orthogonal) between two
 *  function-word frequency vectors. */
function functionWordDrift(
  a: Record<string, number>,
  b: Record<string, number>,
): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const w of FUNCTION_WORDS) {
    const x = a[w] ?? 0;
    const y = b[w] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return round(1 - dot / (Math.sqrt(na) * Math.sqrt(nb)));
}

export type MetricComparison = {
  function_word_drift: number;
  sentence_mean_delta: number;
  sentence_burstiness_delta: number;
  contraction_delta: number;
};

/**
 * Compare two metric sets, `a` relative to `b` (deltas are `a - b`). Used by
 * StyleCheck (candidate vs profile) and AnalyzeSamples (a source vs the saved
 * profile).
 */
export function compareMetrics(a: StyleMetrics, b: StyleMetrics): MetricComparison {
  return {
    function_word_drift: functionWordDrift(a.function_words, b.function_words),
    sentence_mean_delta: round(a.sentence.mean_len - b.sentence.mean_len, 2),
    sentence_burstiness_delta: round(a.sentence.burstiness - b.sentence.burstiness),
    contraction_delta: round(a.contraction_rate - b.contraction_rate),
  };
}

/**
 * Compare a candidate passage against the measured profile. Purely
 * deterministic and pref-free — voice rules (em-dashes, words to avoid, …) live
 * in the prose voice guide, which the agent reads separately. This flags drift
 * from the *measured* style plus the built-in AI-tell list. Advisory; never
 * throws or blocks.
 */
export function styleCheck(
  text: string,
  profile: StyleMetrics | null,
): StyleCheckReport {
  const m = computeMetrics([text]);
  const hasProfile = profile !== null && profile.word_count > 0;

  const deviations: MetricComparison = hasProfile
    ? compareMetrics(m, profile!)
    : {
        sentence_mean_delta: 0,
        sentence_burstiness_delta: 0,
        contraction_delta: 0,
        function_word_drift: 0,
      };

  const tells: { phrase: string; count: number }[] = [];
  for (const { name, re } of AI_TELL_PATTERNS) {
    const count = countMatches(text, new RegExp(re.source, re.flags));
    if (count > 0) tells.push({ phrase: name, count });
  }
  tells.sort((a, b) => b.count - a.count);

  const emDashCount = countMatches(text, /—|--/g);
  // "Overuse" is measured, not a preference: the corpus barely uses em-dashes
  // but this draft does.
  const emDashOveruse =
    hasProfile && profile!.punctuation.em_dash === 0 && m.punctuation.em_dash > 0;

  const suggestions: string[] = [];
  if (emDashOveruse) {
    suggestions.push(
      `Em-dashes appear here but never in your corpus — consider commas or periods instead.`,
    );
  }
  if (tells.length > 0) {
    suggestions.push(
      `AI-tell phrasing to reconsider: ${tells.slice(0, 6).map((t) => `"${t.phrase}"`).join(", ")}.`,
    );
  }
  if (hasProfile && Math.abs(deviations.sentence_mean_delta) >= 6) {
    const dir = deviations.sentence_mean_delta > 0 ? "longer" : "shorter";
    suggestions.push(
      `Sentences run ${Math.abs(deviations.sentence_mean_delta).toFixed(1)} words ${dir} than your average (${profile!.sentence.mean_len}); ${dir === "longer" ? "split some up" : "let some breathe"}.`,
    );
  }
  if (
    hasProfile &&
    profile!.contraction_rate >= 0.5 &&
    m.contraction_rate < 0.2
  ) {
    suggestions.push(
      `You usually write with contractions; this reads more formal than your voice.`,
    );
  }

  // Roll the signals up into one verdict.
  let verdict: StyleCheckReport["verdict"] = "close";
  const drift = deviations.function_word_drift;
  if (
    tells.length >= 3 ||
    drift >= 0.35 ||
    Math.abs(deviations.sentence_mean_delta) >= 10
  ) {
    verdict = "off";
  } else if (
    tells.length >= 1 ||
    drift >= 0.18 ||
    Math.abs(deviations.sentence_mean_delta) >= 6 ||
    emDashOveruse
  ) {
    verdict = "drifting";
  }

  return {
    has_profile: hasProfile,
    deviations,
    hits: { em_dash: emDashCount, ai_tells: tells },
    verdict,
    suggestions,
  };
}

/** Human-readable digest of a profile — the compact form `GetStyle` returns
 *  instead of the full metric blob (~8-10 lines). Descriptive only; voice rules
 *  live in the prose guide. */
export function renderMetricsSummary(m: StyleMetrics): string {
  if (m.word_count === 0) return "(no corpus analyzed yet)";
  const topFn = Object.entries(m.function_words)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([w]) => w)
    .join(", ");
  const tells = Object.entries(m.ai_tells)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([w]) => w);
  const phrases = m.top_bigrams.slice(0, 4).map(([g]) => `"${g}"`).join(", ");
  const lines = [
    `Corpus: ${m.doc_count} doc(s), ~${m.word_count} words.`,
    `Sentences: ${m.sentence.mean_len} words avg (±${m.sentence.stdev_len}, burstiness ${m.sentence.burstiness}).`,
    `Paragraphs: ${m.paragraph.mean_len_words} words avg.`,
    `Vocabulary richness (MATTR): ${m.type_token_ratio}.`,
    `Contractions: ${Math.round(m.contraction_rate * 100)}% of negation/copula forms.`,
    `Punctuation /1k: em-dash ${m.punctuation.em_dash}, semicolon ${m.punctuation.semicolon}, colon ${m.punctuation.colon}, parens ${m.punctuation.parens}, '!' ${m.punctuation.exclamation}, '?' ${m.punctuation.question}.`,
    `Serial-comma tendency: ${Math.round(m.punctuation.oxford_comma_rate * 100)}%.`,
    `Frequent function words: ${topFn}.`,
    phrases ? `Recurring phrasing: ${phrases}.` : `Recurring phrasing: (none repeated).`,
  ];
  if (tells.length > 0) {
    lines.push(`Note: corpus already contains "${tells.join('", "')}" — not necessarily tells for you.`);
  }
  return lines.join("\n");
}

/**
 * Zod schemas for the on-disk style artifacts under `.sheaf/`. Applied on every
 * read so a hand-edited or drifted file surfaces as "no profile" / "default
 * config" rather than crashing the backend — mirrors persistence-schemas.ts.
 */

import { z } from "zod";

import type { StyleConfig, StyleProfile } from "./profile";
import { STYLE_PROFILE_VERSION } from "./profile";

const finite = z.number().finite();

export const stylePrefsSchema = z.object({
  em_dash: z.enum(["yes", "no", "either"]),
  oxford_comma: z.enum(["yes", "no", "either"]),
  contractions: z.enum(["yes", "no", "either"]),
  banned_phrases: z.array(z.string().max(200)).max(100),
});

export const styleConfigSchema = z.object({
  enabled: z.boolean(),
  exclude_globs: z.array(z.string().max(256)).max(100),
  recency_half_life_days: finite.positive().max(100_000),
  refresh_after_doc_changes: z.number().int().min(1).max(100_000),
  exemplar_count: z.number().int().min(1).max(8),
  prefs: stylePrefsSchema,
}) satisfies z.ZodType<StyleConfig>;

const ngramListSchema = z.array(z.tuple([z.string().max(200), finite])).max(64);

const styleMetricsSchema = z.object({
  doc_count: finite,
  word_count: finite,
  sentence: z.object({
    mean_len: finite,
    stdev_len: finite,
    burstiness: finite,
  }),
  paragraph: z.object({
    mean_len_words: finite,
    stdev_len_words: finite,
  }),
  type_token_ratio: finite,
  function_words: z.record(z.string(), finite),
  punctuation: z.object({
    em_dash: finite,
    en_dash: finite,
    semicolon: finite,
    colon: finite,
    parens: finite,
    exclamation: finite,
    question: finite,
    ellipsis: finite,
    oxford_comma_rate: finite,
  }),
  contraction_rate: finite,
  markdown: z.object({
    heading_rate: finite,
    bullet_rate: finite,
    numbered_rate: finite,
    code_fence_rate: finite,
  }),
  top_bigrams: ngramListSchema,
  top_trigrams: ngramListSchema,
  ai_tells: z.record(z.string(), finite),
});

const corpusFingerprintSchema = z.object({
  doc_count: z.number().int().nonnegative(),
  total_bytes: z.number().int().nonnegative(),
  newest_mtime: finite,
  digest: z.string().max(64),
});

export const styleProfileSchema = z.object({
  version: z.literal(STYLE_PROFILE_VERSION),
  fingerprint: corpusFingerprintSchema,
  config_hash: z.string().max(64),
  metrics: styleMetricsSchema,
  computed_at: z.number().int(),
}) satisfies z.ZodType<StyleProfile>;

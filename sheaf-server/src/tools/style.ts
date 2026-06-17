import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Backend } from "../backend/index";
import { LIMITS, topicArg } from "../schemas";
import { toToolError } from "../errors";
import {
  type Exemplar,
  loadOrRefreshProfile,
  selectExemplars,
  selectSamples,
} from "../style/corpus";
import {
  compareMetrics,
  computeMetrics,
  renderMetricsSummary,
  stripMarkdown,
  styleCheck,
  tokenizeWords,
} from "../style/metrics";
import {
  VOICE_GUIDE_PATH,
  isGuideStale,
  isPlaceholderGuide,
} from "../style/profile";

/** Soft cap on the GetStyle text payload (~1.8k tokens). Exemplars are trimmed
 *  from the end if the assembled message would exceed it. */
const GET_STYLE_CHAR_BUDGET = 7_000;
const GUIDE_RENDER_CAP = 2_500;

/**
 * The voice-matching tools.
 *
 * `GetStyle`  — compact, per-write read path: distilled guide + metrics digest
 *               + a few relevant exemplars (~1.5k tokens, never the whole vault).
 * `StyleSamples` — bootstrap input: full metrics + diverse sample passages, so
 *               the agent can write the guide doc (`Sheaf/Voice Guide.md`).
 * `AnalyzeSamples` — deterministic stylometry over caller-supplied content (a
 *               personal site, files the agent fetched), compared to the profile.
 * `StyleCheck` — deterministic "humanize" lint of a candidate passage.
 *
 * The prose guide itself is the visible `Sheaf/Voice Guide.md` doc (the agent
 * writes it with the ordinary `Write` tool) — there is no SaveStyleGuide.
 */
export function registerStyleTools(server: McpServer, backend: Backend): void {
  registerGetStyle(server, backend);
  registerStyleSamples(server, backend);
  registerAnalyzeSamples(server, backend);
  registerStyleCheck(server, backend);
}

/** Read the distilled guide from the visible doc, or null if absent / still the
 *  build-time placeholder. */
async function readGuide(backend: Backend): Promise<string | null> {
  try {
    const doc = await backend.readDoc(VOICE_GUIDE_PATH, "main");
    if (doc.md.trim().length === 0 || isPlaceholderGuide(doc.md)) return null;
    return doc.md;
  } catch {
    return null;
  }
}

function renderExemplars(exemplars: Exemplar[]): string {
  if (exemplars.length === 0) return "";
  return [
    "## Exemplars (passages in your voice)",
    ...exemplars.map((e) => `### ${e.path}\n${e.excerpt}`),
  ].join("\n\n");
}

function registerGetStyle(server: McpServer, backend: Backend): void {
  server.registerTool(
    "GetStyle",
    {
      title: "GetStyle",
      description:
        "Get the user's writing voice for a prose task: a compact distilled style guide, a metrics digest, explicit preferences, and 2-4 relevant exemplar passages from their vault. Call this before drafting or rewriting prose. Cheap and context-bounded.",
      inputSchema: { topic: topicArg },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ topic }) => {
      try {
        const config = await backend.readStyleConfig();
        if (!config.enabled) {
          return {
            content: [
              {
                type: "text",
                text: "Voice matching is disabled in settings. Write in a neutral, clear voice.",
              },
            ],
            structuredContent: { enabled: false },
          };
        }

        const load = await loadOrRefreshProfile(backend, config);
        const { profile, corpus, allFiles, low_corpus } = load;

        const fullGuide = await readGuide(backend);
        const guideFile = allFiles.find((f) => f.path === VOICE_GUIDE_PATH);
        const guideMtime = fullGuide ? (guideFile?.mtime_ms ?? null) : null;
        const guide_stale = isGuideStale(
          guideMtime,
          corpus,
          config.refresh_after_doc_changes,
        );
        const guideText = fullGuide
          ? fullGuide.length > GUIDE_RENDER_CAP
            ? fullGuide.slice(0, GUIDE_RENDER_CAP) + "…"
            : fullGuide
          : null;

        const exemplars = low_corpus
          ? []
          : await selectExemplars(backend, config, corpus, topic);

        const summary = renderMetricsSummary(profile.metrics, config.prefs);

        const structured = {
          enabled: true,
          guide_md: guideText,
          guide_stale,
          low_corpus,
          metrics_summary: summary,
          prefs: config.prefs,
          exemplars,
        };

        const header: string[] = ["# Your writing voice"];
        if (low_corpus) {
          header.push(
            "_Corpus is small — treat this as a weak signal and lean on a clear, neutral voice._",
          );
        }
        if (!guideText) {
          header.push(
            "_No voice guide yet. Bootstrap one: call StyleSamples, then write `Sheaf/Voice Guide.md`._",
          );
        } else if (guide_stale) {
          header.push(
            "_Your voice guide is stale (corpus has grown). Consider re-running the bootstrap flow._",
          );
        }

        const sectionsFor = (ex: Exemplar[]) =>
          [
            header.join("\n"),
            guideText ? `## Voice guide\n${guideText}` : "",
            `## Metrics\n${summary}`,
            renderExemplars(ex),
            "When you draft, match this voice, then run StyleCheck before you land the edit.",
          ]
            .filter((s) => s.length > 0)
            .join("\n\n");

        // Budget enforcement: trim exemplars from the end until under cap.
        let text = sectionsFor(exemplars);
        while (text.length > GET_STYLE_CHAR_BUDGET && exemplars.length > 0) {
          exemplars.pop();
          text = sectionsFor(exemplars);
        }
        structured.exemplars = exemplars;

        return {
          content: [{ type: "text", text }],
          structuredContent: structured,
        };
      } catch (e) {
        return toToolError(e);
      }
    },
  );
}

function registerStyleSamples(server: McpServer, backend: Backend): void {
  server.registerTool(
    "StyleSamples",
    {
      title: "StyleSamples",
      description:
        "Bootstrap input for building/refreshing the voice guide: returns the full style metrics plus a diverse set of sample passages from the user's vault, and any existing guide. Read these, then write a compact prose style guide to `Sheaf/Voice Guide.md` with the Write tool.",
      inputSchema: {
        max_samples: z.number().int().min(1).max(20).optional(),
        max_words_per_sample: z.number().int().min(20).max(400).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ max_samples, max_words_per_sample }) => {
      try {
        const config = await backend.readStyleConfig();
        const load = await loadOrRefreshProfile(backend, config);
        const { profile, corpus } = load;

        const samples = await selectSamples(
          backend,
          config,
          corpus,
          max_samples ?? 8,
          max_words_per_sample ?? 130,
        );

        const existing_guide_md = await readGuide(backend);
        const summary = renderMetricsSummary(profile.metrics, config.prefs);
        const structured = {
          metrics: profile.metrics,
          metrics_summary: summary,
          prefs: config.prefs,
          samples,
          existing_guide_md,
        };

        const text = [
          "# Build the user's voice guide",
          "Read the metrics and the sample passages below, then write a SHORT (≤400 word) prose style guide describing how this person writes — sentence rhythm, diction, punctuation habits, structure, and what to avoid. Refine the existing guide rather than discard it. Then save it by writing the doc `Sheaf/Voice Guide.md` (the Write tool).",
          `## Metrics\n${summary}`,
          existing_guide_md
            ? `## Existing guide (refine this)\n${existing_guide_md}`
            : "## Existing guide\n(none yet)",
          "## Sample passages",
          ...samples.map((s) => `### ${s.path}\n${s.excerpt}`),
        ].join("\n\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: structured,
        };
      } catch (e) {
        return toToolError(e);
      }
    },
  );
}

function registerAnalyzeSamples(server: McpServer, backend: Backend): void {
  server.registerTool(
    "AnalyzeSamples",
    {
      title: "AnalyzeSamples",
      description:
        "Run the deterministic stylometry over writing you supply — e.g. pages from the user's personal site or files you fetched/read yourself — and compare it to their saved voice profile. Use this to fold extra sources into the voice guide: gather the text with your own tools (WebFetch/Read; crawl as asked), call this to measure it, then write the takeaways into `Sheaf/Voice Guide.md`. Stateless: it does not change the saved profile.",
      inputSchema: {
        samples: z
          .array(
            z.object({
              label: z
                .string()
                .max(200)
                .optional()
                .describe("Where this came from, e.g. a URL or filename."),
              content: z
                .string()
                .min(1)
                .max(LIMITS.analyzeContent)
                .describe("The raw text/markdown to analyze."),
            }),
          )
          .min(1)
          .max(20)
          .describe("One entry per source page/file."),
        compare: z
          .boolean()
          .optional()
          .describe("Compare against the saved vault profile (default true)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ samples, compare }) => {
      try {
        const config = await backend.readStyleConfig();
        const contents = samples.map((s) => s.content);
        const metrics = computeMetrics(contents);
        const summary = renderMetricsSummary(metrics, config.prefs);
        const per_sample = samples.map((s) => ({
          label: s.label ?? null,
          word_count: tokenizeWords(stripMarkdown(s.content).prose).length,
        }));

        let comparison: Record<string, unknown> | null = null;
        if (compare !== false) {
          const load = await loadOrRefreshProfile(backend, config);
          if (load.profile.metrics.word_count > 0) {
            comparison = {
              ...compareMetrics(metrics, load.profile.metrics),
              profile_summary: renderMetricsSummary(
                load.profile.metrics,
                config.prefs,
              ),
            };
          }
        }

        const lines = [
          "# Style analysis of supplied samples",
          summary,
        ];
        if (comparison) {
          lines.push(
            "",
            "## Compared to your saved voice (source minus your average)",
            `- function-word drift: ${comparison.function_word_drift} (0 = identical, 1 = unrelated)`,
            `- sentence length Δ: ${comparison.sentence_mean_delta} words`,
            `- burstiness Δ: ${comparison.sentence_burstiness_delta}`,
            `- contraction Δ: ${comparison.contraction_delta}`,
            "",
            "Decide what to carry into your voice guide (`Sheaf/Voice Guide.md`).",
          );
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: {
            metrics,
            metrics_summary: summary,
            per_sample,
            comparison,
          },
        };
      } catch (e) {
        return toToolError(e);
      }
    },
  );
}

function registerStyleCheck(server: McpServer, backend: Backend): void {
  server.registerTool(
    "StyleCheck",
    {
      title: "StyleCheck",
      description:
        "Deterministic 'humanize' lint: compares a candidate passage against the user's style profile and explicit preferences, flagging AI tells, banned phrases, and drift in sentence length / function words. Advisory — use it to self-correct before landing an edit.",
      inputSchema: {
        text: z
          .string()
          .min(1)
          .max(LIMITS.styleText)
          .describe("The candidate passage to check."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ text }) => {
      try {
        const config = await backend.readStyleConfig();
        const load = await loadOrRefreshProfile(backend, config);
        const metrics =
          load.profile.metrics.word_count > 0 ? load.profile.metrics : null;

        const report = styleCheck(text, metrics, config.prefs);

        const lines: string[] = [`verdict: ${report.verdict}`];
        if (report.suggestions.length > 0) {
          lines.push("", "suggestions:");
          for (const s of report.suggestions) lines.push(`- ${s}`);
        } else {
          lines.push("", "No issues found — this reads in the user's voice.");
        }
        if (!report.has_profile) {
          lines.push(
            "",
            "(No corpus profile yet — only rule-based checks applied. Bootstrap a voice guide for sentence/function-word comparison.)",
          );
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: report,
        };
      } catch (e) {
        return toToolError(e);
      }
    },
  );
}

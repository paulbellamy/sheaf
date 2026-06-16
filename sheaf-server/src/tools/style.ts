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
import { renderMetricsSummary, styleCheck } from "../style/metrics";
import { VOICE_GUIDE_PATH, isGuideStale } from "../style/profile";

/** Soft cap on the GetStyle text payload (~1.8k tokens). Exemplars are trimmed
 *  from the end if the assembled message would exceed it. */
const GET_STYLE_CHAR_BUDGET = 7_000;
const GUIDE_RENDER_CAP = 2_500;

/**
 * The voice-matching tools.
 *
 * `GetStyle`  — compact, per-write read path: distilled guide + metrics digest
 *               + a few relevant exemplars (~1.5k tokens, never the whole vault).
 * `StyleSamples` — bootstrap input: full metrics + diverse sample passages for
 *               the agent to distill a guide from.
 * `SaveStyleGuide` — persist the agent-distilled guide (cache + visible doc).
 * `StyleCheck` — deterministic "humanize" lint of a candidate passage.
 */
export function registerStyleTools(server: McpServer, backend: Backend): void {
  registerGetStyle(server, backend);
  registerStyleSamples(server, backend);
  registerSaveStyleGuide(server, backend);
  registerStyleCheck(server, backend);
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
        const { profile, corpus, low_corpus } = load;
        const guide_stale = isGuideStale(profile, config);

        const exemplars = low_corpus
          ? []
          : await selectExemplars(backend, config, corpus, topic);

        const summary = renderMetricsSummary(profile.metrics, config.prefs);
        const guideText = profile.guide_md
          ? profile.guide_md.length > GUIDE_RENDER_CAP
            ? profile.guide_md.slice(0, GUIDE_RENDER_CAP) + "…"
            : profile.guide_md
          : null;

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
            "_No distilled voice guide yet. Bootstrap one: call StyleSamples, write a short guide, then SaveStyleGuide._",
          );
        } else if (guide_stale) {
          header.push(
            "_Your voice guide is stale (corpus has grown). Consider re-running the bootstrap flow._",
          );
        }

        const sections = [
          header.join("\n"),
          guideText ? `## Voice guide\n${guideText}` : "",
          `## Metrics\n${summary}`,
          renderExemplars(exemplars),
          "When you draft, match this voice, then run StyleCheck before you land the edit.",
        ].filter((s) => s.length > 0);

        // Budget enforcement: trim exemplars from the end until under cap.
        let text = sections.join("\n\n");
        while (text.length > GET_STYLE_CHAR_BUDGET && exemplars.length > 0) {
          exemplars.pop();
          const trimmed = [
            header.join("\n"),
            guideText ? `## Voice guide\n${guideText}` : "",
            `## Metrics\n${summary}`,
            renderExemplars(exemplars),
            "When you draft, match this voice, then run StyleCheck before you land the edit.",
          ].filter((s) => s.length > 0);
          text = trimmed.join("\n\n");
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
        "Bootstrap input for building/refreshing the voice guide: returns the full style metrics plus a diverse set of sample passages from the user's vault, and any existing guide. Read these, then write a compact prose style guide and save it with SaveStyleGuide.",
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

        let existing_guide_md: string | null = profile.guide_md;
        try {
          const doc = await backend.readDoc(VOICE_GUIDE_PATH, "main");
          if (doc.md.trim().length > 0) existing_guide_md = doc.md;
        } catch {
          // No visible guide doc yet — use the cached guide_md (or null).
        }

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
          "Read the metrics and the sample passages below, then write a SHORT (≤400 word) prose style guide describing how this person writes — sentence rhythm, diction, punctuation habits, structure, and what to avoid. Refine the existing guide rather than discard it. Then call SaveStyleGuide.",
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

function registerSaveStyleGuide(server: McpServer, backend: Backend): void {
  server.registerTool(
    "SaveStyleGuide",
    {
      title: "SaveStyleGuide",
      description:
        "Persist a distilled prose style guide describing the user's writing voice. Caches it for GetStyle and mirrors it to a visible, user-editable doc (Sheaf/Voice Guide.md).",
      inputSchema: {
        guide_md: z
          .string()
          .min(1)
          .max(LIMITS.styleGuide)
          .describe("The distilled voice guide, in markdown (compact — a page or less)."),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ guide_md }) => {
      try {
        const config = await backend.readStyleConfig();
        const load = await loadOrRefreshProfile(backend, config);
        const profile = load.profile;

        profile.guide_md = guide_md;
        profile.guide_generated_at = Date.now();
        profile.guide_doc_count = profile.fingerprint.doc_count;
        await backend.writeStyleProfile(profile);

        // Mirror to a visible, user-editable vault doc (excluded from the
        // corpus by default so it can't feed itself).
        await backend.writeDoc(VOICE_GUIDE_PATH, "main", guide_md, undefined, "agent");

        return {
          content: [
            {
              type: "text",
              text: `Saved voice guide (${guide_md.length} chars). Mirrored to ${VOICE_GUIDE_PATH} — the user can edit it there.`,
            },
          ],
          structuredContent: {
            ok: true,
            guide_chars: guide_md.length,
            path: VOICE_GUIDE_PATH,
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

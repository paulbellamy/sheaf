/**
 * Thread <-> RFM codec for the filesystem backend (`backend/stub.ts` owns the
 * files). A doc's YAML endmatter authoritatively stores the full record for
 * every thread *homed* in the doc (home = `targets[0].path`); the inline
 * CriticMarkup spans are a regenerated projection. A thread's `draft_id` is
 * derived from the doc's storage location (main vs a `.drafts/<id>/` override),
 * not stored — callers pass it in on parse.
 */

import {
  composeDoc,
  renderInlineMarkers,
  splitEndmatter,
  stripReviewMarkup,
  type Endmatter,
  type InlineMarker,
} from "../rfm/index";
import { threadOnDiskSchema } from "../persistence-schemas";
import type { DocPath, DraftId, Thread, ThreadDraftBody } from "./index";

/**
 * Clean canonical prose. `stripReviewMarkup` returns a plain doc untouched but
 * fails *closed* on a doc that carries injected markup with a broken endmatter,
 * so a comment body can never leak into what `readDoc`/`grep` surface.
 */
export function cleanProse(rawMd: string): string {
  return stripReviewMarkup(rawMd);
}

export function parseReviewDoc(
  rawMd: string,
  draftId?: DraftId,
): { prose: string; threads: Thread[] } {
  return {
    prose: stripReviewMarkup(rawMd),
    threads: endmatterThreads(splitEndmatter(rawMd).endmatter, draftId),
  };
}

function endmatterThreads(
  endmatter: Endmatter | null,
  draftId?: DraftId,
): Thread[] {
  if (!endmatter) return [];
  const out: Thread[] = [];
  for (const bucket of ["comments", "suggestions"] as const) {
    const map = endmatter[bucket];
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    for (const [id, value] of Object.entries(map as Record<string, unknown>)) {
      // Location (not any stored value) is authoritative for draft scoping, so
      // drop a stored draft_id and re-derive it; letting Zod re-emit in schema
      // order keeps the Thread JSON byte-identical to the pre-migration shape.
      let candidate: unknown = value;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const rest: Record<string, unknown> = {
          ...(value as Record<string, unknown>),
        };
        delete rest.draft_id;
        candidate =
          draftId !== undefined ? { ...rest, id, draft_id: draftId } : { ...rest, id };
      }
      const parsed = threadOnDiskSchema.safeParse(candidate);
      if (!parsed.success) continue; // skip drifted/corrupt record
      out.push(parsed.data as Thread);
    }
  }
  return out.sort((a, b) => a.created - b.created);
}

/**
 * Serialize clean prose + the threads homed in `homePath` into one RFM doc.
 * Returns `prose` unchanged when there are no threads.
 */
export function serializeReviewDoc(
  prose: string,
  threads: Thread[],
  homePath: DocPath,
): string {
  const markers: InlineMarker[] = [];
  for (const t of threads) {
    const tgt = t.targets.find(
      (x) => x.path === homePath && x.scope === "range",
    );
    if (!tgt || tgt.scope !== "range") continue;
    const range = decodeRelPos(tgt.anchor.rel_pos);
    const anchoredText = tgt.anchor.anchored_text;
    const draft = singleDraft(t);
    const common = {
      id: t.id,
      from: range?.from ?? 0,
      to: range?.to ?? 0,
      anchoredText,
    };
    if (draft && draft.new_md.length > 0 && anchoredText.length > 0) {
      markers.push({ ...common, kind: "substitution", newText: draft.new_md });
    } else {
      markers.push({
        ...common,
        kind: "comment",
        commentBody: t.messages[0]?.body ?? "",
      });
    }
  }
  const body = renderInlineMarkers(prose, markers);
  return composeDoc(body, threadsToEndmatter(threads));
}

function threadsToEndmatter(threads: Thread[]): Endmatter | null {
  const comments: Record<string, unknown> = {};
  const suggestions: Record<string, unknown> = {};
  for (const t of threads) {
    const proposesChange = t.messages.some(
      (m) => m.draft || (m.draft_options && m.draft_options.length > 0),
    );
    (proposesChange ? suggestions : comments)[t.id] = threadRecord(t);
  }
  const endmatter: Endmatter = {};
  if (Object.keys(comments).length > 0) endmatter.comments = comments;
  if (Object.keys(suggestions).length > 0) endmatter.suggestions = suggestions;
  return Object.keys(endmatter).length > 0 ? endmatter : null;
}

/** `id` (the map key) and `draft_id` (location-derived) are omitted; `by`/`at`
 *  mirror the root message for roughdraft interop and are ignored on read. */
function threadRecord(t: Thread): Record<string, unknown> {
  const root = t.messages[0];
  return {
    by: root?.author ?? "agent",
    at: new Date(root?.ts ?? t.created).toISOString(),
    status: t.status,
    created: t.created,
    targets: t.targets,
    messages: t.messages,
  };
}

/** The single proposed replacement to show inline, or null when the thread
 *  carries no draft or carries multiple options (which can't be one span). */
function singleDraft(t: Thread): ThreadDraftBody | null {
  for (let i = t.messages.length - 1; i >= 0; i--) {
    const m = t.messages[i];
    if (m.draft_options && m.draft_options.length > 0) {
      return m.draft_options.length === 1 ? m.draft_options[0] : null;
    }
    if (m.draft) return m.draft;
  }
  return null;
}

function decodeRelPos(relPos: string): { from: number; to: number } | null {
  try {
    const json = Buffer.from(relPos, "base64").toString("utf8");
    const parsed = JSON.parse(json) as { from: unknown; to: unknown };
    if (typeof parsed.from === "number" && typeof parsed.to === "number") {
      return { from: parsed.from, to: parsed.to };
    }
  } catch {
    /* fall through */
  }
  return null;
}

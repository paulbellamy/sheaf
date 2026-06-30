/**
 * Thread <-> RFM mapping for the filesystem backend.
 *
 * A doc's review state lives inline in its markdown (see
 * `docs/roughdraft-review-markup.md`): a YAML endmatter block authoritatively
 * stores the full thread records for every thread *homed* in that doc (home =
 * `targets[0].path`), and the inline CriticMarkup spans are a regenerated
 * projection of those records onto the prose. This module is the codec between
 * the two; `backend/stub.ts` calls it and owns the filesystem.
 *
 * The endmatter uses roughdraft's two buckets — a thread lands under
 * `suggestions:` when any message carries a draft (it proposes a change) and
 * under `comments:` otherwise — keyed by the sheaf thread id. The thread's
 * `draft_id` is *not* stored: a doc's storage location (main vs a
 * `.drafts/<id>/` override) is the authoritative source for it, so callers pass
 * it in on parse.
 */

import {
  composeDoc,
  renderInlineMarkers,
  splitEndmatter,
  stripInlineMarkup,
  type Endmatter,
  type InlineMarker,
} from "../rfm/index";
import { threadOnDiskSchema } from "../persistence-schemas";
import type { DocPath, DraftId, Thread, ThreadDraftBody } from "./index";

/**
 * Clean canonical prose. Only a doc that carries a real review endmatter has
 * sheaf-injected inline markup; for any other doc we return the bytes untouched,
 * so prose that legitimately contains CriticMarkup-like text (a tutorial, this
 * repo's own RFM docs) round-trips intact instead of being silently stripped.
 */
export function cleanProse(rawMd: string): string {
  const split = splitEndmatter(rawMd);
  return split.endmatter ? stripInlineMarkup(split.body) : rawMd;
}

/** Parse a doc's raw markdown into its clean prose plus the threads it homes. */
export function parseReviewDoc(
  rawMd: string,
  draftId?: DraftId,
): { prose: string; threads: Thread[] } {
  const split = splitEndmatter(rawMd);
  return {
    prose: split.endmatter ? stripInlineMarkup(split.body) : rawMd,
    threads: endmatterThreads(split.endmatter, draftId),
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
      // The map key is the authoritative id, and the file's location (not any
      // stored value) is authoritative for draft scoping. Drop any stored
      // draft_id and re-derive it from location, then let Zod emit keys in
      // canonical schema order — keeping the Thread JSON byte-identical to the
      // pre-migration shape (`draft_id` as the 4th key, present only for
      // draft-scoped threads).
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
 * Serialize clean prose + the threads homed in `homePath` back into one RFM
 * document: inline marker projection for each home-doc range anchor, plus the
 * authoritative YAML endmatter. With no threads this returns `prose` unchanged.
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

/** The stored record for a thread. `id` is the map key; `draft_id` is implied
 *  by location. `by`/`at` mirror the root message for roughdraft interop and
 *  legibility, and are ignored on read. */
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

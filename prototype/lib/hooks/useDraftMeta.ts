"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { subscribeBackendEvents } from "./useBackendEvents";

export type DraftMeta = {
  draft_id: string;
  display_name: string;
  base_version: number;
  touches: string[];
  open_count: number;
  state: "open" | "submitted" | "accepted" | "declined";
  versions_behind: number;
};

/**
 * Fetches `/api/ui/drafts/<id>` for the draft-mode banner (Phase D).
 *
 * Re-fetches on:
 *   - mount, when `docRef` is a draft id;
 *   - any `thread_changed` SSE event (open_count may have changed);
 *   - any `draft_state` SSE event matching this draft.
 *
 * Refetching on every `thread_changed` (rather than scoping by
 * target_paths) is intentional simplicity for v0 — the GET is cheap and
 * the banner only needs `open_count` accuracy, not load minimization.
 */
export function useDraftMeta(docRef: string | undefined): {
  data: DraftMeta | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
} {
  const [data, setData] = useState<DraftMeta | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);
  const isDraft = !!docRef && docRef.startsWith("draft_");

  const load = useCallback(async () => {
    if (!isDraft || !docRef) return;
    const mySeq = ++seqRef.current;
    setIsLoading(true);
    try {
      const r = await fetch(
        `/api/ui/drafts/${encodeURIComponent(docRef)}`,
        { cache: "no-store" },
      );
      if (mySeq !== seqRef.current) return;
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `HTTP ${r.status}`);
        setData(null);
        return;
      }
      const body = (await r.json()) as DraftMeta;
      if (mySeq !== seqRef.current) return;
      setError(null);
      setData({
        draft_id: body.draft_id,
        display_name: body.display_name,
        base_version: body.base_version,
        touches: body.touches,
        open_count: body.open_count,
        state: body.state,
        versions_behind: body.versions_behind ?? 0,
      });
    } catch (e) {
      if (mySeq !== seqRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mySeq === seqRef.current) setIsLoading(false);
    }
  }, [docRef, isDraft]);

  useEffect(() => {
    if (!isDraft) {
      setData(null);
      setError(null);
      return;
    }
    void load();
    const unsubscribe = subscribeBackendEvents((event) => {
      if (event.kind === "thread_changed") {
        void load();
      } else if (
        event.kind === "draft_state" &&
        event.draft_id === docRef
      ) {
        void load();
      } else if (event.kind === "draft_merged") {
        // Another draft just landed on main; recompute `versions_behind`
        // for this still-open draft.
        void load();
      } else if (event.kind === "stream_reset") {
        // Continuity lost (reconnect after a server restart) — re-sync.
        void load();
      }
    });
    return () => {
      seqRef.current += 1;
      unsubscribe();
    };
  }, [docRef, isDraft, load]);

  return { data, isLoading, error, refetch: load };
}

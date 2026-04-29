import { useCallback, useRef } from "react";
import type { Editor } from "@tiptap/react";
import { useRouter } from "next/navigation";

import type { Thread } from "@/lib/types";
import { rangeToAnchor } from "@/lib/md-anchor";
import type { ThreadView } from "@/components/ThreadCard";

type Params = {
  editor: Editor | null;
  docPath: string | undefined;
  docRef: string;
  versionCounter: number | undefined;
  threads: Thread[];
  mdRef: { current: string };
  getThreadView: (threadId: string) => ThreadView | null;
  setThreads: (updater: (prev: Thread[]) => Thread[]) => void;
  setSubmitError: (err: string | null) => void;
  setShowReview: (open: boolean) => void;
};

type StartDraftArgs = {
  name: string;
};

/**
 * Start-Draft pipeline: snapshot the editor doc + md, compute every pending
 * thread's anchor, POST once to `/api/ui/drafts` with the prepared payloads,
 * then navigate the editor to the new draft ref.
 *
 * Replaces the old per-thread submit flow against `?ref=main`. The threads
 * route now refuses `main` (Phase A); the draft route is the single atomic
 * entry point.
 */
export function useStartDraft({
  editor,
  docPath,
  docRef,
  versionCounter,
  threads,
  mdRef,
  getThreadView,
  setThreads,
  setSubmitError,
  setShowReview,
}: Params) {
  const busyRef = useRef(false);
  const router = useRouter();

  return useCallback(
    async ({ name }: StartDraftArgs) => {
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        setSubmitError(null);
        setShowReview(false);
        if (!docPath || !editor || docRef !== "main") return;
        const pending = threads.filter((t) => t.state === "pending");
        if (pending.length === 0) return;

        const snapshotMd = mdRef.current;

        const rangeFor = (t: Thread): { from: number; to: number } | null => {
          if (t.kind === "note" && t.anchor) return t.anchor;
          if (t.kind === "structural" && t.structural?.range)
            return t.structural.range;
          if (t.kind === "redline") {
            const view = getThreadView(t.id);
            const a = view?.del?.from ?? view?.ins?.from;
            const b = view?.del?.to ?? view?.ins?.to;
            if (a !== undefined && b !== undefined) return { from: a, to: b };
          }
          return null;
        };

        const initial_threads = pending.map((t) => {
          const range = rangeFor(t) ?? { from: 0, to: 0 };
          const anchor = rangeToAnchor(editor, snapshotMd, range.from, range.to);
          const message = t.note || `(${t.kind})`;
          return {
            targets: [
              { path: docPath, char_range: anchor.char_range },
            ],
            message,
          };
        });

        const r = await fetch("/api/ui/drafts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            base_path: docPath,
            base_ref: "main",
            base_version: versionCounter ?? 1,
            name,
            initial_threads,
          }),
        });
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as {
            error?: string;
          };
          setSubmitError(body.error ?? `HTTP ${r.status}`);
          return;
        }
        const body = (await r.json()) as {
          draft_id: string;
          display_name: string;
          base_version: number;
        };
        // Drop the local pending threads — `useServerThreads` will hydrate
        // freshly-persisted server copies once the editor's ref switches to
        // the new draft.
        setThreads((prev) => prev.filter((t) => t.state !== "pending"));
        router.push(`/doc/${docPath}?ref=${encodeURIComponent(body.draft_id)}`);
      } catch (e) {
        setSubmitError(e instanceof Error ? e.message : String(e));
      } finally {
        busyRef.current = false;
      }
    },
    [
      threads,
      docPath,
      docRef,
      editor,
      versionCounter,
      getThreadView,
      mdRef,
      router,
      setThreads,
      setSubmitError,
      setShowReview,
    ],
  );
}

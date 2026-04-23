import { useCallback, useRef } from "react";
import type { Editor } from "@tiptap/react";

import type { Thread } from "@/lib/types";
import { rangeToAnchor } from "@/lib/md-anchor";
import type { ThreadView } from "@/components/ThreadCard";

type Params = {
  editor: Editor | null;
  docPath: string | undefined;
  docRef: string;
  threads: Thread[];
  mdRef: { current: string };
  getThreadView: (threadId: string) => ThreadView | null;
  setThreads: (updater: (prev: Thread[]) => Thread[]) => void;
  setSubmitError: (err: string | null) => void;
  setShowReview: (open: boolean) => void;
};

/**
 * Submit pipeline: snapshot the editor doc + md, compute all anchors up-front
 * (so the user can keep typing without drifting anchors), POST threads in
 * parallel via Promise.allSettled, re-key PM marks from local ids to server
 * ids, flip state → submitted.
 *
 * A busy flag protects against double-clicks: the returned callback is a
 * no-op while a submit is already in flight.
 */
export function useSubmitReview({
  editor,
  docPath,
  docRef,
  threads,
  mdRef,
  getThreadView,
  setThreads,
  setSubmitError,
  setShowReview,
}: Params) {
  const busyRef = useRef(false);

  return useCallback(
    async (coverNote: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        setSubmitError(null);
        setShowReview(false);
        const pending = threads.filter((t) => t.state === "pending");
        if (!docPath) {
          setThreads((prev) =>
            prev.map((t) => {
              if (t.state !== "pending") return t;
              const note = coverNote && !t.note ? coverNote : t.note;
              return { ...t, state: "submitted", note };
            }),
          );
          return;
        }
        if (!editor) return;

        // Snapshot: resolve every anchor against the current doc before we
        // hit the network. If the user continues typing, their edits do not
        // retroactively move the anchors we're about to post.
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

        const prepared = pending.map((t) => {
          const range = rangeFor(t) ?? { from: 0, to: 0 };
          const anchor = rangeToAnchor(editor, snapshotMd, range.from, range.to);
          const message = t.note || coverNote || `(${t.kind})`;
          return { id: t.id, anchor, message };
        });

        // POST in parallel. Promise.allSettled so a single failure does not
        // block the remaining threads; we surface aggregated errors below.
        const results = await Promise.allSettled(
          prepared.map(async (p) => {
            const r = await fetch(
              `/api/ui/threads?ref=${encodeURIComponent(docRef)}`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  path: docPath,
                  message: p.message,
                  targets: [{ char_range: p.anchor.char_range }],
                }),
              },
            );
            if (!r.ok) {
              const body = (await r.json().catch(() => ({}))) as {
                error?: string;
              };
              throw new Error(body.error ?? `HTTP ${r.status}`);
            }
            const body = (await r.json()) as { thread_id: string };
            return { from: p.id, to: body.thread_id };
          }),
        );

        const failures: string[] = [];
        const rekey: Array<{ from: string; to: string }> = [];
        for (const res of results) {
          if (res.status === "fulfilled") rekey.push(res.value);
          else failures.push(res.reason instanceof Error ? res.reason.message : String(res.reason));
        }

        if (rekey.length > 0 && editor) {
          const schema = editor.state.schema;
          const insType = schema.marks.proposedInsertion;
          const delType = schema.marks.proposedDeletion;
          const map = new Map(rekey.map((r) => [r.from, r.to]));
          // Build the rekey transaction off the live doc. We don't use a
          // stashed snapshot here because the marks must move with any edits
          // the user made while the network calls were in flight.
          let tr = editor.state.tr;
          editor.state.doc.descendants((node, pos) => {
            if (!node.isText) return true;
            for (const m of node.marks) {
              if (m.type !== insType && m.type !== delType) continue;
              const next = map.get(m.attrs.threadId as string);
              if (!next) continue;
              tr = tr.removeMark(pos, pos + node.nodeSize, m.type);
              tr = tr.addMark(
                pos,
                pos + node.nodeSize,
                m.type.create({ threadId: next }),
              );
            }
            return true;
          });
          if (tr.steps.length > 0) editor.view.dispatch(tr);
        }

        setThreads((prev) => {
          const map = new Map(rekey.map((r) => [r.from, r.to]));
          return prev.map((t) => {
            const next = map.get(t.id);
            if (!next) return t;
            return { ...t, id: next, state: "submitted" };
          });
        });
        if (failures.length > 0) setSubmitError(failures.join("; "));
      } finally {
        busyRef.current = false;
      }
    },
    [
      threads,
      docPath,
      docRef,
      editor,
      getThreadView,
      mdRef,
      setThreads,
      setSubmitError,
      setShowReview,
    ],
  );
}

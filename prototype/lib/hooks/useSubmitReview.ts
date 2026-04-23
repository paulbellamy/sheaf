import { useCallback } from "react";
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
 * Submit pipeline: compute anchors, POST each pending thread, re-key PM marks
 * from local ids to server ids, flip state → submitted.
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
  return useCallback(
    async (coverNote: string) => {
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

      const failures: string[] = [];
      const rekey: Array<{ from: string; to: string }> = [];
      for (const t of pending) {
        const range = rangeFor(t) ?? { from: 0, to: 0 };
        const anchor = rangeToAnchor(editor, mdRef.current, range.from, range.to);
        const message = t.note || coverNote || `(${t.kind})`;
        try {
          const r = await fetch(
            `/api/ui/threads?ref=${encodeURIComponent(docRef)}`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                path: docPath,
                message,
                targets: [{ char_range: anchor.char_range }],
              }),
            },
          );
          if (!r.ok) {
            const body = (await r.json().catch(() => ({}))) as {
              error?: string;
            };
            failures.push(body.error ?? `HTTP ${r.status}`);
            continue;
          }
          const body = (await r.json()) as { thread_id: string };
          rekey.push({ from: t.id, to: body.thread_id });
        } catch (e) {
          failures.push(e instanceof Error ? e.message : String(e));
        }
      }

      if (rekey.length > 0) {
        const schema = editor.state.schema;
        const insType = schema.marks.proposedInsertion;
        const delType = schema.marks.proposedDeletion;
        const map = new Map(rekey.map((r) => [r.from, r.to]));
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

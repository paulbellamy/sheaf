import { useCallback } from "react";
import type { Editor } from "@tiptap/react";

import type { Thread } from "@/lib/types";
import type { ThreadView } from "@/components/ThreadCard";

type Params = {
  editor: Editor | null;
  threads: Thread[];
  getThreadView: (threadId: string) => ThreadView | null;
  setThreads: (updater: (prev: Thread[]) => Thread[]) => void;
  setActiveThreadId: (id: string | null) => void;
  onClearContextFor: (threadId: string) => void;
};

/**
 * Accept / decline a thread. For redline threads the two outcomes differ only
 * in which side (deletion or insertion) is dropped versus materialized.
 * Structural & note threads just dismiss the card (and call resolve() on the
 * server if they were submitted).
 */
export function useThreadOutcome({
  editor,
  threads,
  getThreadView,
  setThreads,
  setActiveThreadId,
  onClearContextFor,
}: Params) {
  const resolveOnServer = useCallback(async (threadId: string) => {
    try {
      await fetch(`/api/ui/threads/${threadId}/resolve`, { method: "POST" });
    } catch {
      /* Server-side resolution is best-effort. */
    }
  }, []);

  const applyOutcome = useCallback(
    (threadId: string, kind: "accept" | "decline") => {
      if (!editor) return;
      const target = threads.find((t) => t.id === threadId);
      if (!target) return;
      if (target.state !== "pending") void resolveOnServer(threadId);

      if (target.kind !== "redline") {
        setThreads((prev) => prev.filter((t) => t.id !== threadId));
        setActiveThreadId(null);
        return;
      }

      const view = getThreadView(threadId);
      if (!view) {
        setThreads((prev) => prev.filter((t) => t.id !== threadId));
        return;
      }

      const schema = editor.state.schema;
      const insType = schema.marks.proposedInsertion;
      const delType = schema.marks.proposedDeletion;

      // accept: materialize insertion, drop deletion.
      // decline: keep original text, drop insertion.
      const keepInsertion = kind === "accept";

      const ops: Array<{ kind: "delete" | "unmark"; from: number; to: number }> = [];
      if (view.del) {
        ops.push({
          kind: keepInsertion ? "delete" : "unmark",
          from: view.del.from,
          to: view.del.to,
        });
      }
      if (view.ins) {
        ops.push({
          kind: keepInsertion ? "unmark" : "delete",
          from: view.ins.from,
          to: view.ins.to,
        });
      }
      ops.sort((a, b) => b.from - a.from);

      let tr = editor.state.tr;
      for (const op of ops) {
        if (op.kind === "delete") tr = tr.delete(op.from, op.to);
        else {
          // On accept: unmark the insertion side (insType).
          // On decline: unmark the deletion side (delType).
          const type = keepInsertion ? insType : delType;
          tr = tr.removeMark(op.from, op.to, type);
        }
      }
      editor.view.dispatch(tr);

      setThreads((prev) => prev.filter((t) => t.id !== threadId));
      setActiveThreadId(null);
      onClearContextFor(threadId);
    },
    [
      editor,
      threads,
      getThreadView,
      setThreads,
      setActiveThreadId,
      onClearContextFor,
      resolveOnServer,
    ],
  );

  const acceptThread = useCallback(
    (threadId: string) => applyOutcome(threadId, "accept"),
    [applyOutcome],
  );

  const declineThread = useCallback(
    (threadId: string) => applyOutcome(threadId, "decline"),
    [applyOutcome],
  );

  return { acceptThread, declineThread };
}

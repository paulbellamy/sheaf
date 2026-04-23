import { useEffect, useRef } from "react";
import type { Editor } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";

import { newId, type Thread } from "@/lib/types";
import {
  TRACKED_FORMATTING_MARKS,
  collectFormattingTokens,
  diffFormattingTokens,
} from "@/lib/editor-helpers";
import {
  findThreadRange,
} from "@/components/extensions/ProposedDeletion";
import {
  findInsertionRange,
} from "@/components/extensions/ProposedInsertion";

const EMPTY_TOKENS = new Uint8Array(0);

/**
 * Own the per-transaction formatting reconciler. Forces MarginRail layout
 * recompute (via `onBump`), garbage-collects redline threads whose marks are
 * gone, and reconciles formatting threads with the baseline diff.
 */
export function useFormattingDiff(
  editor: Editor | null,
  setThreads: (updater: (prev: Thread[]) => Thread[]) => void,
  onBump: () => void,
) {
  const baselineDocRef = useRef<PMNode | null>(null);
  // Baseline doc is immutable after mount, so tokenize it once and reuse
  // on every transaction. That halves per-keystroke work and eliminates
  // ~O(n) allocations of baseline tokens per keystroke.
  const baselineTokensRef = useRef<Uint8Array>(EMPTY_TOKENS);

  useEffect(() => {
    if (!editor) return;
    if (!baselineDocRef.current) {
      baselineDocRef.current = editor.state.doc;
      baselineTokensRef.current = collectFormattingTokens(
        editor.state.doc,
        false,
      );
    }
    const trackedLabels = new Set(Object.values(TRACKED_FORMATTING_MARKS));

    const handler = () => {
      onBump();

      const baseline = baselineDocRef.current;
      const diffs = baseline
        ? diffFormattingTokens(
            baselineTokensRef.current,
            collectFormattingTokens(editor.state.doc, true),
          )
        : [];
      const diffKeys = new Set(
        diffs.map((d) => `${d.label}:${d.range.from}:${d.range.to}`),
      );

      setThreads((prev) => {
        let changed = false;

        // 1) Drop redline threads whose underlying marks are gone.
        const afterRedlineGC = prev.filter((t) => {
          if (t.kind !== "redline") return true;
          const hasDel = !!findThreadRange(editor.state.doc, t.id);
          const hasIns = !!findInsertionRange(editor.state.doc, t.id);
          if (!hasDel && !hasIns) {
            changed = true;
            return false;
          }
          return true;
        });

        // 2) Reconcile formatting threads with the current diff set.
        const isFormattingThread = (t: Thread) =>
          t.kind === "structural" &&
          !!t.structural?.range &&
          trackedLabels.has(t.structural.label);

        const seen = new Set<string>();
        const afterReconcile: Thread[] = [];
        for (const t of afterRedlineGC) {
          if (!isFormattingThread(t)) {
            afterReconcile.push(t);
            continue;
          }
          const k = `${t.structural!.label}:${t.structural!.range!.from}:${t.structural!.range!.to}`;
          if (diffKeys.has(k)) {
            afterReconcile.push(t);
            seen.add(k);
          } else if (t.note !== "" || t.state === "submitted") {
            afterReconcile.push(t);
            seen.add(k);
          } else {
            changed = true;
          }
        }
        for (const d of diffs) {
          const k = `${d.label}:${d.range.from}:${d.range.to}`;
          if (seen.has(k)) continue;
          afterReconcile.push({
            id: newId("strc"),
            kind: "structural",
            note: "",
            state: "pending",
            createdAt: Date.now(),
            structural: { label: d.label, range: d.range },
          });
          changed = true;
        }

        return changed ? afterReconcile : prev;
      });
    };
    editor.on("transaction", handler);
    handler();
    return () => {
      editor.off("transaction", handler);
    };
  }, [editor, setThreads, onBump]);

  return baselineDocRef;
}

import { useEffect, useRef } from "react";

import type { Thread } from "@/lib/types";
import type { Thread as BackendThread } from "@/lib/mcp/backend";
import { subscribeBackendEvents } from "./useBackendEvents";

function backendThreadToUiThread(t: BackendThread): Thread {
  return {
    id: t.id,
    kind: "note",
    note: "",
    state:
      t.status === "accepted" || t.status === "archived"
        ? "accepted"
        : t.status === "declined"
          ? "declined"
          : "submitted",
    createdAt: t.created,
    messages: t.messages,
  };
}

/**
 * Hydrate server threads on mount and whenever doc/ref changes, and re-hydrate
 * on SSE `thread_changed`. Server threads render as submitted note-cards;
 * they coexist with local pending threads keyed by distinct id prefixes.
 */
export function useServerThreads(
  docPath: string | undefined,
  docRef: string,
  setThreads: (updater: (prev: Thread[]) => Thread[]) => void,
) {
  const seqRef = useRef(0);
  useEffect(() => {
    if (!docPath) return;
    const load = async () => {
      const mySeq = ++seqRef.current;
      try {
        const r = await fetch(
          `/api/ui/threads?path=${encodeURIComponent(docPath)}&ref=${encodeURIComponent(docRef)}`,
          { cache: "no-store" },
        );
        if (!r.ok) return;
        const body = (await r.json()) as { threads: BackendThread[] };
        if (mySeq !== seqRef.current) return;
        const server = body.threads
          .filter((t) => t.status === "open")
          .map(backendThreadToUiThread);
        const serverIds = new Set(server.map((t) => t.id));
        setThreads((prev) => {
          const prevById = new Map(prev.map((t) => [t.id, t]));
          // For each server thread, if we already have a local copy, only
          // take the server's server-owned fields (id, kind, state, createdAt,
          // messages) and keep any locally-edited UI fields (note, collapsed,
          // autoFocus) — otherwise the user's in-progress typing would snap
          // back mid-keystroke when a concurrent thread_changed fires.
          const reconciled = server.map((s) => {
            const local = prevById.get(s.id);
            if (!local) return s;
            return {
              ...s,
              note: local.note,
              collapsed: local.collapsed ?? s.collapsed,
              autoFocusNote: local.autoFocusNote,
              anchor: local.anchor,
              structural: local.structural,
            };
          });
          const merged = [
            ...prev.filter((t) => !serverIds.has(t.id)),
            ...reconciled,
          ];
          const seen = new Set<string>();
          return merged.filter((t) => {
            if (seen.has(t.id)) return false;
            seen.add(t.id);
            return true;
          });
        });
      } catch {
        /* silent — SSE will retry; user-visible errors surface on submit. */
      }
    };
    void load();

    const unsubscribe = subscribeBackendEvents((event) => {
      if (event.kind === "thread_changed") void load();
    });
    return () => {
      // advance the sequence so any in-flight response is discarded
      seqRef.current += 1;
      unsubscribe();
    };
  }, [docPath, docRef, setThreads]);
}

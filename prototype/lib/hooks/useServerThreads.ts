import { useEffect } from "react";

import type { Thread } from "@/lib/types";
import { backendSummaryToUiThread } from "@/lib/threads-adapter";
import type { ThreadSummary } from "@/lib/mcp/backend";
import { subscribeBackendEvents } from "./useBackendEvents";

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
  useEffect(() => {
    if (!docPath) return;
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch(
          `/api/ui/threads?path=${encodeURIComponent(docPath)}&ref=${encodeURIComponent(docRef)}`,
          { cache: "no-store" },
        );
        if (!r.ok) return;
        const body = (await r.json()) as { threads: ThreadSummary[] };
        if (cancelled) return;
        const server = body.threads
          .filter((t) => t.status === "open")
          .map(backendSummaryToUiThread);
        const serverIds = new Set(server.map((t) => t.id));
        setThreads((prev) => {
          const merged = [
            ...prev.filter((t) => !serverIds.has(t.id)),
            ...server,
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
      cancelled = true;
      unsubscribe();
    };
  }, [docPath, docRef, setThreads]);
}

import { useEffect, useRef } from "react";

import type { Thread, ThreadDraftOption } from "@/lib/types";
import type { Thread as BackendThread } from "@/lib/mcp/backend";
import { subscribeBackendEvents } from "./useBackendEvents";

/**
 * Walk the message log newest-first and pick the latest set of
 * `draft_options`. Phase F: if no message carries options but one carries a
 * single `draft`, surface that as a 1-leaf array so the rendering path is
 * uniform (the multi-option UI just collapses to the single-payload redline
 * when there's exactly one leaf).
 */
function deriveDraftOptions(
  t: BackendThread,
): ThreadDraftOption[] | undefined {
  for (let i = t.messages.length - 1; i >= 0; i--) {
    const m = t.messages[i];
    if (m.draft_options && m.draft_options.length > 0) {
      return m.draft_options.map((o, idx) => ({
        name: o.name ?? `option ${idx + 1}`,
        new_md: o.new_md,
      }));
    }
    if (m.draft) {
      return [{ name: m.draft.name ?? "proposal", new_md: m.draft.new_md }];
    }
  }
  return undefined;
}

function backendThreadToUiThread(t: BackendThread): Thread {
  const draftOptions = deriveDraftOptions(t);
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
    draftOptions,
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
    // Threads only live on drafts. Skip the fetch and SSE subscription on main
    // so the margin rail stays empty and no listThreads(ref=main) ever fires.
    if (docRef === "main") return;
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
        // Phase J: include accepted threads too so the remix action is
        // reachable. Declined and archived threads stay hidden.
        const server = body.threads
          .filter((t) => t.status === "open" || t.status === "accepted")
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
              // draftOptions is server-derived: always take the freshest copy
              // from the server, ignoring any stale local snapshot.
              draftOptions: s.draftOptions,
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

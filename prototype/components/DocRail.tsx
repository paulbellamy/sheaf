"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { BackendEvent } from "@/lib/mcp/backend/index";

type DocEntry = {
  path: string;
  title: string;
  workspace: string;
  updated_at: number;
};

type DraftEntry = {
  draft_id: string;
  base_path: string;
  primary_path: string;
  changed_paths: string[];
  name?: string;
  state: "open" | "submitted";
  author: string;
  workspace: string;
  created_at: number;
};

type Payload = { docs: DocEntry[]; drafts: DraftEntry[] };

const REFRESH_DEBOUNCE_MS = 150;

export function DocRail({
  activePath,
  activeRef,
}: {
  activePath?: string;
  activeRef?: string;
}) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: { cancelled: boolean }) => {
    try {
      const r = await fetch("/api/ui/docs", { cache: "no-store" });
      const body = (await r.json()) as Payload | { error: string };
      if (signal?.cancelled) return;
      if (!r.ok) {
        setError("error" in body ? body.error : `HTTP ${r.status}`);
        return;
      }
      setError(null);
      setData(body as Payload);
    } catch (e) {
      if (!signal?.cancelled) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }, []);

  useEffect(() => {
    const signal = { cancelled: false };
    void load(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [load]);

  // Refresh the index when drafts are forked, written to, or change state.
  // Debounce bursts (e.g. an agent doing many Edits in a row) with a short
  // trailing timer.
  useEffect(() => {
    const source = new EventSource("/api/ui/drafts/stream");
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void load();
      }, REFRESH_DEBOUNCE_MS);
    };
    source.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as BackendEvent;
        if (
          event.kind === "draft_created" ||
          event.kind === "draft_changed" ||
          event.kind === "draft_state"
        ) {
          schedule();
        }
      } catch {
        /* ignore */
      }
    };
    return () => {
      source.close();
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  const groupedDocs = useMemo(() => {
    const map = new Map<string, DocEntry[]>();
    for (const d of data?.docs ?? []) {
      const arr = map.get(d.workspace) ?? [];
      arr.push(d);
      map.set(d.workspace, arr);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [data]);

  const drafts = data?.drafts ?? [];
  const isEmpty = data !== null && groupedDocs.length === 0 && drafts.length === 0;

  return (
    <aside className="review-rail">
      <header>
        <h2>docs</h2>
        <p className="muted">pick a doc to view</p>
      </header>
      {error ? <div className="review-err">{error}</div> : null}
      {data === null ? (
        <p className="muted">loading…</p>
      ) : isEmpty ? (
        <p className="muted">no docs yet.</p>
      ) : (
        <>
          {drafts.length > 0 ? (
            <section>
              <h3>drafts</h3>
              <ul>
                {drafts.map((d) => {
                  const isActive =
                    activeRef === d.draft_id && activePath === d.primary_path;
                  return (
                    <li
                      key={d.draft_id}
                      className={isActive ? "selected" : undefined}
                    >
                      <Link
                        href={`/doc/${d.primary_path}?ref=${encodeURIComponent(
                          d.draft_id,
                        )}`}
                      >
                        <span className="title">
                          {d.name ?? d.primary_path.split("/").pop()}
                        </span>
                        <span className="meta">
                          {d.state} · {d.author}
                        </span>
                        <span className="hint">{d.primary_path}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
          {groupedDocs.map(([ws, items]) => (
            <section key={ws}>
              <h3>{ws}</h3>
              <ul>
                {items.map((d) => {
                  const isActive = !activeRef && activePath === d.path;
                  return (
                    <li
                      key={d.path}
                      className={isActive ? "selected" : undefined}
                    >
                      <Link href={`/doc/${d.path}`}>
                        <span className="title">{d.title}</span>
                        <span className="meta">
                          {new Date(d.updated_at).toLocaleString()}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </>
      )}
    </aside>
  );
}

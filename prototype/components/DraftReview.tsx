"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { lineDiff, type DiffLine } from "@/lib/diff";

type DraftSummary = {
  draft_id: string;
  base_path: string;
  seed_prompt?: string;
  author: string;
  state: "open" | "submitted" | "accepted" | "declined";
  created_at: number;
  submitted_at?: number;
  note?: string;
  name?: string;
};

type DraftDetail = {
  meta: DraftSummary;
  changes: { path: string; main_md: string; draft_md: string }[];
};

type BackendEvent =
  | { kind: "draft_created"; draft_id: string; base_path: string }
  | { kind: "draft_changed"; draft_id: string; path: string }
  | {
      kind: "draft_state";
      draft_id: string;
      state: DraftSummary["state"];
    }
  | { kind: "thread_changed"; thread_id: string };

type StreamStatus = "connecting" | "live" | "fallback";

const STATE_ORDER: DraftSummary["state"][] = [
  "submitted",
  "open",
  "accepted",
  "declined",
];

const FALLBACK_POLL_MS = 15_000;

export function DraftReview() {
  const [drafts, setDrafts] = useState<DraftSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DraftDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("connecting");

  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;

  const fetchDrafts = useCallback(async () => {
    try {
      const r = await fetch("/api/ui/drafts", { cache: "no-store" });
      const body = (await r.json()) as { drafts: DraftSummary[] };
      setDrafts(body.drafts);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const fetchDetail = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/ui/drafts/${id}`, { cache: "no-store" });
      if (r.status === 404) {
        setDetail(null);
        return;
      }
      const body = (await r.json()) as DraftDetail;
      if (selectedIdRef.current === id) setDetail(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void fetchDetail(selectedId);
  }, [selectedId, fetchDetail]);

  useEffect(() => {
    void fetchDrafts();
    const t = setInterval(fetchDrafts, FALLBACK_POLL_MS);
    return () => clearInterval(t);
  }, [fetchDrafts]);

  // SSE — primary live-update channel. Event receipt triggers fetchDrafts /
  // fetchDetail; the FALLBACK_POLL_MS interval above is only a safety net.
  useEffect(() => {
    const source = new EventSource("/api/ui/drafts/stream");
    let opened = false;

    source.onopen = () => {
      opened = true;
      setStreamStatus("live");
    };

    source.onerror = () => {
      void opened;
      setStreamStatus("fallback");
    };

    source.onmessage = (msg) => {
      setStreamStatus("live");
      let event: BackendEvent;
      try {
        event = JSON.parse(msg.data) as BackendEvent;
      } catch {
        return;
      }
      if (
        event.kind === "draft_created" ||
        event.kind === "draft_state"
      ) {
        void fetchDrafts();
      } else if (event.kind === "draft_changed") {
        void fetchDrafts();
        if (selectedIdRef.current === event.draft_id) {
          void fetchDetail(event.draft_id);
        }
      }
    };

    return () => {
      source.close();
    };
  }, [fetchDrafts, fetchDetail]);

  const grouped = useMemo(() => {
    const out: Record<DraftSummary["state"], DraftSummary[]> = {
      submitted: [],
      open: [],
      accepted: [],
      declined: [],
    };
    for (const d of drafts ?? []) out[d.state].push(d);
    return out;
  }, [drafts]);

  const act = async (kind: "accept" | "decline") => {
    if (!selectedId) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/ui/drafts/${selectedId}/${kind}`, {
        method: "POST",
      });
      if (!r.ok) {
        const body = (await r.json()) as { error?: string };
        throw new Error(body.error ?? `${kind} failed`);
      }
      await fetchDrafts();
      setSelectedId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="review-shell">
      <aside className="review-rail">
        <header>
          <h2>drafts</h2>
          <p className="muted">
            <span
              className={`stream-dot stream-${streamStatus}`}
              aria-hidden
            />
            {streamStatus === "live"
              ? "live · streaming MCP events"
              : streamStatus === "connecting"
                ? "connecting to MCP stream…"
                : "stream offline · polling every 15s"}
          </p>
        </header>
        {error ? <div className="review-err">{error}</div> : null}
        {drafts === null ? (
          <p className="muted">loading…</p>
        ) : drafts.length === 0 ? (
          <p className="muted">
            no drafts yet. forks &amp; proposals from Claude Code will appear
            here.
          </p>
        ) : (
          STATE_ORDER.filter((s) => grouped[s].length > 0).map((s) => (
            <section key={s}>
              <h3>{s}</h3>
              <ul>
                {grouped[s].map((d) => (
                  <li
                    key={d.draft_id}
                    className={
                      selectedId === d.draft_id ? "selected" : undefined
                    }
                  >
                    <button onClick={() => setSelectedId(d.draft_id)}>
                      <span className="title">
                        {d.name ?? d.base_path.split("/").pop()}
                      </span>
                      <span className="meta">
                        {d.author} · {new Date(d.created_at).toLocaleTimeString()}
                      </span>
                      {d.seed_prompt ? (
                        <span className="hint">{d.seed_prompt}</span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </aside>

      <section className="review-pane">
        {!detail ? (
          <div className="review-empty">
            pick a draft on the left to see its diff.
          </div>
        ) : (
          <>
            <header className="review-head">
              <div>
                <h1>
                  {detail.meta.name ?? detail.meta.base_path}
                </h1>
                <p className="muted">
                  {detail.meta.draft_id} · {detail.meta.state} · by{" "}
                  {detail.meta.author}
                </p>
                {detail.meta.note ? <p>{detail.meta.note}</p> : null}
                {detail.meta.seed_prompt ? (
                  <p className="muted">
                    seed: <em>{detail.meta.seed_prompt}</em>
                  </p>
                ) : null}
              </div>
              <div className="review-actions">
                <button
                  disabled={busy || detail.meta.state !== "submitted"}
                  onClick={() => void act("accept")}
                  className="accept"
                >
                  accept
                </button>
                <button
                  disabled={busy || detail.meta.state !== "submitted"}
                  onClick={() => void act("decline")}
                  className="decline"
                >
                  decline
                </button>
              </div>
            </header>

            {detail.changes.length === 0 ? (
              <p className="muted">
                (no file changes yet — the draft exists but nothing has been
                written to it)
              </p>
            ) : (
              detail.changes.map((c) => (
                <DiffBlock key={c.path} {...c} />
              ))
            )}
          </>
        )}
      </section>
    </div>
  );
}

function DiffBlock({
  path,
  main_md,
  draft_md,
}: {
  path: string;
  main_md: string;
  draft_md: string;
}) {
  const diff = useMemo(() => lineDiff(main_md, draft_md), [main_md, draft_md]);
  return (
    <div className="diff-block">
      <h3 className="diff-path">{path}</h3>
      <pre className="diff">
        {diff.map((line, i) => (
          <DiffRow key={i} line={line} />
        ))}
      </pre>
    </div>
  );
}

function DiffRow({ line }: { line: DiffLine }) {
  const prefix =
    line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  ";
  return <span className={`diff-row diff-${line.kind}`}>{prefix + line.text + "\n"}</span>;
}

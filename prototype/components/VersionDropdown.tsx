"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { subscribeBackendEvents } from "@/lib/hooks/useBackendEvents";

type VersionEntry = {
  version: number;
  draft_id?: string;
  accepted_at?: number;
};

type Props = {
  path: string;
  currentVersion: number;
};

function formatTimestamp(ts: number | undefined): string {
  if (ts === undefined) return "";
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function VersionDropdown({ path, currentVersion }: Props) {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    if (!path) return;
    const mySeq = ++seqRef.current;
    try {
      const r = await fetch(
        `/api/ui/doc-versions/${path}`,
        { cache: "no-store" },
      );
      if (mySeq !== seqRef.current) return;
      if (!r.ok) return;
      const body = (await r.json()) as { versions: VersionEntry[] };
      if (mySeq !== seqRef.current) return;
      setVersions(body.versions);
    } catch {
      /* silent — SSE retries */
    }
  }, [path]);

  useEffect(() => {
    void load();
    const unsubscribe = subscribeBackendEvents((event) => {
      if (
        (event.kind === "draft_merged" &&
          event.target_paths.includes(path)) ||
        // continuity lost (reconnect after a server restart) — re-sync
        event.kind === "stream_reset"
      ) {
        void load();
      }
    });
    return () => {
      seqRef.current += 1;
      unsubscribe();
    };
  }, [path, load]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (wrapRef.current && target && !wrapRef.current.contains(target)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const sorted = [...versions].sort((a, b) => b.version - a.version);

  return (
    <span className="version-dropdown-wrap" ref={wrapRef}>
      <button
        type="button"
        className="version-badge version-badge-btn"
        aria-label={`version ${currentVersion} — open history`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        v{currentVersion}
      </button>
      {open ? (
        <div className="version-dropdown" role="menu">
          {sorted.length === 0 ? (
            <div className="version-dropdown-empty">no history</div>
          ) : (
            <ul className="version-dropdown-list">
              {sorted.map((entry) => {
                const isCurrent = entry.version === currentVersion;
                const hasDraft = !!entry.draft_id;
                const label = `v${entry.version}${entry.accepted_at ? "" : " (initial)"}`;
                const timestamp = formatTimestamp(entry.accepted_at);
                return (
                  <li
                    key={entry.version}
                    className="version-dropdown-row"
                    data-current={isCurrent ? "true" : "false"}
                  >
                    <span className="version-dropdown-label">
                      <span className="version-dropdown-name">{label}</span>
                      {timestamp ? (
                        <span className="version-dropdown-time">
                          {timestamp}
                        </span>
                      ) : null}
                    </span>
                    {hasDraft && !isCurrent ? (
                      <Link
                        className="version-dropdown-link"
                        href={`/doc/${path}?ref=${encodeURIComponent(entry.draft_id!)}`}
                        onClick={() => setOpen(false)}
                      >
                        view threads
                      </Link>
                    ) : (
                      <span className="version-dropdown-currentmark">
                        {isCurrent ? "current" : ""}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </span>
  );
}

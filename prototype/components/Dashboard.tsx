"use client";

import Link from "next/link";

import { useDocsIndex } from "@/lib/hooks/useDocsIndex";

function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function Dashboard() {
  const { data, error } = useDocsIndex();

  const docs = data?.docs ?? [];
  const drafts = data?.drafts ?? [];
  const isEmpty = data !== null && docs.length === 0 && drafts.length === 0;

  return (
    <div className="dashboard">
      <header>
        <h1>sheaf</h1>
        <p className="muted">recently edited docs &amp; in-flight drafts</p>
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
              <h2 className="dashboard-section">drafts</h2>
              <ul className="dashboard-list">
                {drafts.map((d) => (
                  <li key={d.draft_id}>
                    <Link
                      href={`/doc/${d.primary_path}?ref=${encodeURIComponent(
                        d.draft_id,
                      )}`}
                    >
                      <span className="title">
                        {d.name ?? d.primary_path.split("/").pop()}
                        <span className={`pill pill-${d.state}`}>{d.state}</span>
                      </span>
                      <span className="meta">
                        {d.author} · {relTime(d.created_at)}
                      </span>
                      <span className="path">{d.primary_path}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {docs.length > 0 ? (
            <section>
              <h2 className="dashboard-section">docs</h2>
              <ul className="dashboard-list">
                {docs.map((d) => (
                  <li key={d.path}>
                    <Link href={`/doc/${d.path}`}>
                      <span className="title">{d.title}</span>
                      <span className="meta">
                        {d.workspace} · {relTime(d.updated_at)}
                      </span>
                      <span className="path">{d.path}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

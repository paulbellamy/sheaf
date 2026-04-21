"use client";

import { useEffect, useMemo, useState } from "react";
import { marked } from "marked";

import { Manuscript } from "./Manuscript";

type Loaded = { md: string; path: string; ref: string };

export function DocView({
  path,
  docRef,
}: {
  path: string;
  docRef?: string;
}) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const qs = docRef ? `?ref=${encodeURIComponent(docRef)}` : "";
        const r = await fetch(`/api/ui/doc/${path}${qs}`, { cache: "no-store" });
        const body = (await r.json()) as Loaded | { error: string };
        if (cancelled) return;
        if (!r.ok) {
          setError("error" in body ? body.error : `HTTP ${r.status}`);
          return;
        }
        setData(body as Loaded);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, docRef]);

  const html = useMemo(
    () => (data ? (marked.parse(data.md, { async: false }) as string) : null),
    [data],
  );

  if (error) return <div className="doc-error">{error}</div>;
  if (!html || !data) return <div className="doc-loading">loading {path}…</div>;
  return (
    <Manuscript
      initialContent={html}
      md={data.md}
      docPath={path}
      docRef={docRef ?? "main"}
    />
  );
}

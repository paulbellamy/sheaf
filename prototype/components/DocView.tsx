"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";

import { Manuscript } from "./Manuscript";
import { subscribeBackendEvents } from "@/lib/hooks/useBackendEvents";

type Loaded = { md: string; path: string; ref: string };

const PROSE_SELECTOR = ".manuscript-prose";

// Simple LCS: for each index in `next`, returns true if that block is new or
// changed relative to `prev`. Used to decide which rendered blocks to flash.
function diffBlocks(prev: string[], next: string[]): boolean[] {
  const m = prev.length;
  const n = next.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      if (prev[i] === next[j]) dp[i + 1][j + 1] = dp[i][j] + 1;
      else dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const changed = new Array<boolean>(n).fill(true);
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (prev[i - 1] === next[j - 1]) {
      changed[j - 1] = false;
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return changed;
}

function sampleBlockTexts(container: HTMLElement | null): string[] {
  if (!container) return [];
  const prose = container.querySelector<HTMLElement>(PROSE_SELECTOR);
  if (!prose) return [];
  return Array.from(prose.children).map((el) =>
    (el.textContent ?? "").trim(),
  );
}

export function DocView({
  path,
  docRef,
}: {
  path: string;
  docRef?: string;
}) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);
  const [rev, setRev] = useState(0);

  const load = useCallback(async () => {
    const mySeq = ++seqRef.current;
    try {
      const qs = docRef ? `?ref=${encodeURIComponent(docRef)}` : "";
      const r = await fetch(`/api/ui/doc/${path}${qs}`, { cache: "no-store" });
      const body = (await r.json()) as Loaded | { error: string };
      if (mySeq !== seqRef.current) return;
      if (!r.ok) {
        setError("error" in body ? body.error : `HTTP ${r.status}`);
        return;
      }
      setError(null);
      setData((prev) => {
        const next = body as Loaded;
        if (prev && prev.md === next.md && prev.ref === next.ref) return prev;
        setRev((n) => n + 1);
        return next;
      });
    } catch (e) {
      if (mySeq !== seqRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [path, docRef]);

  useEffect(() => {
    void load();
    return () => {
      // advance the sequence so any in-flight request is discarded
      seqRef.current += 1;
    };
  }, [load]);

  useEffect(() => {
    if (!docRef || docRef === "main") return;
    return subscribeBackendEvents((event) => {
      if (
        event.kind === "draft_changed" &&
        event.draft_id === docRef &&
        event.path === path
      ) {
        void load();
      }
    });
  }, [path, docRef, load]);

  const html = useMemo(
    () => (data ? (marked.parse(data.md, { async: false }) as string) : null),
    [data],
  );

  // Flash only the blocks whose rendered text changed between the previous
  // and current Manuscript render. Runs after each commit driven by `rev`.
  // First commit: records baseline without flashing. Tracks rAF/timeout ids
  // so we clean up on unmount.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const prevTextsRef = useRef<string[] | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;
    let rafId: number | null = null;
    const timers: number[] = [];
    const overlays: HTMLElement[] = [];
    let attempts = 0;

    const settle = () => {
      if (cancelled) return;
      const texts = sampleBlockTexts(containerRef.current);
      if (texts.length === 0) {
        if (attempts++ < 60) {
          rafId = requestAnimationFrame(settle);
        }
        return;
      }
      const prev = prevTextsRef.current;
      prevTextsRef.current = texts;
      if (!prev) return; // initial load — baseline only, no flash
      const changed = diffBlocks(prev, texts);
      const prose = containerRef.current?.querySelector(PROSE_SELECTOR);
      if (!prose) return;
      const els = Array.from(prose.children) as HTMLElement[];
      const flashEl = (el: HTMLElement) => {
        const rect = el.getBoundingClientRect();
        const overlay = document.createElement("div");
        overlay.style.position = "fixed";
        overlay.style.left = `${rect.left - 4}px`;
        overlay.style.top = `${rect.top - 2}px`;
        overlay.style.width = `${rect.width + 8}px`;
        overlay.style.height = `${rect.height + 4}px`;
        overlay.style.backgroundColor = "rgba(255, 214, 102, 0.45)";
        overlay.style.borderRadius = "4px";
        overlay.style.pointerEvents = "none";
        overlay.style.zIndex = "9999";
        overlay.style.transition = "opacity 1200ms ease-out";
        document.body.appendChild(overlay);
        overlays.push(overlay);
        const rafFade = requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            overlay.style.opacity = "0";
          });
        });
        const t = window.setTimeout(() => {
          overlay.remove();
        }, 1400);
        timers.push(t);
        // track the rAF so we can cancel on unmount
        timers.push(rafFade as unknown as number);
      };
      let flashed = 0;
      for (let i = 0; i < els.length; i++) {
        if (!changed[i]) continue;
        flashEl(els[i]);
        flashed++;
      }
      if (flashed === 0 && prev.join("\n") !== texts.join("\n")) {
        flashEl(prose as HTMLElement);
      }
    };
    rafId = requestAnimationFrame(settle);
    return () => {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      for (const t of timers) window.clearTimeout(t);
      for (const el of overlays) el.remove();
    };
  }, [rev]);

  if (error) return <div className="doc-error">{error}</div>;
  if (!html || !data) return <div className="doc-loading">loading {path}…</div>;
  // Note: no `key={rev}` — we want Manuscript to persist across SSE-driven
  // doc refreshes so the user's in-flight edits, undo history, and scroll
  // position survive. Manuscript applies `md` / `initialContent` changes
  // via a ProseMirror transaction that preserves selection and marks.
  return (
    <div ref={containerRef}>
      <Manuscript
        initialContent={html}
        md={data.md}
        docPath={path}
        docRef={docRef ?? "main"}
      />
    </div>
  );
}

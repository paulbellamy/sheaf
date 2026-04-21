"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";

import { Manuscript } from "./Manuscript";
import type { BackendEvent } from "@/lib/mcp/backend/index";

type Loaded = { md: string; path: string; ref: string };

const FLASH_CLASS = "doc-block-flash";
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
  const [rev, setRev] = useState(0);

  const load = useCallback(
    async (signal?: { cancelled: boolean }) => {
      try {
        const qs = docRef ? `?ref=${encodeURIComponent(docRef)}` : "";
        const r = await fetch(`/api/ui/doc/${path}${qs}`, { cache: "no-store" });
        const body = (await r.json()) as Loaded | { error: string };
        if (signal?.cancelled) return;
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
        if (!signal?.cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    },
    [path, docRef],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    void load(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [load]);

  useEffect(() => {
    if (!docRef || docRef === "main") return;
    const source = new EventSource("/api/ui/drafts/stream");
    source.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as BackendEvent;
        if (
          event.kind === "draft_changed" &&
          event.draft_id === docRef &&
          event.path === path
        ) {
          void load();
        }
      } catch {
        /* ignore */
      }
    };
    return () => {
      source.close();
    };
  }, [path, docRef, load]);

  const html = useMemo(
    () => (data ? (marked.parse(data.md, { async: false }) as string) : null),
    [data],
  );

  // Flash only the blocks whose rendered text changed between the previous
  // and current Manuscript render. Runs after each mount driven by `rev`.
  // First mount: records baseline without flashing.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const prevTextsRef = useRef<string[] | null>(null);
  const savedScrollRef = useRef<number | null>(null);
  // Capture scroll position synchronously before the new Manuscript mount
  // paints, so we can restore it if TipTap's remount-scroll kicks in.
  if (typeof window !== "undefined" && rev > 0) {
    savedScrollRef.current = window.scrollY;
  }
  useEffect(() => {
    if (!containerRef.current) return;
    const savedScroll = savedScrollRef.current;
    let cancelled = false;
    let attempts = 0;
    // Pin scroll for ~600ms after the rev change, defeating any auto-scroll
    // triggered by TipTap's remount / focus-on-mount behaviour.
    if (savedScroll !== null) {
      const pinUntil = performance.now() + 600;
      const pin = () => {
        if (cancelled) return;
        if (Math.abs(window.scrollY - savedScroll) > 1) {
          window.scrollTo(window.scrollX, savedScroll);
        }
        if (performance.now() < pinUntil) requestAnimationFrame(pin);
      };
      requestAnimationFrame(pin);
    }
    const settle = () => {
      if (cancelled) return;
      const texts = sampleBlockTexts(containerRef.current);
      if (texts.length === 0) {
        if (attempts++ < 60) {
          requestAnimationFrame(settle);
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
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            overlay.style.opacity = "0";
          });
        });
        window.setTimeout(() => overlay.remove(), 1400);
      };
      let flashed = 0;
      for (let i = 0; i < els.length; i++) {
        if (!changed[i]) continue;
        flashEl(els[i]);
        flashed++;
      }
      // If nothing was flagged as changed but texts differ overall, flash the
      // whole prose as a fallback so the change is still visible.
      if (flashed === 0 && prev.join("\n") !== texts.join("\n")) {
        flashEl(prose as HTMLElement);
      }
    };
    requestAnimationFrame(settle);
    return () => {
      cancelled = true;
    };
  }, [rev]);

  if (error) return <div className="doc-error">{error}</div>;
  if (!html || !data) return <div className="doc-loading">loading {path}…</div>;
  return (
    <div ref={containerRef}>
      <Manuscript
        key={rev}
        initialContent={html}
        md={data.md}
        docPath={path}
        docRef={docRef ?? "main"}
      />
    </div>
  );
}

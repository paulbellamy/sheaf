"use client";

import { useEffect } from "react";

import {
  backendEventSchema,
  type BackendEvent,
} from "@/lib/mcp/backend/index";

type Listener = (event: BackendEvent) => void;

/**
 * Process-wide singleton over `/api/ui/drafts/stream`. Every component that
 * calls `subscribeBackendEvents` or `useBackendEvents` shares one
 * EventSource — so a /doc page with a Manuscript, DocRail, and DocView no
 * longer opens three connections (six under StrictMode).
 */
let source: EventSource | null = null;
let refCount = 0;
const listeners = new Set<Listener>();

function ensureSource() {
  if (source) return source;
  if (typeof window === "undefined") return null;
  const s = new EventSource("/api/ui/drafts/stream");
  s.onmessage = (msg) => {
    let raw: unknown;
    try {
      raw = JSON.parse(msg.data);
    } catch {
      console.error("backend event: malformed JSON frame", msg.data);
      return;
    }
    const parsed = backendEventSchema.safeParse(raw);
    if (!parsed.success) {
      // Surface corrupt frames loudly — a silent drop hid real schema drift
      // during earlier refactors.
      console.error("backend event: schema mismatch", parsed.error, raw);
      return;
    }
    const event = parsed.data;
    for (const cb of listeners) {
      try {
        cb(event);
      } catch {
        /* listener errors never take the stream down */
      }
    }
  };
  // Auto-reconnect is native to EventSource; no explicit onerror wiring
  // needed beyond logging — the browser retries. If every subscriber goes
  // away we tear down in release().
  source = s;
  return s;
}

function release() {
  if (refCount > 0) return;
  if (!source) return;
  source.close();
  source = null;
}

export function subscribeBackendEvents(listener: Listener): () => void {
  listeners.add(listener);
  refCount++;
  ensureSource();
  return () => {
    listeners.delete(listener);
    refCount = Math.max(0, refCount - 1);
    if (refCount === 0) release();
  };
}

/** Hook wrapper that subscribes for the component's lifetime. */
export function useBackendEvents(listener: Listener, deps: unknown[] = []) {
  useEffect(() => {
    return subscribeBackendEvents(listener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

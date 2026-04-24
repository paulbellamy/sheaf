"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Options<T> = {
  /** Called with the parsed body whenever a fresh load wins the sequence race. */
  onData?: (body: T) => void;
};

/**
 * Fetch + sequence-guard helper. The returned `load` can be called on demand
 * (e.g. from an SSE listener) without risk of a stale response clobbering a
 * newer one: each call bumps a monotonic sequence, and responses that do not
 * match the current sequence are dropped.
 *
 * `data` and `error` are provided for the common case where a component just
 * wants the latest body; callers that need to merge (like the thread list)
 * can pass `onData` and ignore `data`.
 */
export function useJson<T>(
  url: string,
  deps: unknown[],
  options: Options<T> = {},
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);
  const onDataRef = useRef(options.onData);
  onDataRef.current = options.onData;

  const load = useCallback(async () => {
    const mySeq = ++seqRef.current;
    const controller = new AbortController();
    try {
      const r = await fetch(url, { cache: "no-store", signal: controller.signal });
      if (mySeq !== seqRef.current) return;
      const body = (await r.json()) as T | { error: string };
      if (mySeq !== seqRef.current) return;
      if (!r.ok) {
        setError(
          typeof body === "object" && body !== null && "error" in body
            ? (body as { error: string }).error
            : `HTTP ${r.status}`,
        );
        return;
      }
      setError(null);
      setData(body as T);
      onDataRef.current?.(body as T);
    } catch (e) {
      if (mySeq !== seqRef.current) return;
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : String(e));
    }
    // no cleanup of `controller` — if a later load starts, the sequence check
    // discards this one's response; we don't abort eagerly because fetch may
    // already be mid-body when we advance.
  }, [url]);

  useEffect(() => {
    void load();
    return () => {
      // discard any in-flight response when the effect tears down.
      seqRef.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, reload: load };
}

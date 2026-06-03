import type { Backend, BackendEvent } from "./backend/index";

/**
 * A transport-agnostic sink for an SSE connection. The Next route backs it
 * with a `ReadableStream` controller (encoding to bytes); the Fastify route
 * backs it with `reply.raw`. `pipeEvents` only ever writes already-formatted
 * SSE frame strings, so each runtime just adapts `write`/`close`.
 */
export interface SseSink {
  /** Write a raw chunk — an already-formatted SSE frame or comment line. */
  write(chunk: string): void;
  /** Close the underlying response. Must be idempotent. */
  close(): void;
}

/**
 * Hard cap on concurrent SSE subscribers. A slow/leaky consumer otherwise
 * keeps a listener alive and each subsequent connection compounds emit
 * latency. Global cap — no per-IP tracking in the prototype.
 */
const MAX_SSE_CLIENTS = 64;

/** Per-connection buffered-event cap. Drop a consumer this far behind rather
 *  than grow unbounded. */
const MAX_QUEUED_EVENTS = 1000;

let activeClients = 0;

/**
 * Reserve a client slot. Returns false when the cap is reached — the caller
 * should respond 503 and not open a stream. Pairs with the slot release that
 * `pipeEvents`' cleanup performs.
 */
export function reserveSseClient(): boolean {
  if (activeClients >= MAX_SSE_CLIENTS) return false;
  activeClients += 1;
  return true;
}

function releaseSseClient(): void {
  activeClients = Math.max(0, activeClients - 1);
}

/**
 * Wire a reserved SSE connection to the backend event stream. The caller must
 * have called `reserveSseClient()` first (and returned 503 if it was false).
 *
 * Returns a cleanup function to call on client disconnect; it is idempotent,
 * stops the keep-alive, unsubscribes, releases the reserved slot, and closes
 * the sink.
 */
export function pipeEvents(
  backend: Backend,
  sink: SseSink,
  opts: { role: "ui" | "agent" },
): () => void {
  let closed = false;
  let queued = 0;
  let ping: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: () => void = () => {};

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (ping) clearInterval(ping);
    unsubscribe();
    releaseSseClient();
    try {
      sink.close();
    } catch {
      // already closed
    }
  };

  const send = (event: BackendEvent) => {
    if (closed) return;
    if (queued >= MAX_QUEUED_EVENTS) {
      // Drop slow consumer — their EventSource will reconnect.
      cleanup();
      return;
    }
    try {
      queued += 1;
      sink.write(`data: ${JSON.stringify(event)}\n\n`);
      // naive drain: SSE has no client ack, so treat each enqueue as
      // "delivered soon" and decrement a little later via a microtask. A
      // coarse back-pressure hint, not a correctness guarantee.
      queueMicrotask(() => {
        queued = Math.max(0, queued - 1);
      });
    } catch {
      cleanup();
    }
  };

  // prime the stream so the client resolves immediately
  try {
    sink.write(`: connected\n\n`);
  } catch {
    // sink already gone — nothing to do
  }

  unsubscribe = backend.subscribe(send, { role: opts.role });

  // keep-alive comment every 20s to survive idle proxy closes
  ping = setInterval(() => {
    if (closed) return;
    try {
      sink.write(`: ping\n\n`);
    } catch {
      cleanup();
    }
  }, 20_000);

  return cleanup;
}

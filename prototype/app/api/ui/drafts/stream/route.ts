import type { BackendEvent } from "@/lib/mcp/backend/index";
import { getBackend } from "@/lib/mcp/backend/stub";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * SSE stream of backend mutation events. The /doc page opens an
 * EventSource against this route and refetches list/detail on each event.
 *
 * Events are plain JSON matching `BackendEvent` from backend/index.ts.
 * A keep-alive `: ping` comment goes out every 20s to survive idle
 * proxy closes.
 */

/**
 * Hard cap on concurrent SSE subscribers. A slow/leaky consumer otherwise
 * would keep a listener alive and each subsequent connection compounds the
 * emit latency. This is a global cap — the prototype has no per-IP tracking.
 */
const MAX_SSE_CLIENTS = 64;

/** Per-connection buffered-event cap. If the consumer falls this far behind
 *  we drop them rather than grow unbounded. */
const MAX_QUEUED_EVENTS = 1000;

let activeClients = 0;

export async function GET(req: Request): Promise<Response> {
  if (activeClients >= MAX_SSE_CLIENTS) {
    return new Response("too many SSE clients", { status: 503 });
  }
  const backend = getBackend();
  const encoder = new TextEncoder();

  let queued = 0;
  activeClients += 1;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      const send = (event: BackendEvent) => {
        if (closed) return;
        if (queued >= MAX_QUEUED_EVENTS) {
          // Drop slow consumer — their EventSource will reconnect.
          close();
          return;
        }
        try {
          queued += 1;
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
          // naive drain: there's no ack from the client in SSE, so we
          // treat each enqueue as "delivered soon" and decrement a little
          // later via a microtask. This is a coarse back-pressure hint,
          // not a correctness guarantee.
          queueMicrotask(() => {
            queued = Math.max(0, queued - 1);
          });
        } catch {
          close();
        }
      };

      // prime the stream so the client resolves immediately
      controller.enqueue(encoder.encode(`: connected\n\n`));

      const unsubscribe = backend.subscribe(send);

      const ping = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          close();
        }
      }, 20_000);

      const cleanup = () => {
        clearInterval(ping);
        unsubscribe();
        activeClients = Math.max(0, activeClients - 1);
        close();
      };

      req.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

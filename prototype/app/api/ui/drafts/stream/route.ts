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
export async function GET(req: Request): Promise<Response> {
  const backend = getBackend();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: BackendEvent) => {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          // controller is closed; cleanup will happen via the abort handler
        }
      };

      // prime the stream so the client resolves immediately
      controller.enqueue(encoder.encode(`: connected\n\n`));

      const unsubscribe = backend.subscribe(send);

      const ping = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          // ignore
        }
      }, 20_000);

      const cleanup = () => {
        clearInterval(ping);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
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

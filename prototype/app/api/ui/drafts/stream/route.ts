import { pipeEvents, reserveSseClient, type SseSink } from "sheaf-server";
import { backend } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * SSE stream of backend mutation events. The /doc page and the Obsidian
 * plugin open an EventSource/fetch against this route. The cap, keep-alive,
 * and back-pressure logic live in sheaf-server's `pipeEvents` so the Fastify
 * app (in the plugin) and this Next route behave identically; only the
 * transport adapter (a `ReadableStream` here, `reply.raw` there) differs.
 *
 *   role=ui    (default) — passive observer; not counted toward agent_presence.
 *   role=agent — the MCP/event-watcher session; counted toward agent_presence.
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const role = url.searchParams.get("role") === "agent" ? "agent" : "ui";

  if (!reserveSseClient()) {
    return new Response("too many SSE clients", { status: 503 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const sink: SseSink = {
        write: (chunk) => controller.enqueue(encoder.encode(chunk)),
        close: () => {
          try {
            controller.close();
          } catch {
            // already closed
          }
        },
      };
      const cleanup = pipeEvents(backend(), sink, { role });
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

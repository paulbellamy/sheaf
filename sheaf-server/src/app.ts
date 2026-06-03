import Fastify, {
  type FastifyInstance,
  type FastifyReply,
} from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { Backend } from "./backend/index";
import { getBackend } from "./backend/factory";
import { buildServer } from "./server";
import { errorResult } from "./errors";
import { pipeEvents, reserveSseClient, type SseSink } from "./events";
import {
  acceptDraft,
  addThread,
  attachPayload,
  createDraft,
  declineDraft,
  docVersions,
  getDraft,
  type HandlerResult,
  listDocsAndDrafts,
  listDrafts,
  listThreadsForDoc,
  readDoc,
  reopenThread,
  replyThread,
  resolveThread,
} from "./handlers";

/**
 * The canonical sheaf HTTP API as a Fastify app: the `/api/ui/*` REST routes,
 * the `/api/ui/drafts/stream` SSE stream, and the `/api/mcp` MCP Streamable
 * HTTP endpoint. The Obsidian plugin runs this in-process via `.listen()`;
 * the Next prototype reuses the same handlers/transport cores through thin
 * route shims (it doesn't import this Fastify instance).
 *
 * Logging is disabled so the bundle the plugin ships doesn't pull in pino's
 * worker-thread transport (which doesn't bundle cleanly into the Obsidian
 * single-file build).
 */
export function buildSheafApp(backend: Backend = getBackend()): FastifyInstance {
  const app = Fastify({
    logger: false,
    // Thread bodies / draft payloads can approach 1 MB; give headroom.
    bodyLimit: 8 * 1024 * 1024,
  });

  // Tolerate empty-bodied POSTs (resolve/accept/decline send none) even when a
  // client sets `content-type: application/json`.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      if (!body || (body as string).length === 0) return done(null, undefined);
      try {
        done(null, JSON.parse(body as string));
      } catch (e) {
        (e as { statusCode?: number }).statusCode = 400;
        done(e as Error, undefined);
      }
    },
  );

  // Permissive CORS for the localhost dev server. REST goes through Obsidian's
  // `requestUrl` (CORS-exempt), but the plugin's SSE uses `fetch`, so allow it.
  app.addHook("onSend", async (_req, reply) => {
    reply.header("access-control-allow-origin", "*");
  });

  const run = async (
    reply: FastifyReply,
    fn: () => Promise<HandlerResult>,
  ): Promise<void> => {
    try {
      const r = await fn();
      reply.code(r.status).send(r.json);
    } catch (e) {
      const er = errorResult(e);
      reply.code(er.status).send(er.json);
    }
  };

  const q = (req: { query: unknown }, key: string): string | undefined => {
    const v = (req.query as Record<string, unknown> | undefined)?.[key];
    return typeof v === "string" ? v : undefined;
  };

  /* ----------------------------------------------------------- UI: docs -- */

  app.get("/api/ui/docs", (_req, reply) =>
    run(reply, () => listDocsAndDrafts(backend)),
  );

  app.get("/api/ui/doc/*", (req, reply) =>
    run(reply, () =>
      readDoc(backend, {
        path: (req.params as Record<string, string>)["*"],
        ref: q(req, "ref") ?? "main",
      }),
    ),
  );

  app.get("/api/ui/doc-versions/*", (req, reply) =>
    run(reply, () =>
      docVersions(backend, {
        path: (req.params as Record<string, string>)["*"],
      }),
    ),
  );

  /* -------------------------------------------------------- UI: threads -- */

  app.get("/api/ui/threads", (req, reply) =>
    run(reply, () =>
      listThreadsForDoc(backend, {
        path: q(req, "path"),
        ref: q(req, "ref") ?? "main",
      }),
    ),
  );

  app.post("/api/ui/threads", (req, reply) =>
    run(reply, () =>
      addThread(backend, { ref: q(req, "ref") ?? "main", body: req.body }),
    ),
  );

  app.post("/api/ui/threads/:id/reply", (req, reply) =>
    run(reply, () =>
      replyThread(backend, {
        id: (req.params as { id: string }).id,
        body: req.body,
      }),
    ),
  );

  app.post("/api/ui/threads/:id/resolve", (req, reply) =>
    run(reply, () =>
      resolveThread(backend, {
        id: (req.params as { id: string }).id,
        optionIndex: q(req, "option_index"),
        skipApply: q(req, "apply") === "false",
      }),
    ),
  );

  app.post("/api/ui/threads/:id/reopen", (req, reply) =>
    run(reply, () =>
      reopenThread(backend, { id: (req.params as { id: string }).id }),
    ),
  );

  app.post("/api/ui/threads/:id/payload", (req, reply) =>
    run(reply, () =>
      attachPayload(backend, {
        id: (req.params as { id: string }).id,
        body: req.body,
      }),
    ),
  );

  /* --------------------------------------------------------- UI: drafts -- */

  app.get("/api/ui/drafts", (_req, reply) =>
    run(reply, () => listDrafts(backend)),
  );

  app.post("/api/ui/drafts", (req, reply) =>
    run(reply, () => createDraft(backend, { body: req.body })),
  );

  app.get("/api/ui/drafts/:id", (req, reply) =>
    run(reply, () =>
      getDraft(backend, { id: (req.params as { id: string }).id }),
    ),
  );

  app.post("/api/ui/drafts/:id/accept", (req, reply) =>
    run(reply, () =>
      acceptDraft(backend, { id: (req.params as { id: string }).id }),
    ),
  );

  app.post("/api/ui/drafts/:id/decline", (req, reply) =>
    run(reply, () =>
      declineDraft(backend, { id: (req.params as { id: string }).id }),
    ),
  );

  /* ----------------------------------------------------- SSE event stream -- */

  app.get("/api/ui/drafts/stream", (req, reply) => {
    const role = q(req, "role") === "agent" ? "agent" : "ui";
    if (!reserveSseClient()) {
      reply.code(503).send("too many SSE clients");
      return;
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    });
    const sink: SseSink = {
      write: (chunk) => reply.raw.write(chunk),
      close: () => reply.raw.end(),
    };
    const cleanup = pipeEvents(backend, sink, { role });
    req.raw.on("close", cleanup);
  });

  /* ------------------------------------------------------------- MCP API -- */

  app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/api/mcp",
    handler: async (req, reply) => {
      // Stateless: every request reconstructs a fresh server/transport pair.
      // The backend is shared, so on-disk state carries across requests.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const server = buildServer(backend);
      await server.connect(transport);
      reply.raw.on("close", () => {
        void server.close().catch(() => {});
      });
      reply.hijack();
      await transport.handleRequest(req.raw, reply.raw, req.body);
    },
  });

  return app;
}

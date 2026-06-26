import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { Backend } from "./backend/index";
import { getBackend } from "./backend/factory";
import { buildServer, type ToolSurface } from "./server";
import { err, errorResult } from "./errors";
import { assertVaultPath } from "./paths";
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
/**
 * True if the HTTP `Host` header names a loopback address (any port). The
 * server only binds 127.0.0.1, but a DNS-rebinding attack (attacker domain →
 * 127.0.0.1) still arrives carrying the attacker's Host; rejecting anything but
 * loopback defeats it. Handles `localhost`, `127.0.0.1`, and `[::1]` forms.
 */
function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  let host = hostHeader.trim();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    host = end === -1 ? host.slice(1) : host.slice(1, end);
  } else {
    const colon = host.indexOf(":");
    if (colon !== -1) host = host.slice(0, colon);
  }
  host = host.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * Resolve a request's per-connection doc scope (ACP §3.1), failing CLOSED.
 *
 * Scoping is a security boundary — a malformed scope must error, never silently
 * widen to the whole vault. Rules:
 * - `?doc=` takes precedence over the `X-Sheaf-Doc` header.
 * - A repeated/array value for either is ambiguous → reject (`invalid_path`),
 *   so a duplicated param can't drop the scope and open every doc.
 * - An empty value is treated as absent (query falls through to header, header
 *   to no scope) rather than suppressing the header.
 * - A provided scope must be a valid vault path (`assertVaultPath`), so a typo
 *   or traversal attempt fails loudly instead of yielding an empty queue.
 * - Returns `undefined` when no scope is supplied — the legitimate global case.
 */
function resolveDocScope(req: FastifyRequest): string | undefined {
  const rawQuery = (req.query as Record<string, unknown> | undefined)?.["doc"];
  const rawHeader = req.headers["x-sheaf-doc"];
  if (Array.isArray(rawQuery) || Array.isArray(rawHeader)) {
    throw err.invalidPath(
      "doc scope must be a single value, not a repeated parameter",
    );
  }
  const queryDoc =
    typeof rawQuery === "string" && rawQuery !== "" ? rawQuery : undefined;
  const headerDoc =
    typeof rawHeader === "string" && rawHeader !== "" ? rawHeader : undefined;
  const scope = queryDoc ?? headerDoc;
  if (scope === undefined) return undefined;
  assertVaultPath(scope); // throws invalid_path on a malformed scope
  return scope;
}

export function buildSheafApp(
  backend: Backend = getBackend(),
  opts: { allowedOrigins?: string[]; tools?: ToolSurface } = {},
): FastifyInstance {
  const app = Fastify({
    logger: false,
    // Thread bodies / draft payloads can approach 1 MB; give headroom.
    bodyLimit: 8 * 1024 * 1024,
  });

  // Browser origins trusted to read responses cross-origin. The only one in
  // the shipped plugin is Obsidian's renderer (its SSE uses `fetch`); the REST
  // client uses Obsidian's CORS-exempt `requestUrl`, and the agent's MCP client
  // isn't a browser — so the default allowlist is just the Obsidian origin.
  const allowedOrigins = new Set(
    (opts.allowedOrigins ?? ["app://obsidian.md"]).map((o) => o.toLowerCase()),
  );
  const allowedAcao = (origin: string | undefined): string | undefined =>
    origin && allowedOrigins.has(origin.toLowerCase()) ? origin : undefined;

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

  // DNS-rebinding guard: refuse any request whose Host isn't loopback.
  app.addHook("onRequest", async (req, reply) => {
    if (!isLoopbackHost(req.headers.host)) {
      reply
        .code(403)
        .send({ error: "forbidden host", code: "forbidden_host" });
    }
  });

  // Reflect an allowed Origin rather than a wildcard, so a hostile page in the
  // user's browser can't read vault contents cross-origin. Other origins get
  // no CORS header at all (the browser then blocks the read).
  app.addHook("onSend", async (req, reply) => {
    const acao = allowedAcao(req.headers.origin);
    if (acao) {
      reply.header("access-control-allow-origin", acao);
      reply.header("vary", "origin");
    }
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
    const sseHeaders: Record<string, string> = {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    };
    // This route hijacks the reply, so the onSend CORS hook doesn't run —
    // apply the same allowed-origin reflection here for the plugin's SSE fetch.
    const acao = allowedAcao(req.headers.origin);
    if (acao) {
      sseHeaders["Access-Control-Allow-Origin"] = acao;
      sseHeaders["Vary"] = "Origin";
    }
    reply.raw.writeHead(200, sseHeaders);
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
      // Per-connection doc scope (ACP per-session MCP registration, §3.1).
      // Resolved fail-closed: a malformed scope is rejected here, before the
      // reply is hijacked for the transport, rather than silently widening to
      // the whole vault.
      let docScope: string | undefined;
      try {
        docScope = resolveDocScope(req);
      } catch (e) {
        const er = errorResult(e);
        reply.code(er.status).send(er.json);
        return;
      }
      // Stateless: every request reconstructs a fresh server/transport pair.
      // The backend is shared, so on-disk state carries across requests.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const server = buildServer(backend, { tools: opts.tools, docScope });
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

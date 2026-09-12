/**
 * `sheaf mcp` — the stdio MCP bridge (and its `--no-daemon` standalone fallback).
 *
 * This is the command `mcp install` points an agent at: it gives the agent a
 * plain stdio MCP server on this process's stdin/stdout, while the vault's one
 * true backend stays inside the daemon (`sheaf serve`). The invariant from
 * docs/sheaf-cli-v0.1.md — *exactly one live backend per vault, in one process*
 * — is why the bridge does not construct a backend of its own: it relays the
 * agent's JSON-RPC to the daemon over loopback HTTP and relays the answers back.
 *
 * ## Two modes
 *
 *   - **Bridge (default).** A byte relay between two SDK transports:
 *       - agent side: {@link StdioServerTransport} (our stdin/stdout);
 *       - daemon side: {@link StreamableHTTPClientTransport} to `/api/mcp`.
 *     `stdio.onmessage → http.send` and `http.onmessage → stdio.send`. We do
 *     NOT wrap either side in an SDK `Client`/`Server`; the daemon is stateless
 *     (`enableJsonResponse:true`, `listChanged:false`) and never initiates a
 *     server→client message, so a raw relay is complete. We reinterpret the
 *     JSON-RPC only enough to (a) fail in-flight calls on daemon death, and
 *     (b) forward the negotiated protocol version — see below.
 *     `sheaf mcp` is the ONLY command that may auto-spawn a daemon (there is no
 *     human at the keyboard to run `sheaf serve` first).
 *
 *   - **Standalone (`--no-daemon`).** A documented escape hatch, valid only when
 *     nothing else touches the vault: build the MCP server in-process against a
 *     private {@link StubBackend} and connect it straight to a stdio transport.
 *     No daemon, no cross-process events (a stderr note says so).
 *
 * ## The load-bearing details (verified against SDK 1.29.0)
 *
 *   - **stdout is the wire.** Every diagnostic goes to stderr; only relayed
 *     JSON-RPC is written to stdout, or the agent's parser breaks.
 *   - **-32603 on daemon death.** If a forwarded `http.send()` throws (or the
 *     http transport errors/closes), nothing would ever reach stdout and the
 *     agent's pending calls would hang forever. We track outstanding request
 *     ids seen stdio→http and synthesize a JSON-RPC `-32603` response for each,
 *     write them to stdout, then exit non-zero. We do NOT try to reconnect in
 *     place: the client already completed `initialize` against the dead server,
 *     but a stateless daemon reconnection is a *fresh* MCP server that has not
 *     seen this client's handshake, so transparently resuming would require the
 *     bridge to replay `initialize` and re-derive the negotiated state — i.e.
 *     exactly the JSON-RPC re-interpretation this relay is designed to avoid.
 *     Exiting is clean instead: the MCP host owns our lifecycle and re-spawns
 *     `sheaf mcp`, which re-discovers (or auto-spawns) a daemon and lets the
 *     agent re-`initialize` from scratch.
 *   - **Exit on stdin end.** {@link StdioServerTransport} listens for `data`
 *     and `error` but never `end`/`close`, so without our own listener the
 *     bridge would outlive the host that spawned it. On stdin end we drain any
 *     in-flight requests (so a piped `initialize` still gets its answer), then
 *     shut down and exit 0.
 *   - **setProtocolVersion.** A raw relay has no `Client` to call
 *     `setProtocolVersion` for it, so subsequent client requests would omit the
 *     `mcp-protocol-version` header the spec wants. We sniff the `initialize`
 *     *result* flowing http→stdio and forward its `protocolVersion` to the http
 *     transport.
 *   - **`--doc PATH`** → `x-sheaf-doc` request header (ACP per-doc scope; the
 *     daemon resolves it fail-closed).
 *   - **GET /api/mcp → 405.** Relied upon, not implemented here: after the
 *     client's `initialized` notification the http transport auto-opens a
 *     server→client GET stream; the daemon answers 405 and the SDK tolerates
 *     it, so no zombie `buildServer`+socket is stranded for the bridge's life.
 *
 * ## Known limit
 *
 * Stateless proxying is complete only while the server never initiates a
 * message (no elicitation, sampling, or `listChanged`). The sheaf daemon meets
 * that; a server that didn't would need a session-aware bridge.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import { StubBackend, buildServer, type ToolSurface } from "sheaf-server";
import {
  daemonBaseUrl,
  findDaemon,
  type DaemonInfo,
} from "sheaf-server/daemon";

import type { RunContext } from "./commands";
import { CliError, EXIT, usageError, type ExitCode } from "./io";

/** Ceiling on how long auto-spawn waits for the new daemon to become reachable. */
const SPAWN_POLL_CAP_MS = 10_000;
/** First poll delay after spawning; doubles up to {@link SPAWN_POLL_MAX_DELAY_MS}. */
const SPAWN_POLL_BASE_MS = 50;
/** Cap on a single poll delay so the tail of the window stays responsive. */
const SPAWN_POLL_MAX_DELAY_MS = 500;
/**
 * When stdin ends with requests still in flight, wait at most this long for the
 * daemon's answers before exiting anyway — a wedged daemon must not keep the
 * bridge (and its exit code) pending forever.
 */
const DRAIN_CAP_MS = 10_000;

/** Sleep `ms` without blocking the event loop. */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Best-effort message for a wrapped transport/network error. */
function errMessage(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return cause.message;
    return e.message;
  }
  return String(e);
}

/** Validate `--tools`; anything but the two surfaces is a usage error (exit 2). */
function parseTools(value: unknown): ToolSurface | undefined {
  if (value === undefined) return undefined;
  if (value === "full" || value === "thread-only") return value;
  throw usageError(
    `--tools must be 'full' or 'thread-only' (got '${String(value)}')`,
  );
}

/**
 * A loose view of a JSON-RPC message for the small amount of sniffing the relay
 * does. The SDK has already validated the shape (both transports parse with
 * `JSONRPCMessageSchema`); we only read fields, never construct beyond the
 * `-32603` error responses.
 */
interface JsonRpcish {
  id?: string | number | null;
  method?: string;
  result?: { protocolVersion?: unknown } | unknown;
  error?: unknown;
}

/** A request carries both a `method` and a non-null `id` (responses/notifs don't). */
function isRequest(m: JsonRpcish): m is JsonRpcish & { id: string | number } {
  return m.method !== undefined && m.id !== undefined && m.id !== null;
}

/** A response carries a non-null `id` and either a `result` or an `error`. */
function isResponse(m: JsonRpcish): m is JsonRpcish & { id: string | number } {
  return (
    m.id !== undefined &&
    m.id !== null &&
    (m.result !== undefined || m.error !== undefined)
  );
}

/**
 * `run` handler for `sheaf mcp`. Blocks until the host closes stdin (exit 0) or
 * the daemon goes away (exit non-zero). All diagnostics go to stderr; stdout
 * carries only relayed JSON-RPC.
 */
export async function mcpBridgeCommand(ctx: RunContext): Promise<ExitCode> {
  const err = (line: string): void => ctx.io.err(`${line}\n`);
  const tools = parseTools(ctx.values.tools);
  const doc = typeof ctx.values.doc === "string" ? ctx.values.doc : undefined;

  if (ctx.globals.noDaemon) {
    return runStandalone(ctx.vault, tools, doc, err);
  }

  // Locate the daemon, auto-spawning one if the vault has none.
  const info = await resolveDaemon(ctx.vault, ctx.io.env, { tools, log: err });

  // Per-doc scope travels as a request header (ACP §3.1); the daemon resolves
  // it fail-closed.
  const headers: Record<string, string> = {};
  if (doc !== undefined) headers["x-sheaf-doc"] = doc;

  return runBridge({ info, headers, err });
}

/**
 * Locate the running daemon for `vault`, auto-spawning `sheaf serve` (detached,
 * with its own stdio) when none exists, then polling discovery until it is
 * reachable. Throws a {@link CliError} (exit 1) if it never comes up.
 *
 * A discovery race (two bridges both spawn) is harmless: the daemon's inode
 * lock lets exactly one win and the loser exits 0, and either way this poll
 * finds *a* live daemon for the vault.
 */
async function resolveDaemon(
  vault: string,
  env: NodeJS.ProcessEnv,
  opts: { tools?: ToolSurface; log: (line: string) => void },
): Promise<DaemonInfo> {
  const existing = await findDaemon(vault, env);
  if (existing) return existing;

  opts.log(`sheaf mcp: no daemon for ${vault}; starting one`);
  spawnDaemon(vault, env, opts.tools, opts.log);

  const deadline = Date.now() + SPAWN_POLL_CAP_MS;
  let wait = SPAWN_POLL_BASE_MS;
  while (Date.now() < deadline) {
    await delay(wait);
    const info = await findDaemon(vault, env);
    if (info) {
      opts.log(`sheaf mcp: daemon ready at ${info.host}:${info.port}`);
      return info;
    }
    wait = Math.min(wait * 2, SPAWN_POLL_MAX_DELAY_MS);
  }

  throw new CliError(
    `sheaf daemon for ${vault} did not become reachable within ${SPAWN_POLL_CAP_MS}ms; ` +
      `check the daemon log under $SHEAF_HOME/logs`,
    "spawn_failed",
    EXIT.GENERIC,
  );
}

/**
 * Spawn `sheaf serve` as a DETACHED child that does not inherit the bridge's
 * stdio (`stdio: "ignore"` — the daemon logs to `$SHEAF_HOME/logs/<key>.log` on
 * its own file fds, and the bridge's stdout must stay a clean MCP wire).
 * `unref` so this child never keeps the bridge process alive.
 *
 * Re-execs *this* binary via `process.execPath` + the absolute path to the
 * running entry (`import.meta.url`, which esbuild resolves to `bin/sheaf.js`),
 * passing `--vault` (absolute) and `--tools` through; `$SHEAF_HOME` rides along
 * in the inherited `env`.
 */
function spawnDaemon(
  vault: string,
  env: NodeJS.ProcessEnv,
  tools: ToolSurface | undefined,
  log: (line: string) => void,
): void {
  const selfPath = fileURLToPath(import.meta.url);
  const args = [selfPath, "serve", "--vault", vault];
  if (tools) args.push("--tools", tools);
  try {
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      env,
    });
    child.on("error", (e) => log(`sheaf mcp: failed to spawn daemon: ${errMessage(e)}`));
    child.unref();
  } catch (e) {
    log(`sheaf mcp: failed to spawn daemon: ${errMessage(e)}`);
  }
}

/**
 * The transport relay itself. Wires both directions, the `-32603`-on-death
 * synthesis, the `initialize`-result protocol-version sniff, and the stdin-end
 * (drain then) exit. Resolves with the process exit code when the bridge stops.
 */
function runBridge(opts: {
  info: DaemonInfo;
  headers: Record<string, string>;
  err: (line: string) => void;
}): Promise<ExitCode> {
  const { info, headers, err } = opts;
  const mcpUrl = new URL(`${daemonBaseUrl(info)}/api/mcp`);
  const http = new StreamableHTTPClientTransport(mcpUrl, {
    requestInit: { headers },
  });
  const stdio = new StdioServerTransport(process.stdin, process.stdout);

  // Request ids seen flowing stdio→http and not yet answered. On daemon death
  // we synthesize a -32603 for each so the agent's pending calls reject.
  const outstanding = new Set<string | number>();

  let settle!: (code: ExitCode) => void;
  const done = new Promise<ExitCode>((r) => {
    settle = r;
  });

  let shuttingDown = false;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;

  const detachStdin = (): void => {
    process.stdin.removeListener("end", onStdinEnd);
    process.stdin.removeListener("close", onStdinEnd);
  };

  const shutdown = async (code: ExitCode, reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (drainTimer) clearTimeout(drainTimer);
    err(`sheaf mcp: shutting down (${reason})`);
    detachStdin();
    // Close http first (aborts the fetch controller, clears reconnection
    // timers), then stdio (detaches the stdin data listener). Both best-effort.
    try {
      await http.close();
    } catch {
      /* already closed / never fully opened */
    }
    try {
      await stdio.close();
    } catch {
      /* already closed */
    }
    settle(code);
  };

  // -32603 synthesis. Idempotent: the SDK fires both `send()` rejection AND
  // `onerror` for one failure, and our own `http.close()` fires `onclose`.
  let daemonFailed = false;
  const onDaemonFailure = (e: unknown): void => {
    if (daemonFailed || shuttingDown) return;
    daemonFailed = true;
    const ids = [...outstanding];
    outstanding.clear();
    err(
      `sheaf mcp: daemon connection lost (${errMessage(e)}); ` +
        `failing ${ids.length} in-flight request(s) with -32603`,
    );
    void (async () => {
      for (const id of ids) {
        const errorResponse: JSONRPCMessage = {
          jsonrpc: "2.0",
          id,
          error: { code: -32603, message: "sheaf daemon unavailable" },
        };
        try {
          await stdio.send(errorResponse);
        } catch {
          /* stdout is gone too — nothing more we can do */
        }
      }
      await shutdown(EXIT.GENERIC, "daemon unavailable");
    })();
  };

  // Exit when there are no outstanding requests left AND stdin has ended.
  let stdinEnded = false;
  const finishIfDrained = (): void => {
    if (stdinEnded && outstanding.size === 0 && !shuttingDown) {
      void shutdown(EXIT.OK, "stdin closed");
    }
  };

  // --- Relay: agent (stdio) → daemon (http). ---
  stdio.onmessage = (msg) => {
    const m = msg as JsonRpcish;
    if (isRequest(m)) outstanding.add(m.id);
    http.send(msg).catch(onDaemonFailure);
  };
  stdio.onerror = (e) => err(`sheaf mcp: stdin transport error: ${errMessage(e)}`);

  // --- Relay: daemon (http) → agent (stdio). ---
  http.onmessage = (msg) => {
    const m = msg as JsonRpcish;
    if (isResponse(m)) outstanding.delete(m.id);
    // Forward the negotiated protocol version so later client requests carry the
    // `mcp-protocol-version` header (no `Client` wrapper does this for a raw
    // relay). Guarded for absence / a non-initialize result.
    const result = m.result as { protocolVersion?: unknown } | undefined;
    if (result && typeof result.protocolVersion === "string") {
      try {
        http.setProtocolVersion(result.protocolVersion);
      } catch {
        /* older transport without the setter — nothing to do */
      }
    }
    stdio
      .send(msg)
      .catch((e) => err(`sheaf mcp: failed writing to stdout: ${errMessage(e)}`));
    finishIfDrained();
  };
  http.onerror = (e) => onDaemonFailure(e);
  http.onclose = () => onDaemonFailure(new Error("daemon transport closed"));

  // --- stdin end → exit (drain in-flight requests first). ---
  const onStdinEnd = (): void => {
    if (stdinEnded) return;
    stdinEnded = true;
    if (outstanding.size === 0) {
      void shutdown(EXIT.OK, "stdin closed");
      return;
    }
    err(
      `sheaf mcp: stdin closed; draining ${outstanding.size} in-flight request(s)`,
    );
    drainTimer = setTimeout(
      () => void shutdown(EXIT.OK, "stdin closed (drain timeout)"),
      DRAIN_CAP_MS,
    );
    drainTimer.unref();
  };

  // Start the daemon side first so a stdin message that arrives immediately
  // never races an unstarted http transport, then begin reading stdin.
  return (async () => {
    await http.start();
    await stdio.start();
    process.stdin.on("end", onStdinEnd);
    process.stdin.on("close", onStdinEnd);
    return done;
  })();
}

/**
 * `--no-daemon` standalone fallback: an in-process MCP server over stdio backed
 * by a private {@link StubBackend}. Valid only when nothing else touches the
 * vault (docs/sheaf-cli-v0.1.md) — there is no daemon and no cross-process event
 * fan-out, so a comment posted in Obsidian would never reach this agent. We say
 * so on stderr. Blocks until the host closes stdin, then exits 0.
 */
async function runStandalone(
  vault: string,
  tools: ToolSurface | undefined,
  doc: string | undefined,
  err: (line: string) => void,
): Promise<ExitCode> {
  err(
    "sheaf mcp: --no-daemon — serving an in-process backend; live events across " +
      "processes (Obsidian/UI) are unavailable in this mode",
  );

  const backend = new StubBackend(vault, vault);
  const server = buildServer(backend, { tools, docScope: doc });
  const stdio = new StdioServerTransport(process.stdin, process.stdout);

  let settle!: (code: ExitCode) => void;
  const done = new Promise<ExitCode>((r) => {
    settle = r;
  });

  let shuttingDown = false;
  const onStdinEnd = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdin.removeListener("end", onStdinEnd);
    process.stdin.removeListener("close", onStdinEnd);
    err("sheaf mcp: shutting down (stdin closed)");
    void server
      .close()
      .catch(() => {})
      .finally(() => settle(EXIT.OK));
  };

  // `connect` calls `transport.start()`, which attaches the stdin data listener.
  await server.connect(stdio);
  process.stdin.on("end", onStdinEnd);
  process.stdin.on("close", onStdinEnd);
  return done;
}

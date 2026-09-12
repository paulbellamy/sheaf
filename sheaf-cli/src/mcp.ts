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
 *     NOT wrap either side in an SDK `Client`/`Server`; the daemon never
 *     initiates a server→client message, so a raw relay is complete. We
 *     reinterpret the JSON-RPC only enough to (a) forward the negotiated
 *     protocol version, (b) route HTTP vs connection-class failures, and
 *     (c) reconnect + replay on daemon death — see below. `sheaf mcp` is the
 *     ONLY command that may auto-spawn a daemon (no human at the keyboard).
 *
 *   - **Standalone (`--no-daemon`).** A documented escape hatch, valid only when
 *     nothing else touches the vault: build the MCP server in-process against a
 *     private {@link StubBackend} and connect it straight to a stdio transport.
 *     No daemon, no cross-process events (the ReadMe says so in this mode).
 *
 * ## The load-bearing details (verified against SDK 1.29.0)
 *
 *   - **stdout is the wire.** Every diagnostic goes to stderr; only relayed
 *     JSON-RPC is written to stdout. `mcp` errors are forced to stderr text
 *     regardless of `--format`, so a `--format json` error object never lands
 *     on the wire.
 *   - **Reconnect once on daemon death.** The daemon builds a FRESH stateless
 *     `McpServer` per POST, so there is no per-connection handshake state to
 *     resume — the only negotiated state (the protocol version) already lives
 *     here from the `initialize` sniff. So when a forwarded request fails with a
 *     *connection-class* error (a network failure / ECONNREFUSED — no HTTP
 *     response was received; e.g. the daemon idle-exited), we re-resolve the
 *     daemon (auto-spawning one), rebuild the http transport carrying the
 *     sniffed protocol version and the `--doc` header, and RE-SEND each
 *     still-outstanding request ONCE. Each POST is independent, so a replayed
 *     `tools/call` just works against the new daemon. A request is replayed at
 *     most once (no reconnect loop); only if re-resolve/reconnect fails, or a
 *     replayed request fails again, do we synthesize a `-32603` for every
 *     outstanding id and exit non-zero.
 *   - **HTTP status errors are NOT death.** A 4xx/5xx from the daemon (e.g. a
 *     malformed `--doc` → 400 `invalid_path`) arrives as an SDK
 *     `StreamableHTTPError` carrying the status — the daemon is alive and
 *     answered. We synthesize a JSON-RPC error for THAT request id only (the
 *     server body in `error.data`) and STAY UP; we do not reconnect.
 *   - **Exit on stdin end.** {@link StdioServerTransport} never listens for
 *     `end`/`close`, so without our own listener the bridge would outlive the
 *     host. On stdin end we drain in-flight requests (so a piped `initialize`
 *     still gets its answer), capped by {@link DEFAULT_DRAIN_CAP_MS} so a wedged
 *     daemon can't hold the exit forever, then exit 0.
 *   - **setProtocolVersion.** A raw relay has no `Client` to call it, so we
 *     sniff the `initialize` result flowing http→stdio and forward its
 *     `protocolVersion` to the http transport (and re-apply it on reconnect).
 *   - **`--doc PATH`** is normalized to a vault-relative POSIX path and passed
 *     to the `x-sheaf-doc` request header (bridge) or `buildServer`'s `docScope`
 *     (standalone). Out-of-vault / traversal paths are rejected (exit 2).
 *   - **GET /api/mcp → 405.** Relied upon: after the client's `initialized`
 *     notification the http transport auto-opens a server→client GET stream;
 *     the daemon answers 405 and the SDK tolerates it, so no zombie
 *     `buildServer`+socket is stranded.
 *
 * ## Known limit
 *
 * Stateless proxying is complete only while the server never initiates a
 * message (no elicitation, sampling, or `listChanged` push). The sheaf daemon
 * meets that; a server that didn't would need a session-aware bridge.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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
 * Default: when stdin ends with requests still in flight, wait at most this long
 * for the daemon's answers before exiting anyway — a wedged daemon must not keep
 * the bridge (and its exit code) pending forever. Overridable via
 * `SHEAF_MCP_DRAIN_MS` (used by tests to keep the drain-cap assertion fast).
 */
const DEFAULT_DRAIN_CAP_MS = 10_000;

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
 * Normalize `--doc` to a vault-relative POSIX path, the shape the daemon's ACP
 * doc-scope expects (it rejects absolute / `./` / `..` paths fail-closed, and
 * step 5's `mcp install` writes ABSOLUTE vault paths into GUI configs). Resolve
 * against the vault, reject anything that escapes it, and POSIX-ify separators.
 * A path outside the vault (or the vault root itself) is a usage error (exit 2).
 */
function normalizeDocScope(vault: string, doc: string): string {
  const rel = relative(vault, resolve(vault, doc));
  if (
    rel === "" ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    throw usageError(
      `--doc must name a document inside the vault (got '${doc}')`,
    );
  }
  return rel.split(sep).join("/");
}

/**
 * Reject a doc scope that can't ride in an HTTP header. Header values are
 * Latin-1 (a non-Latin-1 char makes `new Headers()` throw a raw TypeError deep
 * in the transport), so we fail fast with a clear message. Only bridge mode
 * needs this — standalone passes the scope in-process, not as a header.
 */
function assertHeaderSafe(doc: string): void {
  for (let i = 0; i < doc.length; i++) {
    if (doc.charCodeAt(i) > 0xff) {
      throw usageError(
        `--doc '${doc}' has characters that can't be sent in the x-sheaf-doc ` +
          `HTTP header; use --no-daemon for a non-Latin-1 doc path`,
      );
    }
  }
}

/** Read `SHEAF_MCP_DRAIN_MS` (non-negative number) or the default. */
function readDrainCapMs(env: NodeJS.ProcessEnv): number {
  const raw = env.SHEAF_MCP_DRAIN_MS;
  if (raw && raw.length > 0) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_DRAIN_CAP_MS;
}

/**
 * A loose view of a JSON-RPC message for the small amount of sniffing the relay
 * does. The SDK has already validated the shape (both transports parse with
 * `JSONRPCMessageSchema`); we only read fields, never construct beyond the
 * synthesized error responses.
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
    m.method === undefined &&
    m.id !== undefined &&
    m.id !== null &&
    (m.result !== undefined || m.error !== undefined)
  );
}

/**
 * `run` handler for `sheaf mcp`. Blocks until the host closes stdin (exit 0) or
 * the daemon is unrecoverable (exit non-zero). All diagnostics and errors go to
 * stderr as plain text — regardless of `--format` — so stdout stays a clean
 * JSON-RPC wire.
 */
export async function mcpBridgeCommand(ctx: RunContext): Promise<ExitCode> {
  const err = (line: string): void => ctx.io.err(`${line}\n`);
  try {
    const tools = parseTools(ctx.values.tools);
    const rawDoc = typeof ctx.values.doc === "string" ? ctx.values.doc : undefined;
    const doc =
      rawDoc !== undefined ? normalizeDocScope(ctx.vault, rawDoc) : undefined;

    if (ctx.globals.noDaemon) {
      return await runStandalone(ctx.vault, tools, doc, err);
    }

    // Per-doc scope travels as a request header (ACP §3.1); the daemon resolves
    // it fail-closed. Reject a value HTTP headers can't carry before we connect.
    const headers: Record<string, string> = {};
    if (doc !== undefined) {
      assertHeaderSafe(doc);
      headers["x-sheaf-doc"] = doc;
    }

    const info = await resolveDaemon(ctx.vault, ctx.io.env, { tools, log: err });
    return await runBridge({
      vault: ctx.vault,
      env: ctx.io.env,
      tools,
      headers,
      info,
      drainCapMs: readDrainCapMs(ctx.io.env),
      err,
    });
  } catch (e) {
    // Force TEXT (stderr) errors for `mcp` regardless of --format: stdout is the
    // MCP wire and must never carry a non-JSON-RPC object.
    if (e instanceof CliError) {
      err(`sheaf mcp: ${e.message}`);
      return e.exitCode;
    }
    err(`sheaf mcp: internal error: ${errMessage(e)}`);
    return EXIT.GENERIC;
  }
}

/**
 * Locate the running daemon for `vault`, auto-spawning `sheaf serve` (detached,
 * with its own stdio) when none exists, then polling discovery until it is
 * reachable. Fails fast if the spawned child errors or exits non-zero at boot
 * (a lock-loser exits 0 → another daemon is coming up, so keep polling). Throws
 * a {@link CliError} (exit 1) if no daemon comes up within the cap.
 */
async function resolveDaemon(
  vault: string,
  env: NodeJS.ProcessEnv,
  opts: { tools?: ToolSurface; log: (line: string) => void },
): Promise<DaemonInfo> {
  const existing = await findDaemon(vault, env);
  if (existing) return existing;

  opts.log(`sheaf mcp: no daemon for ${vault}; starting one`);
  const child = spawnDaemon(vault, env, opts.tools, opts.log);

  // Watch the child so a boot failure ends the poll early instead of costing
  // the full window. A lock-loser exits 0 (someone else is the daemon) — that
  // is not a failure, so only a non-zero exit / spawn error is fatal.
  let childExit: number | null | undefined;
  let childErr: Error | undefined;
  const onExit = (code: number | null): void => {
    childExit = code;
  };
  const onErr = (e: Error): void => {
    childErr = e;
  };
  child?.on("exit", onExit);
  child?.on("error", onErr);

  try {
    const deadline = Date.now() + SPAWN_POLL_CAP_MS;
    let wait = SPAWN_POLL_BASE_MS;
    while (Date.now() < deadline) {
      await delay(wait);
      const info = await findDaemon(vault, env);
      if (info) {
        opts.log(`sheaf mcp: daemon ready at ${info.host}:${info.port}`);
        return info;
      }
      if (childErr) {
        throw new CliError(
          `failed to spawn daemon: ${errMessage(childErr)}`,
          "spawn_failed",
          EXIT.GENERIC,
        );
      }
      if (typeof childExit === "number" && childExit !== 0) {
        throw new CliError(
          `sheaf serve exited with code ${childExit} during boot; ` +
            `check the daemon log under $SHEAF_HOME/logs`,
          "spawn_failed",
          EXIT.GENERIC,
        );
      }
      wait = Math.min(wait * 2, SPAWN_POLL_MAX_DELAY_MS);
    }
    throw new CliError(
      `sheaf daemon for ${vault} did not become reachable within ${SPAWN_POLL_CAP_MS}ms; ` +
        `check the daemon log under $SHEAF_HOME/logs`,
      "spawn_failed",
      EXIT.GENERIC,
    );
  } finally {
    child?.removeListener("exit", onExit);
    child?.removeListener("error", onErr);
  }
}

/**
 * Spawn `sheaf serve` as a DETACHED child that does not inherit the bridge's
 * stdio (`stdio: "ignore"` — the daemon logs to `$SHEAF_HOME/logs/<key>.log` on
 * its own file fds, and the bridge's stdout must stay a clean MCP wire).
 * `unref` so this child never keeps the bridge process alive. Returns the child
 * (so the caller can watch its exit), or `undefined` if spawn threw synchronously.
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
): ChildProcess | undefined {
  const selfPath = fileURLToPath(import.meta.url);
  const args = [selfPath, "serve", "--vault", vault];
  if (tools) args.push("--tools", tools);
  try {
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      env,
    });
    child.unref();
    return child;
  } catch (e) {
    log(`sheaf mcp: failed to spawn daemon: ${errMessage(e)}`);
    return undefined;
  }
}

/**
 * The transport relay itself. Wires both directions, the reconnect-once /
 * fail-with-`-32603` handling on daemon death, the HTTP-status per-id error
 * synthesis, the `initialize`-result protocol-version sniff, and the stdin-end
 * (drain then) exit. Resolves with the process exit code when the bridge stops.
 */
function runBridge(opts: {
  vault: string;
  env: NodeJS.ProcessEnv;
  tools?: ToolSurface;
  headers: Record<string, string>;
  info: DaemonInfo;
  drainCapMs: number;
  err: (line: string) => void;
}): Promise<ExitCode> {
  const { vault, env, tools, headers, err } = opts;
  const mcpUrl = (info: DaemonInfo): URL =>
    new URL(`${daemonBaseUrl(info)}/api/mcp`);

  const stdio = new StdioServerTransport(process.stdin, process.stdout);
  // `http` is reassigned on reconnect; every reference reads the current one.
  let http = new StreamableHTTPClientTransport(mcpUrl(opts.info), {
    requestInit: { headers },
  });

  // Outstanding REQUEST objects (id → the JSON-RPC request), so a connection-
  // class failure can replay them against a reconnected daemon. `replayed`
  // guards a request from being replayed more than once (no reconnect loop).
  const outstanding = new Map<string | number, JSONRPCMessage>();
  const replayed = new Set<string | number>();
  let protocolVersion: string | undefined;

  let settle!: (code: ExitCode) => void;
  const done = new Promise<ExitCode>((r) => {
    settle = r;
  });

  let shuttingDown = false;
  let stdinEnded = false;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectPromise: Promise<boolean> | null = null;

  function detachStdin(): void {
    process.stdin.removeListener("end", onStdinEnd);
    process.stdin.removeListener("close", onStdinEnd);
  }

  async function shutdown(code: ExitCode, reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    if (drainTimer) clearTimeout(drainTimer);
    err(`sheaf mcp: shutting down (${reason})`);
    detachStdin();
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
  }

  /** Exit 0 once stdin has ended and nothing is left in flight or reconnecting. */
  function finishIfDrained(): void {
    if (
      stdinEnded &&
      outstanding.size === 0 &&
      !reconnectPromise &&
      !shuttingDown
    ) {
      void shutdown(EXIT.OK, "stdin closed");
    }
  }

  /** Synthesize `-32603` for every still-outstanding id, then exit non-zero. */
  async function failAllAndExit(reason: string): Promise<void> {
    if (shuttingDown) return;
    const ids = [...outstanding.keys()];
    err(
      `sheaf mcp: daemon unavailable (${reason}); ` +
        `failing ${ids.length} in-flight request(s) with -32603`,
    );
    for (const id of ids) {
      // A real response landing mid-loop already retired the id — don't also
      // synthesize an error for it (deliver exactly one answer per id).
      if (!outstanding.delete(id)) continue;
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
    await shutdown(EXIT.GENERIC, reason);
  }

  /** Send a message on a specific transport, routing its failure back with context. */
  function sendVia(
    transport: StreamableHTTPClientTransport,
    msg: JSONRPCMessage,
  ): void {
    transport.send(msg).catch((e) => onSendFailure(transport, msg, e));
  }

  /** Relay agent (stdio) → daemon (http). Records request ids for replay/synth. */
  function forward(msg: JSONRPCMessage): void {
    const m = msg as JsonRpcish;
    if (isRequest(m)) outstanding.set(m.id, msg);
    if (reconnectPromise) {
      // A reconnect is in flight: outstanding requests are (re)sent by the
      // replay loop on the new transport. Notifications during a reconnect are
      // dropped — the daemon is stateless, only requests need delivery.
      return;
    }
    sendVia(http, msg);
  }

  function onSendFailure(
    transport: StreamableHTTPClientTransport,
    msg: JSONRPCMessage,
    e: unknown,
  ): void {
    if (shuttingDown) return;
    // A stale failure from a transport we already replaced during a reconnect
    // (its aborted in-flight sends) — the replay already happened on `http`.
    if (transport !== http) return;

    const m = msg as JsonRpcish;

    // HTTP/protocol error: the daemon responded with a status (or a bad content
    // type). It's alive — synthesize a JSON-RPC error for THIS id only (server
    // body in error.data) and STAY UP, rather than treating it as death.
    if (e instanceof StreamableHTTPError) {
      if (isRequest(m)) {
        if (outstanding.delete(m.id)) {
          replayed.delete(m.id);
          const errorResponse: JSONRPCMessage = {
            jsonrpc: "2.0",
            id: m.id,
            error: {
              code: -32603,
              message: `sheaf daemon returned an error (HTTP ${e.code})`,
              data: { httpStatus: e.code, detail: e.message },
            },
          };
          stdio
            .send(errorResponse)
            .catch((se) =>
              err(`sheaf mcp: failed writing to stdout: ${errMessage(se)}`),
            );
          finishIfDrained();
        }
      } else {
        err(
          `sheaf mcp: daemon returned an error for a notification (HTTP ${e.code}): ${e.message}`,
        );
      }
      return;
    }

    // Connection-class error (no HTTP response): the daemon is gone.
    if (isRequest(m) && replayed.has(m.id)) {
      // Already replayed once and it failed again → reconnect didn't help.
      void failAllAndExit("reconnect did not restore the daemon");
      return;
    }
    void ensureReconnect();
  }

  /** Run at most one reconnect at a time; fail-all if it can't restore a daemon. */
  async function ensureReconnect(): Promise<void> {
    if (shuttingDown || reconnectPromise) return;
    reconnectPromise = doReconnect();
    const ok = await reconnectPromise;
    reconnectPromise = null;
    if (!ok) {
      await failAllAndExit("could not reconnect to a daemon");
    } else {
      // A reconnect that replayed nothing (e.g. only a notification failed) may
      // have left a drained-stdin exit pending.
      finishIfDrained();
    }
  }

  /**
   * Rebuild the daemon transport once (re-resolving/auto-spawning the daemon)
   * and replay each still-outstanding request on it. Returns false if a daemon
   * couldn't be restored — the caller then fails all outstanding + exits.
   */
  async function doReconnect(): Promise<boolean> {
    err("sheaf mcp: daemon connection lost; reconnecting once");
    try {
      await http.close();
    } catch {
      /* best effort */
    }
    let info: DaemonInfo;
    try {
      info = await resolveDaemon(vault, env, { tools, log: err });
    } catch (e) {
      err(`sheaf mcp: reconnect failed: ${errMessage(e)}`);
      return false;
    }
    const next = new StreamableHTTPClientTransport(mcpUrl(info), {
      requestInit: { headers },
    });
    wireHttp(next);
    if (protocolVersion) {
      try {
        next.setProtocolVersion(protocolVersion);
      } catch {
        /* older transport without the setter */
      }
    }
    try {
      await next.start();
    } catch (e) {
      err(`sheaf mcp: reconnect failed to start transport: ${errMessage(e)}`);
      return false;
    }
    http = next;
    err(`sheaf mcp: reconnected to ${info.host}:${info.port}`);
    // Replay each still-outstanding request once, on the new transport.
    for (const [id, req] of outstanding) {
      if (replayed.has(id)) continue;
      replayed.add(id);
      sendVia(next, req);
    }
    return true;
  }

  /** (Re)wire a daemon-side transport's callbacks. Called for each http transport. */
  function wireHttp(transport: StreamableHTTPClientTransport): void {
    transport.onmessage = (msg) => {
      const m = msg as JsonRpcish;
      // Forward the negotiated protocol version so later requests carry the
      // `mcp-protocol-version` header (no `Client` wrapper does this for a raw
      // relay). Guarded for absence / a non-initialize result.
      const result = m.result as { protocolVersion?: unknown } | undefined;
      if (result && typeof result.protocolVersion === "string") {
        protocolVersion = result.protocolVersion;
        try {
          transport.setProtocolVersion(result.protocolVersion);
        } catch {
          /* older transport without the setter */
        }
      }
      if (isResponse(m)) {
        // Deliver exactly one answer per id: if the id was already retired (by a
        // synthesized error, or a duplicate), drop this late response.
        if (!outstanding.delete(m.id)) return;
        replayed.delete(m.id);
      }
      stdio
        .send(msg)
        .catch((e) => err(`sheaf mcp: failed writing to stdout: ${errMessage(e)}`));
      finishIfDrained();
    };
    transport.onerror = (e) =>
      err(`sheaf mcp: daemon transport error: ${errMessage(e)}`);
    // onclose fires only from our own close() (reconnect/shutdown) — the SDK
    // never closes on network death — so ignore it; a send() rejection is the
    // death signal.
    transport.onclose = () => {};
  }

  function onStdinEnd(): void {
    if (stdinEnded) return;
    stdinEnded = true;
    if (outstanding.size === 0 && !reconnectPromise) {
      void shutdown(EXIT.OK, "stdin closed");
      return;
    }
    err(
      `sheaf mcp: stdin closed; draining ${outstanding.size} in-flight request(s)`,
    );
    drainTimer = setTimeout(
      () => void shutdown(EXIT.OK, "stdin closed (drain timeout)"),
      opts.drainCapMs,
    );
    drainTimer.unref();
  }

  wireHttp(http);
  stdio.onmessage = (msg) => forward(msg);
  stdio.onerror = (e) => err(`sheaf mcp: stdin transport error: ${errMessage(e)}`);

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
 * fan-out, so the ReadMe is served in `standalone` mode (it tells the agent to
 * poll `ListThreads` rather than subscribe). We also note the limitation on
 * stderr. Blocks until the host closes stdin, then exits 0.
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
  const server = buildServer(backend, {
    tools,
    docScope: doc,
    standalone: true,
  });
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

/**
 * The reusable client core: locate the vault's daemon, then talk to it over
 * loopback HTTP two ways.
 *
 * The invariant (docs/sheaf-cli-v0.1.md) is "exactly one live backend per
 * vault, in one process" — the daemon. Every command that isn't `sheaf serve`
 * is a *client* of that daemon; none constructs its own backend (the one
 * exception, `sheaf mcp --no-daemon`, is step 4). This module is the single
 * seam those clients share:
 *
 *   - {@link connectDaemon} resolves the running daemon via `findDaemon` (the
 *     step-2 "reachable daemon" seam — a record whose `/api/health` confirms
 *     the matching vault *and* pid) and returns a {@link DaemonClient} bound to
 *     its base URL. No daemon ⇒ `noDaemonError` (exit 3). It never spawns one:
 *     auto-spawn is `sheaf mcp`'s alone (step 4).
 *   - {@link DaemonClient.rest} is the thin `fetch` wrapper for the REST surface
 *     (`/api/ui/*`) — the path used by `--as ui` mutations, which stamp origin
 *     `ui` and wake the connected agent.
 *   - {@link DaemonClient.mcp} lazily connects an MCP SDK `Client` over
 *     Streamable HTTP to `/api/mcp` — the path for reads and `--as agent`
 *     mutations (origin `agent`, the full tool surface). See the wire-protocol
 *     table in the plan.
 *
 * The wire split is deliberate and lives in the domain verbs (step 6); this
 * module just makes both transports available and cleanly closable.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  daemonBaseUrl,
  findDaemon,
  type DaemonInfo,
} from "sheaf-server/daemon";

import type { Globals } from "./args";
import { CliError, EXIT, noDaemonError } from "./io";
import { VERSION } from "./version";

/** Options for a single {@link DaemonClient.rest} call. */
export interface RestOptions {
  /** Query params appended to the path; `undefined` values are skipped. */
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON request body; serialized and sent with `content-type: application/json`. */
  body?: unknown;
  /** Extra request headers (merged over the defaults). */
  headers?: Record<string, string>;
  /** Abort signal (e.g. a timeout or a cancelled command). */
  signal?: AbortSignal;
}

/**
 * A live MCP session over the daemon's `/api/mcp` endpoint. Returned by
 * {@link DaemonClient.mcp}; `callTool`/`listTools` are the two verbs step 6 (and
 * anything driving the tool surface) needs. `client` is the underlying SDK
 * `Client` for anything more exotic.
 */
export interface McpSession {
  /** Call a tool by name; `args` becomes the JSON-RPC `arguments` object. */
  callTool(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<Awaited<ReturnType<Client["callTool"]>>>;
  /** List the registered tools (name, description, input schema). */
  listTools(): Promise<Awaited<ReturnType<Client["listTools"]>>>;
  /** The underlying SDK client, memoized for this {@link DaemonClient}. */
  client: Client;
}

/**
 * A client bound to one running daemon. Cheap to construct (it just holds the
 * discovery record + base URL); the MCP transport is connected lazily on the
 * first {@link mcp} call and reused. Always {@link close} it so the MCP socket
 * doesn't keep the process alive.
 */
export class DaemonClient {
  /** The daemon's loopback base URL (`http://host:port`, IPv6-bracketed). */
  readonly base: string;

  private session: McpSession | undefined;
  private transport: StreamableHTTPClientTransport | undefined;
  private connecting: Promise<McpSession> | undefined;

  constructor(readonly info: DaemonInfo) {
    this.base = daemonBaseUrl(info);
  }

  /**
   * The MCP endpoint URL. Step 4's stdio bridge builds its *own*
   * `StreamableHTTPClientTransport` against this (it relays raw JSON-RPC rather
   * than going through an SDK `Client`), so it is exposed here as the single
   * source of the address.
   */
  get mcpUrl(): URL {
    return new URL(`${this.base}/api/mcp`);
  }

  /**
   * Issue a REST request against the daemon and return the parsed JSON body.
   *
   * The daemon binds loopback only, and {@link base} is therefore a loopback
   * host, so Node's `fetch` sets `Host: 127.0.0.1:PORT` (or `[::1]:PORT`)
   * automatically — which is exactly what the server's DNS-rebinding Host guard
   * (see `isLoopbackHost` in `sheaf-server/app`) requires. No manual `Host`
   * override is needed or wanted (undici rejects some header overrides); the
   * client tests exercise a real round-trip to prove the guard is satisfied.
   *
   * On a non-2xx response the `{ error, code }` body (mirroring the server's
   * `errorResult`) is turned into a {@link CliError} with the server's `code`
   * preserved, so callers/scripts can branch on it. A transport-level failure
   * (the daemon died mid-call) becomes a clear "cannot reach daemon" error.
   */
  async rest<T = unknown>(
    method: string,
    path: string,
    opts: RestOptions = {},
  ): Promise<T> {
    const url = new URL(`${this.base}${path}`);
    if (opts.query) {
      for (const [key, value] of Object.entries(opts.query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = { accept: "application/json", ...opts.headers };
    let body: string | undefined;
    if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers["content-type"] = "application/json";
    }

    let res: Response;
    try {
      res = await fetch(url, { method, headers, body, signal: opts.signal });
    } catch (e) {
      throw new CliError(
        `cannot reach sheaf daemon at ${this.base}: ${errMessage(e)}`,
        "daemon_unreachable",
        EXIT.GENERIC,
      );
    }

    // Parse the body once (tolerating an empty one — some mutations 200 with no
    // content). A JSON parse failure on an error response still surfaces the
    // status; on a success response it's a protocol violation worth reporting.
    const text = await res.text();
    let parsed: unknown;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new CliError(
          res.ok
            ? `daemon returned a non-JSON response (HTTP ${res.status})`
            : `daemon returned HTTP ${res.status}`,
          res.ok ? "bad_response" : "http_error",
          EXIT.GENERIC,
        );
      }
    }

    if (!res.ok) {
      const errBody = parsed as { error?: unknown; code?: unknown } | undefined;
      const message =
        typeof errBody?.error === "string"
          ? errBody.error
          : `daemon returned HTTP ${res.status}`;
      const code =
        typeof errBody?.code === "string" ? errBody.code : "http_error";
      throw new CliError(message, code, EXIT.GENERIC);
    }

    return parsed as T;
  }

  /**
   * Connect (once) an MCP `Client` to `/api/mcp` over Streamable HTTP and return
   * a reusable {@link McpSession}. Memoized: concurrent callers share the single
   * in-flight connect, and every later call returns the same session. A failed
   * connect is not cached, so a caller can retry.
   *
   * The daemon runs the transport in stateless JSON-response mode and answers
   * `GET /api/mcp` with 405; the SDK client tolerates the 405 and simply forgoes
   * the (empty) server→client stream, so nothing is left hanging after
   * `connect()` — {@link close} then tears the socket down cleanly.
   */
  async mcp(): Promise<McpSession> {
    if (this.session) return this.session;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const transport = new StreamableHTTPClientTransport(this.mcpUrl);
      const client = new Client(
        { name: "sheaf-cli", version: VERSION },
        { capabilities: {} },
      );
      try {
        await client.connect(transport);
      } catch (e) {
        // Leave nothing half-open, and don't memoize the failure.
        try {
          await transport.close();
        } catch {
          /* best effort */
        }
        throw new CliError(
          `cannot open MCP session at ${this.mcpUrl.href}: ${errMessage(e)}`,
          "mcp_connect",
          EXIT.GENERIC,
        );
      }
      this.transport = transport;
      const session: McpSession = {
        client,
        callTool: (name, args) =>
          client.callTool({ name, arguments: args ?? {} }),
        listTools: () => client.listTools(),
      };
      this.session = session;
      return session;
    })();

    try {
      return await this.connecting;
    } catch (e) {
      this.connecting = undefined;
      throw e;
    }
  }

  /**
   * Close the MCP transport if it was opened, so the process can exit cleanly
   * (the REST path is stateless `fetch` — nothing to close there). Idempotent.
   */
  async close(): Promise<void> {
    const transport = this.transport;
    this.transport = undefined;
    this.session = undefined;
    this.connecting = undefined;
    if (transport) {
      try {
        await transport.close();
      } catch {
        /* already closed / never fully opened */
      }
    }
  }
}

/**
 * Locate the running daemon for `vault` and return a {@link DaemonClient} bound
 * to it. Throws {@link noDaemonError} (exit 3) when no live daemon owns the
 * vault — deliberately: only `sheaf mcp` may auto-spawn (step 4); every other
 * client errors and tells the user to run `sheaf serve`.
 */
export async function connectDaemon(
  vault: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DaemonClient> {
  const info = await findDaemon(vault, env);
  if (!info) throw noDaemonError(vault);
  return new DaemonClient(info);
}

/**
 * Guard for every non-`mcp` command: `--no-daemon` is only meaningful for
 * `sheaf mcp` (the daemon-less MCP escape hatch, step 4). On any other command
 * it is a misuse, so fail fast (exit 3) with a message that names the command
 * and points at the right flag — rather than silently ignoring it and hitting a
 * confusing "no daemon" error later.
 */
export function requireDaemonAllowed(globals: Globals, command: string): void {
  if (globals.noDaemon) {
    throw new CliError(
      `${command} requires a running daemon (run \`sheaf serve\`); ` +
        "--no-daemon is only valid for `sheaf mcp`",
      "no_daemon",
      EXIT.NO_DAEMON,
    );
  }
}

/** Best-effort message extraction for wrapped transport/network errors. */
function errMessage(e: unknown): string {
  if (e instanceof Error) {
    // Node wraps the real cause on fetch failures ("fetch failed").
    const cause = (e as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return cause.message;
    return e.message;
  }
  return String(e);
}

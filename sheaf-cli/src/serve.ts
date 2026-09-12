/**
 * `sheaf serve` — the daemon.
 *
 * Owns the single `StubBackend(vault, vault)` for a vault (the invariant from
 * docs/sheaf-cli-v0.1.md), runs `buildSheafApp` on a loopback socket, registers
 * itself for discovery, and stays up until a signal, an explicit stop, or the
 * idle timeout tears it down.
 *
 * The work is split so tests can drive it without the blocking foreground loop:
 *   - {@link startServer} claims the lock, listens, registers, arms idle-exit,
 *     and returns a {@link ServeHandle} *without* blocking. Tests call this,
 *     hit the socket, then `handle.close()`.
 *   - {@link serveCommand} is the `run` handler: it calls `startServer`, prints
 *     the bound address, wires SIGTERM/SIGINT to a clean shutdown, and only
 *     then awaits `handle.closed` (so the command blocks like a real daemon).
 */
import { createWriteStream, mkdirSync, unlinkSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";

import { StubBackend, type ToolSurface } from "sheaf-server";
import { buildSheafApp } from "sheaf-server/app";
import {
  acquireLock,
  daemonBaseUrl,
  daemonFile,
  daemonKey,
  isDaemonAlive,
  lockFile,
  readDaemon,
  registerDaemon,
  type DaemonInfo,
} from "sheaf-server/daemon";

import type { RunContext } from "./commands";
import { ensureSheafHome, loadConfig, logsDir } from "./config";
import { EXIT, usageError, type ExitCode } from "./io";
import { resolveVault } from "./vault";
import { VERSION } from "./version";

/** Idle-exit default: 30 minutes with no MCP request and no open SSE stream. */
const DEFAULT_IDLE_MS = 30 * 60 * 1000;

/** A started daemon: its bound address and a way to stop it. */
export interface ServeHandle {
  host: string;
  port: number;
  /** Loopback base URL (`http://host:port`), IPv6-bracketed where needed. */
  url: string;
  /** The realpath'd vault this daemon owns. */
  vault: string;
  pid: number;
  /** Resolves once the daemon has fully shut down and cleaned up. */
  closed: Promise<void>;
  /** Trigger a clean shutdown (idempotent); resolves when cleanup is done. */
  close(reason?: string): Promise<void>;
}

/** Options for {@link startServer}. `vault` must already be realpath'd. */
export interface StartServerOptions {
  vault: string;
  host?: string;
  /** Bound port; `0` (the default) picks an ephemeral one. */
  port?: number;
  tools?: ToolSurface;
  allowedOrigins?: string[];
  version: string;
  /** `$SHEAF_HOME` / `SHEAF_IDLE_MS` source (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Override the idle timeout (ms); otherwise `SHEAF_IDLE_MS` or the default. */
  idleMs?: number;
  /** Append daemon logs to this file (mode 0600). Omit to skip file logging. */
  logFile?: string;
  /** Mirror each log line here too (stderr, when a human runs in foreground). */
  log?: (line: string) => void;
}

/**
 * Raised by {@link startServer} when another process already owns the vault's
 * lock. Carries the existing discovery record (or `null` when a daemon is
 * mid-boot — it holds the lock but has not written its record yet).
 */
export class DaemonAlreadyRunningError extends Error {
  constructor(readonly existing: DaemonInfo | null) {
    super(
      existing
        ? `a sheaf daemon is already running (pid ${existing.pid}) at ${existing.host}:${existing.port}`
        : "a sheaf daemon is already starting",
    );
    this.name = "DaemonAlreadyRunningError";
  }
}

/** Read `SHEAF_IDLE_MS` (positive number) or fall back to the 30-min default. */
function readIdleMs(env: NodeJS.ProcessEnv): number {
  const raw = env.SHEAF_IDLE_MS;
  if (raw && raw.length > 0) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_IDLE_MS;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Start the daemon and return once it is listening + registered. Does not
 * block. Throws {@link DaemonAlreadyRunningError} on lock contention.
 */
export async function startServer(
  opts: StartServerOptions,
): Promise<ServeHandle> {
  const env = opts.env ?? process.env;
  ensureSheafHome(env);

  const host = opts.host ?? "127.0.0.1";
  const requestedPort = opts.port ?? 0;

  // --- Spawn lock (before listening). ---
  let lockRelease = acquireLock(opts.vault, env);
  if (!lockRelease) {
    const existing = readDaemon(opts.vault, env);
    const alive = existing ? await isDaemonAlive(opts.vault, env) : false;
    if (existing && !alive) {
      // A crashed daemon left its lock + record behind. The health probe
      // confirms it is dead (a mid-boot winner has no record yet, so it is not
      // mistaken for stale), so reclaim: drop the stale files and retry once.
      try {
        unlinkSync(daemonFile(opts.vault, env));
      } catch {
        /* already gone */
      }
      try {
        unlinkSync(lockFile(opts.vault, env));
      } catch {
        /* already gone */
      }
      lockRelease = acquireLock(opts.vault, env);
    }
    if (!lockRelease) {
      // Still contended: a live daemon, or another `serve` won the reclaim
      // race, or a winner holds the lock while still booting.
      throw new DaemonAlreadyRunningError(existing);
    }
  }

  // --- Logging (file + optional stderr mirror). ---
  let logStream: ReturnType<typeof createWriteStream> | null = null;
  if (opts.logFile) {
    mkdirSync(dirname(opts.logFile), { recursive: true, mode: 0o700 });
    logStream = createWriteStream(opts.logFile, { flags: "a", mode: 0o600 });
  }
  const log = (line: string): void => {
    const stamped = `${new Date().toISOString()} sheaf serve[${process.pid}] ${line}`;
    try {
      logStream?.write(`${stamped}\n`);
    } catch {
      /* logging must never throw */
    }
    try {
      opts.log?.(stamped);
    } catch {
      /* ditto */
    }
  };

  // --- Backend + app. ---
  const backend = new StubBackend(opts.vault, opts.vault);
  const startedAt = Date.now();
  const app = buildSheafApp(backend, {
    tools: opts.tools,
    allowedOrigins: opts.allowedOrigins,
    health: { vault: opts.vault, startedAt, version: opts.version },
  });

  // --- Idle-exit accounting. A live SSE stream keeps the daemon up; otherwise
  // it exits `idleMs` after the last MCP request. Health probes and UI REST
  // don't count (a `daemon status` poll must not keep an orphan alive). ---
  const idleMs = opts.idleMs ?? readIdleMs(env);
  let lastActivity = Date.now();
  let openStreams = 0;
  app.addHook("onRequest", async (req) => {
    const pathOnly = req.url.split("?")[0];
    if (pathOnly === "/api/mcp") {
      lastActivity = Date.now();
    } else if (pathOnly === "/api/ui/drafts/stream") {
      openStreams += 1;
      lastActivity = Date.now();
      req.raw.on("close", () => {
        openStreams = Math.max(0, openStreams - 1);
        lastActivity = Date.now();
      });
    }
  });

  try {
    await app.listen({ port: requestedPort, host });
  } catch (e) {
    lockRelease();
    logStream?.end();
    throw e;
  }
  const port = (app.server.address() as AddressInfo).port;
  const disposer = registerDaemon(
    { vault: opts.vault, host, port, version: opts.version },
    env,
  );

  // --- Shutdown plumbing. ---
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => {
    resolveClosed = r;
  });
  let idleTimer: ReturnType<typeof setInterval> | undefined;
  let shuttingDown = false;
  const close = async (reason = "close"): Promise<void> => {
    if (shuttingDown) return closed;
    shuttingDown = true;
    if (idleTimer) clearInterval(idleTimer);
    log(`shutting down (${reason})`);
    try {
      disposer();
    } catch {
      /* discovery already gone */
    }
    try {
      lockRelease();
    } catch {
      /* lock already released */
    }
    try {
      await app.close();
    } catch (e) {
      log(`error closing server: ${errMsg(e)}`);
    }
    try {
      logStream?.end();
    } catch {
      /* stream already ended */
    }
    resolveClosed();
    return closed;
  };

  // Check more often than the timeout so tiny test timeouts fire promptly;
  // `unref` so the timer alone never keeps the process alive.
  const period = Math.max(20, Math.min(Math.ceil(idleMs / 3), 60_000));
  idleTimer = setInterval(() => {
    if (openStreams > 0) return;
    if (Date.now() - lastActivity >= idleMs) {
      log(`idle for ${idleMs}ms with no active clients`);
      void close("idle");
    }
  }, period);
  idleTimer.unref();

  const url = daemonBaseUrl({ host, port });
  log(`listening at ${url} (vault: ${opts.vault})`);

  return { host, port, url, vault: opts.vault, pid: process.pid, closed, close };
}

/** Validate `--tools`; anything but the two surfaces is a usage error. */
function parseTools(value: unknown): ToolSurface | undefined {
  if (value === undefined) return undefined;
  if (value === "full" || value === "thread-only") return value;
  throw usageError(
    `--tools must be 'full' or 'thread-only' (got '${String(value)}')`,
  );
}

/** Resolve the bound port: `--port` › config `defaultPort` › `0` (ephemeral). */
function resolvePort(flag: unknown, configured: number | undefined): number {
  if (flag !== undefined) {
    const n = Number(flag);
    if (!Number.isInteger(n) || n < 0 || n > 65535) {
      throw usageError(
        `--port must be an integer 0-65535 (got '${String(flag)}')`,
      );
    }
    return n;
  }
  return configured ?? 0;
}

/**
 * `run` handler for `sheaf serve`. Blocks until the daemon shuts down.
 */
export async function serveCommand(ctx: RunContext): Promise<ExitCode> {
  const { globals, out, io } = ctx;
  const config = loadConfig(io.env);
  const vault = resolveVault({
    flag: globals.vault,
    env: io.env,
    config,
    cwd: io.cwd,
  });

  const tools = parseTools(ctx.values.tools);
  const host =
    typeof ctx.values.host === "string" ? ctx.values.host : "127.0.0.1";
  const port = resolvePort(ctx.values.port, config.defaultPort);
  const allowRaw = ctx.values["allow-origin"];
  const allowedOrigins = Array.isArray(allowRaw)
    ? (allowRaw as string[])
    : undefined;

  const logFile = join(logsDir(io.env), `${daemonKey(vault)}.log`);

  let handle: ServeHandle;
  try {
    handle = await startServer({
      vault,
      host,
      port,
      tools,
      allowedOrigins,
      version: VERSION,
      env: io.env,
      logFile,
      // Foreground: mirror the file log to stderr so a human sees it live.
      log: (line) => io.err(`${line}\n`),
    });
  } catch (e) {
    if (e instanceof DaemonAlreadyRunningError) {
      const d = e.existing;
      if (out.format === "json") {
        out.json(
          d
            ? {
                status: "already-running",
                host: d.host,
                port: d.port,
                vault: d.vault,
                pid: d.pid,
              }
            : { status: "already-running", vault },
        );
      } else if (d) {
        out.text(
          `a sheaf daemon is already running for ${vault} at ${d.host}:${d.port} (pid ${d.pid})`,
        );
      } else {
        out.text(`a sheaf daemon is already starting for ${vault}`);
      }
      return EXIT.OK; // loser exits cleanly
    }
    throw e;
  }

  // Announce the bound address (stdout), then block until shutdown.
  if (out.format === "json") {
    out.json({
      host: handle.host,
      port: handle.port,
      vault: handle.vault,
      pid: handle.pid,
    });
  } else {
    out.text(`sheaf daemon listening at ${handle.url}`);
    out.text(`vault: ${handle.vault}`);
  }

  const onSignal = (): void => {
    void handle.close("signal");
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    await handle.closed;
  } finally {
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  }
  return EXIT.OK;
}

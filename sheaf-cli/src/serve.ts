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
 *   - {@link serveCommand} is the `run` handler: it calls `startServer` (asking
 *     it to install signal handlers), prints the bound address, and awaits
 *     `handle.closed` (so the command blocks like a real daemon).
 *
 * Lock protocol (the load-bearing part — keeps "exactly one backend per vault"):
 *   - The lock is owned by inode (see `sheaf-server/daemon`), so a loser never
 *     deletes the survivor's lock or record.
 *   - A contended lock is reclaimed only when provably stale, and the reclaim is
 *     atomic (rename-aside); a race where a would-be daemon has its lock stolen
 *     out from under it is caught by the post-register inode re-check and the
 *     pre-register liveness check, so exactly one daemon survives.
 *   - Every resource from `acquireLock` through `registerDaemon` is unwound on
 *     any failure (including a signal mid-boot), so a crash never leaks a lock
 *     that wedges the vault.
 */
import {
  chmodSync,
  createWriteStream,
  mkdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
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
  isPidAlive,
  lockFile,
  readDaemon,
  readLock,
  registerDaemon,
  type DaemonInfo,
  type LockHandle,
} from "sheaf-server/daemon";

import type { RunContext } from "./commands";
import { ensureSheafHome, loadConfig, logsDir } from "./config";
import { EXIT, usageError, type ExitCode } from "./io";
import { VERSION } from "./version";

/** Idle-exit default: 30 minutes with no MCP request and no open SSE stream. */
const DEFAULT_IDLE_MS = 30 * 60 * 1000;

/**
 * A record-less lock younger than this is presumed to belong to a daemon that
 * holds the lock but has not registered yet (mid-boot), so it is never
 * reclaimed. Older than this (with a dead pid) it is a crash leftover.
 */
const STALE_LOCK_MS = 10_000;

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
  /**
   * Install process SIGTERM/SIGINT handlers (foreground daemon). Off for
   * in-process test callers, which drive shutdown via `handle.close()`.
   */
  installSignalHandlers?: boolean;
}

/**
 * Raised by {@link startServer} when another process already owns the vault.
 * Carries the existing discovery record (or `null` when a daemon is mid-boot —
 * it holds the lock but has not written its record yet).
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

/**
 * Raised when a lock is held but could not be reclaimed and no live daemon
 * answers — the vault is wedged by a leaked lock/record a human must clear.
 */
export class LockWedgedError extends Error {
  constructor(
    readonly lockPath: string,
    readonly recordPath: string,
  ) {
    super("stale sheaf daemon lock could not be reclaimed");
    this.name = "LockWedgedError";
  }
}

type ClaimResult =
  | { ok: true; lock: LockHandle }
  | { ok: false; kind: "running" | "starting" | "wedged"; existing: DaemonInfo | null };

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
 * Claim the lock for `vault`, atomically reclaiming a provably-stale one.
 *
 * On contention the lock is reclaimed only when either (a) a discovery record
 * exists but no live daemon answers, or (b) the lock has no record, its pid is
 * dead, and it is older than {@link STALE_LOCK_MS}. Reclaim moves the stale lock
 * aside with an atomic `rename` (so two racers can't both "reclaim" the same
 * file — one wins, the other sees `ENOENT` and simply retries), drops the dead
 * record if it is unchanged, then re-acquires. Bounded retries keep a busy race
 * from looping forever.
 */
async function claimLock(
  vault: string,
  env: NodeJS.ProcessEnv,
): Promise<ClaimResult> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const lock = acquireLock(vault, env);
    if (lock) return { ok: true, lock };

    const existing = readDaemon(vault, env);
    if (existing && (await isDaemonAlive(vault, env))) {
      return { ok: false, kind: "running", existing };
    }

    // Not alive. Decide whether the held lock is reclaimable.
    let reclaimable: boolean;
    if (existing) {
      reclaimable = true; // a dead daemon left its record behind
    } else {
      const lk = readLock(vault, env);
      if (!lk) continue; // lock vanished under us → retry a clean acquire
      const oldEnough = Date.now() - lk.mtimeMs > STALE_LOCK_MS;
      const pidDead = lk.pid === null || !isPidAlive(lk.pid);
      reclaimable = oldEnough && pidDead;
      if (!reclaimable) return { ok: false, kind: "starting", existing: null };
    }

    // Atomically move the stale lock aside. The rename is the serialization
    // point: exactly one racer moves the file; the other gets ENOENT.
    const lp = lockFile(vault, env);
    const aside = `${lp}.stale.${process.pid}.${attempt}`;
    try {
      renameSync(lp, aside);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // lost — retry
      throw e;
    }
    // We moved the stale lock aside. Drop the dead record only if it is still
    // the one we judged dead (a live successor's record is left untouched),
    // then remove the aside file and loop to re-acquire cleanly.
    if (existing) {
      const cur = readDaemon(vault, env);
      if (cur && cur.pid === existing.pid) {
        try {
          unlinkSync(daemonFile(vault, env));
        } catch {
          /* already gone */
        }
      }
    }
    try {
      unlinkSync(aside);
    } catch {
      /* already gone */
    }
  }

  // Retries exhausted. Re-classify one last time for the right message.
  const existing = readDaemon(vault, env);
  if (existing) {
    const alive = await isDaemonAlive(vault, env);
    return { ok: false, kind: alive ? "running" : "wedged", existing };
  }
  const lk = readLock(vault, env);
  const fresh = lk ? Date.now() - lk.mtimeMs <= STALE_LOCK_MS : false;
  const pidAlive = lk?.pid != null && isPidAlive(lk.pid);
  if (fresh || pidAlive) return { ok: false, kind: "starting", existing: null };
  return { ok: false, kind: "wedged", existing: null };
}

/**
 * Start the daemon and return once it is listening + registered. Does not
 * block. Throws {@link DaemonAlreadyRunningError} (loser) or
 * {@link LockWedgedError} (stuck) on contention; unwinds every resource it
 * allocated on any failure.
 */
export async function startServer(
  opts: StartServerOptions,
): Promise<ServeHandle> {
  const env = opts.env ?? process.env;
  ensureSheafHome(env);

  const vault = opts.vault;
  const host = opts.host ?? "127.0.0.1";
  const requestedPort = opts.port ?? 0;

  // Boot state, read by close() so a signal at any boot phase cleans up safely.
  let lock: LockHandle | null = null;
  let disposer: (() => void) | null = null;
  let app: ReturnType<typeof buildSheafApp> | null = null;
  let logStream: ReturnType<typeof createWriteStream> | null = null;
  let idleTimer: ReturnType<typeof setInterval> | undefined;

  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => {
    resolveClosed = r;
  });
  let shuttingDown = false;

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

  // Shutdown: remove record → drain backend → release lock LAST, so a new
  // `serve` can only grab the vault once this backend has fully stopped writing.
  const close = async (reason = "close"): Promise<void> => {
    if (shuttingDown) return closed;
    shuttingDown = true;
    if (idleTimer) clearInterval(idleTimer);
    log(`shutting down (${reason})`);
    try {
      disposer?.();
    } catch {
      /* record already gone */
    }
    try {
      if (app) await app.close();
    } catch (e) {
      log(`error closing server: ${errMsg(e)}`);
    }
    try {
      lock?.release();
    } catch {
      /* lock already released */
    }
    try {
      logStream?.end();
    } catch {
      /* stream already ended */
    }
    removeSignals();
    resolveClosed();
    return closed;
  };

  // Signal handling, installed EARLY so a signal mid-boot still runs `close`
  // (which null-checks every resource). A second signal during a slow drain
  // stops waiting and exits immediately.
  let sigCount = 0;
  const onSignal = (sig: NodeJS.Signals): void => {
    sigCount += 1;
    if (sigCount >= 2) process.exit(130);
    void close(`signal ${sig}`);
  };
  const addSignals = (): void => {
    if (!opts.installSignalHandlers) return;
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
  };
  const removeSignals = (): void => {
    if (!opts.installSignalHandlers) return;
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  };
  addSignals();

  // --- Spawn lock (before listening). ---
  const claim = await claimLock(vault, env);
  if (shuttingDown) {
    // A signal arrived during the claim. Release anything we grabbed and bail.
    if (claim.ok) claim.lock.release();
    throw new Error("interrupted during boot");
  }
  if (!claim.ok) {
    removeSignals();
    if (claim.kind === "wedged") {
      throw new LockWedgedError(lockFile(vault, env), daemonFile(vault, env));
    }
    throw new DaemonAlreadyRunningError(claim.existing);
  }
  lock = claim.lock;

  try {
    // --- Logging (file + optional stderr mirror). ---
    if (opts.logFile) {
      mkdirSync(dirname(opts.logFile), { recursive: true, mode: 0o700 });
      logStream = createWriteStream(opts.logFile, { flags: "a", mode: 0o600 });
      // createWriteStream's mode is umask-masked and create-only; force 0600.
      try {
        chmodSync(opts.logFile, 0o600);
      } catch {
        /* best effort */
      }
      // An async fd error (EACCES/ENOSPC) must not crash the daemon: drop the
      // file sink and keep mirroring to the foreground.
      logStream.on("error", () => {
        logStream = null;
      });
    }

    // --- Backend + app. ---
    const backend = new StubBackend(vault, vault);
    const startedAt = Date.now();
    app = buildSheafApp(backend, {
      tools: opts.tools,
      allowedOrigins: opts.allowedOrigins,
      health: { vault, startedAt, version: opts.version },
      forceCloseConnections: true,
    });

    // --- Idle-exit accounting. A live SSE stream keeps the daemon up; else it
    // exits `idleMs` after the last *MCP request*. Only POST /api/mcp counts —
    // a GET (405) is not an MCP request, and health / UI-REST hits (e.g. a
    // `daemon status` poll) must not keep an orphan alive. ---
    const idleMs = opts.idleMs ?? readIdleMs(env);
    let lastActivity = Date.now();
    let openStreams = 0;
    app.addHook("onRequest", async (req) => {
      const pathOnly = req.url.split("?")[0];
      if (pathOnly === "/api/mcp" && req.method === "POST") {
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

    await app.listen({ port: requestedPort, host });
    if (shuttingDown) throw new Error("interrupted during boot");
    const port = (app.server.address() as AddressInfo).port;

    // P2.3: never overwrite a live foreign daemon's record. If one already
    // owns this vault, back off before registering (so we don't clobber it).
    if (await isDaemonAlive(vault, env)) {
      throw new DaemonAlreadyRunningError(readDaemon(vault, env));
    }
    if (shuttingDown) throw new Error("interrupted during boot");

    disposer = registerDaemon({ vault, host, port, version: opts.version }, env);

    // P1.1: if the lock was reclaimed out from under us during boot, the
    // on-disk lock is a different inode now. Someone else is the daemon — bail
    // (our pid-guarded disposer removes the record we just wrote).
    if (readLock(vault, env)?.ino !== lock.ino) {
      throw new DaemonAlreadyRunningError(readDaemon(vault, env));
    }

    // --- Idle timer. Check more often than the timeout so tiny test timeouts
    // fire promptly; `unref` so the timer alone never keeps the process up. ---
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
    log(`listening at ${url} (vault: ${vault})`);
    return { host, port, url, vault, pid: process.pid, closed, close };
  } catch (e) {
    // Full unwind on any boot failure (idempotent close null-checks each piece).
    await close("boot-failed").catch(() => {});
    throw e;
  }
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
 * Reject a non-loopback `--host`. v0.1 is local-only, and binding `0.0.0.0`
 * would expose the vault to the network — the DNS-rebinding guard only checks
 * the Host header, which `Host: localhost` to a `0.0.0.0` bind bypasses.
 */
function assertLoopbackHost(host: string): void {
  const h = host.toLowerCase();
  if (h === "127.0.0.1" || h === "::1" || h === "localhost") return;
  throw usageError(
    `--host must be a loopback address (127.0.0.1, ::1, or localhost); sheaf v0.1 is local-only (got '${host}')`,
  );
}

/** `run` handler for `sheaf serve`. Blocks until the daemon shuts down. */
export async function serveCommand(ctx: RunContext): Promise<ExitCode> {
  const { out, io, vault } = ctx;
  const config = loadConfig(io.env);

  const tools = parseTools(ctx.values.tools);
  const host =
    typeof ctx.values.host === "string" ? ctx.values.host : "127.0.0.1";
  assertLoopbackHost(host);
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
      installSignalHandlers: true,
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
    if (e instanceof LockWedgedError) {
      if (out.format === "json") {
        out.json({
          error: "stale record, reclaim failed",
          code: "lock_wedged",
          lock: e.lockPath,
          record: e.recordPath,
          vault,
        });
      } else {
        out.diagnostic(`could not start daemon: stale record, reclaim failed`);
        out.diagnostic(`  lock:   ${e.lockPath}`);
        out.diagnostic(`  record: ${e.recordPath}`);
        out.diagnostic(
          `If no sheaf daemon is running for this vault, remove them and retry.`,
        );
      }
      return EXIT.GENERIC;
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

  await handle.closed;
  return EXIT.OK;
}

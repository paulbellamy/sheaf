/**
 * Daemon discovery, registration, locking, and liveness.
 *
 * This lives in `sheaf-server` (not `sheaf-cli`) on purpose: the invariant is
 * "exactly one live backend per vault, in exactly one process" (see
 * docs/sheaf-cli-v0.1.md). That process is *the daemon*, and any embedding host
 * that owns the backend for a vault — `sheaf serve` today, potentially Obsidian
 * or the Next prototype tomorrow — must be able to register as the daemon so CLI
 * clients find it over loopback HTTP instead of standing up a second, conflicting
 * backend. Since sheaf-server must not depend on the CLI package, the discovery
 * machinery belongs here and the CLI consumes it via the `sheaf-server/daemon`
 * subpath export.
 *
 * On-disk layout (all under `$SHEAF_HOME`, see `./home`):
 *   daemons/<key>.json   discovery record (mode 0600) — who is serving, where
 *   daemons/<key>.lock   spawn lock (mode 0600) — held for the daemon's life
 *
 * `<key>` is a short hash of the vault's realpath, so every process keys the
 * same vault to the same files regardless of how the path was spelled.
 *
 * Every helper takes an optional `env` so tests (and sandboxes) can point
 * `$SHEAF_HOME` at a throwaway directory and never touch the real home.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import { daemonsDir } from "./home";

/**
 * The discovery record written to `daemons/<key>.json`. `vault` is the
 * realpath, so a liveness check can compare it against `realpath(target)`
 * without re-normalizing. `startedAt` is Unix-ms.
 */
export interface DaemonInfo {
  pid: number;
  host: string;
  port: number;
  vault: string;
  startedAt: number;
  version: string;
}

/**
 * Stable per-vault key: the first 16 hex chars of `sha256(realpath(vault))`.
 * Short enough to keep filenames tidy, wide enough that a collision across a
 * user's handful of vaults is not a practical concern. Throws if the vault path
 * cannot be resolved (caller decides whether that is fatal).
 */
export function daemonKey(vault: string): string {
  const real = realpathSync(vault);
  return createHash("sha256").update(real).digest("hex").slice(0, 16);
}

/** Path to the discovery record for `vault` (`daemons/<key>.json`). */
export function daemonFile(
  vault: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(daemonsDir(env), `${daemonKey(vault)}.json`);
}

/** Path to the spawn lock for `vault` (`daemons/<key>.lock`). */
export function lockFile(
  vault: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(daemonsDir(env), `${daemonKey(vault)}.lock`);
}

/**
 * The loopback base URL of a daemon, IPv6-bracketing the host where needed
 * (`::1` → `http://[::1]:PORT`). Clients (step 3) build request URLs from this.
 */
export function daemonBaseUrl(info: {
  host: string;
  port: number;
}): string {
  const host =
    info.host.includes(":") && !info.host.startsWith("[")
      ? `[${info.host}]`
      : info.host;
  return `http://${host}:${info.port}`;
}

/**
 * Write the discovery record for a freshly-started daemon and return a disposer
 * that removes it.
 *
 * The write is atomic (a pid-suffixed sibling `.tmp` chmod'd 0600, then
 * `rename` over the target) so a concurrent reader never sees a half-written
 * record, and mode 0600 keeps the host/port out of other users' reach. The
 * disposer is idempotent — safe to call from both the SIGTERM path and an
 * idle-exit that races it.
 */
export function registerDaemon(
  info: { vault: string; host: string; port: number; version: string },
  env: NodeJS.ProcessEnv = process.env,
): () => void {
  const real = realpathSync(info.vault);
  const record: DaemonInfo = {
    pid: process.pid,
    host: info.host,
    port: info.port,
    vault: real,
    startedAt: Date.now(),
    version: info.version,
  };
  const dir = daemonsDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${daemonKey(real)}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600); // writeFile's mode is masked by umask; force it
  renameSync(tmp, file);

  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    try {
      unlinkSync(file);
    } catch {
      // already gone (a racing disposer, or manual cleanup)
    }
  };
}

/**
 * Claim the spawn lock for `vault`, returning a release function, or `null`
 * when another process already holds it.
 *
 * `openSync(..., "wx")` is the atomic primitive: it creates the file or fails
 * with `EEXIST`, so exactly one racing `serve` wins. The winner's pid is written
 * in for debugging (`cat daemons/<key>.lock`). The release closes the fd and
 * unlinks the file, and is idempotent. A crash leaves the lock behind; `serve`
 * reclaims such a stale lock by confirming (via `isDaemonAlive`) that the
 * recorded daemon is actually dead before removing it.
 */
export function acquireLock(
  vault: string,
  env: NodeJS.ProcessEnv = process.env,
): (() => void) | null {
  const dir = daemonsDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = lockFile(vault, env);
  let fd: number;
  try {
    fd = openSync(file, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw e;
  }
  try {
    writeSync(fd, `${process.pid}\n`);
  } catch {
    // The pid is advisory; a write failure must not fail the acquisition.
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      closeSync(fd);
    } catch {
      // fd already closed
    }
    try {
      unlinkSync(file);
    } catch {
      // already gone
    }
  };
}

/**
 * Read and validate the discovery record for `vault`, or `null` if it is
 * missing or corrupt. Tolerant by design: a torn or hand-edited file must read
 * as "no daemon" rather than throw, so a stale record can never wedge a client.
 */
export function readDaemon(
  vault: string,
  env: NodeJS.ProcessEnv = process.env,
): DaemonInfo | null {
  let file: string;
  try {
    file = daemonFile(vault, env);
  } catch {
    return null; // vault path no longer resolvable
  }
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null; // ENOENT and friends → no daemon
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DaemonInfo>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.host === "string" &&
      typeof parsed.port === "number" &&
      typeof parsed.vault === "string"
    ) {
      return {
        pid: parsed.pid,
        host: parsed.host,
        port: parsed.port,
        vault: parsed.vault,
        startedAt:
          typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
        version: typeof parsed.version === "string" ? parsed.version : "",
      };
    }
    return null;
  } catch {
    return null; // malformed JSON
  }
}

/**
 * True iff a *live* daemon owns `vault`: the discovery record is present, its
 * `GET /api/health` answers, and the health payload's `vault` equals
 * `realpath(vault)`.
 *
 * Deliberately not `process.kill(pid, 0)`: pids are reused, so a dead daemon's
 * pid may belong to an unrelated process, and a health round-trip that reports
 * the matching vault is the only trustworthy proof. A short timeout keeps a
 * hung or wrong-owner port from stalling the caller; any error (refused
 * connection, timeout, non-200, non-JSON, mismatched vault) is `false`.
 */
export async function isDaemonAlive(
  vault: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 1000,
): Promise<boolean> {
  const info = readDaemon(vault, env);
  if (!info) return false;
  let target: string;
  try {
    target = realpathSync(vault);
  } catch {
    return false;
  }
  const health = await fetchHealth(info.host, info.port, timeoutMs);
  return health !== null && health.vault === target;
}

/** GET `/api/health` with a hard timeout; `null` on any failure. */
async function fetchHealth(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<{ vault?: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${daemonBaseUrl({ host, port })}/api/health`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as { vault?: string };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

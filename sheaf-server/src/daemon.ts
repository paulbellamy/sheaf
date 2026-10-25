/**
 * Daemon discovery, registration, locking, and liveness.
 *
 * This lives in `sheaf-server` (not `sheaf-cli`) on purpose: the invariant is
 * "exactly one live backend per vault, in exactly one process" (see
 * docs/sheaf-cli-v0.1.md). That process is *the daemon* (`sheaf serve`), but any
 * host that owns the backend for a vault must be able to register as the daemon
 * so CLI clients find it over loopback HTTP instead of standing up a second,
 * conflicting backend. Since sheaf-server must not depend on the CLI package,
 * the discovery machinery belongs here and the CLI consumes it via the
 * `sheaf-server/daemon` subpath export.
 *
 * On-disk layout (all under `$SHEAF_HOME`, see `./home`):
 *   daemons/<key>.json   discovery record (mode 0600) — who is serving, where
 *   daemons/<key>.lock   spawn lock (mode 0600) — held for the daemon's life
 *
 * `<key>` is a short hash of the vault's realpath, so every process keys the
 * same vault to the same files regardless of how the path was spelled.
 *
 * The lock is owned by INODE, not by path: `acquireLock` captures the inode of
 * the file it created, and `release` unlinks only if the on-disk lock is still
 * that same inode. A reclaimer that atomically renames a stale lock aside, or a
 * successor that recreates it, therefore owns a *different* inode — so a loser
 * can never delete the survivor's lock. This, plus the pid-guarded record
 * disposer, is what keeps concurrent reclaim from producing two daemons.
 *
 * Every helper takes an optional `env` so tests (and sandboxes) can point
 * `$SHEAF_HOME` at a throwaway directory and never touch the real home.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
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

/** A held spawn lock: how to release it, and the inode that proves ownership. */
export interface LockHandle {
  /** Release the lock: unlink it iff the on-disk lock is still `ino`, close fd. */
  release: () => void;
  /** Inode of the lock file we created — our proof of ownership. */
  ino: number;
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
export function daemonBaseUrl(info: { host: string; port: number }): string {
  const host =
    info.host.includes(":") && !info.host.startsWith("[")
      ? `[${info.host}]`
      : info.host;
  return `http://${host}:${info.port}`;
}

/**
 * True if a process with `pid` currently exists. `process.kill(pid, 0)` sends
 * no signal but performs the existence + permission check: `ESRCH` means gone,
 * `EPERM` means alive-but-not-ours (still alive). A non-positive/NaN pid is
 * treated as dead.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Write the discovery record for a freshly-started daemon and return a disposer
 * that removes it.
 *
 * The write is atomic (a pid-suffixed sibling `.tmp` chmod'd 0600, then
 * `rename` over the target) so a concurrent reader never sees a half-written
 * record, and mode 0600 keeps the host/port out of other users' reach. The
 * disposer is idempotent AND pid-guarded: it re-reads the record and unlinks it
 * only if it is still *ours* (`pid === process.pid`), so a daemon tearing down
 * can never clobber a successor's record.
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
    // Re-read the on-disk record and remove it only if it is still ours. A
    // successor that registered after us owns a record with a different pid
    // (or, in-process, was written after ours was replaced) — never delete it.
    let cur: { pid?: number } | null = null;
    try {
      cur = JSON.parse(readFileSync(file, "utf8")) as { pid?: number };
    } catch {
      return; // gone or unreadable — nothing to remove
    }
    if (cur.pid !== process.pid) return; // superseded — leave the survivor's
    try {
      unlinkSync(file);
    } catch {
      // already gone (a racing disposer, or manual cleanup)
    }
  };
}

/**
 * Claim the spawn lock for `vault`, returning a {@link LockHandle}, or `null`
 * when another process already holds it.
 *
 * `openSync(..., "wx")` is the atomic primitive: it creates the file or fails
 * with `EEXIST`, so exactly one racing `serve` wins. The winner's pid is written
 * in for debugging (`cat daemons/<key>.lock`), and its inode is captured so
 * `release` can prove the on-disk lock is still the one we created before
 * unlinking it. A crash leaves the lock behind; `serve` reclaims such a stale
 * lock (atomic rename-aside) after confirming the recorded daemon is dead.
 */
export function acquireLock(
  vault: string,
  env: NodeJS.ProcessEnv = process.env,
): LockHandle | null {
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
  const ino = fstatSync(fd).ino;
  try {
    writeSync(fd, `${process.pid}\n`);
  } catch {
    // The pid is advisory; a write failure must not fail the acquisition.
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    // Unlink only if the on-disk lock is still the inode we created. A
    // reclaimer that renamed ours aside — or a successor that recreated it —
    // owns a different inode; deleting theirs would strand two daemons.
    try {
      if (statSync(file).ino === ino) unlinkSync(file);
    } catch {
      // already gone, or renamed aside by a reclaimer — nothing to do
    }
    try {
      closeSync(fd);
    } catch {
      // fd already closed
    }
  };
  return { release, ino };
}

/**
 * Read the lock file's pid + mtime + inode, or `null` if it is absent. Used by
 * `serve` to classify a contended lock: a record-less lock whose pid is dead
 * and whose mtime is old is a crash leftover safe to reclaim, whereas a fresh
 * one belongs to a daemon that holds the lock but has not registered yet.
 */
export function readLock(
  vault: string,
  env: NodeJS.ProcessEnv = process.env,
): { pid: number | null; mtimeMs: number; ino: number } | null {
  let file: string;
  try {
    file = lockFile(vault, env);
  } catch {
    return null;
  }
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(file);
  } catch {
    return null;
  }
  let pid: number | null = null;
  try {
    const n = Number(readFileSync(file, "utf8").trim());
    if (Number.isInteger(n) && n > 0) pid = n;
  } catch {
    // unreadable pid — treat as absent
  }
  return { pid, mtimeMs: st.mtimeMs, ino: st.ino };
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
 * The discovery record for `vault` iff a *live* daemon owns it, else `null`.
 *
 * Composes read + health so callers (and step 3) have exactly one seam for
 * "give me the daemon I can talk to." A record is only returned when its
 * `GET /api/health` answers AND the payload's `vault` equals `realpath(vault)`
 * AND its `pid` equals the record's pid. Deliberately not `process.kill(pid, 0)`
 * alone: pids are reused, so a health round-trip reporting the matching vault +
 * pid is the only trustworthy proof. A short timeout keeps a hung or wrong-owner
 * port from stalling the caller; any error is treated as "not alive".
 */
export async function findDaemon(
  vault: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 1000,
): Promise<DaemonInfo | null> {
  const info = readDaemon(vault, env);
  if (!info) return null;
  let target: string;
  try {
    target = realpathSync(vault);
  } catch {
    return null;
  }
  const health = await fetchHealth(info.host, info.port, timeoutMs);
  if (health && health.vault === target && health.pid === info.pid) {
    return info;
  }
  return null;
}

/** True iff a live daemon owns `vault` (see {@link findDaemon}). */
export async function isDaemonAlive(
  vault: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 1000,
): Promise<boolean> {
  return (await findDaemon(vault, env, timeoutMs)) !== null;
}

/** GET `/api/health` with a hard timeout; `null` on any failure. */
async function fetchHealth(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<{ vault?: string; pid?: number } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${daemonBaseUrl({ host, port })}/api/health`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as { vault?: string; pid?: number };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

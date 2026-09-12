/**
 * `$SHEAF_HOME` layout — the on-disk root for cross-process sheaf state.
 *
 * This lives in sheaf-server (not sheaf-cli) on purpose: daemon discovery and
 * registration is a server-side concern — `registerDaemon` (step 2) writes
 * `$SHEAF_HOME/daemons/<key>.json`, and any host that owns *the* backend for a
 * vault must be able to register there so CLI clients find it instead of
 * spawning a second backend. sheaf-server must not depend on the CLI
 * package, so the layout helpers belong here and the CLI re-exports them.
 *
 * `$SHEAF_HOME` defaults to `~/.sheaf` (dir mode 0700) and is overridable via
 * the `SHEAF_HOME` env var, so tests and sandboxes can point it at a throwaway
 * directory and never touch the real home. Every helper takes an optional env
 * for that injection.
 */
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Resolve `$SHEAF_HOME` without creating it. A non-empty `SHEAF_HOME` wins
 * (resolved to an absolute path); otherwise `~/.sheaf`.
 */
export function sheafHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.SHEAF_HOME;
  if (override && override.length > 0) return resolve(override);
  return join(homedir(), ".sheaf");
}

/**
 * Resolve `$SHEAF_HOME`, creating it lazily with mode 0700. The explicit
 * `chmod` defends against a permissive umask (mkdir's mode is masked by it).
 */
export function ensureSheafHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = sheafHome(env);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  return home;
}

/** Directory holding per-vault daemon discovery files (`$SHEAF_HOME/daemons`). */
export function daemonsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(sheafHome(env), "daemons");
}

/** Directory holding daemon logs (`$SHEAF_HOME/logs`). */
export function logsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(sheafHome(env), "logs");
}

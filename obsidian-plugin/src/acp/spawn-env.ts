import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import * as path from "node:path";

/**
 * Electron GUI apps inherit a minimal PATH (e.g. `/usr/bin:/bin`), not your
 * login shell's — so a bare `npx` spawn fails with ENOENT even though npx is on
 * your real PATH. These helpers recover a usable PATH (ask the login shell, plus
 * the common node install dirs) and resolve the adapter command to an absolute
 * path so spawn doesn't depend on the inherited PATH at all.
 */

let cachedDirs: string[] | undefined;

/** PATH directories to search: login-shell PATH ∪ common node dirs ∪ inherited. */
export function spawnPathDirs(): string[] {
  if (cachedDirs) return cachedDirs;
  const dirs = new Set<string>();

  if (process.platform !== "win32") {
    // Best-effort: ask the login shell for its PATH (covers nvm/fnm/volta,
    // Homebrew, etc.). Timeout-bounded so a misconfigured shell can't hang us.
    const shell = process.env.SHELL || "/bin/bash";
    try {
      const out = execFileSync(shell, ["-ilc", "echo -n \"$PATH\""], {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      for (const d of out.split(":")) if (d) dirs.add(d);
    } catch {
      // shell unavailable / errored — fall back to the common dirs below
    }
    for (const d of [
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ]) {
      dirs.add(d);
    }
  }

  for (const d of (process.env.PATH ?? "").split(path.delimiter)) {
    if (d) dirs.add(d);
  }

  cachedDirs = [...dirs];
  return cachedDirs;
}

/** The child's env with the recovered PATH spliced in. */
export function spawnEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extra,
    PATH: spawnPathDirs().join(path.delimiter),
  };
}

/**
 * Resolve a bare command (e.g. `npx`) to an absolute path on the recovered
 * PATH, so spawn doesn't rely on Electron's stripped PATH. Returns the input
 * unchanged if it already has a path separator, or if nothing matches (the
 * caller then spawns the bare name and surfaces ENOENT + the install hint).
 */
export function resolveCommand(cmd: string): string {
  if (cmd.includes("/") || cmd.includes("\\")) return cmd;
  const exts = process.platform === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""];
  for (const dir of spawnPathDirs()) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      try {
        accessSync(full, constants.X_OK);
        return full;
      } catch {
        // not here / not executable — keep looking
      }
    }
  }
  return cmd;
}

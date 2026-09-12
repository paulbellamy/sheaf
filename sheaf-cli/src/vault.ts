/**
 * Vault resolution.
 *
 * Precedence (highest wins): `--vault`/`-C` › `$SHEAF_VAULT` env › config
 * `defaultVault` › `process.cwd()`. The winner is resolved to an absolute,
 * symlink-canonical path via `realpath` so every downstream consumer (daemon
 * discovery keying, path scoping) compares one and the same string.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import type { Config } from "./config";
import { CliError, EXIT } from "./io";

export interface VaultSources {
  /** `--vault`/`-C` value, if provided. */
  flag?: string;
  /** Environment to read `SHEAF_VAULT` from (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Loaded config, for its `defaultVault`. */
  config?: Config;
  /** Working directory, the last-resort default (defaults to `process.cwd()`). */
  cwd?: string;
}

/**
 * Pick the vault directory per the precedence rule, then return its realpath.
 * Relative candidates resolve against `cwd`. Throws a {@link CliError} when the
 * chosen directory does not exist.
 */
export function resolveVault(sources: VaultSources = {}): string {
  const env = sources.env ?? process.env;
  const cwd = sources.cwd ?? process.cwd();
  const chosen =
    sources.flag ?? envVault(env) ?? sources.config?.defaultVault ?? cwd;

  const abs = resolve(cwd, chosen);
  try {
    return realpathSync(abs);
  } catch {
    throw new CliError(
      `vault directory not found: ${abs}`,
      "vault_not_found",
      EXIT.GENERIC,
    );
  }
}

/** Read a non-empty `SHEAF_VAULT` from the environment, else undefined. */
function envVault(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.SHEAF_VAULT;
  return value && value.length > 0 ? value : undefined;
}

/**
 * `$SHEAF_HOME` layout + config file load/save.
 *
 * `$SHEAF_HOME` (default `~/.sheaf`, dir mode 0700) is the single root for all
 * cross-invocation state: the config file, the per-vault daemon discovery files
 * (`daemons/`), and daemon logs (`logs/`). It is overridable via the
 * `SHEAF_HOME` env var so tests (and sandboxes) can point it at a throwaway
 * directory and never touch the real home.
 *
 * Step 1 provides only the path helpers plus config load/save; `daemons/` and
 * `logs/` are created by later steps (`sheaf serve`) when first needed.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { z } from "zod";

import { CliError, EXIT } from "./io";

/**
 * Config file schema. Deliberately minimal and forward-compatible: unknown keys
 * are preserved on load/save (`z.looseObject`) so a newer sheaf that writes
 * extra fields survives an older sheaf's load→save round-trip. All fields are
 * optional; a missing file is an empty config, never an error.
 */
export const ConfigSchema = z.looseObject({
  /** Default vault when neither `--vault` nor `$SHEAF_VAULT` is set. */
  defaultVault: z.string().optional(),
  /** Preferred port for `sheaf serve` (0 / omitted → ephemeral). */
  defaultPort: z.number().int().min(0).max(65535).optional(),
  /** MCP-related settings; shape intentionally open for now. */
  mcp: z.record(z.string(), z.unknown()).optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

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

/** Path to the config file (`$SHEAF_HOME/config.json`). */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(sheafHome(env), "config.json");
}

/** Directory holding per-vault daemon discovery files (`$SHEAF_HOME/daemons`). */
export function daemonsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(sheafHome(env), "daemons");
}

/** Directory holding daemon logs (`$SHEAF_HOME/logs`). */
export function logsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(sheafHome(env), "logs");
}

/**
 * Load + validate the config. A missing file yields an empty config `{}` (not
 * an error). Malformed JSON or a schema violation throws a {@link CliError}.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const path = configPath(env);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new CliError(
      `cannot read config at ${path}`,
      "config_read",
      EXIT.GENERIC,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(
      `invalid JSON in config at ${path}`,
      "config_parse",
      EXIT.GENERIC,
    );
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new CliError(`invalid config at ${path}`, "config_invalid", EXIT.GENERIC);
  }
  return result.data;
}

/**
 * Persist the config to `$SHEAF_HOME/config.json` with mode 0600. The `chmod`
 * runs unconditionally because `writeFile`'s mode only applies when creating a
 * new file — an existing file keeps its old (possibly looser) permissions.
 */
export function saveConfig(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const validated = ConfigSchema.parse(config);
  ensureSheafHome(env);
  const path = configPath(env);
  writeFileSync(path, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

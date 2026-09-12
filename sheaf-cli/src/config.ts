/**
 * Config file load/save on top of the `$SHEAF_HOME` layout.
 *
 * The layout helpers (`sheafHome`, `ensureSheafHome`, `daemonsDir`, `logsDir`)
 * live in `sheaf-server/home` — daemon registration (step 2) is a server-side
 * concern that cannot depend on this package. We import them here, re-export
 * them for local call sites (and step-2 discoverability), and build the config
 * path on top of `sheafHome()`.
 *
 * The config file itself (`$SHEAF_HOME/config.json`) is a CLI concern, so
 * `configPath`, `loadConfig`, and `saveConfig` stay here. A missing file is an
 * empty config, never an error.
 */
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { ensureSheafHome, sheafHome } from "sheaf-server/home";
import { z } from "zod";

import { CliError, EXIT } from "./io";

// Re-export the layout helpers so CLI call sites import them from one place.
export { daemonsDir, ensureSheafHome, logsDir, sheafHome } from "sheaf-server/home";

/**
 * Config file schema. Deliberately minimal and forward-compatible: unknown keys
 * are preserved on load/save (`z.looseObject`) so a newer sheaf that writes
 * extra fields survives an older sheaf's load→save round-trip. All fields are
 * optional; a missing file is an empty config, never an error.
 */
export const ConfigSchema = z.looseObject({
  /**
   * Default vault when neither `--vault` nor `$SHEAF_VAULT` is set. Must be
   * absolute — a relative value would resolve differently per shell cwd, so the
   * config-sourced vault would silently drift.
   */
  defaultVault: z
    .string()
    .refine((p) => isAbsolute(p), {
      message: "defaultVault must be an absolute path",
    })
    .optional(),
  /** Preferred port for `sheaf serve` (0 / omitted → ephemeral). */
  defaultPort: z.number().int().min(0).max(65535).optional(),
  /** MCP-related settings; shape intentionally open for now. */
  mcp: z.record(z.string(), z.unknown()).optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Path to the config file (`$SHEAF_HOME/config.json`). */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(sheafHome(env), "config.json");
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
 * Persist the config to `$SHEAF_HOME/config.json` with mode 0600, atomically:
 * write a sibling `.tmp` (chmod 0600 — `writeFile`'s mode is masked by umask
 * and only applies on create) then `rename` it over the target. The rename is
 * atomic on POSIX, so a crash mid-write can never leave a truncated
 * `config.json` that bricks every later command.
 */
export function saveConfig(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const validated = ConfigSchema.parse(config);
  ensureSheafHome(env);
  const path = configPath(env);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

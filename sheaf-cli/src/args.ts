/**
 * Global flag parsing via `node:util.parseArgs` (zero deps).
 *
 * Only the *global* flags are declared here. Per-command flags are the
 * business of each command (the step-1 stubs ignore them). `strict: false`
 * lets unknown, command-specific flags pass through without aborting the parse,
 * so a single top-level pass recovers the command path regardless of where the
 * global flags sit relative to the subcommand.
 */
import { parseArgs } from "node:util";

import { usageError, type OutputFormat } from "./io";

export interface Globals {
  /** `--vault`/`-C` value, if given. */
  vault?: string;
  /** Output format (`--format`), defaulting to `text`. */
  format: OutputFormat;
  /** `--no-daemon` flag. */
  noDaemon: boolean;
  /** `--help`/`-h` flag. */
  help: boolean;
  /** `--version`/`-V` flag. */
  version: boolean;
  /**
   * Positionals in order — the command path followed by command-specific args
   * (e.g. `["thread", "show", "thrd_x"]`).
   */
  positionals: string[];
}

const GLOBAL_OPTIONS = {
  vault: { type: "string", short: "C" },
  format: { type: "string" },
  "no-daemon": { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "V" },
} as const;

/** Parse the global flags + positionals out of `argv`. */
export function parseGlobals(argv: string[]): Globals {
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      options: GLOBAL_OPTIONS,
      allowPositionals: true,
      strict: false,
    });
    values = parsed.values as Record<string, unknown>;
    positionals = parsed.positionals;
  } catch (e) {
    // parseArgs throws on malformed input (e.g. a value-taking flag at the end
    // with no value). Surface it as a usage error rather than a crash.
    throw usageError(e instanceof Error ? e.message : String(e));
  }

  return {
    vault: typeof values.vault === "string" ? values.vault : undefined,
    format: normalizeFormat(values.format),
    noDaemon: values["no-daemon"] === true,
    help: values.help === true,
    version: values.version === true,
    positionals,
  };
}

/** Validate `--format`; anything but text/json is a usage error. */
function normalizeFormat(value: unknown): OutputFormat {
  if (value === undefined) return "text";
  if (value === "text" || value === "json") return value;
  throw usageError(`--format must be 'text' or 'json' (got '${String(value)}')`);
}

/**
 * Argument parsing via `node:util.parseArgs` (zero deps), in two passes.
 *
 * A single non-strict pass cannot both locate the command and validate its
 * flags: unknown (command-specific) options are coerced to booleans, so their
 * values leak out as positionals and dangling globals go unnoticed. So we split
 * the work:
 *
 *   1. {@link preParse} — a lenient pass whose ONLY job is to locate the
 *      command path. It knows the global options (so a value-taking global
 *      before the command, `--vault X serve`, doesn't misplace the command) and
 *      never throws on command flags.
 *   2. {@link parseCommand} — a strict pass with the resolved command's own
 *      options merged in. Strict mode makes an unknown flag or a dangling
 *      value-flag (`--vault` with no argument) a proper usage error.
 */
import { parseArgs } from "node:util";

import { usageError, type OutputFormat } from "./io";

/** One `parseArgs` option definition (a subset of the node type we use). */
export interface OptionDef {
  type: "string" | "boolean";
  short?: string;
  multiple?: boolean;
}

/** Global flags, recognized regardless of the command. */
export const GLOBAL_OPTIONS: Record<string, OptionDef> = {
  vault: { type: "string", short: "C" },
  format: { type: "string" },
  "no-daemon": { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "V" },
  // Hidden: constructs a sheaf-server backend to prove the bundle can import it
  // at runtime (see src/selftest.ts). Not shown in help.
  selftest: { type: "boolean" },
};

/** Resolved global flags for a run. */
export interface Globals {
  vault?: string;
  format: OutputFormat;
  noDaemon: boolean;
  help: boolean;
  version: boolean;
}

/** The lenient pass result: enough to route + short-circuit help/version. */
export interface PreParse {
  /** Command path + command args, in order. */
  positionals: string[];
  help: boolean;
  version: boolean;
  selftest: boolean;
  /** Best-effort format for early error rendering (invalid → text, no throw). */
  format: OutputFormat;
}

/** Lenient first pass: locate the command path; never throws on command flags. */
export function preParse(argv: string[]): PreParse {
  // strict:false coerces unknown flags to booleans and (verified on Node 20)
  // coerces a dangling global value-flag to `true` rather than throwing, so the
  // command path is always recoverable here; the strict pass validates later.
  const { values, positionals } = parseArgs({
    args: argv,
    options: GLOBAL_OPTIONS,
    allowPositionals: true,
    strict: false,
  });
  return {
    positionals,
    help: values.help === true,
    version: values.version === true,
    selftest: values.selftest === true,
    format: coerceFormat(values.format),
  };
}

/**
 * Strict second pass with the command's own options merged onto the globals.
 * Throws a usage error (exit 2) on any unknown flag or dangling value-flag.
 */
export function parseCommand(
  argv: string[],
  options: Record<string, OptionDef> | undefined,
): { values: Record<string, unknown>; positionals: string[] } {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: { ...GLOBAL_OPTIONS, ...options },
      allowPositionals: true,
      strict: true,
    });
    return { values: values as Record<string, unknown>, positionals };
  } catch (e) {
    throw usageError(e instanceof Error ? e.message : String(e));
  }
}

/** Build resolved globals from the strict pass values (validates `--format`). */
export function globalsFromValues(values: Record<string, unknown>): Globals {
  return {
    vault: typeof values.vault === "string" ? values.vault : undefined,
    format: requireFormat(values.format),
    noDaemon: values["no-daemon"] === true,
    help: values.help === true,
    version: values.version === true,
  };
}

/** Validate `--format`; anything but text/json is a usage error (exit 2). */
export function requireFormat(value: unknown): OutputFormat {
  if (value === undefined) return "text";
  if (value === "text" || value === "json") return value;
  throw usageError(`--format must be 'text' or 'json' (got '${String(value)}')`);
}

/** Lenient format for early rendering: fall back to text rather than throw. */
function coerceFormat(value: unknown): OutputFormat {
  return value === "json" ? "json" : "text";
}

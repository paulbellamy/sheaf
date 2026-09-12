/**
 * Output contract + process-exit vocabulary shared by every command.
 *
 * The rules (docs/sheaf-cli-v0.1.md "Output contract"):
 *   - human-readable data → stdout; diagnostics/errors → stderr;
 *   - `--format json` emits exactly one JSON object on stdout per command;
 *   - error JSON is `{ error, code }`, mirroring the server's `errorResult`;
 *   - exit codes: 0 ok, 1 generic failure, 2 usage error, 3 no daemon.
 *
 * All writes funnel through an injectable {@link Io} so tests can capture output
 * without touching the real process streams (and so a fake env/cwd keeps
 * `$SHEAF_HOME` / `$SHEAF_VAULT` resolution off the real machine).
 */

/** Central exit-code constants. */
export const EXIT = {
  OK: 0,
  GENERIC: 1,
  USAGE: 2,
  NO_DAEMON: 3,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export type OutputFormat = "text" | "json";

/** The side-effecting surface a run needs: two byte sinks, an env, and a cwd. */
export interface Io {
  /** Write to the data channel (stdout). */
  out(chunk: string): void;
  /** Write to the diagnostic channel (stderr). */
  err(chunk: string): void;
  /** Environment (source of `SHEAF_HOME` / `SHEAF_VAULT`). */
  env: NodeJS.ProcessEnv;
  /** Working directory (last-resort vault default). */
  cwd: string;
}

/** The real, process-backed IO used by the `bin/sheaf.js` entry point. */
export function processIo(): Io {
  return {
    out: (chunk) => process.stdout.write(chunk),
    err: (chunk) => process.stderr.write(chunk),
    env: process.env,
    cwd: process.cwd(),
  };
}

/**
 * A command failure carrying both a machine-readable `code` (surfaced in error
 * JSON) and the `exitCode` the process should terminate with. Thrown by
 * handlers/helpers and rendered exactly once at the top of {@link run}.
 */
export class CliError extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;

  constructor(message: string, code: string, exitCode: ExitCode) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

/** A usage / argument error → exit 2. */
export function usageError(message: string): CliError {
  return new CliError(message, "usage", EXIT.USAGE);
}

/**
 * No daemon is running for the target vault → exit 3. The message mirrors the
 * plan's exact wording so scripts can match on it.
 */
export function noDaemonError(vault: string): CliError {
  return new CliError(
    `no sheaf daemon for ${vault}; run \`sheaf serve\``,
    "no_daemon",
    EXIT.NO_DAEMON,
  );
}

/** A subcommand not yet implemented in the current build step → exit 1. */
export function notImplementedError(step: number): CliError {
  return new CliError(
    `not implemented (step ${step})`,
    "not_implemented",
    EXIT.GENERIC,
  );
}

/**
 * Format-aware writer, constructed once per invocation from the resolved
 * `--format`. `text()` / `json()` go to stdout (data); `diagnostic()` goes to
 * stderr; `fail()` renders a {@link CliError} per the output contract and
 * returns its exit code.
 */
export class Output {
  constructor(
    private readonly io: Io,
    readonly format: OutputFormat,
  ) {}

  /** Emit a line of human-readable text on stdout. */
  text(line = ""): void {
    this.io.out(`${line}\n`);
  }

  /** Emit exactly one JSON object on stdout. */
  json(value: unknown): void {
    this.io.out(`${JSON.stringify(value)}\n`);
  }

  /** Emit a diagnostic line on stderr, regardless of format. */
  diagnostic(line = ""): void {
    this.io.err(`${line}\n`);
  }

  /**
   * Render an error: `{ error, code }` on stdout in json mode, else the plain
   * message on stderr. Returns the exit code to propagate.
   */
  fail(error: CliError): ExitCode {
    if (this.format === "json") {
      this.json({ error: error.message, code: error.code });
    } else {
      this.diagnostic(error.message);
    }
    return error.exitCode;
  }
}

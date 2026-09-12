/**
 * Top-level dispatch: parse global flags, resolve the command path against the
 * registry, and run the matching handler (a stub in step 1).
 *
 * `run` returns the process exit code and never calls `process.exit` itself, so
 * it stays unit-testable — the thin `main.ts` entry point does the exiting.
 */
import { parseGlobals } from "./args";
import { REGISTRY, type CommandSpec, type RunContext } from "./commands";
import { printCommandHelp, printRootHelp } from "./help";
import {
  CliError,
  EXIT,
  Output,
  notImplementedError,
  processIo,
  usageError,
  type ExitCode,
  type Io,
} from "./io";
import { VERSION } from "./version";

interface Resolved {
  spec: CommandSpec;
  /** The command path consumed (e.g. `["thread", "show"]`). */
  path: string[];
  /** Positionals left over for the command itself. */
  args: string[];
}

/**
 * Walk the registry from the parsed positionals to the target command. Handles
 * one level of nesting plus the `mcp`-style group that is `runnable` on its own.
 * Throws a usage error (exit 2) on an unknown command or subcommand.
 */
function resolveCommand(positionals: string[]): Resolved {
  const [top, sub, ...rest] = positionals;
  const group = REGISTRY[top];
  if (!group) throw usageError(`unknown command: ${top}`);

  if (group.subcommands) {
    if (sub && group.subcommands[sub]) {
      return { spec: group.subcommands[sub], path: [top, sub], args: rest };
    }
    // A `runnable` group (mcp) runs itself when no subcommand matches; any
    // leftover positional is handed to it as an arg.
    if (group.runnable) {
      return { spec: group, path: [top], args: sub ? [sub, ...rest] : [] };
    }
    if (!sub) throw usageError(`\`${top}\` requires a subcommand`);
    throw usageError(`unknown subcommand: ${top} ${sub}`);
  }

  return { spec: group, path: [top], args: sub ? [sub, ...rest] : [] };
}

/** Print help for a (possibly partial) command path; root help as fallback. */
function printHelpFor(out: Output, positionals: string[]): void {
  const [top, sub] = positionals;
  const group = top ? REGISTRY[top] : undefined;
  if (!group) {
    printRootHelp(out);
    return;
  }
  if (group.subcommands && sub && group.subcommands[sub]) {
    printCommandHelp(out, group.subcommands[sub], [top, sub]);
    return;
  }
  printCommandHelp(out, group, [top]);
}

/** Parse, dispatch, and return the exit code. Handles all errors internally. */
export async function run(argv: string[], io: Io = processIo()): Promise<number> {
  // Default to text output for errors raised before we know `--format`.
  let out = new Output(io, "text");
  try {
    const globals = parseGlobals(argv);
    out = new Output(io, globals.format);

    // `--help` is forgiving and takes precedence: show help for whatever
    // command path resolves (root help when none/unknown), always exit 0.
    if (globals.help) {
      printHelpFor(out, globals.positionals);
      return EXIT.OK;
    }
    if (globals.version) {
      if (out.format === "json") out.json({ version: VERSION });
      else out.text(VERSION);
      return EXIT.OK;
    }
    // Bare `sheaf` → root help (friendly, exit 0).
    if (globals.positionals.length === 0) {
      printRootHelp(out);
      return EXIT.OK;
    }

    const resolved = resolveCommand(globals.positionals);
    const ctx: RunContext = { globals, out, io, args: resolved.args };
    if (resolved.spec.run) return await resolved.spec.run(ctx);

    // Step 1: no handler wired yet for this command.
    throw notImplementedError(resolved.spec.step);
  } catch (e) {
    const err =
      e instanceof CliError
        ? e
        : new CliError(
            `internal error: ${e instanceof Error ? e.message : String(e)}`,
            "internal",
            EXIT.GENERIC,
          );
    return out.fail(err);
  }
}

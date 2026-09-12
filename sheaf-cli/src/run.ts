/**
 * Top-level dispatch: locate the command (lenient pass), parse + validate its
 * flags (strict pass), and run the matching handler (a stub in step 1).
 *
 * `run` returns the process exit code and never calls `process.exit` itself, so
 * it stays unit-testable — the thin `main.ts` entry point does the exiting.
 */
import { globalsFromValues, parseCommand, preParse } from "./args";
import { REGISTRY, type CommandSpec, type RunContext } from "./commands";
import { loadConfig } from "./config";
import { printCommandHelp, printRootHelp } from "./help";
import {
  CliError,
  EXIT,
  Output,
  notImplementedError,
  processIo,
  usageError,
  type Io,
} from "./io";
import { resolveVault } from "./vault";
import { VERSION } from "./version";

interface Located {
  spec: CommandSpec;
  /** The command path consumed (e.g. `["thread", "show"]`). */
  path: string[];
  /** True when we landed on a runnable group without a matching subcommand. */
  runnableGroup: boolean;
}

/**
 * Walk the registry from the (lenient) positionals to the target command.
 * Handles one level of nesting plus the `mcp`-style group that is `runnable` on
 * its own. Throws a usage error (exit 2) on an unknown command or subcommand.
 */
function locateCommand(positionals: string[]): Located {
  const [top, sub] = positionals;
  const group = REGISTRY[top];
  if (!group) throw usageError(`unknown command: ${top}`);

  if (group.subcommands) {
    if (sub && group.subcommands[sub]) {
      return { spec: group.subcommands[sub], path: [top, sub], runnableGroup: false };
    }
    // A `runnable` group (mcp) runs itself when no subcommand matches; whether a
    // leftover positional is a stray bad subcommand is decided after the strict
    // pass (a real flag value like `mcp --doc x` must not be mistaken for one).
    if (group.runnable) {
      return { spec: group, path: [top], runnableGroup: true };
    }
    if (!sub) throw usageError(`\`${top}\` requires a subcommand`);
    throw usageError(`unknown subcommand: ${top} ${sub}`);
  }

  return { spec: group, path: [top], runnableGroup: false };
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
    const pre = preParse(argv);
    out = new Output(io, pre.format);

    // `--help` is forgiving and takes precedence: show help for whatever
    // command path resolves (root help when none/unknown), always exit 0.
    if (pre.help) {
      printHelpFor(out, pre.positionals);
      return EXIT.OK;
    }
    if (pre.version) {
      if (out.format === "json") out.json({ version: VERSION });
      else out.text(VERSION);
      return EXIT.OK;
    }
    // Hidden runtime probe: proves the bundle can import sheaf-server.
    if (pre.selftest) {
      const { runSelftest } = await import("./selftest");
      return runSelftest(io);
    }
    // Bare `sheaf` → root help (friendly, exit 0).
    if (pre.positionals.length === 0) {
      printRootHelp(out);
      return EXIT.OK;
    }

    const located = locateCommand(pre.positionals);

    // Strict pass: validate + parse this command's flags (unknown flag or
    // dangling value-flag ⇒ usage error). Also the authoritative source for the
    // globals (and `--format` validation).
    const parsed = parseCommand(argv, located.spec.options);
    const globals = globalsFromValues(parsed.values);
    out = new Output(io, globals.format);

    // Command-specific positionals sit after the consumed command path.
    const commandArgs = parsed.positionals.slice(located.path.length);

    // A runnable group reached without a subcommand takes no positionals, so a
    // leftover is a mistyped subcommand, not an argument (e.g. `mcp bogus`).
    if (located.runnableGroup && commandArgs.length > 0) {
      throw usageError(`unknown subcommand: ${located.path[0]} ${commandArgs[0]}`);
    }

    if (located.spec.run) {
      // Every runnable command is a vault-scoped client, so resolve the target
      // vault once here (precedence: `--vault` › `$SHEAF_VAULT` › config › cwd)
      // and hand it down. Stubs (no `run`) don't need it, so they never trigger
      // a "vault not found" before their own "not implemented".
      const vault = resolveVault({
        flag: globals.vault,
        env: io.env,
        config: loadConfig(io.env),
        cwd: io.cwd,
      });
      const ctx: RunContext = {
        globals,
        out,
        io,
        vault,
        values: parsed.values,
        positionals: commandArgs,
        argv,
      };
      return await located.spec.run(ctx);
    }

    // Step 1: no handler wired yet. Surface the parsed flags under SHEAF_DEBUG
    // so the wiring can be verified before the real handler exists.
    if (io.env.SHEAF_DEBUG) {
      io.err(
        `[debug] command=${located.path.join(" ")} ` +
          `values=${JSON.stringify(parsed.values)} ` +
          `positionals=${JSON.stringify(commandArgs)}\n`,
      );
    }
    throw notImplementedError(located.spec.step);
  } catch (e) {
    if (e instanceof CliError) return out.fail(e);
    // Unexpected internal error: clean message by default, full stack under
    // SHEAF_DEBUG.
    if (io.env.SHEAF_DEBUG && e instanceof Error && e.stack) {
      io.err(`${e.stack}\n`);
    }
    return out.fail(
      new CliError(
        `internal error: ${e instanceof Error ? e.message : String(e)}`,
        "internal",
        EXIT.GENERIC,
      ),
    );
  }
}

/**
 * The command tree + hand-written help metadata.
 *
 * This is the v0.1 command surface (docs/sheaf-cli-v0.1.md "Command tree"). In
 * step 1 every domain command is a stub: `run` is left undefined and the
 * dispatcher emits `not implemented (step N)` (exit 1). Later steps attach real
 * `run` handlers without changing the tree shape or the help text.
 */
import type { Globals } from "./args";
import type { ExitCode, Io, Output } from "./io";

/** Everything a command handler receives. */
export interface RunContext {
  globals: Globals;
  out: Output;
  io: Io;
  /** Positionals after the resolved command path (command-specific args). */
  args: string[];
}

export interface CommandSpec {
  /** Command word (leaf or group name). */
  name: string;
  /** One-line summary shown in the parent's command list. */
  summary: string;
  /** Usage line shown at the top of the command's own `--help`. */
  usage: string;
  /** Plan step that implements this command (drives the stub message). */
  step: number;
  /**
   * For a group (a spec with `subcommands`): whether it can also run on its own
   * without a matching subcommand. Only `mcp` does — `mcp` runs the bridge,
   * `mcp install` runs the installer. Ignored for leaf commands, which always
   * run.
   */
  runnable?: boolean;
  /** Nested subcommands, if this is a group (e.g. `thread`, `daemon`). */
  subcommands?: Record<string, CommandSpec>;
  /**
   * Leaf handler. Undefined in step 1 (⇒ stub via `notImplementedError`). Later
   * steps set this; the dispatcher calls it and uses its return as the exit
   * code.
   */
  run?: (ctx: RunContext) => ExitCode | Promise<ExitCode>;
}

/**
 * The top-level command registry. Insertion order is the order shown in
 * `sheaf --help`.
 */
export const REGISTRY: Record<string, CommandSpec> = {
  serve: {
    name: "serve",
    summary: "Run the sheaf daemon for a vault",
    usage:
      "sheaf serve [--port N] [--host H] [--tools full|thread-only] [--allow-origin O]...",
    step: 2,
  },

  daemon: {
    name: "daemon",
    summary: "Inspect or stop the running daemon",
    usage: "sheaf daemon <status|stop>",
    step: 2,
    subcommands: {
      status: {
        name: "status",
        summary: "Show the daemon's status for the vault",
        usage: "sheaf daemon status",
        step: 2,
      },
      stop: {
        name: "stop",
        summary: "Stop the running daemon (SIGTERM)",
        usage: "sheaf daemon stop",
        step: 2,
      },
    },
  },

  mcp: {
    name: "mcp",
    summary: "Run the stdio MCP bridge (or `mcp install`)",
    usage: "sheaf mcp [--doc PATH] [--tools full|thread-only] [--no-daemon]",
    step: 4,
    runnable: true,
    subcommands: {
      install: {
        name: "install",
        summary: "Install sheaf as an MCP server in an agent's config",
        usage: "sheaf mcp install [client...] [--name NAME] [--dry-run]",
        step: 5,
      },
    },
  },

  docs: {
    name: "docs",
    summary: "List documents in the vault",
    usage: "sheaf docs",
    step: 6,
  },

  read: {
    name: "read",
    summary: "Read a document",
    usage: "sheaf read <path> [--ref REF]",
    step: 6,
  },

  grep: {
    name: "grep",
    summary: "Search document contents",
    usage: "sheaf grep <pattern> [--path P] [--glob G] [-i] [-A n] [-B n]",
    step: 6,
  },

  glob: {
    name: "glob",
    summary: "List documents matching a glob",
    usage: "sheaf glob <pattern> [--ref REF]",
    step: 6,
  },

  thread: {
    name: "thread",
    summary: "List, show, and manage comment threads",
    usage: "sheaf thread <list|show|add|reply|resolve|reopen>",
    step: 6,
    subcommands: {
      list: {
        name: "list",
        summary: "List threads",
        usage: "sheaf thread list [--path P] [--ref REF]",
        step: 6,
      },
      show: {
        name: "show",
        summary: "Show a thread",
        usage: "sheaf thread show <id>",
        step: 6,
      },
      add: {
        name: "add",
        summary: "Start a new thread",
        usage:
          "sheaf thread add --path P [--range from:to | --doc] -m MSG [--as ui|agent]",
        step: 6,
      },
      reply: {
        name: "reply",
        summary: "Reply to a thread",
        usage: "sheaf thread reply <id> -m MSG [--as ui|agent]",
        step: 6,
      },
      resolve: {
        name: "resolve",
        summary: "Resolve a thread",
        usage: "sheaf thread resolve <id>",
        step: 6,
      },
      reopen: {
        name: "reopen",
        summary: "Reopen a thread",
        usage: "sheaf thread reopen <id>",
        step: 6,
      },
    },
  },

  events: {
    name: "events",
    summary: "Follow the live event stream",
    usage: "sheaf events <follow>",
    step: 3,
    subcommands: {
      follow: {
        name: "follow",
        summary: "Follow events as NDJSON",
        usage: "sheaf events follow [--role agent|ui] [--since ID]",
        step: 3,
      },
    },
  },
};

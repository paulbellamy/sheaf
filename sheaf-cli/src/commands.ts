/**
 * The command tree + hand-written help metadata + per-command flag schemas.
 *
 * This is the v0.1 command surface (docs/sheaf-cli-v0.1.md "Command tree"). In
 * step 1 every domain command is a stub: `run` is left undefined and the
 * dispatcher emits `not implemented (step N)` (exit 1). But each command's
 * `options` (its `parseArgs` schema) is real, so the documented flags parse now
 * — later steps only need to add the `run` handler, which reads them off
 * {@link RunContext}.
 */
import type { Globals, OptionDef } from "./args";
import type { ExitCode, Io, Output } from "./io";
import { daemonStatusCommand, daemonStopCommand } from "./daemon-cmd";
import { docsCommand } from "./docs";
import { eventsFollowCommand } from "./events";
import { mcpBridgeCommand } from "./mcp";
import { mcpInstallCommand } from "./mcp-install";
import { grepCommand, globCommand, readCommand } from "./reads";
import { serveCommand } from "./serve";
import {
  threadAddCommand,
  threadListCommand,
  threadReopenCommand,
  threadReplyCommand,
  threadResolveCommand,
  threadShowCommand,
} from "./threads";

/** Everything a command handler receives. */
export interface RunContext {
  globals: Globals;
  out: Output;
  io: Io;
  /**
   * The resolved, realpath'd target vault (precedence: `--vault` › `$SHEAF_
   * VAULT` › config › cwd). Resolved once by the dispatcher before a handler
   * runs, so every client command — `connectDaemon(ctx.vault, ctx.io.env)`,
   * `followEvents({ vault: ctx.vault, … })` — reads one and the same string.
   */
  vault: string;
  /** Parsed flag values (globals + this command's own), from the strict pass. */
  values: Record<string, unknown>;
  /** Positionals after the resolved command path (command-specific args). */
  positionals: string[];
  /** Raw argv, kept for handlers that need to re-parse or inspect it. */
  argv: string[];
}

export interface CommandSpec {
  /** Command word (leaf or group name). */
  name: string;
  /** One-line summary shown in the parent's command list. */
  summary: string;
  /** Usage line shown at the top of the command's own `--help`. */
  usage: string;
  /** Optional extra paragraph(s) shown under the summary in `--help`. */
  details?: string;
  /** Plan step that implements this command (drives the stub message). */
  step: number;
  /**
   * True for a command that talks to the daemon. The dispatcher enforces the
   * `--no-daemon` guard for these (exit 3) so a handler can't silently ignore
   * the flag by forgetting to check it — a real risk as step 6 adds verbs.
   */
  needsDaemon?: boolean;
  /** This command's own `parseArgs` options, merged onto the globals. */
  options?: Record<string, OptionDef>;
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

// Shared option fragments, kept consistent across commands.
const REF: Record<string, OptionDef> = { ref: { type: "string" } };
const TOOLS: Record<string, OptionDef> = { tools: { type: "string" } };
const AS_MESSAGE: Record<string, OptionDef> = {
  message: { type: "string", short: "m" },
  as: { type: "string" },
};

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
    options: {
      port: { type: "string" },
      host: { type: "string" },
      ...TOOLS,
      "allow-origin": { type: "string", multiple: true },
    },
    run: serveCommand,
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
        run: daemonStatusCommand,
      },
      stop: {
        name: "stop",
        summary: "Stop the running daemon (SIGTERM)",
        usage: "sheaf daemon stop",
        step: 2,
        run: daemonStopCommand,
      },
    },
  },

  mcp: {
    name: "mcp",
    summary: "Run the stdio MCP bridge (or `mcp install`)",
    usage: "sheaf mcp [--doc PATH] [--tools full|thread-only] [--no-daemon]",
    step: 4,
    runnable: true,
    // `--no-daemon` is a global flag, so it already parses here.
    options: { doc: { type: "string" }, ...TOOLS },
    // Running `mcp` (no subcommand) starts the stdio bridge. It is the one
    // command allowed to auto-spawn a daemon, and the one place `--no-daemon`
    // is meaningful (its standalone escape hatch), so it is NOT `needsDaemon`.
    run: mcpBridgeCommand,
    subcommands: {
      install: {
        name: "install",
        summary: "Install sheaf as an MCP server in an agent's config",
        usage:
          "sheaf mcp install [client...] [--name NAME] [--tools full|thread-only] [--dry-run]",
        details:
          "Writes an absolute stdio invocation (command: node, args: <abs bin/sheaf.js> mcp\n" +
          "--vault <abs vault>) into each client's config, upserting only the `--name` entry\n" +
          "(default `sheaf`) and preserving every other server/key. Clients: claude (project\n" +
          "`<vault>/.mcp.json`), claude-desktop (macOS), codex (`~/.codex/config.toml`).\n" +
          "No client arg installs into every detected client; --dry-run prints the diff and\n" +
          "writes nothing. This command needs no daemon and never spawns or connects to one.\n" +
          "Note: the entry pins the current node binary (command: process.execPath). Under a\n" +
          "node version manager (nvm/volta/asdf), switching node later can stale that path —\n" +
          "re-run `sheaf mcp install` after such a switch.",
        step: 5,
        // `--tools` (shared TOOLS fragment) is appended to the written args; it
        // is not a global, so it must be declared here to parse on `install`.
        options: {
          name: { type: "string" },
          "dry-run": { type: "boolean" },
          ...TOOLS,
        },
        run: mcpInstallCommand,
      },
    },
  },

  docs: {
    name: "docs",
    summary: "List documents in the vault",
    usage: "sheaf docs",
    step: 6,
    needsDaemon: true,
    run: docsCommand,
  },

  read: {
    name: "read",
    summary: "Read a document",
    usage: "sheaf read <path> [--ref REF]",
    step: 6,
    needsDaemon: true,
    options: { ...REF },
    run: readCommand,
  },

  grep: {
    name: "grep",
    summary: "Search document contents",
    usage:
      "sheaf grep <pattern> [--path P] [--glob G] [-i] [-A n] [-B n] [--multiline] [--head-limit n] [--output-mode M] [--ref REF]",
    step: 6,
    needsDaemon: true,
    options: {
      path: { type: "string" },
      glob: { type: "string" },
      "ignore-case": { type: "boolean", short: "i" },
      "after-context": { type: "string", short: "A" },
      "before-context": { type: "string", short: "B" },
      multiline: { type: "boolean" },
      "head-limit": { type: "string" },
      "output-mode": { type: "string" },
      ...REF,
    },
    run: grepCommand,
  },

  glob: {
    name: "glob",
    summary: "List documents matching a glob",
    usage: "sheaf glob <pattern> [--ref REF]",
    step: 6,
    needsDaemon: true,
    options: { ...REF },
    run: globCommand,
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
        needsDaemon: true,
        options: { path: { type: "string" }, ...REF },
        run: threadListCommand,
      },
      show: {
        name: "show",
        summary: "Show a thread",
        usage: "sheaf thread show <id>",
        step: 6,
        needsDaemon: true,
        run: threadShowCommand,
      },
      add: {
        name: "add",
        summary: "Start a new thread",
        usage:
          "sheaf thread add --path P [--range from:to | --doc] -m MSG [--as ui|agent] [--ref REF]",
        step: 6,
        needsDaemon: true,
        options: {
          path: { type: "string" },
          range: { type: "string" },
          doc: { type: "boolean" },
          ...REF,
          ...AS_MESSAGE,
        },
        run: threadAddCommand,
      },
      reply: {
        name: "reply",
        summary: "Reply to a thread",
        usage: "sheaf thread reply <id> -m MSG [--as ui|agent]",
        step: 6,
        needsDaemon: true,
        options: { ...AS_MESSAGE },
        run: threadReplyCommand,
      },
      resolve: {
        name: "resolve",
        summary: "Resolve a thread",
        usage: "sheaf thread resolve <id> [--as ui|agent]",
        step: 6,
        needsDaemon: true,
        options: { as: { type: "string" } },
        run: threadResolveCommand,
      },
      reopen: {
        name: "reopen",
        summary: "Reopen a thread",
        usage: "sheaf thread reopen <id> [--as ui]",
        step: 6,
        needsDaemon: true,
        options: { as: { type: "string" } },
        run: threadReopenCommand,
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
        usage:
          "sheaf events follow [--role agent|ui] [--since ID] [--exit-on-disconnect]",
        details:
          "Prints one JSON event per line to stdout (always NDJSON, ignoring --format).\n" +
          "--role defaults to 'ui'; pass 'agent' for the MCP agent watcher (it flips the\n" +
          "plugin's \"agent connected\" status). By default it runs until interrupted,\n" +
          "reconnecting across daemon restarts; --exit-on-disconnect exits instead when the\n" +
          "daemon goes away (0 on a clean shutdown, non-zero on error).",
        step: 3,
        needsDaemon: true,
        options: {
          role: { type: "string" },
          since: { type: "string" },
          "exit-on-disconnect": { type: "boolean" },
        },
        run: eventsFollowCommand,
      },
    },
  },
};

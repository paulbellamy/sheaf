/**
 * Hand-written help tables.
 *
 * Help is always plain text on stdout (it is not a data command, so `--format
 * json` does not apply). Root help lists the command tree + global flags;
 * per-command help shows the usage line, the summary, and — for groups — the
 * subcommand list.
 */
import { REGISTRY, type CommandSpec } from "./commands";
import type { Output } from "./io";

/** Global flags, as `[flag, description]` rows for the help table. */
const GLOBAL_FLAGS: ReadonlyArray<readonly [string, string]> = [
  ["-C, --vault DIR", "Vault directory (default: $SHEAF_VAULT, config, or cwd)"],
  ["    --format FMT", "Output format: text (default) or json"],
  ["    --no-daemon", "Do not auto-spawn or require a daemon"],
  ["-h, --help", "Show help"],
  ["-V, --version", "Print version"],
];

/** Right-pad `s` to at least `width` columns. */
function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/** Print the top-level help: tagline, usage, commands, global flags. */
export function printRootHelp(out: Output): void {
  out.text("sheaf — comment on a doc, an agent edits it inline.");
  out.text();
  out.text("Usage: sheaf [global flags] <command> [args]");
  out.text();
  out.text("Commands:");
  for (const spec of Object.values(REGISTRY)) {
    out.text(`  ${pad(spec.name, 10)}${spec.summary}`);
  }
  out.text();
  out.text("Global flags:");
  for (const [flag, desc] of GLOBAL_FLAGS) {
    out.text(`  ${pad(flag, 18)}${desc}`);
  }
  out.text();
  out.text("Run `sheaf <command> --help` for command-specific usage.");
}

/** Print help for one command (or group), given the path used to reach it. */
export function printCommandHelp(
  out: Output,
  spec: CommandSpec,
  path: string[],
): void {
  out.text(`Usage: ${spec.usage}`);
  out.text();
  out.text(spec.summary);
  if (spec.details) {
    out.text();
    for (const line of spec.details.split("\n")) out.text(line);
  }
  if (spec.subcommands) {
    out.text();
    out.text("Subcommands:");
    for (const sub of Object.values(spec.subcommands)) {
      out.text(`  ${pad(sub.name, 10)}${sub.summary}`);
    }
    out.text();
    out.text(`Run \`sheaf ${path.join(" ")} <subcommand> --help\` for details.`);
  }
}

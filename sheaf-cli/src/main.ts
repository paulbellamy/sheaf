/**
 * `bin/sheaf.js` entry point.
 *
 * Thin wrapper around {@link run}. On the normal path we set `process.exitCode`
 * and let the event loop drain rather than calling `process.exit(code)`:
 * `process.exit` tears down the process immediately, and stdout/stderr are
 * async pipes on macOS/BSD, so an eager exit can truncate output once real
 * payloads (not just tiny stub messages) start flowing. `process.exit(1)` is
 * kept only in the fatal catch, where output no longer matters.
 */
import { run } from "./run";

// EPIPE on stdout/stderr is the normal end of a pipe — `sheaf events follow |
// head -1` closes the reader after one line, and the next write would otherwise
// throw an unhandled `write EPIPE` and crash with exit 1. This is THE agent
// idiom (the MCP ReadMe replaces its curl loop with `sheaf events follow`, often
// piped), so a broken downstream pipe must be a clean exit 0, not a stack trace.
const onPipeError = (e: NodeJS.ErrnoException): void => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
};
process.stdout.on("error", onPipeError);
process.stderr.on("error", onPipeError);

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    process.stderr.write(
      `fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
    );
    process.exit(1);
  });

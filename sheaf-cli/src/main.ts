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

/**
 * `bin/sheaf.js` entry point.
 *
 * Thin wrapper: run the dispatcher on the real process IO and translate the
 * returned exit code into `process.exit`. All expected errors are handled
 * inside `run`; the `.catch` here is a last-resort guard so a stray rejection
 * still terminates with a nonzero code rather than hanging.
 */
import { run } from "./run";

run(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    process.stderr.write(
      `fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
    );
    process.exit(1);
  });

/**
 * Small typed readers over the `parseArgs` values bag, shared by the step-6
 * verbs. `parseArgs` hands back `Record<string, unknown>` (strings, booleans,
 * or arrays); these coerce a single flag to the shape a verb wants and raise a
 * {@link usageError} (exit 2) when the value is malformed — so a bad `-A`, a
 * junk `--range`, or an unknown `--as` fails as a usage error rather than
 * flowing into the daemon as garbage.
 */
import { usageError } from "./io";

/** A string flag, or `undefined` when unset. (parseArgs already rejects a
 *  dangling value-flag, so a present string flag always has a string value.) */
export function strFlag(
  values: Record<string, unknown>,
  name: string,
): string | undefined {
  const v = values[name];
  return typeof v === "string" ? v : undefined;
}

/**
 * An integer flag (e.g. `-A`/`-B`/`--head-limit`, which parseArgs captures as
 * strings), or `undefined` when unset. `min` (default 0) is the smallest
 * accepted value — `--head-limit` requires `>= 1` to match the Grep tool's
 * schema, so a `0` is rejected here rather than dumped as a raw zod error from
 * the daemon. Anything below `min` or non-integer is a usage error naming the
 * flag.
 */
export function intFlag(
  values: Record<string, unknown>,
  name: string,
  displayName = `--${name}`,
  min = 0,
): number | undefined {
  const v = values[name];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !/^\d+$/.test(v) || Number(v) < min) {
    throw usageError(
      `${displayName} must be an integer >= ${min} (got '${String(v)}')`,
    );
  }
  return Number(v);
}

/**
 * The thread-id shape, copied from `sheaf-server/src/schemas.ts` `threadIdArg`.
 * The daemon validates ids too, but the MCP tools surface a schema miss as a
 * raw multi-line zod dump; pre-checking here lets a malformed id fail fast as a
 * clean usage error (and identically on the `ui` and `agent` paths).
 */
const THREAD_ID_RE = /^thrd_[A-Za-z0-9]{6,64}(?:-[A-Za-z0-9]{1,64}){0,8}$/;

/** Require a well-formed `thrd_…` id, else a usage error (exit 2). */
export function requireThreadId(id: string): string {
  if (!THREAD_ID_RE.test(id)) {
    throw usageError(`invalid thread id '${id}' (expected a thrd_… id)`);
  }
  return id;
}

/**
 * Parse the `--as ui|agent` selector shared by the thread mutation verbs.
 * Defaults to `ui` — the human default that routes through REST so the daemon
 * stamps origin `ui` and wakes the connected agent (docs/sheaf-cli-v0.1.md
 * "Wire protocol"). Anything but the two values is a usage error.
 */
export function parseAs(value: unknown): "ui" | "agent" {
  if (value === undefined) return "ui";
  if (value === "ui" || value === "agent") return value;
  throw usageError(`--as must be 'ui' or 'agent' (got '${String(value)}')`);
}

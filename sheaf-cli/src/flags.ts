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
 * A non-negative integer flag (e.g. `-A`/`-B`/`--head-limit`, which parseArgs
 * captures as strings), or `undefined` when unset. Anything that isn't a
 * non-negative integer is a usage error naming the flag.
 */
export function intFlag(
  values: Record<string, unknown>,
  name: string,
  displayName = `--${name}`,
): number | undefined {
  const v = values[name];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !/^\d+$/.test(v)) {
    throw usageError(`${displayName} must be a non-negative integer (got '${String(v)}')`);
  }
  return Number(v);
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

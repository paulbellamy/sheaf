import * as path from "node:path";

import type { Backend } from "./index";
import { StubBackend } from "./stub";

/**
 * Backend factory.
 *
 * Consumers should import `getBackend` from here (not from `./stub`) so the
 * concrete backend can be swapped by editing a single file.
 */

let cachedBackend: Backend | null = null;

export function getBackend(): Backend {
  if (cachedBackend) return cachedBackend;
  const root =
    process.env.SHEAF_DATA_ROOT ?? path.join(process.cwd(), "data");
  cachedBackend = new StubBackend(root);
  return cachedBackend;
}

/** Test hook: override the backend instance. */
export function setBackend(backend: Backend | null): void {
  cachedBackend = backend;
}

/**
 * Hidden `--selftest` handler.
 *
 * Its whole purpose is to prove, at runtime, that the bundled `bin/sheaf.js`
 * can import from `sheaf-server` (whose package publishes extensionless *.ts,
 * so it must be BUNDLED, not left external) and that sheaf-server's own
 * external runtime deps resolve from the install next to `bin/`. It constructs a
 * real `StubBackend` against a throwaway temp dir and prints `selftest ok`.
 *
 * This module is only ever loaded via a dynamic import from the dispatcher, so
 * normal commands don't pay the cost of pulling sheaf-server (and, transitively,
 * the MCP SDK) into memory. The static `sheaf-server` import here is what makes
 * esbuild bundle it. A dedicated build-and-exec vitest (bundle.test.ts) guards
 * against a build-config regression silently breaking this.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StubBackend } from "sheaf-server";

import type { Io } from "./io";

export function runSelftest(io: Io): number {
  const dir = mkdtempSync(join(tmpdir(), "sheaf-selftest-"));
  try {
    // Construct the real backend — proves the sheaf-server TS was bundled and
    // its external deps (zod, the MCP SDK) resolved.
    const backend = new StubBackend(dir);
    if (typeof backend.subscribe !== "function") {
      io.err("selftest failed: StubBackend missing expected API\n");
      return 1;
    }
    io.out("selftest ok\n");
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

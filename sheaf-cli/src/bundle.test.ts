import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { VERSION } from "./version";

// src/ → package root is one directory up.
const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(pkgRoot, "bin", "sheaf.js");

/**
 * These tests exercise the *built* bundle, not the TS source, so a build-config
 * regression (e.g. wrongly externalizing `sheaf-server`, whose package exports
 * extensionless *.ts that Node cannot import) is caught here instead of at the
 * moment step 2 first imports the backend.
 */
describe("built bin/sheaf.js", () => {
  beforeAll(() => {
    // Build the bundle so this test is self-contained (the `test` script also
    // builds; this makes a bare `vitest run` work too). ~ a few ms.
    execFileSync(process.execPath, [join(pkgRoot, "build.mjs")], {
      cwd: pkgRoot,
      stdio: "pipe",
      timeout: 60_000,
    });
    expect(existsSync(bin)).toBe(true);
  }, 60_000);

  it("imports and constructs a sheaf-server backend at runtime (--selftest)", () => {
    const out = execFileSync(process.execPath, [bin, "--selftest"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(out.trim()).toBe("selftest ok");
  });

  it("reports the injected version", () => {
    const out = execFileSync(process.execPath, [bin, "--version"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(out.trim()).toBe(VERSION);
  });
});

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { resolveVault } from "./vault";

// Four distinct, existing directories — one per precedence source. realpath is
// applied to the expectations too so the comparison holds on platforms where
// tmpdir is itself a symlink (e.g. macOS /var → /private/var).
const dirFlag = mkdtempSync(join(tmpdir(), "sheaf-vault-flag-"));
const dirEnv = mkdtempSync(join(tmpdir(), "sheaf-vault-env-"));
const dirConfig = mkdtempSync(join(tmpdir(), "sheaf-vault-config-"));
const dirCwd = mkdtempSync(join(tmpdir(), "sheaf-vault-cwd-"));

const real = (p: string) => realpathSync(p);

afterAll(() => {
  // Best-effort cleanup; leaving temp dirs is harmless if this throws.
  for (const d of [dirFlag, dirEnv, dirConfig, dirCwd]) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe("resolveVault precedence", () => {
  it("--vault wins over everything", () => {
    const got = resolveVault({
      flag: dirFlag,
      env: { SHEAF_VAULT: dirEnv },
      config: { defaultVault: dirConfig },
      cwd: dirCwd,
    });
    expect(got).toBe(real(dirFlag));
  });

  it("$SHEAF_VAULT wins when no --vault", () => {
    const got = resolveVault({
      env: { SHEAF_VAULT: dirEnv },
      config: { defaultVault: dirConfig },
      cwd: dirCwd,
    });
    expect(got).toBe(real(dirEnv));
  });

  it("config defaultVault wins when no flag and no env", () => {
    const got = resolveVault({
      env: {},
      config: { defaultVault: dirConfig },
      cwd: dirCwd,
    });
    expect(got).toBe(real(dirConfig));
  });

  it("falls back to cwd when nothing else is set", () => {
    const got = resolveVault({ env: {}, cwd: dirCwd });
    expect(got).toBe(real(dirCwd));
  });

  it("treats an empty $SHEAF_VAULT as unset", () => {
    const got = resolveVault({
      env: { SHEAF_VAULT: "" },
      config: { defaultVault: dirConfig },
      cwd: dirCwd,
    });
    expect(got).toBe(real(dirConfig));
  });
});

describe("resolveVault normalization", () => {
  it("resolves a relative --vault against cwd and realpaths it", () => {
    const got = resolveVault({ flag: ".", cwd: dirCwd });
    expect(got).toBe(real(dirCwd));
  });

  it("throws a CliError when the chosen directory does not exist", () => {
    expect(() =>
      resolveVault({ flag: join(dirCwd, "does-not-exist"), cwd: dirCwd }),
    ).toThrowError(/vault directory not found/);
  });
});

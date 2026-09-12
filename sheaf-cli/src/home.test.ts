import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  configPath,
  daemonsDir,
  ensureSheafHome,
  logsDir,
  sheafHome,
} from "./config";

const created: string[] = [];

function tempHomeEnv(): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), "sheaf-home-"));
  created.push(home);
  return { SHEAF_HOME: home };
}

afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("$SHEAF_HOME resolution", () => {
  it("honors a SHEAF_HOME override", () => {
    const env = tempHomeEnv();
    expect(sheafHome(env)).toBe(env.SHEAF_HOME);
  });

  it("defaults to ~/.sheaf without touching the filesystem", () => {
    // Pure string computation — no directory is created for the real home.
    expect(sheafHome({})).toBe(join(homedir(), ".sheaf"));
  });

  it("derives every sub-path under the override, never the real home", () => {
    const env = tempHomeEnv();
    const home = env.SHEAF_HOME as string;
    expect(configPath(env)).toBe(join(home, "config.json"));
    expect(daemonsDir(env)).toBe(join(home, "daemons"));
    expect(logsDir(env)).toBe(join(home, "logs"));

    // Not one of them points at the real ~/.sheaf.
    const realHome = join(homedir(), ".sheaf");
    for (const p of [configPath(env), daemonsDir(env), logsDir(env)]) {
      expect(p.startsWith(home)).toBe(true);
      expect(p.startsWith(realHome)).toBe(false);
    }
  });
});

describe("ensureSheafHome", () => {
  it("creates the directory lazily with mode 0700", () => {
    const env = tempHomeEnv();
    const nested = join(env.SHEAF_HOME as string, "deeper");
    const nestedEnv = { SHEAF_HOME: nested };
    created.push(nested);

    expect(existsSync(nested)).toBe(false);
    const returned = ensureSheafHome(nestedEnv);
    expect(returned).toBe(nested);
    expect(existsSync(nested)).toBe(true);
    expect(statSync(nested).mode & 0o777).toBe(0o700);
  });
});

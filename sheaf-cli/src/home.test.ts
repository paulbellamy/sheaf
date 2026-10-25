import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// These come THROUGH sheaf-cli's config module, which re-exports the layout
// helpers from `sheaf-server/home`. The canonical layout behavior is tested in
// sheaf-server/src/home.test.ts; here we verify the CLI wiring: the re-exports
// resolve and `configPath` is built on the (overridable) $SHEAF_HOME.
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

describe("config module re-exports the $SHEAF_HOME layout", () => {
  it("derives every path under the override, never the real home", () => {
    const env = tempHomeEnv();
    const home = env.SHEAF_HOME as string;
    expect(sheafHome(env)).toBe(home);
    expect(configPath(env)).toBe(join(home, "config.json"));
    expect(daemonsDir(env)).toBe(join(home, "daemons"));
    expect(logsDir(env)).toBe(join(home, "logs"));

    const realHome = join(homedir(), ".sheaf");
    for (const p of [configPath(env), daemonsDir(env), logsDir(env)]) {
      expect(p.startsWith(home)).toBe(true);
      expect(p.startsWith(realHome)).toBe(false);
    }
  });

  it("ensureSheafHome creates the override dir with mode 0700", () => {
    const env = tempHomeEnv();
    const nested = join(env.SHEAF_HOME as string, "deeper");
    const nestedEnv = { SHEAF_HOME: nested };

    expect(existsSync(nested)).toBe(false);
    expect(ensureSheafHome(nestedEnv)).toBe(nested);
    expect(existsSync(nested)).toBe(true);
    expect(statSync(nested).mode & 0o777).toBe(0o700);
  });
});

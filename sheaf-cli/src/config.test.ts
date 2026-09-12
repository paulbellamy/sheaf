import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configPath, loadConfig, saveConfig, type Config } from "./config";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sheaf-home-"));
  env = { SHEAF_HOME: home };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("config load/save", () => {
  it("treats a missing file as an empty config (not an error)", () => {
    expect(loadConfig(env)).toEqual({});
  });

  it("round-trips a saved config", () => {
    const config: Config = { defaultVault: "/vaults/notes", defaultPort: 31415 };
    saveConfig(config, env);
    expect(loadConfig(env)).toEqual(config);
  });

  it("writes the config file with mode 0600", () => {
    saveConfig({ defaultVault: "/x" }, env);
    expect(statSync(configPath(env)).mode & 0o777).toBe(0o600);
  });

  it("re-tightens permissions on an externally-loosened file", () => {
    saveConfig({ defaultVault: "/a" }, env);
    // Simulate a file left world/group-readable (e.g. an older sheaf, or a
    // umask/editor quirk); the next save must bring it back to 0600.
    chmodSync(configPath(env), 0o644);
    expect(statSync(configPath(env)).mode & 0o777).toBe(0o644);

    saveConfig({ defaultVault: "/b" }, env);
    expect(statSync(configPath(env)).mode & 0o777).toBe(0o600);
    expect(loadConfig(env)).toEqual({ defaultVault: "/b" });
  });

  it("preserves unknown keys across a round-trip (forward-compatible)", () => {
    // A future field an older sheaf doesn't know about must survive load→save.
    const withFuture = { defaultVault: "/x", futureField: 42 } as Config;
    saveConfig(withFuture, env);
    expect(loadConfig(env)).toEqual(withFuture);
  });

  it("carries an mcp settings object through unchanged", () => {
    const config: Config = { mcp: { defaultClient: "claude", extra: [1, 2] } };
    saveConfig(config, env);
    expect(loadConfig(env)).toEqual(config);
  });

  it("rejects a relative defaultVault", () => {
    expect(() => saveConfig({ defaultVault: "notes" } as Config, env)).toThrow(
      /absolute/,
    );
  });
});

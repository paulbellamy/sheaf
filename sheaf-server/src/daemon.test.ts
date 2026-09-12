import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { StubBackend } from "./backend/stub";
import { buildSheafApp } from "./app";
import { daemonsDir } from "./home";
import {
  acquireLock,
  daemonBaseUrl,
  daemonFile,
  daemonKey,
  isDaemonAlive,
  lockFile,
  readDaemon,
  registerDaemon,
  type DaemonInfo,
} from "./daemon";

/**
 * Every test gets a throwaway `$SHEAF_HOME` and a throwaway vault so nothing
 * touches the real home. `realpathSync` on the vault mirrors what the helpers
 * do internally, so comparisons hold on platforms where tmpdir is a symlink.
 */
const cleanups: Array<() => void> = [];

function tempEnv(): { env: NodeJS.ProcessEnv; vault: string } {
  const home = mkdtempSync(join(tmpdir(), "sheaf-home-"));
  const vault = realpathSync(mkdtempSync(join(tmpdir(), "sheaf-vault-")));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  cleanups.push(() => rmSync(vault, { recursive: true, force: true }));
  return { env: { SHEAF_HOME: home }, vault };
}

afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

describe("daemonKey / path helpers", () => {
  it("keys the same vault the same regardless of spelling", () => {
    const { vault } = tempEnv();
    expect(daemonKey(vault)).toBe(daemonKey(`${vault}/.`));
    expect(daemonKey(vault)).toBe(daemonKey(`${vault}/`));
  });

  it("keys different vaults differently", () => {
    const a = tempEnv();
    const b = tempEnv();
    expect(daemonKey(a.vault)).not.toBe(daemonKey(b.vault));
  });

  it("places discovery + lock files under daemons/", () => {
    const { env, vault } = tempEnv();
    const key = daemonKey(vault);
    expect(daemonFile(vault, env)).toBe(join(daemonsDir(env), `${key}.json`));
    expect(lockFile(vault, env)).toBe(join(daemonsDir(env), `${key}.lock`));
  });

  it("brackets an IPv6 host in the base URL", () => {
    expect(daemonBaseUrl({ host: "127.0.0.1", port: 8080 })).toBe(
      "http://127.0.0.1:8080",
    );
    expect(daemonBaseUrl({ host: "::1", port: 8080 })).toBe(
      "http://[::1]:8080",
    );
  });
});

describe("registerDaemon", () => {
  it("writes a 0600 discovery record and a disposer removes it", () => {
    const { env, vault } = tempEnv();
    const dispose = registerDaemon(
      { vault, host: "127.0.0.1", port: 12345, version: "1.2.3" },
      env,
    );
    const file = daemonFile(vault, env);
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const record = JSON.parse(readFileSync(file, "utf8")) as DaemonInfo;
    expect(record.pid).toBe(process.pid);
    expect(record.host).toBe("127.0.0.1");
    expect(record.port).toBe(12345);
    expect(record.vault).toBe(vault);
    expect(record.version).toBe("1.2.3");
    expect(typeof record.startedAt).toBe("number");

    dispose();
    expect(existsSync(file)).toBe(false);
    // Idempotent: a second call is a no-op, not a throw.
    expect(() => dispose()).not.toThrow();
  });
});

describe("acquireLock", () => {
  it("grants the lock once, refuses a second holder, and frees on release", () => {
    const { env, vault } = tempEnv();
    const release = acquireLock(vault, env);
    expect(release).not.toBeNull();
    expect(existsSync(lockFile(vault, env))).toBe(true);

    // A second acquire while the first is held loses.
    expect(acquireLock(vault, env)).toBeNull();

    release!();
    expect(existsSync(lockFile(vault, env))).toBe(false);
    // Now a fresh acquire succeeds again.
    const again = acquireLock(vault, env);
    expect(again).not.toBeNull();
    again!();
  });

  it("writes the holder's pid into the lock for debugging", () => {
    const { env, vault } = tempEnv();
    const release = acquireLock(vault, env);
    expect(readFileSync(lockFile(vault, env), "utf8").trim()).toBe(
      String(process.pid),
    );
    release!();
  });
});

describe("readDaemon", () => {
  it("returns null when no record exists", () => {
    const { env, vault } = tempEnv();
    expect(readDaemon(vault, env)).toBeNull();
  });

  it("round-trips a registered record", () => {
    const { env, vault } = tempEnv();
    const dispose = registerDaemon(
      { vault, host: "127.0.0.1", port: 999, version: "0.0.1" },
      env,
    );
    const info = readDaemon(vault, env);
    expect(info).toMatchObject({
      pid: process.pid,
      host: "127.0.0.1",
      port: 999,
      vault,
      version: "0.0.1",
    });
    dispose();
  });

  it("tolerates a corrupt record (reads as null, not a throw)", () => {
    const { env, vault } = tempEnv();
    // registerDaemon first so daemonsDir exists.
    const dispose = registerDaemon(
      { vault, host: "127.0.0.1", port: 1, version: "x" },
      env,
    );
    writeFileSync(daemonFile(vault, env), "{ not json");
    expect(readDaemon(vault, env)).toBeNull();
    dispose();
  });
});

describe("isDaemonAlive", () => {
  const apps: Array<ReturnType<typeof buildSheafApp>> = [];

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close().catch(() => {});
  });

  async function serve(
    vault: string,
    healthVault: string,
  ): Promise<{ host: string; port: number }> {
    const app = buildSheafApp(new StubBackend(vault, vault), {
      health: { vault: healthVault, startedAt: Date.now(), version: "t" },
    });
    apps.push(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address() as AddressInfo;
    return { host: "127.0.0.1", port: addr.port };
  }

  it("is true when a live server owns the vault", async () => {
    const { env, vault } = tempEnv();
    const { host, port } = await serve(vault, vault);
    const dispose = registerDaemon({ vault, host, port, version: "t" }, env);
    expect(await isDaemonAlive(vault, env)).toBe(true);
    dispose();
  });

  it("is false when there is no discovery record", async () => {
    const { env, vault } = tempEnv();
    expect(await isDaemonAlive(vault, env)).toBe(false);
  });

  it("is false when the recorded port is not listening (stale record)", async () => {
    const { env, vault } = tempEnv();
    // A live server just to grab a real port, then close it so the port is dead.
    const { host, port } = await serve(vault, vault);
    const dispose = registerDaemon({ vault, host, port, version: "t" }, env);
    await apps.splice(0)[0].close();
    expect(await isDaemonAlive(vault, env, 500)).toBe(false);
    dispose();
  });

  it("is false when the server reports a different vault (pid/port reuse)", async () => {
    const { env, vault } = tempEnv();
    const other = tempEnv().vault;
    // The server answers health with a *different* vault than the record claims.
    const { host, port } = await serve(vault, other);
    const dispose = registerDaemon({ vault, host, port, version: "t" }, env);
    expect(await isDaemonAlive(vault, env)).toBe(false);
    dispose();
  });
});

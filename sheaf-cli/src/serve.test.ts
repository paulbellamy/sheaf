import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  acquireLock,
  daemonFile,
  isDaemonAlive,
  lockFile,
  readDaemon,
} from "sheaf-server/daemon";

import { REGISTRY, type RunContext } from "./commands";
import { daemonsDir } from "./config";
import { daemonStatusCommand } from "./daemon-cmd";
import { Output, type Io } from "./io";
import { serveCommand, startServer, type ServeHandle } from "./serve";

/** Sleep helper for the idle/lifecycle timing assertions. */
const delay = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(pkgRoot, "bin", "sheaf.js");

/** Temp `$SHEAF_HOME` + temp vault (realpath'd, with one doc), auto-cleaned. */
const trash: string[] = [];
const handles: ServeHandle[] = [];

function scratch(): { env: NodeJS.ProcessEnv; vault: string } {
  const home = mkdtempSync(join(tmpdir(), "sheaf-home-"));
  const vault = realpathSync(mkdtempSync(join(tmpdir(), "sheaf-vault-")));
  writeFileSync(join(vault, "note.md"), "hello world");
  trash.push(home, vault);
  return { env: { SHEAF_HOME: home }, vault };
}

afterEach(async () => {
  for (const h of handles.splice(0)) await h.close().catch(() => {});
  for (const d of trash.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A capturing {@link RunContext} for the status/serve command handlers. */
function makeCtx(
  vault: string,
  env: NodeJS.ProcessEnv,
  format: "text" | "json" = "text",
  values: Record<string, unknown> = {},
): { ctx: RunContext; stdout: () => string; stderr: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (c) => out.push(c),
    err: (c) => err.push(c),
    env,
    cwd: vault,
  };
  const ctx: RunContext = {
    globals: { vault, format, noDaemon: false, help: false, version: false },
    out: new Output(io, format),
    io,
    values,
    positionals: [],
    argv: [],
  };
  return { ctx, stdout: () => out.join(""), stderr: () => err.join("") };
}

describe("startServer lifecycle (in-process)", () => {
  it("listens on an ephemeral port and serves health + UI REST", async () => {
    const { env, vault } = scratch();
    const handle = await startServer({ vault, version: "test", env });
    handles.push(handle);

    expect(handle.port).toBeGreaterThan(0);

    const health = await fetch(`${handle.url}/api/health`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as {
      vault: string;
      pid: number;
      version: string;
    };
    expect(body.vault).toBe(vault);
    expect(body.pid).toBe(process.pid);
    expect(body.version).toBe("test");

    const docs = await fetch(`${handle.url}/api/ui/docs`);
    expect(docs.status).toBe(200);
    const docsBody = (await docs.json()) as { docs: { path: string }[] };
    expect(docsBody.docs.map((d) => d.path)).toContain("note.md");
  });

  it("returns 405 for GET /api/mcp", async () => {
    const { env, vault } = scratch();
    const handle = await startServer({ vault, version: "test", env });
    handles.push(handle);
    const res = await fetch(`${handle.url}/api/mcp`);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("POST");
  });

  it("writes a discovery file that disappears on shutdown", async () => {
    const { env, vault } = scratch();
    const handle = await startServer({ vault, version: "test", env });
    const file = daemonFile(vault, env);
    expect(existsSync(file)).toBe(true);
    expect(readDaemon(vault, env)?.port).toBe(handle.port);

    await handle.close();
    expect(existsSync(file)).toBe(false);
  });

  it("a second acquireLock fails while the daemon holds it", async () => {
    const { env, vault } = scratch();
    const handle = await startServer({ vault, version: "test", env });
    handles.push(handle);
    expect(acquireLock(vault, env)).toBeNull();
  });

  it("idle-exits after SHEAF_IDLE_MS with no clients", async () => {
    const { env, vault } = scratch();
    const handle = await startServer({
      vault,
      version: "test",
      env,
      idleMs: 150,
    });
    const file = daemonFile(vault, env);
    expect(existsSync(file)).toBe(true);

    // Wait for the idle timer to fire and tear the daemon down.
    const timedOut = Symbol("timeout");
    const raced = await Promise.race([
      handle.closed.then(() => "closed"),
      new Promise((r) => setTimeout(() => r(timedOut), 3000)),
    ]);
    expect(raced).toBe("closed");
    expect(existsSync(file)).toBe(false);
  });
});

describe("serve contention + status (in-process)", () => {
  it("serveCommand on a busy vault reports already-running and exits 0", async () => {
    const { env, vault } = scratch();
    const handle = await startServer({ vault, version: "test", env });
    handles.push(handle);

    const { ctx, stdout } = makeCtx(vault, env, "json");
    const code = await serveCommand(ctx);
    expect(code).toBe(0); // loser exits cleanly, does not block
    const reported = JSON.parse(stdout()) as { status: string; port: number };
    expect(reported.status).toBe("already-running");
    expect(reported.port).toBe(handle.port);
  });

  it("daemon status reports a running daemon", async () => {
    const { env, vault } = scratch();
    const handle = await startServer({ vault, version: "test", env });
    handles.push(handle);

    const { ctx, stdout } = makeCtx(vault, env, "json");
    expect(await daemonStatusCommand(ctx)).toBe(0);
    const status = JSON.parse(stdout()) as { running: boolean; port: number };
    expect(status.running).toBe(true);
    expect(status.port).toBe(handle.port);
  });

  it("daemon status reports stopped when nothing runs", async () => {
    const { env, vault } = scratch();
    const { ctx, stdout } = makeCtx(vault, env, "json");
    expect(await daemonStatusCommand(ctx)).toBe(0);
    expect((JSON.parse(stdout()) as { running: boolean }).running).toBe(false);
  });

  it("has a `run` handler wired for serve and daemon subcommands", () => {
    expect(typeof REGISTRY.serve.run).toBe("function");
    expect(typeof REGISTRY.daemon.subcommands?.status.run).toBe("function");
    expect(typeof REGISTRY.daemon.subcommands?.stop.run).toBe("function");
  });
});

describe("lock protocol: reclaim, leak-safety, races", () => {
  /** Plant a stale lock (dead pid) and a matching dead discovery record. */
  function plantStale(env: NodeJS.ProcessEnv, vault: string): void {
    mkdirSync(daemonsDir(env), { recursive: true, mode: 0o700 });
    writeFileSync(lockFile(vault, env), "0\n"); // pid 0 → treated as dead
    writeFileSync(
      daemonFile(vault, env),
      JSON.stringify({
        pid: 0,
        host: "127.0.0.1",
        port: 1, // nothing listening → isDaemonAlive false
        vault,
        startedAt: 1,
        version: "stale",
      }),
    );
  }

  it("racing two startServers against a planted stale lock+record yields exactly one daemon", async () => {
    // Repeat: the race resolution is timing-sensitive, so exercise it a few
    // times. Every round must leave exactly one live backend + one record.
    for (let round = 0; round < 4; round++) {
      const { env, vault } = scratch();
      plantStale(env, vault);

      const results = await Promise.allSettled([
        startServer({ vault, version: "a", env }),
        startServer({ vault, version: "b", env }),
      ]);
      const winners = results.filter((r) => r.status === "fulfilled");
      const losers = results.filter((r) => r.status === "rejected");

      expect(winners.length).toBe(1);
      expect(losers.length).toBe(1);
      expect((losers[0] as PromiseRejectedResult).reason).toBeInstanceOf(Error);

      const winner = (winners[0] as PromiseFulfilledResult<ServeHandle>).value;
      handles.push(winner);

      // Exactly one backend, and the surviving record matches the winner.
      expect(await isDaemonAlive(vault, env)).toBe(true);
      expect(readDaemon(vault, env)?.port).toBe(winner.port);

      await winner.close();
    }
  }, 20_000);

  it("reclaims a record-less lock left by a dead process", async () => {
    const { env, vault } = scratch();
    mkdirSync(daemonsDir(env), { recursive: true, mode: 0o700 });
    const lp = lockFile(vault, env);
    writeFileSync(lp, "0\n"); // pid 0 → dead
    // Age it past the mid-boot grace window so it's judged a crash leftover.
    const old = new Date(Date.now() - 30_000);
    utimesSync(lp, old, old);

    const handle = await startServer({ vault, version: "test", env });
    handles.push(handle);
    expect(handle.port).toBeGreaterThan(0);
    expect(await isDaemonAlive(vault, env)).toBe(true);
  });

  it("does NOT reclaim a fresh record-less lock (a daemon mid-boot)", async () => {
    const { env, vault } = scratch();
    mkdirSync(daemonsDir(env), { recursive: true, mode: 0o700 });
    // A fresh lock owned by *this* (alive) process: not reclaimable.
    writeFileSync(lockFile(vault, env), `${process.pid}\n`);

    await expect(
      startServer({ vault, version: "test", env }),
    ).rejects.toMatchObject({ name: "DaemonAlreadyRunningError" });
  });

  it("releases the lock (and writes no record) when boot throws after acquiring", async () => {
    const { env, vault } = scratch();
    // logFile's parent is a *file* (note.md), so mkdirSync throws ENOTDIR after
    // the lock is acquired but before the daemon registers.
    const badLog = join(vault, "note.md", "nested", "d.log");

    await expect(
      startServer({ vault, version: "test", env, logFile: badLog }),
    ).rejects.toThrow();

    // No leaked lock or record → the vault is not wedged.
    expect(existsSync(lockFile(vault, env))).toBe(false);
    expect(existsSync(daemonFile(vault, env))).toBe(false);
    const relock = acquireLock(vault, env);
    expect(relock).not.toBeNull();
    relock!.release();
  });
});

describe("idle-exit accounting", () => {
  it("health and UI-REST hits do NOT reset the idle clock", async () => {
    const { env, vault } = scratch();
    const handle = await startServer({
      vault,
      version: "test",
      env,
      idleMs: 300,
    });
    const file = daemonFile(vault, env);

    // Hammer non-MCP endpoints for less than the idle window. These must not
    // hold the daemon open, so it should still idle-exit ~300ms after boot.
    const stop = Date.now() + 220;
    while (Date.now() < stop) {
      await fetch(`${handle.url}/api/health`).catch(() => {});
      await fetch(`${handle.url}/api/ui/docs`).catch(() => {});
      await delay(20);
    }

    const raced = await Promise.race([
      handle.closed.then(() => "closed" as const),
      delay(3000).then(() => "timeout" as const),
    ]);
    expect(raced).toBe("closed");
    expect(existsSync(file)).toBe(false);
  }, 10_000);

  it("an open SSE stream holds the daemon past the idle window", async () => {
    const { env, vault } = scratch();
    const handle = await startServer({
      vault,
      version: "test",
      env,
      idleMs: 150,
    });
    const file = daemonFile(vault, env);

    const ctrl = new AbortController();
    const res = await fetch(`${handle.url}/api/ui/drafts/stream?role=agent`, {
      headers: { accept: "text/event-stream" },
      signal: ctrl.signal,
    });
    const reader = res.body!.getReader();
    await reader.read(); // primed frame — connection fully established

    // Well past idleMs, but the open stream keeps it alive.
    await delay(500);
    expect(existsSync(file)).toBe(true);

    // Close the stream; now it should idle-exit.
    await reader.cancel();
    ctrl.abort();
    const raced = await Promise.race([
      handle.closed.then(() => "closed" as const),
      delay(3000).then(() => "timeout" as const),
    ]);
    expect(raced).toBe("closed");
    expect(existsSync(file)).toBe(false);
  }, 10_000);
});

describe("in-process signal handling", () => {
  it("SIGTERM cleans up the lock and record, then removes its handler", async () => {
    const { env, vault } = scratch();
    const baseline = process.listenerCount("SIGTERM");

    const handle = await startServer({
      vault,
      version: "test",
      env,
      installSignalHandlers: true,
    });
    expect(existsSync(daemonFile(vault, env))).toBe(true);
    expect(existsSync(lockFile(vault, env))).toBe(true);
    expect(process.listenerCount("SIGTERM")).toBe(baseline + 1);

    // `process.emit` invokes the registered listeners without the OS default
    // termination — the safe way to exercise the handler in-process.
    process.emit("SIGTERM");

    await Promise.race([
      handle.closed,
      delay(3000).then(() => {
        throw new Error("SIGTERM did not shut the daemon down");
      }),
    ]);
    expect(existsSync(daemonFile(vault, env))).toBe(false);
    expect(existsSync(lockFile(vault, env))).toBe(false);
    // The handler must have been removed so it can't leak across tests.
    expect(process.listenerCount("SIGTERM")).toBe(baseline);
  });
});

/**
 * The full daemon lifecycle through the built binary: `serve` in one process,
 * `daemon status`/`stop` in others. `stop` SIGTERMs the daemon's pid, so it
 * must run against a *separate* process — an in-process stop would signal the
 * test runner itself.
 */
describe("daemon status/stop via the built binary (spawned)", () => {
  beforeAll(() => {
    if (!existsSync(bin)) {
      execFileSync(process.execPath, [join(pkgRoot, "build.mjs")], {
        cwd: pkgRoot,
        stdio: "pipe",
        timeout: 60_000,
      });
    }
  }, 60_000);

  it("serves, reports running, then stops and removes the discovery file", async () => {
    const { env, vault } = scratch();
    const childEnv = { ...process.env, ...env };

    const child = spawn(
      process.execPath,
      [bin, "serve", "--vault", vault, "--format", "json"],
      { env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
    );
    const exited = new Promise<number | null>((r) =>
      child.on("exit", (code) => r(code)),
    );

    try {
      // Read the announced {host,port,vault,pid} line from the daemon's stdout.
      const info = await new Promise<{ port: number; pid: number }>(
        (resolve, reject) => {
          let buf = "";
          const to = setTimeout(
            () => reject(new Error("daemon did not announce in time")),
            10_000,
          );
          child.stdout.on("data", (d: Buffer) => {
            buf += d.toString();
            const line = buf.split("\n").find((l) => l.trim().startsWith("{"));
            if (line) {
              clearTimeout(to);
              resolve(JSON.parse(line));
            }
          });
          child.on("exit", () => {
            clearTimeout(to);
            reject(new Error("daemon exited before announcing"));
          });
        },
      );
      expect(info.port).toBeGreaterThan(0);
      expect(existsSync(daemonFile(vault, env))).toBe(true);

      const status = execFileSync(
        process.execPath,
        [bin, "daemon", "status", "--vault", vault, "--format", "json"],
        { env: childEnv, encoding: "utf8", timeout: 15_000 },
      );
      expect((JSON.parse(status) as { running: boolean }).running).toBe(true);

      const stop = execFileSync(
        process.execPath,
        [bin, "daemon", "stop", "--vault", vault, "--format", "json"],
        { env: childEnv, encoding: "utf8", timeout: 15_000 },
      );
      expect((JSON.parse(stop) as { stopped: boolean }).stopped).toBe(true);

      expect(await exited).toBe(0);
      expect(existsSync(daemonFile(vault, env))).toBe(false);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }, 30_000);
});

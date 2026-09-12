import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { acquireLock, daemonFile, readDaemon } from "sheaf-server/daemon";

import { REGISTRY, type RunContext } from "./commands";
import { daemonStatusCommand } from "./daemon-cmd";
import { Output, type Io } from "./io";
import { serveCommand, startServer, type ServeHandle } from "./serve";

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

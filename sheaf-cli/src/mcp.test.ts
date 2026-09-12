import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  daemonFile,
  isPidAlive,
  readDaemon,
  registerDaemon,
} from "sheaf-server/daemon";

import { daemonsDir } from "./config";
import { startServer, type ServeHandle } from "./serve";

/**
 * Exercise the `sheaf mcp` bridge end to end by driving the *built* binary as a
 * subprocess — the exact path a real agent host takes. Two daemon shapes back
 * it: a real in-process `startServer`/auto-spawned daemon, or a {@link FakeDaemon}
 * (a bare HTTP server registered for discovery) so we can force HTTP errors,
 * hangs, and socket resets that a real daemon won't produce on demand.
 *
 * Hermetic: a throwaway `$SHEAF_HOME` + vault per test; every daemon (in-process
 * handle, fake, or auto-spawned pid) is torn down in `afterEach` regardless of
 * whether assertions passed.
 */

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(pkgRoot, "bin", "sheaf.js");

const trash: string[] = [];
const handles: ServeHandle[] = [];
const fakes: FakeDaemon[] = [];
const scratches: { env: NodeJS.ProcessEnv; vault: string }[] = [];

function scratch(): { env: NodeJS.ProcessEnv; home: string; vault: string } {
  const home = mkdtempSync(join(tmpdir(), "sheaf-home-"));
  const vault = realpathSync(mkdtempSync(join(tmpdir(), "sheaf-vault-")));
  writeFileSync(join(vault, "note.md"), "# Note\n\nhello world");
  const env = { SHEAF_HOME: home };
  trash.push(home, vault);
  scratches.push({ env, vault });
  return { env, home, vault };
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Env for a spawned bridge: the real env (so `node`/PATH resolve) plus an
 * isolated `$SHEAF_HOME` and the target vault. Filtered to defined strings —
 * `StdioClientTransport` / `spawn` env types don't accept `undefined`.
 */
function childEnv(
  home: string,
  vault: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  env.SHEAF_HOME = home;
  env.SHEAF_VAULT = vault;
  return { ...env, ...extra };
}

/** Connect an SDK `Client` to `sheaf mcp` (built bin) over stdio. */
async function connectBridge(
  home: string,
  vault: string,
  extraArgs: string[] = [],
): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, "mcp", ...extraArgs],
    env: childEnv(home, vault),
    stderr: "ignore",
  });
  const client = new Client({ name: "mcp-bridge-test", version: "0.0.0" });
  await client.connect(transport);
  return { client, transport };
}

/** A newline-delimited JSON-RPC driver over a raw `sheaf mcp` subprocess. */
interface RawBridge {
  child: ChildProcess;
  send(obj: unknown): void;
  next(): Promise<Record<string, unknown>>;
  endStdin(): void;
  waitExit(): Promise<number | null>;
}

function spawnBridgeRaw(args: string[], env: Record<string, string>): RawBridge {
  const child = spawn(process.execPath, [bin, ...args], {
    env,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const queue: Record<string, unknown>[] = [];
  const waiters: ((m: Record<string, unknown>) => void)[] = [];
  let buf = "";
  child.stdout!.on("data", (d: Buffer) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim() === "") continue;
      const msg = JSON.parse(line) as Record<string, unknown>;
      const w = waiters.shift();
      if (w) w(msg);
      else queue.push(msg);
    }
  });
  return {
    child,
    send: (obj) => child.stdin!.write(`${JSON.stringify(obj)}\n`),
    next: () =>
      new Promise((res) => {
        const m = queue.shift();
        if (m) res(m);
        else waiters.push(res);
      }),
    endStdin: () => child.stdin!.end(),
    waitExit: () =>
      new Promise((res) => child.on("exit", (code) => res(code))),
  };
}

/**
 * A minimal fake daemon: serves a matching `/api/health` and a scriptable
 * `/api/mcp`, and registers a discovery record (with THIS process's pid, so
 * `findDaemon`'s pid+vault check passes). `behavior` decides, per JSON-RPC
 * method and call count, whether to respond with a canned result, hang (never
 * reply), or destroy the socket (a connection-class failure with no HTTP status).
 */
interface FakeDaemon {
  port: number;
  docHeaders: (string | string[] | undefined)[];
  dispose(): Promise<void>;
}

function cannedResult(method: string): unknown {
  if (method === "initialize") {
    return {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "sheaf", version: "fake" },
    };
  }
  if (method === "tools/list") {
    return { tools: [{ name: "ReadMe", inputSchema: { type: "object" } }] };
  }
  return {};
}

async function startFakeDaemon(
  vault: string,
  env: NodeJS.ProcessEnv,
  behavior: (method: string, count: number) => "respond" | "hang" | "destroy" = () =>
    "respond",
): Promise<FakeDaemon> {
  const docHeaders: (string | string[] | undefined)[] = [];
  const counts = new Map<string, number>();
  const server: Server = createServer((req, res) => {
    if (req.url === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          vault: realpathSync(vault),
          pid: process.pid,
          startedAt: Date.now(),
          version: "fake",
        }),
      );
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/api/mcp")) {
      res.writeHead(405, { allow: "POST, DELETE" }).end();
      return;
    }
    if (req.method === "POST" && req.url === "/api/mcp") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        docHeaders.push(req.headers["x-sheaf-doc"]);
        const msg = JSON.parse(body || "{}") as {
          id?: unknown;
          method?: string;
        };
        const method = msg.method ?? "";
        const n = (counts.get(method) ?? 0) + 1;
        counts.set(method, n);
        // Notifications (no id) always get a bare 202.
        if (msg.id === undefined || msg.id === null) {
          res.writeHead(202).end();
          return;
        }
        const decision = behavior(method, n);
        if (decision === "hang") return; // hold the request open, never reply
        if (decision === "destroy") {
          req.socket.destroy();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: cannedResult(method),
          }),
        );
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  registerDaemon({ vault, host: "127.0.0.1", port, version: "fake" }, env);
  const fake: FakeDaemon = {
    port,
    docHeaders,
    dispose: async () => {
      try {
        server.closeAllConnections?.();
      } catch {
        /* older node */
      }
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  fakes.push(fake);
  return fake;
}

/** Kill any real (non-self) daemon that registered under a scratch's home. */
function killSpawnedDaemons(env: NodeJS.ProcessEnv): void {
  let dir: string;
  try {
    dir = daemonsDir(env);
  } catch {
    return;
  }
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(readFileSync(join(dir, f), "utf8")) as {
        pid?: number;
      };
      if (
        typeof rec.pid === "number" &&
        rec.pid !== process.pid &&
        isPidAlive(rec.pid)
      ) {
        process.kill(rec.pid, "SIGTERM");
      }
    } catch {
      /* ignore torn/partial records */
    }
  }
}

beforeAll(() => {
  if (!existsSync(bin)) {
    execFileSync(process.execPath, [join(pkgRoot, "build.mjs")], {
      cwd: pkgRoot,
      stdio: "pipe",
      timeout: 60_000,
    });
  }
  expect(existsSync(bin)).toBe(true);
}, 60_000);

afterEach(async () => {
  for (const h of handles.splice(0)) await h.close().catch(() => {});
  for (const f of fakes.splice(0)) await f.dispose().catch(() => {});
  for (const { env } of scratches.splice(0)) killSpawnedDaemons(env);
  for (const d of trash.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("sheaf mcp bridge → live daemon", () => {
  it("round-trips initialize, tools/list, and a ReadMe tool call", async () => {
    const { env, home, vault } = scratch();
    const handle = await startServer({ vault, version: "test", env });
    handles.push(handle);

    const { client, transport } = await connectBridge(home, vault);
    try {
      expect(client.getServerVersion()?.name).toBe("sheaf");

      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(
        expect.arrayContaining(["ReadMe", "Read", "ListThreads"]),
      );

      const res = (await client.callTool({
        name: "ReadMe",
        arguments: {},
      })) as { content: { type: string; text: string }[] };
      const text = res.content.map((c) => c.text).join("\n");
      expect(text).toContain("Sheaf MCP");
      // Daemon-mode ReadMe leads with the CLI tail.
      expect(text).toContain("sheaf events follow --role agent");
    } finally {
      await client.close();
      await transport.close();
    }
  }, 30_000);

  it("reconnects and replays the request when the daemon dies (P1)", async () => {
    const { env, home, vault } = scratch();
    const handle = await startServer({ vault, version: "test", env });

    const { client, transport } = await connectBridge(home, vault);
    try {
      await client.listTools(); // session live against the first daemon

      // Kill the daemon out from under the bridge (its discovery record is
      // removed on clean shutdown).
      await handle.close();
      expect(existsSync(daemonFile(vault, env))).toBe(false);

      // The next call trips a connection-class failure → the bridge auto-spawns
      // a fresh daemon and replays the request, so it SUCCEEDS (no -32603, no
      // hang). This is the P1 fix: no handshake state to lose in a stateless
      // per-POST daemon.
      const res = (await client.callTool(
        { name: "ReadMe", arguments: {} },
        undefined,
        { timeout: 20_000 },
      )) as { content: { type: string; text: string }[] };
      expect(res.content.map((c) => c.text).join("\n")).toContain("Sheaf MCP");

      // A new daemon was spawned and registered.
      const info = readDaemon(vault, env);
      expect(info).not.toBeNull();
      expect(info!.pid).not.toBe(handle.pid);
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  }, 40_000);
});

describe("sheaf mcp bridge → HTTP error handling (P2.1)", () => {
  it("surfaces a daemon HTTP error as a per-request JSON-RPC error and stays up", async () => {
    const { env, home, vault } = scratch();
    // Fake daemon: initialize OK, but tools/list → HTTP 400 (a daemon-alive
    // error, not a connection death). We drive raw so we can see the response.
    const server: Server = createServer((req, res) => {
      if (req.url === "/api/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ vault: realpathSync(vault), pid: process.pid }),
        );
        return;
      }
      if (req.method === "POST" && req.url === "/api/mcp") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const msg = JSON.parse(body || "{}") as { id?: unknown; method?: string };
          if (msg.id === undefined || msg.id === null) {
            res.writeHead(202).end();
            return;
          }
          if (msg.method === "tools/list") {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "bad doc", code: "invalid_path" }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: cannedResult(msg.method ?? ""),
            }),
          );
        });
        return;
      }
      if (req.method === "GET") return void res.writeHead(405).end();
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    registerDaemon(
      {
        vault,
        host: "127.0.0.1",
        port: (server.address() as AddressInfo).port,
        version: "fake",
      },
      env,
    );
    const raw = spawnBridgeRaw(["mcp"], childEnv(home, vault));
    try {
      raw.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      });
      const init = await raw.next();
      expect((init.result as { serverInfo?: { name?: string } }).serverInfo?.name).toBe("sheaf");

      // The 400 must come back as a JSON-RPC error for THIS id, not a death.
      raw.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const err = (await raw.next()) as {
        id: number;
        error?: { code: number; data?: { httpStatus?: number } };
      };
      expect(err.id).toBe(2);
      expect(err.error?.code).toBe(-32603);
      expect(err.error?.data?.httpStatus).toBe(400);

      // The bridge stayed up: another request still round-trips.
      raw.send({
        jsonrpc: "2.0",
        id: 3,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      });
      const again = (await raw.next()) as { id: number; result?: unknown };
      expect(again.id).toBe(3);
      expect(again.result).toBeDefined();
    } finally {
      raw.endStdin();
      await raw.waitExit();
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30_000);
});

describe("sheaf mcp bridge → daemon death with no recovery (-32603)", () => {
  it("synthesizes -32603 for a string request id when reconnect can't help", async () => {
    const { env, home, vault } = scratch();
    // Fake: initialize OK, then destroy the socket on every tools/list — even
    // after reconnect (health stays up, so findDaemon returns the fake again),
    // so the replayed request fails a second time and the bridge gives up.
    await startFakeDaemon(vault, env, (method) =>
      method === "tools/list" ? "destroy" : "respond",
    );
    const raw = spawnBridgeRaw(["mcp"], childEnv(home, vault));
    try {
      raw.send({
        jsonrpc: "2.0",
        id: "init-1",
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      });
      const init = (await raw.next()) as { id: string };
      expect(init.id).toBe("init-1");

      raw.send({ jsonrpc: "2.0", id: "req-abc", method: "tools/list", params: {} });
      const err = (await raw.next()) as { id: unknown; error?: { code: number } };
      expect(err.id).toBe("req-abc"); // string id preserved
      expect(err.error?.code).toBe(-32603);

      expect(await raw.waitExit()).not.toBe(0); // exits non-zero after fail-all
    } finally {
      raw.endStdin();
      if (raw.child.exitCode === null) raw.child.kill("SIGKILL");
    }
  }, 30_000);
});

describe("sheaf mcp bridge → auto-spawn", () => {
  it("spawns a daemon when none exists and round-trips cleanly", async () => {
    const { env, home, vault } = scratch();
    expect(existsSync(daemonFile(vault, env))).toBe(false);

    const { client, transport } = await connectBridge(home, vault);
    try {
      // A working round-trip through the SDK client is proof the bridge kept
      // stdout a clean JSON-RPC wire — a daemon log leaking there would break
      // the client's parser.
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(
        expect.arrayContaining(["ReadMe", "Read", "ListThreads"]),
      );
      const res = (await client.callTool({
        name: "ReadMe",
        arguments: {},
      })) as { content: { type: string; text: string }[] };
      expect(res.content.map((c) => c.text).join("\n")).toContain("Sheaf MCP");

      const info = readDaemon(vault, env);
      expect(info).not.toBeNull();
      expect(isPidAlive(info!.pid)).toBe(true);
    } finally {
      await client.close();
      await transport.close();
    }
  }, 30_000);
});

describe("sheaf mcp --no-daemon (standalone)", () => {
  it("serves an in-process backend with no daemon or discovery file", async () => {
    const { env, home, vault } = scratch();

    const { client, transport } = await connectBridge(home, vault, ["--no-daemon"]);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("ReadMe");

      const res = (await client.callTool({
        name: "ReadMe",
        arguments: {},
      })) as { content: { type: string; text: string }[] };
      const text = res.content.map((c) => c.text).join("\n");
      expect(text).toContain("Sheaf MCP");
      // P2.3: standalone ReadMe must NOT instruct the agent to run the
      // daemon-only event stream (it may mention it to say "don't").
      expect(text).not.toContain("command: 'sheaf events follow --role agent'");
      expect(text).not.toContain("/api/ui/drafts/stream");
      expect(text).toContain("no live events");

      // Standalone never touches discovery.
      expect(existsSync(daemonFile(vault, env))).toBe(false);
    } finally {
      await client.close();
      await transport.close();
    }
  }, 30_000);

  it("exits 0 promptly when stdin closes (piped host, not an SDK SIGTERM)", async () => {
    const { home, vault } = scratch();
    const raw = spawnBridgeRaw(["mcp", "--no-daemon"], childEnv(home, vault));
    raw.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    const init = (await raw.next()) as { id: number };
    expect(init.id).toBe(1);

    raw.endStdin();
    const exit = await Promise.race([
      raw.waitExit(),
      delay(5_000).then(() => "timeout" as const),
    ]);
    if (exit === "timeout") raw.child.kill("SIGKILL");
    expect(exit).toBe(0);
  }, 15_000);
});

describe("sheaf mcp bridge → --doc scoping (P2.2)", () => {
  it("sends the normalized --doc on the x-sheaf-doc header", async () => {
    const { env, home, vault } = scratch();
    const fake = await startFakeDaemon(vault, env);

    // Pass an ABSOLUTE in-vault path; the bridge must normalize it to a
    // vault-relative POSIX path before putting it on the wire.
    const { client, transport } = await connectBridge(home, vault, [
      "--doc",
      join(vault, "note.md"),
    ]);
    try {
      await client.listTools();
      expect(fake.docHeaders.length).toBeGreaterThan(0);
      for (const h of fake.docHeaders) expect(h).toBe("note.md");
    } finally {
      await client.close();
      await transport.close();
    }
  }, 30_000);

  it("rejects an out-of-vault --doc with exit 2 and nothing on stdout", async () => {
    const { home, vault } = scratch();
    let status: number | null = null;
    let stdout = "";
    let stderr = "";
    try {
      stdout = execFileSync(
        process.execPath,
        [bin, "mcp", "--vault", vault, "--doc", "/etc/passwd", "--format", "json"],
        { env: childEnv(home, vault), encoding: "utf8", stdio: "pipe" },
      );
    } catch (e) {
      const err = e as { status: number; stdout: string; stderr: string };
      status = err.status;
      stdout = err.stdout;
      stderr = err.stderr;
    }
    expect(status).toBe(2);
    expect(stdout).toBe(""); // no JSON error object on the MCP wire
    expect(stderr).toContain("--doc must name a document inside the vault");
  }, 15_000);
});

describe("sheaf mcp bridge → drain cap on stdin end", () => {
  it("exits 0 within the drain cap when an in-flight request never completes", async () => {
    const { env, home, vault } = scratch();
    // Fake hangs on tools/list (holds the request open, never replies).
    await startFakeDaemon(vault, env, (method) =>
      method === "tools/list" ? "hang" : "respond",
    );
    // Short drain cap so this is fast.
    const raw = spawnBridgeRaw(
      ["mcp"],
      childEnv(home, vault, { SHEAF_MCP_DRAIN_MS: "400" }),
    );
    try {
      raw.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      });
      await raw.next(); // initialize answered
      raw.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      await delay(150); // let the hanging request go in flight
      raw.endStdin();

      const exit = await Promise.race([
        raw.waitExit(),
        delay(5_000).then(() => "timeout" as const),
      ]);
      if (exit === "timeout") raw.child.kill("SIGKILL");
      expect(exit).toBe(0);
    } finally {
      if (raw.child.exitCode === null) raw.child.kill("SIGKILL");
    }
  }, 15_000);
});

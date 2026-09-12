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

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { daemonFile, isPidAlive, readDaemon } from "sheaf-server/daemon";

import { startServer, type ServeHandle } from "./serve";

/**
 * Exercise the `sheaf mcp` bridge end to end by driving the *built* binary as a
 * subprocess through the SDK's own `StdioClientTransport` + `Client` — the exact
 * path a real agent host takes. The daemon side is either an in-process
 * `startServer` (round-trip / death tests) or auto-spawned by the bridge itself.
 *
 * Hermetic: a throwaway `$SHEAF_HOME` + vault per test, every daemon (in-process
 * handle, or auto-spawned pid) torn down in `afterEach`.
 */

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(pkgRoot, "bin", "sheaf.js");

const trash: string[] = [];
const handles: ServeHandle[] = [];
/** Pids of daemons the bridge auto-spawned, killed in cleanup. */
const spawnedPids = new Set<number>();

function scratch(): { env: NodeJS.ProcessEnv; home: string; vault: string } {
  const home = mkdtempSync(join(tmpdir(), "sheaf-home-"));
  const vault = realpathSync(mkdtempSync(join(tmpdir(), "sheaf-vault-")));
  writeFileSync(join(vault, "note.md"), "# Note\n\nhello world");
  trash.push(home, vault);
  return { env: { SHEAF_HOME: home }, home, vault };
}

/**
 * Env for a spawned bridge: the real env (so `node`/PATH resolve) plus an
 * isolated `$SHEAF_HOME` and the target vault. Filtered to defined strings —
 * `StdioClientTransport` types `env` as `Record<string, string>`.
 */
function childEnv(home: string, vault: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  env.SHEAF_HOME = home;
  env.SHEAF_VAULT = vault;
  return env;
}

/** Connect a `Client` to `sheaf mcp` (built bin) over stdio. */
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

beforeAll(() => {
  // The bridge/auto-spawn tests exec the real bundle; build it if a bare
  // `vitest run` skipped the `pnpm test` build step.
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
  for (const pid of spawnedPids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  spawnedPids.clear();
  for (const d of trash.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("sheaf mcp bridge → live daemon", () => {
  it("round-trips initialize, tools/list, and a ReadMe tool call", async () => {
    const { env, home, vault } = scratch();
    const handle = await startServer({ vault, version: "test", env });
    handles.push(handle);

    const { client, transport } = await connectBridge(home, vault);
    try {
      // initialize implicitly succeeded (connect resolved). The negotiated
      // server info flows back through the relay.
      expect(client.getServerVersion()?.name).toBe("sheaf");

      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toEqual(
        expect.arrayContaining(["ReadMe", "Read", "ListThreads"]),
      );

      const res = (await client.callTool({
        name: "ReadMe",
        arguments: {},
      })) as { content: { type: string; text: string }[] };
      const text = res.content.map((c) => c.text).join("\n");
      expect(text).toContain("Sheaf MCP");
      // Step-4 ReadMe leads with the CLI tail (see readme.ts / publicUrl).
      expect(text).toContain("sheaf events follow --role agent");
    } finally {
      await client.close();
      await transport.close();
    }
  }, 30_000);

  it("synthesizes a -32603 error (not a hang) when the daemon dies mid-session", async () => {
    const { env, home, vault } = scratch();
    const handle = await startServer({ vault, version: "test", env });

    const { client, transport } = await connectBridge(home, vault);
    try {
      // Prove the session is live first.
      await client.listTools();

      // Kill the daemon out from under the bridge.
      await handle.close();

      // A call now must reject with the synthesized internal error rather than
      // hang forever. The SDK request `timeout` bounds the wait, so a hang would
      // surface as a *different* (timeout) code and fail the assertion loudly.
      let code: unknown;
      try {
        await client.callTool(
          { name: "ReadMe", arguments: {} },
          undefined,
          { timeout: 8_000 },
        );
        throw new Error("expected the tool call to reject");
      } catch (e) {
        code = (e as { code?: unknown }).code;
      }
      expect(code).toBe(-32603);
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  }, 30_000);
});

describe("sheaf mcp bridge → auto-spawn", () => {
  it("spawns a daemon when none exists and round-trips cleanly", async () => {
    const { env, home, vault } = scratch();
    // Precondition: no daemon / discovery file for this vault.
    expect(existsSync(daemonFile(vault, env))).toBe(false);

    const { client, transport } = await connectBridge(home, vault);
    try {
      // A working round-trip through the SDK client is itself proof the bridge
      // kept stdout a clean JSON-RPC wire — any daemon log leaking to stdout
      // would break the client's message parsing.
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(
        expect.arrayContaining(["ReadMe", "Read", "ListThreads"]),
      );
      const res = (await client.callTool({
        name: "ReadMe",
        arguments: {},
      })) as { content: { type: string; text: string }[] };
      expect(res.content.map((c) => c.text).join("\n")).toContain("Sheaf MCP");

      // The bridge auto-spawned a daemon: a discovery record now exists.
      const info = readDaemon(vault, env);
      expect(info).not.toBeNull();
      expect(isPidAlive(info!.pid)).toBe(true);
      // Register it for teardown (it was spawned detached, so afterEach kills it).
      spawnedPids.add(info!.pid);
    } finally {
      await client.close();
      await transport.close();
    }
  }, 30_000);
});

describe("sheaf mcp --no-daemon (standalone)", () => {
  it("serves an in-process backend with no daemon or discovery file", async () => {
    const { env, home, vault } = scratch();

    const { client, transport } = await connectBridge(home, vault, [
      "--no-daemon",
    ]);
    try {
      // initialize + a real tool call both work against the in-process server.
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("ReadMe");
      const res = (await client.callTool({
        name: "ReadMe",
        arguments: {},
      })) as { content: { type: string; text: string }[] };
      expect(res.content.map((c) => c.text).join("\n")).toContain("Sheaf MCP");

      // Standalone never touches discovery: no daemon record was written.
      expect(existsSync(daemonFile(vault, env))).toBe(false);
    } finally {
      await client.close();
      await transport.close();
    }
  }, 30_000);
});

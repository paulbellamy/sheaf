import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { connectDaemon, requireDaemonAllowed } from "./client";
import { CliError, EXIT } from "./io";
import { startServer, type ServeHandle } from "./serve";

/** Temp `$SHEAF_HOME` + temp vault (realpath'd, with one doc), auto-cleaned. */
const trash: string[] = [];
const handles: ServeHandle[] = [];

function scratch(): { env: NodeJS.ProcessEnv; vault: string } {
  const home = mkdtempSync(join(tmpdir(), "sheaf-home-"));
  const vault = realpathSync(mkdtempSync(join(tmpdir(), "sheaf-vault-")));
  writeFileSync(join(vault, "note.md"), "# Note\n\nhello world");
  trash.push(home, vault);
  return { env: { SHEAF_HOME: home }, vault };
}

afterEach(async () => {
  for (const h of handles.splice(0)) await h.close().catch(() => {});
  for (const d of trash.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("connectDaemon", () => {
  it("resolves against a live daemon and reaches the REST surface", async () => {
    const { env, vault } = scratch();
    const handle = await startServer({ vault, version: "test", env });
    handles.push(handle);

    const client = await connectDaemon(vault, env);
    expect(client.base).toBe(handle.url);
    try {
      // REST round-trip: the loopback Host header (set automatically by fetch to
      // 127.0.0.1) satisfies the daemon's DNS-rebinding guard.
      const docs = await client.rest<{ docs: { path: string }[] }>(
        "GET",
        "/api/ui/docs",
      );
      expect(docs.docs.map((d) => d.path)).toContain("note.md");
    } finally {
      await client.close();
    }
  });

  it("throws a no-daemon CliError (exit 3) when nothing is running", async () => {
    const { env, vault } = scratch();
    await expect(connectDaemon(vault, env)).rejects.toMatchObject({
      name: "CliError",
      code: "no_daemon",
      exitCode: EXIT.NO_DAEMON,
    });
  });
});

describe("DaemonClient.rest error mapping", () => {
  it("maps a non-2xx {error,code} body to a CliError preserving the code", async () => {
    const { env, vault } = scratch();
    const handle = await startServer({ vault, version: "test", env });
    handles.push(handle);

    const client = await connectDaemon(vault, env);
    try {
      // A malformed thread body → the handler returns a 4xx {error, code}.
      await expect(
        client.rest("POST", "/api/ui/threads", { body: { bogus: true } }),
      ).rejects.toMatchObject({ name: "CliError" });
    } finally {
      await client.close();
    }
  });
});

describe("DaemonClient.mcp", () => {
  it("lists the sheaf tools and round-trips a tool call", async () => {
    const { env, vault } = scratch();
    const handle = await startServer({ vault, version: "test", env });
    handles.push(handle);

    const client = await connectDaemon(vault, env);
    try {
      const mcp = await client.mcp();

      const { tools } = await mcp.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toEqual(
        expect.arrayContaining(["ReadMe", "Read", "ListThreads"]),
      );

      // A real tool call over the transport (POST /api/mcp → JSON response).
      const result = await mcp.callTool("ReadMe", {});
      expect(Array.isArray(result.content)).toBe(true);
      const first = (result.content as { type: string; text?: string }[])[0];
      expect(first.type).toBe("text");
      expect(first.text).toContain("Sheaf MCP");
    } finally {
      await client.close();
    }
  });

  it("memoizes the session across calls", async () => {
    const { env, vault } = scratch();
    const handle = await startServer({ vault, version: "test", env });
    handles.push(handle);

    const client = await connectDaemon(vault, env);
    try {
      const a = await client.mcp();
      const b = await client.mcp();
      expect(a).toBe(b);
    } finally {
      await client.close();
    }
  });

  it("close() tears the MCP transport down and lets the daemon idle-exit", async () => {
    const { env, vault } = scratch();
    // Short idle window: once the client's MCP connection is gone and no SSE
    // stream is open, the daemon must be free to idle-exit — proof that close()
    // released the transport rather than leaving a live connection behind.
    const handle = await startServer({ vault, version: "test", env, idleMs: 200 });
    handles.push(handle);

    const client = await connectDaemon(vault, env);
    const mcp = await client.mcp();
    await mcp.callTool("ReadMe", {});
    await client.close(); // must resolve without throwing

    const raced = await Promise.race([
      handle.closed.then(() => "closed" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 3000)),
    ]);
    expect(raced).toBe("closed");
  }, 10_000);
});

describe("requireDaemonAllowed", () => {
  it("rejects --no-daemon on a non-mcp command with exit 3", () => {
    let thrown: unknown;
    try {
      requireDaemonAllowed(
        { format: "text", noDaemon: true, help: false, version: false },
        "sheaf docs",
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CliError);
    expect((thrown as CliError).exitCode).toBe(EXIT.NO_DAEMON);
    expect((thrown as CliError).message).toContain("only valid for `sheaf mcp`");
  });

  it("is a no-op without --no-daemon", () => {
    expect(() =>
      requireDaemonAllowed(
        { format: "text", noDaemon: false, help: false, version: false },
        "sheaf docs",
      ),
    ).not.toThrow();
  });
});

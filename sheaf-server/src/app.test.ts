import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StubBackend } from "./backend/stub";
import { buildSheafApp } from "./app";

/**
 * End-to-end smoke tests against a *real* listening socket — the path the
 * Obsidian plugin takes (`app.listen()`), which `inject()`-based tests don't
 * cover: the MCP node transport wired to `reply.raw`, and live SSE streaming.
 */
describe("buildSheafApp over a real socket", () => {
  let root: string;
  let app: ReturnType<typeof buildSheafApp>;
  let base: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-app-"));
    await fs.mkdir(path.join(root, "workspaces", "ws", "docs"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, "workspaces", "ws", "docs", "a.md"),
      "hello world",
    );
    app = buildSheafApp(new StubBackend(root));
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("serves the UI REST API", async () => {
    const res = await fetch(`${base}/api/ui/docs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { docs: { path: string }[] };
    expect(body.docs.map((d) => d.path)).toContain("workspaces/ws/docs/a.md");
  });

  it("speaks the MCP Streamable HTTP transport (initialize handshake)", async () => {
    const res = await fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "0.0.0" },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { serverInfo?: { name?: string } };
    };
    expect(body.result?.serverInfo?.name).toBe("sheaf");
  });

  it("streams SSE events with a primed connection frame", async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/ui/drafts/stream?role=ui`, {
      headers: { accept: "text/event-stream" },
      signal: ctrl.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    // The stream primes with `: connected` and replays current agent presence.
    expect(text).toContain(":");
    await reader.cancel();
    ctrl.abort();
  });
});

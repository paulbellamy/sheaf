import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

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
    // The close()-with-live-SSE test closes the app itself; a second close
    // rejects, so tolerate it here.
    await app.close().catch(() => {});
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

  it("ReadMe serves an immediate (non-debounced) event-watch command", async () => {
    // Regression: the Monitor one-liner must stream each SSE event as it
    // arrives. A `read -t N` quiet-window debounce (once shipped here) held a
    // posted comment's `thread_changed` until the stream idled — and because
    // the quiet timer reset on every event, a user who kept working starved
    // delivery indefinitely, so the connected agent never woke. Guard against
    // a reprise of that debounce in the served guide.
    const transport = new StreamableHTTPClientTransport(
      new URL(`${base}/api/mcp`),
    );
    const client = new Client({ name: "readme-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      const res = (await client.callTool({
        name: "ReadMe",
        arguments: {},
      })) as { content: { type: string; text: string }[] };
      const text = res.content.map((c) => c.text).join("\n");
      // Streams each `data:` line the instant it arrives, then reconnects.
      expect(text).toContain('sed -n -u "s/^data: //p"; sleep 1; done');
      // Must not reintroduce the starving quiet-window buffer.
      expect(text).not.toContain("read -r -t");
      expect(text).not.toContain("buf+=");
    } finally {
      await client.close();
    }
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

  it("resumes a reconnect from Last-Event-ID without a gap", async () => {
    // First connection: catch the id of a thread_changed frame.
    const res1 = await fetch(`${base}/api/ui/drafts/stream?role=agent`, {
      headers: { accept: "text/event-stream" },
    });
    const reader1 = res1.body!.getReader();
    const decoder = new TextDecoder();
    let buf1 = "";
    const post = (msg: string) =>
      fetch(`${base}/api/ui/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "workspaces/ws/docs/a.md",
          targets: [{ scope: "doc" }],
          message: msg,
        }),
      });
    await post("first");
    let lastId: string | undefined;
    while (!lastId) {
      const { value, done } = await reader1.read();
      if (done) break;
      buf1 += decoder.decode(value, { stream: true });
      const m = [...buf1.matchAll(/^id: (\S+)$/gm)];
      lastId = m.at(-1)?.[1];
    }
    expect(lastId).toBeDefined();
    await reader1.cancel();

    // Missed while disconnected.
    await post("second — missed");

    // Reconnect with Last-Event-ID: the missed event is replayed, no reset.
    const res2 = await fetch(`${base}/api/ui/drafts/stream?role=agent`, {
      headers: {
        accept: "text/event-stream",
        "last-event-id": lastId!,
      },
    });
    const reader2 = res2.body!.getReader();
    let buf2 = "";
    while (!buf2.includes("thread_changed")) {
      const { value, done } = await reader2.read();
      if (done) break;
      buf2 += decoder.decode(value, { stream: true });
    }
    expect(buf2).toContain("thread_changed");
    expect(buf2).not.toContain("stream_reset");
    await reader2.cancel();
  });

  it("sends stream_reset when the resume position can't be honored", async () => {
    // An id minted by "another instance" (unknown epoch) → explicit reset,
    // so a restart gap is never silent.
    const res = await fetch(`${base}/api/ui/drafts/stream?role=agent`, {
      headers: {
        accept: "text/event-stream",
        "last-event-id": "deadbeef.42",
      },
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (!buf.includes("stream_reset")) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }
    expect(buf).toContain('{"kind":"stream_reset"}');
    await reader.cancel();
  });

  it("close() ends live SSE streams instead of hanging on them", async () => {
    // Regression: hijacked SSE replies are invisible to Fastify's shutdown,
    // so `close()` used to wait forever on a connected stream. The Obsidian
    // host's stop→start restart then left the old app alive with the agent's
    // Monitor still subscribed to the *old* backend — kept open by the
    // keep-alive ping, never reconnecting, silently missing every event
    // emitted on the restarted instance (user replies included).
    const res = await fetch(`${base}/api/ui/drafts/stream?role=agent`, {
      headers: { accept: "text/event-stream" },
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read(); // primed frame — connection fully established

    const closed = app.close().then(() => "closed" as const);
    const hung = new Promise<"hung">((r) => setTimeout(() => r("hung"), 3000));
    expect(await Promise.race([closed, hung])).toBe("closed");

    // The client must observe EOF so its reconnect loop re-attaches to the
    // restarted server rather than waiting on a zombie connection.
    const eof = (async () => {
      while (true) {
        const { done } = await reader.read();
        if (done) return true;
      }
    })();
    expect(
      await Promise.race([
        eof,
        new Promise<false>((r) => setTimeout(() => r(false), 3000)),
      ]),
    ).toBe(true);
  });
});

describe("buildSheafApp request hardening", () => {
  let root: string;
  let app: ReturnType<typeof buildSheafApp>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-cors-"));
    app = buildSheafApp(new StubBackend(root));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("rejects a non-loopback Host (DNS-rebinding guard)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/ui/docs",
      headers: { host: "evil.example:31415" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("allows a loopback Host", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/ui/docs",
      headers: { host: "127.0.0.1:31415" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("reflects an allowed Origin but omits CORS for others", async () => {
    const ok = await app.inject({
      method: "GET",
      url: "/api/ui/docs",
      headers: { host: "localhost:31415", origin: "app://obsidian.md" },
    });
    expect(ok.headers["access-control-allow-origin"]).toBe("app://obsidian.md");

    const evil = await app.inject({
      method: "GET",
      url: "/api/ui/docs",
      headers: { host: "localhost:31415", origin: "https://evil.example" },
    });
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

/**
 * End-to-end doc-scoping over the real MCP HTTP transport (the agent's actual
 * path): the per-connection scope arrives as `?doc=` or the `X-Sheaf-Doc`
 * header and clamps the thread queue. See docs/sheaf-acp-v0.1.md §3.1.
 */
describe("MCP doc-scoping over HTTP", () => {
  const A = "workspaces/ws/docs/a.md";
  const B = "workspaces/ws/docs/b.md";
  let root: string;
  let app: ReturnType<typeof buildSheafApp>;
  let base: string;
  let idA: string;
  let idB: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-mcpscope-"));
    await fs.mkdir(path.join(root, "workspaces", "ws", "docs"), {
      recursive: true,
    });
    await fs.writeFile(path.join(root, A), "alpha document body");
    await fs.writeFile(path.join(root, B), "beta document body");
    const backend = new StubBackend(root);
    idA = await backend.addThread({
      targets: [{ path: A, char_range: { from: 0, to: 5 } }],
      message: "on a",
      origin: "agent",
    });
    idB = await backend.addThread({
      targets: [{ path: B, char_range: { from: 0, to: 5 } }],
      message: "on b",
      origin: "agent",
    });
    app = buildSheafApp(backend);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function listThreadIds(scope?: {
    query?: string;
    header?: string;
  }): Promise<string[]> {
    const url = new URL(`${base}/api/mcp`);
    // `!== undefined` so an empty-string query (`?doc=`) is still sent.
    if (scope?.query !== undefined) url.searchParams.set("doc", scope.query);
    const transport = new StreamableHTTPClientTransport(
      url,
      scope?.header
        ? { requestInit: { headers: { "x-sheaf-doc": scope.header } } }
        : undefined,
    );
    const client = new Client({ name: "scope-http-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      const res = (await client.callTool({
        name: "ListThreads",
        arguments: { ref: "main" },
      })) as { structuredContent?: { threads: { id: string }[] } };
      return (res.structuredContent?.threads ?? []).map((t) => t.id).sort();
    } finally {
      await client.close();
    }
  }

  // Raw initialize POST so we can assert the HTTP status for malformed scopes
  // (the MCP client would just throw on a 4xx).
  async function mcpInitStatus(shape: (u: URL) => void): Promise<number> {
    const url = new URL(`${base}/api/mcp`);
    shape(url);
    const res = await fetch(url, {
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
          clientInfo: { name: "t", version: "0.0.0" },
        },
      }),
    });
    return res.status;
  }

  it("unscoped connection sees every doc's threads", async () => {
    expect(await listThreadIds()).toEqual([idA, idB].sort());
  });

  it("?doc= scopes the queue to that doc", async () => {
    expect(await listThreadIds({ query: A })).toEqual([idA]);
    expect(await listThreadIds({ query: B })).toEqual([idB]);
  });

  it("X-Sheaf-Doc header scopes the queue to that doc", async () => {
    expect(await listThreadIds({ header: A })).toEqual([idA]);
  });

  it("?doc= wins over X-Sheaf-Doc when both are present", async () => {
    expect(await listThreadIds({ query: A, header: B })).toEqual([idA]);
  });

  it("empty ?doc= falls through to the X-Sheaf-Doc header", async () => {
    expect(await listThreadIds({ query: "", header: A })).toEqual([idA]);
  });

  it("rejects a repeated ?doc= param (fails closed, not open)", async () => {
    const status = await mcpInitStatus((u) => {
      u.searchParams.append("doc", A);
      u.searchParams.append("doc", B);
    });
    expect(status).toBe(400);
  });

  it("rejects a malformed scope path instead of yielding an empty queue", async () => {
    expect(
      await mcpInitStatus((u) => u.searchParams.set("doc", "../secret.md")),
    ).toBe(400);
  });

  it("accepts a well-formed scope", async () => {
    expect(await mcpInitStatus((u) => u.searchParams.set("doc", A))).toBe(200);
  });
});

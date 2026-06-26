import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildServer } from "../server";
import { StubBackend } from "../backend/stub";

/**
 * Doc-scoping (docs/sheaf-acp-v0.1.md §3.1): a connection scoped to one doc may
 * only see/act on that doc's threads. We drive the real MCP tools over an
 * in-memory client so the clamp logic rides the actual tool-call path. The
 * unscoped client proves the global behavior is unchanged.
 */

const A = "workspaces/ws/docs/a.md";
const B = "workspaces/ws/docs/b.md";

type ToolResult = {
  isError?: boolean;
  structuredContent?: unknown;
};

describe("thread tools doc-scoping", () => {
  let root: string;
  let backend: StubBackend;
  const open: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-scope-"));
    await fs.mkdir(path.join(root, "workspaces", "ws", "docs"), {
      recursive: true,
    });
    await fs.writeFile(path.join(root, A), "alpha document body");
    await fs.writeFile(path.join(root, B), "beta document body");
    backend = new StubBackend(root);
  });

  afterEach(async () => {
    for (const close of open.splice(0)) await close();
    await fs.rm(root, { recursive: true, force: true });
  });

  /** Connect an MCP client to a (optionally scoped) server over the same backend. */
  async function connect(docScope?: string): Promise<Client> {
    const server = buildServer(backend, docScope ? { docScope } : {});
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "scope-test", version: "0.0.0" });
    await Promise.all([client.connect(clientT), server.connect(serverT)]);
    open.push(async () => {
      await client.close();
      await server.close();
    });
    return client;
  }

  async function call(
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    return (await client.callTool({ name, arguments: args })) as ToolResult;
  }

  async function addThread(
    client: Client,
    docPath: string,
  ): Promise<ToolResult> {
    return call(client, "AddThread", {
      targets: [{ path: docPath, char_range: { from: 0, to: 5 } }],
      message: `comment on ${docPath}`,
    });
  }

  function threadId(res: ToolResult): string {
    return (res.structuredContent as { thread_id: string }).thread_id;
  }

  function listedIds(res: ToolResult): string[] {
    return (res.structuredContent as { threads: { id: string }[] }).threads.map(
      (t) => t.id,
    );
  }

  function errCode(res: ToolResult): string | undefined {
    return (res.structuredContent as { code?: string } | undefined)?.code;
  }

  /** Seed one thread on each doc via an unscoped client; return their ids. */
  async function seed(): Promise<{ idA: string; idB: string }> {
    const c = await connect();
    return { idA: threadId(await addThread(c, A)), idB: threadId(await addThread(c, B)) };
  }

  it("unscoped ListThreads sees every doc's threads (back-compat)", async () => {
    const { idA, idB } = await seed();
    const c = await connect();
    const ids = listedIds(await call(c, "ListThreads", { ref: "main" }));
    expect(ids).toEqual(expect.arrayContaining([idA, idB]));
  });

  it("scoped ListThreads returns only its doc — even when asked for another", async () => {
    const { idA, idB } = await seed();
    const c = await connect(A);

    const noPath = listedIds(await call(c, "ListThreads", { ref: "main" }));
    expect(noPath).toEqual([idA]);

    // A wider/foreign path is ignored, not honored.
    const widerPath = listedIds(
      await call(c, "ListThreads", { path: B, ref: "main" }),
    );
    expect(widerPath).toEqual([idA]);
    expect(noPath).not.toContain(idB);
  });

  it("scoped ReadThread allows in-scope, rejects out-of-scope", async () => {
    const { idA, idB } = await seed();
    const c = await connect(A);

    const ok = await call(c, "ReadThread", { thread_id: idA });
    expect(ok.isError).toBeFalsy();

    const denied = await call(c, "ReadThread", { thread_id: idB });
    expect(denied.isError).toBe(true);
    expect(errCode(denied)).toBe("out_of_scope");
  });

  it("scoped AddThread accepts in-scope targets, rejects foreign ones", async () => {
    const c = await connect(A);

    const ok = await addThread(c, A);
    expect(ok.isError).toBeFalsy();

    const denied = await addThread(c, B);
    expect(denied.isError).toBe(true);
    expect(errCode(denied)).toBe("out_of_scope");
  });

  it("scoped ReplyThread / ResolveThread / AttachDraftPayload reject out-of-scope ids", async () => {
    const { idA, idB } = await seed();
    const c = await connect(A);

    const reply = await call(c, "ReplyThread", { thread_id: idB, message: "x" });
    expect(reply.isError).toBe(true);
    expect(errCode(reply)).toBe("out_of_scope");

    const attach = await call(c, "AttachDraftPayload", {
      thread_id: idB,
      draft_options: [
        { name: "one", new_md: "1" },
        { name: "two", new_md: "2" },
      ],
    });
    expect(attach.isError).toBe(true);
    expect(errCode(attach)).toBe("out_of_scope");

    const resolve = await call(c, "ResolveThread", { thread_id: idB });
    expect(resolve.isError).toBe(true);
    expect(errCode(resolve)).toBe("out_of_scope");

    // The in-scope thread is still actionable.
    const okReply = await call(c, "ReplyThread", { thread_id: idA, message: "y" });
    expect(okReply.isError).toBeFalsy();
  });
});

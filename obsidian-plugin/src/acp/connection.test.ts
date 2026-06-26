import { describe, expect, it, vi } from "vitest";

import { JsonRpcPeer } from "./jsonrpc";
import { AcpConnection, type AcpCallbacks } from "./connection";
import { DocStore, type VaultFs } from "./doc-store";
import { textBlock } from "./protocol";

function fakeFs(seed: Record<string, string> = {}): VaultFs {
  const texts = new Map(Object.entries(seed));
  const bins = new Map<string, Uint8Array>();
  return {
    async exists(p) {
      return texts.has(p) || bins.has(p);
    },
    async readText(p) {
      const v = texts.get(p);
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    async writeText(p, d) {
      texts.set(p, d);
    },
    async readBinary(p) {
      const v = bins.get(p);
      if (!v) throw new Error(`ENOENT ${p}`);
      return v;
    },
    async writeBinary(p, d) {
      bins.set(p, d);
    },
  };
}

/** A connection wired to an in-process fake "agent" peer (no subprocess). */
function harness(opts?: {
  fs?: VaultFs;
  permission?: AcpCallbacks["onPermission"];
}) {
  let agent!: JsonRpcPeer;
  let client!: JsonRpcPeer;
  client = new JsonRpcPeer((line) => agent.receive(line));
  agent = new JsonRpcPeer((line) => client.receive(line));

  const onUpdate = vi.fn<AcpCallbacks["onUpdate"]>();
  const onPermission =
    opts?.permission ??
    vi.fn<AcpCallbacks["onPermission"]>(async () => ({
      outcome: { outcome: "selected", optionId: "allow" },
    }));

  const docs = new DocStore(opts?.fs ?? fakeFs());
  const conn = new AcpConnection(
    client,
    docs,
    { onUpdate, onPermission },
    {
      cwd: "/vault",
      mcpServersFor: (docPath) => [
        {
          type: "http",
          name: "sheaf",
          url: `http://localhost:31415/api/mcp?doc=${encodeURIComponent(docPath)}`,
          headers: [{ name: "X-Sheaf-Doc", value: docPath }],
        },
      ],
      toVaultPath: (abs) =>
        abs.startsWith("/vault/") ? abs.slice("/vault/".length) : null,
    },
  );

  return { agent, conn, onUpdate, onPermission };
}

describe("AcpConnection — driving the agent", () => {
  it("initializes with fs capability and protocol version", async () => {
    const { agent, conn } = harness();
    const seen: any[] = [];
    agent.onRequest("initialize", (p) => {
      seen.push(p);
      return { protocolVersion: 1 };
    });

    await expect(conn.initialize()).resolves.toEqual({ protocolVersion: 1 });
    expect(seen[0]).toMatchObject({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });
  });

  it("creates a doc-scoped session then prompts on it", async () => {
    const { agent, conn } = harness();
    let newSessionParams: any;
    let promptParams: any;
    agent.onRequest("session/new", (p) => {
      newSessionParams = p;
      return { sessionId: "sess_a" };
    });
    agent.onRequest("session/prompt", (p) => {
      promptParams = p;
      return { stopReason: "end_turn" };
    });

    const res = await conn.prompt("notes/a.md", [textBlock("rewrite the intro")]);
    expect(res).toEqual({ stopReason: "end_turn" });

    expect(newSessionParams).toMatchObject({ cwd: "/vault" });
    // The sheaf MCP is registered scoped to this doc, with the schema-required
    // `headers` array present (not a map, not omitted).
    expect(newSessionParams.mcpServers[0]).toEqual({
      type: "http",
      name: "sheaf",
      url: expect.stringContaining("doc=notes%2Fa.md"),
      headers: [{ name: "X-Sheaf-Doc", value: "notes/a.md" }],
    });
    expect(promptParams).toEqual({
      sessionId: "sess_a",
      prompt: [{ type: "text", text: "rewrite the intro" }],
    });
  });

  it("reuses one session per doc across prompts", async () => {
    const { agent, conn } = harness();
    const newSession = vi.fn(() => ({ sessionId: "sess_a" }));
    agent.onRequest("session/new", newSession);
    agent.onRequest("session/prompt", () => ({ stopReason: "end_turn" }));

    await conn.prompt("notes/a.md", [textBlock("one")]);
    await conn.prompt("notes/a.md", [textBlock("two")]);
    expect(newSession).toHaveBeenCalledTimes(1);
  });
});

describe("AcpConnection — serving the agent's calls (client-write path)", () => {
  it("services fs/read_text_file from the doc store (absolute → vault path)", async () => {
    const { agent } = harness({ fs: fakeFs({ "notes/a.md": "live body" }) });
    const res = await agent.request("fs/read_text_file", {
      sessionId: "s",
      path: "/vault/notes/a.md",
    });
    expect(res).toEqual({ content: "live body" });
  });

  it("routes fs/write_text_file through the doc store", async () => {
    const fs = fakeFs({ "notes/a.md": "old" });
    const { agent } = harness({ fs });
    await agent.request("fs/write_text_file", {
      sessionId: "s",
      path: "/vault/notes/a.md",
      content: "agent rewrote this",
    });
    // Read back through a fresh read confirms the write landed.
    const res = (await agent.request("fs/read_text_file", {
      sessionId: "s",
      path: "/vault/notes/a.md",
    })) as { content: string };
    expect(res.content).toBe("agent rewrote this");
  });

  it("rejects fs paths outside the vault", async () => {
    const { agent } = harness();
    await expect(
      agent.request("fs/read_text_file", { sessionId: "s", path: "/etc/passwd" }),
    ).rejects.toThrow(/outside the vault/);
  });

  it("resolves a permission request via the callback, routed to its doc", async () => {
    const onPermission = vi.fn<AcpCallbacks["onPermission"]>(async () => ({
      outcome: { outcome: "selected", optionId: "allow_once" },
    }));
    const { agent, conn } = harness({ permission: onPermission });
    agent.onRequest("session/new", () => ({ sessionId: "sess_a" }));
    agent.onRequest("session/prompt", () => ({ stopReason: "end_turn" }));
    await conn.prompt("notes/a.md", [textBlock("go")]); // establishes sess_a → notes/a.md

    const res = await agent.request("session/request_permission", {
      sessionId: "sess_a",
      toolCall: { toolCallId: "t1", title: "Write a.md" },
      options: [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }],
    });

    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow_once" } });
    expect(onPermission).toHaveBeenCalledTimes(1);
    // The callback learns which doc the request belongs to (reverse-mapped).
    expect(onPermission.mock.calls[0][1]).toBe("notes/a.md");
  });

  it("dispatches session/update to the callback with the resolved doc", async () => {
    const { agent, conn, onUpdate } = harness();
    agent.onRequest("session/new", () => ({ sessionId: "sess_a" }));
    agent.onRequest("session/prompt", () => ({ stopReason: "end_turn" }));
    await conn.prompt("notes/a.md", [textBlock("go")]);

    agent.notify("session/update", {
      sessionId: "sess_a",
      update: { sessionUpdate: "agent_thought_chunk", content: textBlock("thinking…") },
    });

    expect(onUpdate).toHaveBeenCalledTimes(1);
    const [notif, docPath] = onUpdate.mock.calls[0];
    expect(notif.update.sessionUpdate).toBe("agent_thought_chunk");
    expect(docPath).toBe("notes/a.md");
  });
});

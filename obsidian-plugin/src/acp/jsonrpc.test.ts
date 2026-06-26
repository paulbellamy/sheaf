import { describe, expect, it, vi } from "vitest";

import { JsonRpcPeer, JsonRpcResponseError, RPC_ERROR } from "./jsonrpc";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("JsonRpcPeer — outgoing", () => {
  it("frames a request and resolves on the matching response", async () => {
    const sent: any[] = [];
    const peer = new JsonRpcPeer((line) => sent.push(JSON.parse(line)));

    const p = peer.request("initialize", { protocolVersion: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: 1 },
    });
    const id = sent[0].id;
    expect(typeof id).toBe("number");

    peer.receive(JSON.stringify({ jsonrpc: "2.0", id, result: { ok: true } }));
    await expect(p).resolves.toEqual({ ok: true });
  });

  it("rejects with a JsonRpcResponseError on an error response", async () => {
    const sent: any[] = [];
    const peer = new JsonRpcPeer((line) => sent.push(JSON.parse(line)));
    const p = peer.request("session/new", {});
    peer.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: sent[0].id,
        error: { code: -32000, message: "boom", data: { why: "x" } },
      }),
    );
    await expect(p).rejects.toBeInstanceOf(JsonRpcResponseError);
    await p.catch((e: JsonRpcResponseError) => {
      expect(e.code).toBe(-32000);
      expect(e.message).toBe("boom");
      expect(e.data).toEqual({ why: "x" });
    });
  });

  it("writes a notification with no id", () => {
    const sent: any[] = [];
    const peer = new JsonRpcPeer((line) => sent.push(JSON.parse(line)));
    peer.notify("session/cancel", { sessionId: "s1" });
    expect(sent[0]).toEqual({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "s1" },
    });
    expect("id" in sent[0]).toBe(false);
  });

  it("appends a newline frame to every written message", () => {
    const raw: string[] = [];
    const peer = new JsonRpcPeer((line) => raw.push(line));
    peer.notify("x");
    expect(raw[0].endsWith("\n")).toBe(true);
  });
});

describe("JsonRpcPeer — incoming", () => {
  it("dispatches an incoming request to its handler and replies with the result", async () => {
    const sent: any[] = [];
    const peer = new JsonRpcPeer((line) => sent.push(JSON.parse(line)));
    peer.onRequest("fs/read_text_file", (params) => {
      expect(params).toEqual({ path: "a.md" });
      return { content: "hello" };
    });
    peer.receive(
      JSON.stringify({ jsonrpc: "2.0", id: 7, method: "fs/read_text_file", params: { path: "a.md" } }),
    );
    await tick();
    expect(sent[0]).toEqual({ jsonrpc: "2.0", id: 7, result: { content: "hello" } });
  });

  it("replies method-not-found when no handler is registered", async () => {
    const sent: any[] = [];
    const peer = new JsonRpcPeer((line) => sent.push(JSON.parse(line)));
    peer.receive(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "nope" }));
    await tick();
    expect(sent[0].error.code).toBe(RPC_ERROR.methodNotFound);
    expect(sent[0].id).toBe(9);
  });

  it("replies internal-error when a handler throws", async () => {
    const sent: any[] = [];
    const peer = new JsonRpcPeer((line) => sent.push(JSON.parse(line)));
    peer.onRequest("boom", () => {
      throw new Error("kaboom");
    });
    peer.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "boom" }));
    await tick();
    expect(sent[0].error).toMatchObject({ code: RPC_ERROR.internal, message: "kaboom" });
  });

  it("invokes notification handlers and writes nothing back", () => {
    const sent: any[] = [];
    const peer = new JsonRpcPeer((line) => sent.push(JSON.parse(line)));
    const onUpdate = vi.fn();
    peer.onNotification("session/update", onUpdate);
    peer.receive(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { x: 1 } }));
    expect(onUpdate).toHaveBeenCalledWith({ x: 1 });
    expect(sent).toHaveLength(0);
  });

  it("ignores malformed and empty lines without throwing", () => {
    const sent: any[] = [];
    const peer = new JsonRpcPeer((line) => sent.push(JSON.parse(line)));
    expect(() => peer.receive("not json {")).not.toThrow();
    expect(() => peer.receive("   ")).not.toThrow();
    expect(sent).toHaveLength(0);
  });
});

describe("JsonRpcPeer — lifecycle", () => {
  it("rejects in-flight and subsequent requests after close()", async () => {
    const peer = new JsonRpcPeer(() => {});
    const inflight = peer.request("slow");
    peer.close("subprocess exited");
    await expect(inflight).rejects.toThrow("subprocess exited");
    await expect(peer.request("after")).rejects.toThrow(/closed/);
  });
});

describe("JsonRpcPeer — two peers wired together", () => {
  it("round-trips a request both directions (the symmetric ACP shape)", async () => {
    let client!: JsonRpcPeer;
    let agent!: JsonRpcPeer;
    client = new JsonRpcPeer((line) => agent.receive(line));
    agent = new JsonRpcPeer((line) => client.receive(line));

    // agent serves a client→agent call
    agent.onRequest("session/new", () => ({ sessionId: "sess_1" }));
    // client serves an agent→client call (fs read)
    client.onRequest("fs/read_text_file", () => ({ content: "on disk" }));

    await expect(client.request("session/new", { cwd: "/v" })).resolves.toEqual({
      sessionId: "sess_1",
    });
    await expect(agent.request("fs/read_text_file", { path: "a.md" })).resolves.toEqual({
      content: "on disk",
    });
  });
});

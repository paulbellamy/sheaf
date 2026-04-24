import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type Connection = { req: IncomingMessage; res: ServerResponse };

const SCRIPT = path.resolve(
  __dirname,
  "../../.claude-plugin/scripts/watch-events.mjs",
);

async function collectLines(
  child: ChildProcessByStdio<null, Readable, Readable>,
  minCount: number,
  timeoutMs: number,
): Promise<string[]> {
  const lines: string[] = [];
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  const onData = (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line) lines.push(line);
    }
  };
  child.stdout.on("data", onData);
  while (lines.length < minCount && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  child.stdout.off("data", onData);
  return lines;
}

describe("watch-events.mjs", () => {
  let server: Server;
  let connections: Connection[];
  let port: number;
  let child: ChildProcessByStdio<null, Readable, Readable> | null = null;

  beforeEach(async () => {
    connections = [];
    server = createServer((req, res) => {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
      });
      res.write(": connected\n\n");
      connections.push({ req, res });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit").catch(() => {});
    }
    for (const { res } of connections) {
      try {
        res.end();
      } catch {}
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function startWatcher(): Promise<ChildProcessByStdio<null, Readable, Readable>> {
    child = spawn("node", [SCRIPT], {
      env: { ...process.env, SHEAF_STREAM_URL: `http://127.0.0.1:${port}/` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    while (connections.length === 0) {
      await new Promise((r) => setTimeout(r, 25));
    }
    return child;
  }

  it("emits one stdout JSON line per SSE data event", async () => {
    const c = await startWatcher();
    const events = [
      { kind: "thread_changed", thread_id: "thrd_a" },
      { kind: "draft_changed", draft_id: "drft_1", path: "p.md" },
    ];
    for (const e of events) {
      connections[0].res.write(`data: ${JSON.stringify(e)}\n\n`);
    }

    const lines = await collectLines(c, events.length, 1500);
    expect(lines.map((l) => JSON.parse(l))).toEqual(events);
  });

  it("reconnects after the stream closes and keeps emitting", async () => {
    const c = await startWatcher();
    connections[0].res.write(
      `data: ${JSON.stringify({ kind: "thread_changed", thread_id: "t1" })}\n\n`,
    );
    // let the first event flush before dropping
    await new Promise((r) => setTimeout(r, 100));
    connections[0].res.end();

    // wait for reconnect (watcher backoff starts at 500ms)
    const deadline = Date.now() + 5000;
    while (connections.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(connections.length).toBeGreaterThanOrEqual(2);

    connections[1].res.write(
      `data: ${JSON.stringify({ kind: "thread_changed", thread_id: "t2" })}\n\n`,
    );

    const lines = await collectLines(c, 2, 3000);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed).toContainEqual({ kind: "thread_changed", thread_id: "t1" });
    expect(parsed).toContainEqual({ kind: "thread_changed", thread_id: "t2" });
  });

  it("ignores comments and malformed frames", async () => {
    const c = await startWatcher();
    connections[0].res.write(": keepalive\n\n");
    connections[0].res.write("data: not json\n\n");
    connections[0].res.write(
      `data: ${JSON.stringify({ kind: "thread_changed", thread_id: "ok" })}\n\n`,
    );

    const lines = await collectLines(c, 1, 1500);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({ kind: "thread_changed", thread_id: "ok" });
  });
});

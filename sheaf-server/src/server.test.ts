import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildServer } from "./server";
import { StubBackend } from "./backend/stub";

/**
 * Tool-roster guard. `buildServer` registers exactly one surface now (the
 * `--tools`/ToolSurface split and the draft + style tools are gone). This test
 * pins the full registered tool-name set over a real MCP client (in-memory
 * transport, so it rides the actual `tools/list` path) — the trip-wire that
 * catches an accidental registration change (a tool added, dropped, or renamed)
 * in later phases.
 */
const EXPECTED_TOOLS = [
  "AddThread",
  "AttachDraftPayload",
  "Edit",
  "Glob",
  "Grep",
  "ListDocs",
  "ListThreads",
  "Read",
  "ReadMe",
  "ReadThread",
  "ReadThreads",
  "ReplyThread",
  "ResolveThread",
  "Write",
].sort();

describe("buildServer tool roster", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-roster-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("registers exactly the expected tool set and nothing else", async () => {
    const server = buildServer(new StubBackend(root));
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "roster-test", version: "0.0.0" });
    try {
      await Promise.all([client.connect(clientT), server.connect(serverT)]);
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(EXPECTED_TOOLS);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("doc tools over MCP", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-doc-tools-"));
    await fs.writeFile(path.join(root, "note.md"), "# note\n\nbody\n");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  type TextResult = {
    content: { type: string; text?: string }[];
    structuredContent?: unknown;
    isError?: boolean;
  };

  async function withClient(
    fn: (call: (name: string, args: Record<string, unknown>) => Promise<TextResult>) => Promise<void>,
  ): Promise<void> {
    const server = buildServer(new StubBackend(root));
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "doc-tools-test", version: "0.0.0" });
    try {
      await Promise.all([client.connect(clientT), server.connect(serverT)]);
      await fn(
        async (name, args) =>
          (await client.callTool({ name, arguments: args })) as TextResult,
      );
    } finally {
      await client.close();
      await server.close();
    }
  }

  it("Read returns only the doc text (no metadata footer)", async () => {
    await withClient(async (call) => {
      const res = await call("Read", { file_path: "note.md" });
      expect(res.isError).toBeFalsy();
      expect(res.content).toEqual([{ type: "text", text: "# note\n\nbody\n" }]);
    });
  });

  it("Write / Edit confirm briefly, and a repeated op_id applies once", async () => {
    await withClient(async (call) => {
      const w1 = await call("Write", { file_path: "note.md", content: "a", op_id: "op-1" });
      expect(w1.content).toEqual([{ type: "text", text: "wrote note.md" }]);
      expect(w1.structuredContent).toBeUndefined();
      // Same op_id, different content: acknowledged, but not re-applied.
      const w2 = await call("Write", { file_path: "note.md", content: "b", op_id: "op-1" });
      expect(w2.isError).toBeFalsy();
      const read = await call("Read", { file_path: "note.md" });
      expect(read.content[0]?.text).toBe("a");

      const e1 = await call("Edit", {
        file_path: "note.md",
        old_string: "a",
        new_string: "aa",
        op_id: "op-2",
      });
      expect(e1.content).toEqual([{ type: "text", text: "edited note.md" }]);
      // A re-run would hit two `a`s and fail `edit_ambiguous`; a replay is a no-op.
      const e2 = await call("Edit", {
        file_path: "note.md",
        old_string: "a",
        new_string: "aa",
        op_id: "op-2",
      });
      expect(e2.isError).toBeFalsy();
      expect((await call("Read", { file_path: "note.md" })).content[0]?.text).toBe("aa");
    });
  });
});

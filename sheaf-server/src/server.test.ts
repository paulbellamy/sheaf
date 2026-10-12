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

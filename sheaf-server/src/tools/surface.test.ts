import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildServer, type ToolSurface } from "../server";
import { StubBackend } from "../backend/stub";

/**
 * Tool-surface gating: the embedded server can expose the full tool set (web
 * prototype, default) or a "thread-only" surface (Obsidian plugin) that omits
 * the draft-workflow tools. We assert the registered tool list over a real MCP
 * client (in-memory transport) so the check rides the actual tools/list path.
 */

const DRAFT_TOOLS = ["Fork", "Propose", "Merge", "DeclineDraft", "DraftChanges"];
const THREAD_TOOLS = [
  "ListThreads",
  "ReadThread",
  "AddThread",
  "ReplyThread",
  "AttachDraftPayload",
  "ResolveThread",
];
// Kept in both surfaces — Read/Edit/Write stay until the ACP fs path exists.
const ALWAYS_TOOLS = ["ReadMe", "Read", "Write", "Edit", "Glob", "Grep"];

describe("buildServer tool surface", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-surface-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function listToolNames(tools?: ToolSurface): Promise<string[]> {
    const server = buildServer(new StubBackend(root), tools ? { tools } : {});
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "surface-test", version: "0.0.0" });
    try {
      await Promise.all([client.connect(clientT), server.connect(serverT)]);
      const { tools: list } = await client.listTools();
      return list.map((t) => t.name);
    } finally {
      await client.close();
      await server.close();
    }
  }

  it("full surface (default) registers the draft tools", async () => {
    const names = await listToolNames();
    for (const t of [...DRAFT_TOOLS, ...THREAD_TOOLS, ...ALWAYS_TOOLS]) {
      expect(names).toContain(t);
    }
  });

  it('explicit tools:"full" matches the default surface', async () => {
    const def = new Set(await listToolNames());
    const full = new Set(await listToolNames("full"));
    expect(full).toEqual(def);
  });

  it("thread-only omits the draft tools, keeps thread + file tools", async () => {
    const names = await listToolNames("thread-only");
    for (const t of DRAFT_TOOLS) expect(names).not.toContain(t);
    for (const t of [...THREAD_TOOLS, ...ALWAYS_TOOLS]) {
      expect(names).toContain(t);
    }
  });
});

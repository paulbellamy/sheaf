import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildServer } from "../server";
import { StubBackend } from "../backend/stub";
import { VOICE_GUIDE_PATH } from "../style/profile";

/** A chunk of plain, direct prose so the seeded vault clears the low-corpus
 *  threshold and the metrics have real signal. */
const PARA =
  "The team shipped the change on a Tuesday. Nobody noticed at first. " +
  "Then the numbers moved, and we knew it had worked. We kept the rollout " +
  "small and watched the graphs. When they held steady, we widened it. " +
  "There is no trick here. You ship a little, you watch, you ship more. ";

async function connect(backend: StubBackend): Promise<Client> {
  const server = buildServer(backend);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  return client;
}

type ToolResult = {
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

describe("style MCP tools end-to-end", () => {
  let root: string;
  let backend: StubBackend;
  let client: Client;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-style-mcp-"));
    await fs.mkdir(path.join(root, "notes"), { recursive: true });
    await fs.mkdir(path.join(root, "journal"), { recursive: true });
    for (const [p, topic] of [
      ["notes/databases.md", "databases and indexes"],
      ["notes/gardening.md", "gardening and soil health"],
      ["notes/travel.md", "travel and slow trains"],
      ["journal/monday.md", "the week ahead"],
      ["journal/friday.md", "what shipped this week"],
    ] as const) {
      await fs.writeFile(path.join(root, p), `# ${topic}\n${PARA}${PARA}`);
    }
    backend = new StubBackend(root);
    client = await connect(backend);
  });

  afterEach(async () => {
    await client.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("GetStyle returns a bounded profile with no guide yet", async () => {
    const res = (await client.callTool({
      name: "GetStyle",
      arguments: { topic: "gardening" },
    })) as ToolResult;
    const sc = res.structuredContent!;
    expect(sc.enabled).toBe(true);
    expect(sc.guide_md).toBeNull();
    expect(sc.guide_stale).toBe(true);
    expect(sc.low_corpus).toBe(false);
    expect(Array.isArray(sc.exemplars)).toBe(true);
    expect((sc.exemplars as unknown[]).length).toBeGreaterThan(0);
    expect(res.content[0].text!).toContain("Your writing voice");
  });

  it("bootstrap flow: StyleSamples -> SaveStyleGuide -> GetStyle has a fresh guide", async () => {
    const samples = (await client.callTool({
      name: "StyleSamples",
      arguments: {},
    })) as ToolResult;
    const metrics = samples.structuredContent!.metrics as { word_count: number };
    expect(metrics.word_count).toBeGreaterThan(400);
    expect((samples.structuredContent!.samples as unknown[]).length).toBeGreaterThan(0);
    expect(samples.structuredContent!.existing_guide_md).toBeNull();

    const saved = (await client.callTool({
      name: "SaveStyleGuide",
      arguments: { guide_md: "# Voice\nShort, plain sentences. No em-dashes. Ship and watch." },
    })) as ToolResult;
    expect(saved.structuredContent!.ok).toBe(true);

    // Mirrored to a visible, user-editable doc.
    const guideDoc = await backend.readDoc(VOICE_GUIDE_PATH, "main");
    expect(guideDoc.md).toContain("Short, plain sentences");

    const after = (await client.callTool({
      name: "GetStyle",
      arguments: {},
    })) as ToolResult;
    expect(after.structuredContent!.guide_md).toContain("Short, plain sentences");
    expect(after.structuredContent!.guide_stale).toBe(false);
  });

  it("StyleCheck flags AI tells and banned phrases", async () => {
    await backend.writeStyleConfig({
      ...(await backend.readStyleConfig()),
      prefs: {
        em_dash: "no",
        oxford_comma: "either",
        contractions: "either",
        banned_phrases: ["game-changer"],
      },
    });

    const res = (await client.callTool({
      name: "StyleCheck",
      arguments: {
        text: "Let us delve into this realm — it is a robust, seamless game-changer. Furthermore, it is a testament to design.",
      },
    })) as ToolResult;
    const sc = res.structuredContent!;
    expect(sc.verdict).toBe("off");
    const hits = sc.hits as {
      em_dash: number;
      banned_phrases: { phrase: string }[];
      ai_tells: { phrase: string }[];
    };
    expect(hits.em_dash).toBeGreaterThan(0);
    expect(hits.banned_phrases.some((b) => b.phrase === "game-changer")).toBe(true);
    expect(hits.ai_tells.length).toBeGreaterThanOrEqual(3);
  });

  it("GetStyle short-circuits when voice matching is disabled", async () => {
    await backend.writeStyleConfig({
      ...(await backend.readStyleConfig()),
      enabled: false,
    });
    const res = (await client.callTool({
      name: "GetStyle",
      arguments: {},
    })) as ToolResult;
    expect(res.structuredContent!.enabled).toBe(false);
    expect(res.content[0].text!).toMatch(/disabled/i);
  });
});

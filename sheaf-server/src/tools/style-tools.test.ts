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

  it("bootstrap flow: StyleSamples -> Write guide doc -> GetStyle has a fresh guide", async () => {
    const samples = (await client.callTool({
      name: "StyleSamples",
      arguments: {},
    })) as ToolResult;
    const metrics = samples.structuredContent!.metrics as { word_count: number };
    expect(metrics.word_count).toBeGreaterThan(400);
    expect((samples.structuredContent!.samples as unknown[]).length).toBeGreaterThan(0);
    expect(samples.structuredContent!.existing_guide_md).toBeNull();

    // The agent saves the guide by writing the ordinary visible doc — there is
    // no SaveStyleGuide tool.
    const guide = "# Voice\nShort, plain sentences. No em-dashes. Ship and watch.";
    const wrote = (await client.callTool({
      name: "Write",
      arguments: { file_path: VOICE_GUIDE_PATH, content: guide, ref: "main" },
    })) as ToolResult;
    expect(wrote.isError).not.toBe(true);

    const guideDoc = await backend.readDoc(VOICE_GUIDE_PATH, "main");
    expect(guideDoc.md).toContain("Short, plain sentences");

    const after = (await client.callTool({
      name: "GetStyle",
      arguments: {},
    })) as ToolResult;
    expect(after.structuredContent!.guide_md).toContain("Short, plain sentences");
    expect(after.structuredContent!.guide_stale).toBe(false);
  });

  it("AnalyzeSamples measures supplied content + compares to the profile, statelessly", async () => {
    // Ensure a profile exists on disk first.
    await client.callTool({ name: "GetStyle", arguments: {} });
    const before = await backend.readStyleProfile();
    expect(before).not.toBeNull();

    const res = (await client.callTool({
      name: "AnalyzeSamples",
      arguments: {
        samples: [
          {
            label: "site:about",
            content: `I build small tools. I keep it short. I ship. ${PARA}`,
          },
        ],
      },
    })) as ToolResult;
    const sc = res.structuredContent!;
    expect((sc.metrics as { word_count: number }).word_count).toBeGreaterThan(0);
    expect((sc.per_sample as unknown[]).length).toBe(1);
    expect(sc.comparison).not.toBeNull();
    expect(
      (sc.comparison as { function_word_drift: number }).function_word_drift,
    ).toBeGreaterThanOrEqual(0);

    // Stateless: the cached profile is untouched.
    const after = await backend.readStyleProfile();
    expect(after!.fingerprint.digest).toBe(before!.fingerprint.digest);
    expect(after!.computed_at).toBe(before!.computed_at);
  });

  it("StyleCheck flags AI tells and em-dash overuse, and surfaces the voice guide", async () => {
    // Seed the profile from the (em-dash-free) corpus.
    await client.callTool({ name: "GetStyle", arguments: {} });
    // A guide with a written rule the mechanical lint can't parse.
    await backend.writeDoc(
      VOICE_GUIDE_PATH,
      "main",
      "# Voice\nNever use em-dashes. Avoid the word 'tapestry'.",
      undefined,
      "agent",
    );

    const res = (await client.callTool({
      name: "StyleCheck",
      arguments: {
        text: "Let us delve into this realm — it is a robust, seamless tapestry. Furthermore, it is a testament to design.",
      },
    })) as ToolResult;
    const sc = res.structuredContent!;
    expect(sc.verdict).toBe("off");
    const hits = sc.hits as {
      em_dash: number;
      ai_tells: { phrase: string }[];
    };
    expect(hits.em_dash).toBeGreaterThan(0);
    expect(hits.ai_tells.length).toBeGreaterThanOrEqual(3);
    // A 0..1 style_distance is surfaced when a profile exists.
    expect(typeof sc.style_distance).toBe("number");
    // The voice guide is returned so the agent can apply its written rules.
    expect(sc.guide_md).toContain("Never use em-dashes");
    expect(res.content[0].text!).toContain("Avoid the word 'tapestry'");
  });

  it("StyleJudge returns the candidate beside real passages + a style distance", async () => {
    await client.callTool({ name: "GetStyle", arguments: {} });

    const res = (await client.callTool({
      name: "StyleJudge",
      arguments: {
        candidate:
          "Let us delve into this realm — a robust, seamless tapestry, moreover.",
        topic: "shipping changes",
      },
    })) as ToolResult;
    const sc = res.structuredContent!;
    expect(typeof sc.candidate_style_distance).toBe("number");
    expect(Array.isArray(sc.real_samples)).toBe(true);
    expect((sc.real_samples as unknown[]).length).toBeGreaterThan(0);
    expect(res.content[0].text!).toContain("Voice critic pass");
    expect(res.content[0].text!).toContain("delve into this realm");
  });

  it("StyleJudge blind mode hides the candidate among real passages with an answer key", async () => {
    await client.callTool({ name: "GetStyle", arguments: {} });

    const candidate =
      "Let us delve into this realm — a robust, seamless tapestry, moreover.";
    const res = (await client.callTool({
      name: "StyleJudge",
      arguments: { candidate, blind: true },
    })) as ToolResult;
    const sc = res.structuredContent!;
    expect(sc.blind).toBe(true);
    const passages = sc.passages as { label: string; text: string }[];
    // Candidate + the real passages, all present and shuffled together.
    expect(passages.length).toBeGreaterThan(1);
    const idx = sc.candidate_index as number;
    expect(passages[idx].text).toContain("delve into this realm");
    expect(sc.candidate_label).toBe(`Passage ${idx + 1}`);
    // The packet instructs delegating to a sub-agent and carries an answer key.
    expect(res.content[0].text!).toContain("fresh sub-agent");
    expect(res.content[0].text!).toContain("ANSWER KEY");
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

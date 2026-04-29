import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StubBackend } from "../backend/stub";
import {
  GET as threadsGET,
  POST as threadsPOST,
} from "../../../app/api/ui/threads/route";
import { POST as draftsPOST } from "../../../app/api/ui/drafts/route";
import { GET as draftIdGET } from "../../../app/api/ui/drafts/[id]/route";
import { POST as payloadPOST } from "../../../app/api/ui/threads/[id]/payload/route";
import { setBackend } from "../backend/factory";
import type { BackendEvent } from "../backend";

describe("backend.draftChanges on an empty draft", () => {
  let root: string;
  let backend: StubBackend;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-tools-"));
    await fs.mkdir(path.join(root, "workspaces", "ws", "docs"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, "workspaces", "ws", "docs", "a.md"),
      "# a\n",
    );
    backend = new StubBackend(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns an empty array for a fresh draft with no writes", async () => {
    const [draftId] = await backend.fork("workspaces/ws/docs/a.md", 1);
    const changes = await backend.draftChanges(draftId);
    expect(changes).toEqual([]);
  });

  it("returns pairs after a write", async () => {
    const [draftId] = await backend.fork("workspaces/ws/docs/a.md", 1);
    await backend.writeDoc("workspaces/ws/docs/a.md", draftId, "# a v2\n");
    const changes = await backend.draftChanges(draftId);
    expect(changes).toHaveLength(1);
    expect(changes[0].path).toBe("workspaces/ws/docs/a.md");
    expect(changes[0].main_md).toBe("# a\n");
    expect(changes[0].draft_md).toBe("# a v2\n");
  });
});

describe("backend serves .claude-plugin/ read-only", () => {
  let root: string;
  let pluginRoot: string;
  let backend: StubBackend;
  const SKILL_PATH =
    ".claude-plugin/skills/sheaf-event-watcher/SKILL.md";
  const SKILL_BODY = "---\nname: sheaf-event-watcher\n---\n# watch\n";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-tools-"));
    pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-plugin-"));
    await fs.mkdir(path.join(root, "workspaces", "ws", "docs"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, "workspaces", "ws", "docs", "a.md"),
      "# a\n",
    );
    const skillDir = path.join(
      pluginRoot,
      ".claude-plugin",
      "skills",
      "sheaf-event-watcher",
    );
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), SKILL_BODY);
    await fs.mkdir(path.join(pluginRoot, ".claude-plugin", "scripts"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(pluginRoot, ".claude-plugin", "scripts", "watch-events.mjs"),
      "// stub\n",
    );
    backend = new StubBackend(root, pluginRoot);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(pluginRoot, { recursive: true, force: true });
  });

  it("Read returns plugin file contents verbatim (frontmatter kept)", async () => {
    const result = await backend.readDoc(SKILL_PATH);
    expect(result.md).toBe(SKILL_BODY);
    expect(result.origin).toBe("main");
  });

  it("Read finds non-markdown plugin files too", async () => {
    const result = await backend.readDoc(
      ".claude-plugin/scripts/watch-events.mjs",
    );
    expect(result.md).toBe("// stub\n");
  });

  it("Glob discovers SKILL.md files under the plugin tree", async () => {
    const matches = await backend.glob(".claude-plugin/skills/**/SKILL.md");
    expect(matches.map((m) => m.path)).toContain(SKILL_PATH);
  });

  it("Write to a plugin path is rejected", async () => {
    await expect(
      backend.writeDoc(SKILL_PATH, "draft_fake", "hacked"),
    ).rejects.toThrow();
  });

  it("Fork from a plugin path is rejected", async () => {
    await expect(backend.fork(SKILL_PATH, 1)).rejects.toThrow();
  });

  it("traversal via .claude-plugin/.. is rejected", async () => {
    await expect(
      backend.readDoc(".claude-plugin/../etc/passwd"),
    ).rejects.toThrow();
  });
});

describe("threads route refuses ref=main", () => {
  it("POST returns 400 with a clear error", async () => {
    const req = new Request("http://localhost/api/ui/threads?ref=main", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: "workspaces/ws/docs/a.md",
        targets: [{ char_range: { from: 0, to: 1 } }],
        message: "hi",
      }),
    });
    const res = await threadsPOST(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/start a draft first/);
  });

  it("GET returns an empty thread list without hitting the backend", async () => {
    const req = new Request(
      "http://localhost/api/ui/threads?path=workspaces/ws/docs/a.md&ref=main",
    );
    const res = await threadsGET(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ref: string; threads: unknown[] };
    expect(body.ref).toBe("main");
    expect(body.threads).toEqual([]);
  });
});

describe("backend.readDoc version_counter (Phase B)", () => {
  let root: string;
  let backend: StubBackend;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-tools-"));
    await fs.mkdir(path.join(root, "workspaces", "ws", "docs"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, "workspaces", "ws", "docs", "a.md"),
      "# a\n",
    );
    backend = new StubBackend(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns version_counter: 1 for a fresh doc with prose", async () => {
    const result = await backend.readDoc("workspaces/ws/docs/a.md");
    expect(result.version_counter).toBe(1);
  });

  it("exposes version_token (renamed from version) on the read result", async () => {
    const result = await backend.readDoc("workspaces/ws/docs/a.md");
    expect(typeof result.version_token).toBe("string");
    expect(result.version_token).toMatch(/^v-/);
    // The legacy `version` field must not exist on the new shape.
    expect((result as { version?: unknown }).version).toBeUndefined();
  });

  it("does not bump version_counter on writeDoc (Phase I bumps on accept)", async () => {
    const [draftId] = await backend.fork("workspaces/ws/docs/a.md", 1);
    await backend.writeDoc(
      "workspaces/ws/docs/a.md",
      draftId,
      "# a edited\n",
    );
    const main = await backend.readDoc("workspaces/ws/docs/a.md");
    expect(main.version_counter).toBe(1);
    const draft = await backend.readDoc("workspaces/ws/docs/a.md", draftId);
    expect(draft.version_counter).toBe(1);
  });

  it("writeDoc result carries version_token (renamed from version)", async () => {
    const [draftId] = await backend.fork("workspaces/ws/docs/a.md", 1);
    const result = await backend.writeDoc(
      "workspaces/ws/docs/a.md",
      draftId,
      "# a v2\n",
    );
    expect(typeof result.version_token).toBe("string");
    expect(result.version_token).toMatch(/^v-/);
    expect((result as { version?: unknown }).version).toBeUndefined();
  });
});

describe("backend.listDocs workspace filter", () => {
  let root: string;
  let backend: StubBackend;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-tools-"));
    for (const ws of ["alpha", "beta"]) {
      const dir = path.join(root, "workspaces", ws, "docs");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "x.md"), `# ${ws}/x\n`);
    }
    backend = new StubBackend(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns only docs under the requested workspace", async () => {
    const alphaDocs = await backend.listDocs("alpha");
    expect(alphaDocs.map((d) => d.path)).toEqual([
      "workspaces/alpha/docs/x.md",
    ]);
    const betaDocs = await backend.listDocs("beta");
    expect(betaDocs.map((d) => d.path)).toEqual([
      "workspaces/beta/docs/x.md",
    ]);
  });
});

describe("backend.forkAndAttachThreads (Phase C)", () => {
  let root: string;
  let backend: StubBackend;
  const DOC = "workspaces/ws/docs/a.md";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-tools-"));
    await fs.mkdir(path.join(root, "workspaces", "ws", "docs"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, "workspaces", "ws", "docs", "a.md"),
      "# title\n\nbody one\n\nbody two\n",
    );
    backend = new StubBackend(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("creates the draft, persists threads, and emits one draft_created + N thread_changed", async () => {
    const events: BackendEvent[] = [];
    backend.subscribe((e) => events.push(e));

    const result = await backend.forkAndAttachThreads({
      base_path: DOC,
      base_version: 1,
      name: "v2 depth-first",
      author: "alice",
      initial_threads: [
        {
          targets: [{ path: DOC, char_range: { from: 0, to: 7 } }],
          message: "scope",
        },
        {
          targets: [{ path: DOC, char_range: { from: 9, to: 17 } }],
          message: "tighten",
        },
      ],
    });

    expect(result.draft_id).toMatch(/^draft_/);
    expect(result.base_version).toBe(1);
    // display_name = "<name> #<4hex>" where 4hex is the first 4 chars after `draft_`.
    const suffix = result.draft_id.slice("draft_".length, "draft_".length + 4);
    expect(result.display_name).toBe(`v2 depth-first #${suffix}`);

    // Drafts list reflects new shape (touches + base_version + display_name).
    const drafts = await backend.listDrafts();
    const created = drafts.find((d) => d.draft_id === result.draft_id);
    expect(created).toBeDefined();
    expect(created!.touches).toEqual([DOC]);
    expect(created!.base_version).toBe(1);
    expect(created!.display_name).toBe(`v2 depth-first #${suffix}`);

    // Threads landed on the new draft ref.
    const threads = await backend.listThreads({ ref: result.draft_id });
    expect(threads).toHaveLength(2);

    // Atomicity / event budget: one draft_created, two thread_changed.
    const created_events = events.filter((e) => e.kind === "draft_created");
    const thread_events = events.filter((e) => e.kind === "thread_changed");
    expect(created_events).toHaveLength(1);
    expect(thread_events).toHaveLength(2);
  });

  it("works with zero initial_threads (allowed; no thread_changed events)", async () => {
    const events: BackendEvent[] = [];
    backend.subscribe((e) => events.push(e));

    const result = await backend.forkAndAttachThreads({
      base_path: DOC,
      base_version: 1,
      name: "empty",
      initial_threads: [],
    });

    expect(result.draft_id).toMatch(/^draft_/);
    const thread_events = events.filter((e) => e.kind === "thread_changed");
    expect(thread_events).toHaveLength(0);
  });
});

describe("POST /api/ui/drafts (Phase C)", () => {
  let root: string;
  let backend: StubBackend;
  const DOC = "workspaces/ws/docs/a.md";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-tools-"));
    await fs.mkdir(path.join(root, "workspaces", "ws", "docs"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, "workspaces", "ws", "docs", "a.md"),
      "# title\n\nbody one\n",
    );
    backend = new StubBackend(root);
    setBackend(backend);
  });

  afterEach(async () => {
    setBackend(null);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("creates a draft, returns 201 + {draft_id, display_name, base_version}", async () => {
    const req = new Request("http://localhost/api/ui/drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        base_path: DOC,
        base_ref: "main",
        base_version: 1,
        name: "v2",
        initial_threads: [
          {
            targets: [{ path: DOC, char_range: { from: 0, to: 7 } }],
            message: "scope",
          },
        ],
      }),
    });
    const res = await draftsPOST(req);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      draft_id: string;
      display_name: string;
      base_version: number;
    };
    expect(body.draft_id).toMatch(/^draft_/);
    expect(body.base_version).toBe(1);
    expect(body.display_name).toMatch(/^v2 #[a-f0-9]{4}$/);

    const drafts = await backend.listDrafts();
    expect(drafts.some((d) => d.draft_id === body.draft_id)).toBe(true);
  });

  it("rejects invalid bodies with 400", async () => {
    const req = new Request("http://localhost/api/ui/drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ base_path: DOC }),
    });
    const res = await draftsPOST(req);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/ui/drafts/[id] (Phase D)", () => {
  let root: string;
  let backend: StubBackend;
  const DOC = "workspaces/ws/docs/a.md";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-tools-"));
    await fs.mkdir(path.join(root, "workspaces", "ws", "docs"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, "workspaces", "ws", "docs", "a.md"),
      "# title\n\nbody one\n\nbody two\n",
    );
    backend = new StubBackend(root);
    setBackend(backend);
  });

  afterEach(async () => {
    setBackend(null);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns the banner shape: display_name, base_version, touches, open_count, state", async () => {
    const created = await backend.forkAndAttachThreads({
      base_path: DOC,
      base_version: 1,
      name: "v2",
      author: "alice",
      initial_threads: [
        {
          targets: [{ path: DOC, char_range: { from: 0, to: 7 } }],
          message: "scope",
        },
        {
          targets: [{ path: DOC, char_range: { from: 9, to: 17 } }],
          message: "tighten",
        },
      ],
    });

    const req = new Request(
      `http://localhost/api/ui/drafts/${created.draft_id}`,
    );
    const res = await draftIdGET(req, {
      params: Promise.resolve({ id: created.draft_id }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      draft_id: string;
      display_name: string;
      base_version: number;
      touches: string[];
      open_count: number;
      state: string;
    };
    expect(body.draft_id).toBe(created.draft_id);
    expect(body.display_name).toBe(created.display_name);
    expect(body.base_version).toBe(1);
    expect(body.touches).toEqual([DOC]);
    expect(body.open_count).toBe(2);
    expect(body.state).toBe("open");
  });

  it("returns 404 for a non-existent draft", async () => {
    const id = "draft_doesnotexist";
    const req = new Request(`http://localhost/api/ui/drafts/${id}`);
    const res = await draftIdGET(req, {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(404);
  });
});

describe("backend open_count derivation (Phase D)", () => {
  let root: string;
  let backend: StubBackend;
  const DOC = "workspaces/ws/docs/a.md";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-tools-"));
    await fs.mkdir(path.join(root, "workspaces", "ws", "docs"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, "workspaces", "ws", "docs", "a.md"),
      "# title\n\nbody one\n\nbody two\n",
    );
    backend = new StubBackend(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("open_count drops when a thread is resolved", async () => {
    const { draft_id } = await backend.forkAndAttachThreads({
      base_path: DOC,
      base_version: 1,
      name: "v2",
      initial_threads: [
        {
          targets: [{ path: DOC, char_range: { from: 0, to: 7 } }],
          message: "a",
        },
        {
          targets: [{ path: DOC, char_range: { from: 9, to: 17 } }],
          message: "b",
        },
      ],
    });

    const before = await backend.listThreads({ ref: draft_id });
    const beforeOpen = before.filter((t) => t.status === "open").length;
    expect(beforeOpen).toBe(2);

    const firstId = before[0].id;
    await backend.resolveThread(firstId);

    const after = await backend.listThreads({ ref: draft_id });
    const afterOpen = after.filter((t) => t.status === "open").length;
    expect(afterOpen).toBe(1);
  });
});

describe("backend.subscribe agent_presence (Phase E)", () => {
  let root: string;
  let backend: StubBackend;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-tools-"));
    await fs.mkdir(path.join(root, "workspaces", "ws", "docs"), {
      recursive: true,
    });
    backend = new StubBackend(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("emits agent_presence{connected:true} to all subscribers when the first agent subscribes", () => {
    const uiEvents: BackendEvent[] = [];
    backend.subscribe((e) => uiEvents.push(e), { role: "ui" });
    // The synthetic-on-connect frame above goes first; clear it so we just
    // assert on what arrives after the agent shows up.
    uiEvents.length = 0;

    const agentEvents: BackendEvent[] = [];
    backend.subscribe((e) => agentEvents.push(e), { role: "agent" });

    expect(uiEvents).toContainEqual({
      kind: "agent_presence",
      connected: true,
    });
    expect(agentEvents).toContainEqual({
      kind: "agent_presence",
      connected: true,
    });
  });

  it("emits agent_presence{connected:false,last_seen} when the last agent unsubscribes", () => {
    const uiEvents: BackendEvent[] = [];
    backend.subscribe((e) => uiEvents.push(e), { role: "ui" });
    const unsub = backend.subscribe(() => {}, { role: "agent" });

    uiEvents.length = 0;
    const t0 = Date.now();
    unsub();

    const presenceEvents = uiEvents.filter(
      (e) => e.kind === "agent_presence",
    );
    expect(presenceEvents).toHaveLength(1);
    const evt = presenceEvents[0];
    if (evt.kind !== "agent_presence")
      throw new Error("unreachable: filtered above");
    expect(evt.connected).toBe(false);
    expect(typeof evt.last_seen).toBe("number");
    // last_seen should be roughly "now"; allow a generous window for slow CI.
    expect(evt.last_seen!).toBeGreaterThanOrEqual(t0 - 1);
  });

  it("replays current presence to a new UI subscriber when no agent is connected", () => {
    const events: BackendEvent[] = [];
    backend.subscribe((e) => events.push(e), { role: "ui" });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "agent_presence",
      connected: false,
    });
  });

  it("does not double-fire when a second agent subscribes (still connected)", () => {
    backend.subscribe(() => {}, { role: "agent" });

    const uiEvents: BackendEvent[] = [];
    backend.subscribe((e) => uiEvents.push(e), { role: "ui" });
    // After the synthetic replay, only the next transition should arrive.
    uiEvents.length = 0;

    backend.subscribe(() => {}, { role: "agent" });
    const presence = uiEvents.filter((e) => e.kind === "agent_presence");
    expect(presence).toHaveLength(0);
  });
});

describe("backend.attachDraftPayload (Phase F)", () => {
  let root: string;
  let backend: StubBackend;
  const DOC = "workspaces/ws/docs/a.md";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-tools-"));
    await fs.mkdir(path.join(root, "workspaces", "ws", "docs"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, "workspaces", "ws", "docs", "a.md"),
      "# title\n\nbody one\n\nbody two\n",
    );
    backend = new StubBackend(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("appends a system-style message carrying the single `draft` payload and emits thread_changed", async () => {
    const { draft_id } = await backend.forkAndAttachThreads({
      base_path: DOC,
      base_version: 1,
      name: "v2",
      initial_threads: [
        {
          targets: [{ path: DOC, char_range: { from: 9, to: 17 } }],
          message: "tighten",
        },
      ],
    });
    const [t] = await backend.listThreads({ ref: draft_id });

    const events: BackendEvent[] = [];
    backend.subscribe((e) => events.push(e), { role: "ui" });
    events.length = 0;

    await backend.attachDraftPayload(t.id, {
      message: "cut ~40%, same beats",
      draft: { new_md: "tightened body\n" },
    });

    const after = await backend.readThread(t.id);
    const last = after.messages[after.messages.length - 1];
    expect(last.body).toBe("cut ~40%, same beats");
    expect(last.draft).toEqual({ new_md: "tightened body\n" });
    expect(last.draft_options).toBeUndefined();
    expect(last.author).toBe("system");

    const changed = events.filter((e) => e.kind === "thread_changed");
    expect(changed).toHaveLength(1);
  });

  it("appends a system-style message carrying multi-leaf `draft_options`", async () => {
    const { draft_id } = await backend.forkAndAttachThreads({
      base_path: DOC,
      base_version: 1,
      name: "v2",
      initial_threads: [
        {
          targets: [{ path: DOC, char_range: { from: 9, to: 17 } }],
          message: "rewrite",
        },
      ],
    });
    const [t] = await backend.listThreads({ ref: draft_id });

    await backend.attachDraftPayload(t.id, {
      message: "two angles; pick one",
      draft_options: [
        { name: "option a", new_md: "depth\n" },
        { name: "option b", new_md: "breadth\n" },
      ],
    });

    const after = await backend.readThread(t.id);
    const last = after.messages[after.messages.length - 1];
    expect(last.draft_options).toEqual([
      { name: "option a", new_md: "depth\n" },
      { name: "option b", new_md: "breadth\n" },
    ]);
    expect(last.draft).toBeUndefined();
  });

  it("rejects calls with neither `draft` nor `draft_options` set", async () => {
    const { draft_id } = await backend.forkAndAttachThreads({
      base_path: DOC,
      base_version: 1,
      name: "v2",
      initial_threads: [
        {
          targets: [{ path: DOC, char_range: { from: 9, to: 17 } }],
          message: "tighten",
        },
      ],
    });
    const [t] = await backend.listThreads({ ref: draft_id });

    await expect(
      backend.attachDraftPayload(t.id, { message: "no payload" }),
    ).rejects.toThrow();
  });

  it("rejects calls with both `draft` and `draft_options` set simultaneously", async () => {
    const { draft_id } = await backend.forkAndAttachThreads({
      base_path: DOC,
      base_version: 1,
      name: "v2",
      initial_threads: [
        {
          targets: [{ path: DOC, char_range: { from: 9, to: 17 } }],
          message: "tighten",
        },
      ],
    });
    const [t] = await backend.listThreads({ ref: draft_id });

    await expect(
      backend.attachDraftPayload(t.id, {
        draft: { new_md: "x\n" },
        draft_options: [
          { name: "a", new_md: "x\n" },
          { name: "b", new_md: "y\n" },
        ],
      }),
    ).rejects.toThrow();
  });
});

describe("POST /api/ui/threads/[id]/payload (Phase F)", () => {
  let root: string;
  let backend: StubBackend;
  const DOC = "workspaces/ws/docs/a.md";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-tools-"));
    await fs.mkdir(path.join(root, "workspaces", "ws", "docs"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, "workspaces", "ws", "docs", "a.md"),
      "# title\n\nbody one\n\nbody two\n",
    );
    backend = new StubBackend(root);
    setBackend(backend);
  });

  afterEach(async () => {
    setBackend(null);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns 201 on a valid single-payload body", async () => {
    const { draft_id } = await backend.forkAndAttachThreads({
      base_path: DOC,
      base_version: 1,
      name: "v2",
      initial_threads: [
        {
          targets: [{ path: DOC, char_range: { from: 9, to: 17 } }],
          message: "tighten",
        },
      ],
    });
    const [t] = await backend.listThreads({ ref: draft_id });

    const req = new Request(
      `http://localhost/api/ui/threads/${t.id}/payload`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "cut ~40%",
          draft: { new_md: "tightened\n" },
        }),
      },
    );
    const res = await payloadPOST(req, {
      params: Promise.resolve({ id: t.id }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok?: boolean };
    expect(body.ok).toBe(true);
  });

  it("returns 400 when the body has neither `draft` nor `draft_options`", async () => {
    const { draft_id } = await backend.forkAndAttachThreads({
      base_path: DOC,
      base_version: 1,
      name: "v2",
      initial_threads: [
        {
          targets: [{ path: DOC, char_range: { from: 9, to: 17 } }],
          message: "tighten",
        },
      ],
    });
    const [t] = await backend.listThreads({ ref: draft_id });

    const req = new Request(
      `http://localhost/api/ui/threads/${t.id}/payload`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "empty" }),
      },
    );
    const res = await payloadPOST(req, {
      params: Promise.resolve({ id: t.id }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 on malformed JSON", async () => {
    const { draft_id } = await backend.forkAndAttachThreads({
      base_path: DOC,
      base_version: 1,
      name: "v2",
      initial_threads: [
        {
          targets: [{ path: DOC, char_range: { from: 9, to: 17 } }],
          message: "x",
        },
      ],
    });
    const [t] = await backend.listThreads({ ref: draft_id });
    const req = new Request(
      `http://localhost/api/ui/threads/${t.id}/payload`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      },
    );
    const res = await payloadPOST(req, {
      params: Promise.resolve({ id: t.id }),
    });
    expect(res.status).toBe(400);
  });
});

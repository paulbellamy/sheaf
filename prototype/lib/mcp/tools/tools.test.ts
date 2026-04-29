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
import { POST as acceptPOST } from "../../../app/api/ui/drafts/[id]/accept/route";
import { POST as payloadPOST } from "../../../app/api/ui/threads/[id]/payload/route";
import { POST as reopenPOST } from "../../../app/api/ui/threads/[id]/reopen/route";
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

  it("returns the base_path entry for a fresh draft with no writes (main_md === draft_md)", async () => {
    const [draftId] = await backend.fork("workspaces/ws/docs/a.md", 1);
    const changes = await backend.draftChanges(draftId);
    expect(changes).toHaveLength(1);
    expect(changes[0].path).toBe("workspaces/ws/docs/a.md");
    expect(changes[0].main_md).toBe("# a\n");
    expect(changes[0].draft_md).toBe("# a\n");
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

describe("backend.fork(parent=...) sub-drafts (Phase G)", () => {
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
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("backwards compat: fork(path, n) without parent leaves parent_draft_id undefined", async () => {
    const [id] = await backend.fork(DOC, 1);
    const drafts = await backend.listDrafts();
    const created = drafts.find((d) => d.draft_id === id);
    expect(created).toBeDefined();
    expect(created!.parent_draft_id).toBeUndefined();
  });

  it("fork with parent returns sub-drafts whose parent_draft_id matches", async () => {
    const [parentId] = await backend.fork(DOC, 1);
    const subIds = await backend.fork(DOC, 2, undefined, undefined, parentId);
    expect(subIds).toHaveLength(2);

    const drafts = await backend.listDrafts();
    for (const subId of subIds) {
      const sub = drafts.find((d) => d.draft_id === subId);
      expect(sub).toBeDefined();
      expect(sub!.parent_draft_id).toBe(parentId);
      expect(sub!.base_path).toBe(DOC);
    }
  });

  it("a sub-draft sees the parent's edits, not main", async () => {
    const [parentId] = await backend.fork(DOC, 1);
    await backend.writeDoc(DOC, parentId, "# title\n\nparent edit\n");

    const [subId] = await backend.fork(DOC, 1, undefined, undefined, parentId);
    const subView = await backend.readDoc(DOC, subId);
    expect(subView.md).toBe("# title\n\nparent edit\n");

    // Main is unchanged.
    const mainView = await backend.readDoc(DOC, "main");
    expect(mainView.md).toBe("# title\n\nbody one\n");
  });

  it("a sub-draft's working copy is independent of the parent after fork", async () => {
    const [parentId] = await backend.fork(DOC, 1);
    await backend.writeDoc(DOC, parentId, "# title\n\nparent v1\n");
    const [subId] = await backend.fork(DOC, 1, undefined, undefined, parentId);

    // Edit the parent again; the sub-draft should keep its snapshot.
    await backend.writeDoc(DOC, parentId, "# title\n\nparent v2\n");
    const subView = await backend.readDoc(DOC, subId);
    expect(subView.md).toBe("# title\n\nparent v1\n");

    // Edit only the sub-draft; the parent should be unaffected.
    await backend.writeDoc(DOC, subId, "# title\n\nsub edit\n");
    const parentView = await backend.readDoc(DOC, parentId);
    expect(parentView.md).toBe("# title\n\nparent v2\n");
  });

  it("sub-draft inherits base_version from the parent (lineage back to main)", async () => {
    const [parentId] = await backend.fork(DOC, 1);
    const [parentSummary] = (await backend.listDrafts()).filter(
      (d) => d.draft_id === parentId,
    );
    const [subId] = await backend.fork(DOC, 1, undefined, undefined, parentId);
    const drafts = await backend.listDrafts();
    const sub = drafts.find((d) => d.draft_id === subId);
    expect(sub!.base_version).toBe(parentSummary.base_version);
  });

  it("rejects fork(parent=...) when path differs from the parent's base_path", async () => {
    await fs.writeFile(
      path.join(root, "workspaces", "ws", "docs", "b.md"),
      "# b\n",
    );
    const OTHER = "workspaces/ws/docs/b.md";
    const [parentId] = await backend.fork(DOC, 1);
    await expect(
      backend.fork(OTHER, 1, undefined, undefined, parentId),
    ).rejects.toThrow();
  });

  it("_cascadeDeclineSubDrafts declines all unaccepted sub-drafts of the parent", async () => {
    const [parentId] = await backend.fork(DOC, 1);
    const [a, b, c] = await backend.fork(
      DOC,
      3,
      undefined,
      undefined,
      parentId,
    );
    // Mark one sub-draft accepted: it must not be touched.
    await backend.propose(a);
    await backend.merge(a);
    // Independent draft (different parent, no parent at all): must not be touched.
    const [other] = await backend.fork(DOC, 1);

    const declined = await backend._cascadeDeclineSubDrafts(parentId);
    expect(new Set(declined)).toEqual(new Set([b, c]));

    const drafts = await backend.listDrafts();
    const get = (id: string) => drafts.find((d) => d.draft_id === id)!;
    expect(get(a).state).toBe("accepted");
    expect(get(b).state).toBe("declined");
    expect(get(c).state).toBe("declined");
    expect(get(other).state).toBe("open");
    expect(get(parentId).state).toBe("open");
  });

  it("_cascadeDeclineSubDrafts is a no-op when the parent has no sub-drafts", async () => {
    const [parentId] = await backend.fork(DOC, 1);
    const declined = await backend._cascadeDeclineSubDrafts(parentId);
    expect(declined).toEqual([]);
  });
});

describe("backend cross-cutting drafts (Phase H)", () => {
  let root: string;
  let backend: StubBackend;
  const DOC_A = "workspaces/ws/docs/a.md";
  const DOC_B = "workspaces/ws/docs/b.md";
  const DOC_C = "workspaces/ws/docs/c.md";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-tools-"));
    await fs.mkdir(path.join(root, "workspaces", "ws", "docs"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, "workspaces", "ws", "docs", "a.md"),
      "# a\nbody\n",
    );
    await fs.writeFile(
      path.join(root, "workspaces", "ws", "docs", "b.md"),
      "# b\nbody\n",
    );
    await fs.writeFile(
      path.join(root, "workspaces", "ws", "docs", "c.md"),
      "# c\nbody\n",
    );
    backend = new StubBackend(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const touchesOf = async (id: string): Promise<string[]> => {
    const drafts = await backend.listDrafts();
    return drafts.find((d) => d.draft_id === id)!.touches;
  };

  it("editDoc against a path outside touches appends it", async () => {
    const [draftId] = await backend.fork(DOC_A, 1);
    expect(await touchesOf(draftId)).toEqual([DOC_A]);

    await backend.editDoc(DOC_B, draftId, "# b", "# b v2", false);

    expect(await touchesOf(draftId)).toEqual([DOC_A, DOC_B]);
  });

  it("writeDoc against a path outside touches appends it", async () => {
    const [draftId] = await backend.fork(DOC_A, 1);

    await backend.writeDoc(DOC_B, draftId, "# b v2\n");

    expect(await touchesOf(draftId)).toEqual([DOC_A, DOC_B]);
  });

  it("addThread targeting a new path appends it to touches", async () => {
    const [draftId] = await backend.fork(DOC_A, 1);

    await backend.addThread({
      ref: draftId,
      targets: [{ path: DOC_B, char_range: { from: 0, to: 3 } }],
      message: "rename",
    });

    expect(await touchesOf(draftId)).toEqual([DOC_A, DOC_B]);
  });

  it("does not duplicate a path written multiple times", async () => {
    const [draftId] = await backend.fork(DOC_A, 1);

    await backend.writeDoc(DOC_B, draftId, "# b v2\n");
    await backend.writeDoc(DOC_B, draftId, "# b v3\n");
    await backend.editDoc(DOC_B, draftId, "v3", "v4", false);

    expect(await touchesOf(draftId)).toEqual([DOC_A, DOC_B]);
  });

  it("a multi-target thread spanning two new paths adds both", async () => {
    const [draftId] = await backend.fork(DOC_A, 1);

    await backend.addThread({
      ref: draftId,
      targets: [
        { path: DOC_B, char_range: { from: 0, to: 3 } },
        { path: DOC_C, char_range: { from: 0, to: 3 } },
      ],
      message: "cross-cutting rename",
    });

    const touches = await touchesOf(draftId);
    expect(new Set(touches)).toEqual(new Set([DOC_A, DOC_B, DOC_C]));
  });

  it("draftChanges returns entries for every path in touches", async () => {
    const [draftId] = await backend.fork(DOC_A, 1);
    await backend.writeDoc(DOC_B, draftId, "# b v2\n");
    await backend.addThread({
      ref: draftId,
      targets: [{ path: DOC_C, char_range: { from: 0, to: 3 } }],
      message: "thread on c",
    });

    const changes = await backend.draftChanges(draftId);
    const paths = changes.map((c) => c.path).sort();
    expect(paths).toEqual([DOC_A, DOC_B, DOC_C].sort());

    // The path with no override falls back to main_md on both sides.
    const cEntry = changes.find((c) => c.path === DOC_C)!;
    expect(cEntry.main_md).toBe("# c\nbody\n");
    expect(cEntry.draft_md).toBe("# c\nbody\n");

    // The edited path shows the override on draft_md.
    const bEntry = changes.find((c) => c.path === DOC_B)!;
    expect(bEntry.main_md).toBe("# b\nbody\n");
    expect(bEntry.draft_md).toBe("# b v2\n");
  });
});

describe("backend.merge atomic accept (Phase I)", () => {
  let root: string;
  let backend: StubBackend;
  const DOC_A = "workspaces/ws/docs/a.md";
  const DOC_B = "workspaces/ws/docs/b.md";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-tools-"));
    await fs.mkdir(path.join(root, "workspaces", "ws", "docs"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, "workspaces", "ws", "docs", "a.md"),
      "# a\nbody\n",
    );
    await fs.writeFile(
      path.join(root, "workspaces", "ws", "docs", "b.md"),
      "# b\nbody\n",
    );
    backend = new StubBackend(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("single-doc merge: bumps version, lands content, accepts state, emits versions", async () => {
    // Read once so the counter for DOC_A is initialized to 1.
    await backend.readDoc(DOC_A);
    const [draftId] = await backend.fork(DOC_A, 1);
    await backend.writeDoc(DOC_A, draftId, "# a v2\nbody v2\n");
    await backend.propose(draftId);

    const events: BackendEvent[] = [];
    backend.subscribe((e) => events.push(e));

    const result = await backend.merge(draftId);
    expect(result.versions).toEqual([{ path: DOC_A, from: 1, to: 2 }]);
    expect(result.commit).toMatch(/^c-/);

    const main = await backend.readDoc(DOC_A);
    expect(main.md).toBe("# a v2\nbody v2\n");
    expect(main.version_counter).toBe(2);

    const drafts = await backend.listDrafts();
    expect(drafts.find((d) => d.draft_id === draftId)!.state).toBe("accepted");

    const merged = events.filter((e) => e.kind === "draft_merged");
    expect(merged).toHaveLength(1);
    const evt = merged[0];
    if (evt.kind !== "draft_merged") throw new Error("unreachable");
    expect(evt.versions).toEqual([{ path: DOC_A, from: 1, to: 2 }]);
    expect(evt.target_paths).toEqual([DOC_A]);
  });

  it("cross-cutting merge: bumps every touched path atomically", async () => {
    await backend.readDoc(DOC_A);
    await backend.readDoc(DOC_B);
    const [draftId] = await backend.fork(DOC_A, 1);
    await backend.writeDoc(DOC_A, draftId, "# a v2\nbody\n");
    await backend.writeDoc(DOC_B, draftId, "# b v2\nbody\n");
    await backend.propose(draftId);

    const result = await backend.merge(draftId);
    expect(result.versions).toHaveLength(2);
    const byPath = new Map(result.versions.map((v) => [v.path, v]));
    expect(byPath.get(DOC_A)).toEqual({ path: DOC_A, from: 1, to: 2 });
    expect(byPath.get(DOC_B)).toEqual({ path: DOC_B, from: 1, to: 2 });

    const a = await backend.readDoc(DOC_A);
    const b = await backend.readDoc(DOC_B);
    expect(a.md).toBe("# a v2\nbody\n");
    expect(b.md).toBe("# b v2\nbody\n");
    expect(a.version_counter).toBe(2);
    expect(b.version_counter).toBe(2);
  });

  it("conflict: throws merge_conflict, leaves main untouched, draft state unchanged", async () => {
    await backend.readDoc(DOC_A);
    const [draftId] = await backend.fork(DOC_A, 1);
    await backend.writeDoc(DOC_A, draftId, "# a v2\nbody\n");
    await backend.propose(draftId);

    // Simulate a competing accept landing on main: another draft bumps the
    // counter for DOC_A past the draft's base_version.
    const [other] = await backend.fork(DOC_A, 1);
    await backend.writeDoc(DOC_A, other, "# a other\nbody\n");
    await backend.propose(other);
    await backend.merge(other);

    const events: BackendEvent[] = [];
    backend.subscribe((e) => events.push(e));

    let thrown: unknown;
    try {
      await backend.merge(draftId);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe("merge_conflict");
    expect((thrown as { conflicts?: unknown[] }).conflicts).toEqual([
      { path: DOC_A, base_version: 1, main_version: 2 },
    ]);

    // Main reflects the *other* draft, not this one. No new merge events.
    const main = await backend.readDoc(DOC_A);
    expect(main.md).toBe("# a other\nbody\n");
    expect(main.version_counter).toBe(2);

    const drafts = await backend.listDrafts();
    const meta = drafts.find((d) => d.draft_id === draftId)!;
    expect(meta.state).toBe("submitted");

    expect(events.filter((e) => e.kind === "draft_merged")).toHaveLength(0);
  });

  it("cascades-decline unaccepted sub-drafts on parent merge", async () => {
    await backend.readDoc(DOC_A);
    const [parentId] = await backend.fork(DOC_A, 1);
    const [subA, subB] = await backend.fork(
      DOC_A,
      2,
      undefined,
      undefined,
      parentId,
    );
    await backend.writeDoc(DOC_A, parentId, "# a v2\nbody\n");
    await backend.propose(parentId);

    await backend.merge(parentId);

    const drafts = await backend.listDrafts();
    expect(drafts.find((d) => d.draft_id === subA)!.state).toBe("declined");
    expect(drafts.find((d) => d.draft_id === subB)!.state).toBe("declined");
  });
});

describe("POST /api/ui/drafts/[id]/accept (Phase I)", () => {
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
      "# a\nbody\n",
    );
    backend = new StubBackend(root);
    setBackend(backend);
  });

  afterEach(async () => {
    setBackend(null);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns 200 with {commit, versions} on success", async () => {
    await backend.readDoc(DOC);
    const [draftId] = await backend.fork(DOC, 1);
    await backend.writeDoc(DOC, draftId, "# a v2\nbody\n");

    const req = new Request(
      `http://localhost/api/ui/drafts/${draftId}/accept`,
      { method: "POST" },
    );
    const res = await acceptPOST(req, {
      params: Promise.resolve({ id: draftId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      commit: string;
      versions: { path: string; from: number; to: number }[];
    };
    expect(body.ok).toBe(true);
    expect(body.commit).toMatch(/^c-/);
    expect(body.versions).toEqual([{ path: DOC, from: 1, to: 2 }]);
  });

  it("returns 409 with {conflicts} when main has advanced past base_version", async () => {
    await backend.readDoc(DOC);
    const [draftId] = await backend.fork(DOC, 1);
    await backend.writeDoc(DOC, draftId, "# a v2\nbody\n");

    const [other] = await backend.fork(DOC, 1);
    await backend.writeDoc(DOC, other, "# a other\nbody\n");
    await backend.propose(other);
    await backend.merge(other);

    const req = new Request(
      `http://localhost/api/ui/drafts/${draftId}/accept`,
      { method: "POST" },
    );
    const res = await acceptPOST(req, {
      params: Promise.resolve({ id: draftId }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      code: string;
      conflicts: { path: string; base_version: number; main_version: number }[];
    };
    expect(body.code).toBe("merge_conflict");
    expect(body.conflicts).toEqual([
      { path: DOC, base_version: 1, main_version: 2 },
    ]);
  });
});

describe("backend versions_behind on DraftSummary (Phase J)", () => {
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
      "# a\nbody\n",
    );
    backend = new StubBackend(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("is 0 for a fresh draft pinned to current main", async () => {
    await backend.readDoc(DOC);
    const [draftId] = await backend.fork(DOC, 1);
    const drafts = await backend.listDrafts();
    expect(drafts.find((d) => d.draft_id === draftId)!.versions_behind).toBe(
      0,
    );
  });

  it("advances when a sibling draft accepts to main", async () => {
    await backend.readDoc(DOC);
    const [draftId] = await backend.fork(DOC, 1);

    const [other] = await backend.fork(DOC, 1);
    await backend.writeDoc(DOC, other, "# a v2\nbody\n");
    await backend.propose(other);
    await backend.merge(other);

    const drafts = await backend.listDrafts();
    expect(drafts.find((d) => d.draft_id === draftId)!.versions_behind).toBe(
      1,
    );
  });

  it("clamps to 0 when the main counter has not advanced", async () => {
    const [draftId] = await backend.fork(DOC, 1);
    // No reads on main, no merges. main counter is unset; versions_behind
    // must not go negative.
    const drafts = await backend.listDrafts();
    expect(drafts.find((d) => d.draft_id === draftId)!.versions_behind).toBe(
      0,
    );
  });
});

describe("backend.reopenThread (Phase J)", () => {
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

  it("flips an accepted thread to open and appends a `current` leaf", async () => {
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
    await backend.resolveThread(t.id);

    const events: BackendEvent[] = [];
    backend.subscribe((e) => events.push(e), { role: "ui" });
    events.length = 0;

    await backend.reopenThread(t.id);

    const after = await backend.readThread(t.id);
    expect(after.status).toBe("open");
    const last = after.messages[after.messages.length - 1];
    expect(last.author).toBe("system");
    expect(last.draft_options).toBeDefined();
    expect(last.draft_options).toHaveLength(1);
    expect(last.draft_options![0].name).toBe("current");
    expect(typeof last.draft_options![0].new_md).toBe("string");

    const changed = events.filter((e) => e.kind === "thread_changed");
    expect(changed).toHaveLength(1);
  });

  it("rejects reopening an already-open thread", async () => {
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
    await expect(backend.reopenThread(t.id)).rejects.toThrow();
  });
});

describe("backend.merge accept_blocked gating (Phase J)", () => {
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
      "# a\nbody\n",
    );
    backend = new StubBackend(root);
    setBackend(backend);
  });

  afterEach(async () => {
    setBackend(null);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("merge throws accept_blocked when an open thread remains", async () => {
    const { draft_id } = await backend.forkAndAttachThreads({
      base_path: DOC,
      base_version: 1,
      name: "v2",
      initial_threads: [
        {
          targets: [{ path: DOC, char_range: { from: 0, to: 3 } }],
          message: "scope",
        },
      ],
    });
    await backend.propose(draft_id);

    let thrown: unknown;
    try {
      await backend.merge(draft_id);
    } catch (e) {
      thrown = e;
    }
    expect((thrown as { code?: string }).code).toBe("accept_blocked");
    expect((thrown as { open_count?: number }).open_count).toBe(1);
  });

  it("accept route returns 422 with open_count when the gate trips", async () => {
    const { draft_id } = await backend.forkAndAttachThreads({
      base_path: DOC,
      base_version: 1,
      name: "v2",
      initial_threads: [
        {
          targets: [{ path: DOC, char_range: { from: 0, to: 3 } }],
          message: "scope",
        },
      ],
    });

    const req = new Request(
      `http://localhost/api/ui/drafts/${draft_id}/accept`,
      { method: "POST" },
    );
    const res = await acceptPOST(req, {
      params: Promise.resolve({ id: draft_id }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      code: string;
      open_count: number;
    };
    expect(body.code).toBe("accept_blocked");
    expect(body.open_count).toBe(1);
  });
});

describe("POST /api/ui/threads/[id]/reopen (Phase J)", () => {
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

  it("returns 200 on success", async () => {
    const { draft_id } = await backend.forkAndAttachThreads({
      base_path: DOC,
      base_version: 1,
      name: "v2",
      initial_threads: [
        {
          targets: [{ path: DOC, char_range: { from: 0, to: 3 } }],
          message: "scope",
        },
      ],
    });
    const [t] = await backend.listThreads({ ref: draft_id });
    await backend.resolveThread(t.id);

    const req = new Request(
      `http://localhost/api/ui/threads/${t.id}/reopen`,
      { method: "POST" },
    );
    const res = await reopenPOST(req, {
      params: Promise.resolve({ id: t.id }),
    });
    expect(res.status).toBe(200);
  });

  it("returns 404 on missing thread", async () => {
    const id = "thrd_doesnotexist";
    const req = new Request(`http://localhost/api/ui/threads/${id}/reopen`, {
      method: "POST",
    });
    const res = await reopenPOST(req, {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(404);
  });
});

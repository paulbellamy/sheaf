import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StubBackend } from "../backend/stub";
import { buildSheafApp } from "../app";
import type { Backend, BackendEvent } from "../backend";

// Test-local backend registry. The old `getBackend`/`setBackend` module factory
// is gone (the CLI/daemon constructs its backend directly), so these route-shim
// tests hold the current backend here instead: each suite's `beforeEach` calls
// `setBackend(backend)` and its `afterEach` calls `setBackend(null)`, and the
// `dispatch` shim builds the app against whatever is set.
let activeBackend: Backend | null = null;
function setBackend(backend: Backend | null): void {
  activeBackend = backend;
}
function getBackend(): Backend {
  if (!activeBackend) throw new Error("test backend not set");
  return activeBackend;
}

/**
 * The HTTP-route tests below predate the Fastify app: they were written
 * against the Next route handlers (one `(req, ctx)` function per route). Now
 * that the routes live in one shared Fastify app, these shims preserve the
 * old call signatures by dispatching the `Request` through `app.inject()` —
 * exercising the real app end-to-end. The `ctx` arg (params) is ignored
 * because the id/path is already in the request URL.
 */
type RouteRes = { status: number; json: () => Promise<unknown> };

async function dispatch(req: Request): Promise<RouteRes> {
  const url = new URL(req.url);
  const app = buildSheafApp(getBackend());
  await app.ready();
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headers[k] = v;
  });
  // Web `Request` doesn't expose Host; set it from the URL so the app's
  // loopback Host guard passes (test URLs use http://localhost/...).
  headers.host = url.host;
  const bodyText =
    req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
  try {
    const res = await app.inject({
      method: req.method as "GET" | "POST" | "DELETE" | "PUT" | "PATCH",
      url: url.pathname + url.search,
      headers,
      payload: bodyText.length > 0 ? bodyText : undefined,
    });
    return { status: res.statusCode, json: async () => res.json() };
  } finally {
    await app.close();
  }
}

const threadsGET = (req: Request) => dispatch(req);
const threadsPOST = (req: Request) => dispatch(req);
const reopenPOST = (req: Request, _ctx?: unknown) => dispatch(req);
const resolvePOST = (req: Request, _ctx?: unknown) => dispatch(req);
const replyPOST = (req: Request, _ctx?: unknown) => dispatch(req);

describe("threads route (thread-on-doc)", () => {
  let root: string;
  let backend: StubBackend;
  const docPath = "workspaces/ws/docs/a.md";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-threads-main-"));
    await fs.mkdir(path.join(root, "workspaces", "ws", "docs"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, "workspaces", "ws", "docs", "a.md"),
      "hello world",
    );
    backend = new StubBackend(root);
    setBackend(backend);
  });

  afterEach(async () => {
    setBackend(null);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("POST creates a thread anchored to the doc and returns 201", async () => {
    const req = new Request("http://localhost/api/ui/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: docPath,
        targets: [{ char_range: { from: 0, to: 5 } }],
        message: "tighten this",
      }),
    });
    const res = await threadsPOST(req);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { thread_id?: string };
    expect(body.thread_id).toMatch(/^thrd_/);
  });

  it("GET returns a doc's threads (no ?ref)", async () => {
    await backend.addThread({
      targets: [{ path: docPath, char_range: { from: 0, to: 5 } }],
      message: "tighten this",
      author: "user",
    });
    const req = new Request(
      `http://localhost/api/ui/threads?path=${encodeURIComponent(docPath)}`,
    );
    const res = await threadsGET(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { threads: { id: string }[] };
    expect(body.threads.length).toBeGreaterThan(0);
  });
});

describe("writeDoc/editDoc land on the doc (thread-on-doc)", () => {
  let root: string;
  let backend: StubBackend;
  const docPath = "workspaces/ws/docs/a.md";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-writemain-"));
    await fs.mkdir(path.join(root, "workspaces", "ws", "docs"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, "workspaces", "ws", "docs", "a.md"),
      "hello world",
    );
    backend = new StubBackend(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("writeDoc lands on disk and emits doc_changed", async () => {
    const events: BackendEvent[] = [];
    backend.subscribe((e) => events.push(e));
    await backend.writeDoc(docPath, "rewritten");
    const onDisk = await fs.readFile(
      path.join(root, "workspaces", "ws", "docs", "a.md"),
      "utf8",
    );
    expect(onDisk).toBe("rewritten");
    expect(events).toContainEqual({ kind: "doc_changed", path: docPath });
  });

  it("editDoc replaces in place and emits doc_changed", async () => {
    const events: BackendEvent[] = [];
    backend.subscribe((e) => events.push(e));
    await backend.editDoc(docPath, "world", "obsidian", false);
    const onDisk = await fs.readFile(
      path.join(root, "workspaces", "ws", "docs", "a.md"),
      "utf8",
    );
    expect(onDisk).toBe("hello obsidian");
    expect(events).toContainEqual({ kind: "doc_changed", path: docPath });
  });
});

describe("doc-level threads (scope=doc)", () => {
  let root: string;
  let backend: StubBackend;
  const docPath = "workspaces/ws/docs/a.md";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-doc-thread-"));
    await fs.mkdir(path.join(root, "workspaces", "ws", "docs"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, "workspaces", "ws", "docs", "a.md"),
      "hello world",
    );
    backend = new StubBackend(root);
    setBackend(backend);
  });

  afterEach(async () => {
    setBackend(null);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("addThread stores a target with scope=doc and no anchor", async () => {
    const id = await backend.addThread({
      targets: [{ path: docPath, scope: "doc" }],
      message: "rewrite this for tone",
      author: "user",
    });
    const thread = await backend.readThread(id);
    expect(thread.targets).toHaveLength(1);
    expect(thread.targets[0].scope).toBe("doc");
    expect("anchor" in thread.targets[0]).toBe(false);
  });

  it("HTTP POST without char_range creates a doc-level thread", async () => {
    const req = new Request("http://localhost/api/ui/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: docPath,
        targets: [{ scope: "doc" }],
        message: "rewrite this for tone",
      }),
    });
    const res = await threadsPOST(req);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { thread_id: string };
    const thread = await backend.readThread(body.thread_id);
    expect(thread.targets[0].scope).toBe("doc");
  });

  it("HTTP POST with char_range still creates a range thread (back-compat)", async () => {
    const req = new Request("http://localhost/api/ui/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: docPath,
        targets: [{ char_range: { from: 0, to: 5 } }],
        message: "tighten this",
      }),
    });
    const res = await threadsPOST(req);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { thread_id: string };
    const thread = await backend.readThread(body.thread_id);
    expect(thread.targets[0].scope).toBe("range");
    if (thread.targets[0].scope === "range") {
      expect(thread.targets[0].anchor.anchored_text).toBe("hello");
    }
  });

  it("rejects addThread when the doc doesn't exist", async () => {
    await expect(
      backend.addThread({
        targets: [{ path: "workspaces/ws/docs/missing.md", scope: "doc" }],
        message: "fix this",
        author: "user",
      }),
    ).rejects.toThrow();
  });
});

describe("resolve route does NOT auto-apply options to the doc", () => {
  let root: string;
  let backend: StubBackend;
  const docPath = "workspaces/ws/docs/a.md";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-apply-"));
    await fs.mkdir(path.join(root, "workspaces", "ws", "docs"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, "workspaces", "ws", "docs", "a.md"),
      "hello world",
    );
    backend = new StubBackend(root);
    setBackend(backend);
  });

  afterEach(async () => {
    setBackend(null);
    await fs.rm(root, { recursive: true, force: true });
  });

  // Thread-on-doc options are a choice routed back to the agent, not a literal
  // diff. Resolving must NOT write the option's new_md to the doc — the agent
  // makes the real edit.
  it("leaves a range-anchored doc untouched when resolved", async () => {
    const threadId = await backend.addThread({
      targets: [{ path: docPath, scope: "range", char_range: { from: 0, to: 5 } }],
      message: "punchier",
      author: "user",
    });
    await backend.attachDraftPayload(threadId, {
      author: "agent",
      message: "two takes",
      draft_options: [
        { name: "shout", new_md: "HELLO" },
        { name: "soft", new_md: "hey" },
      ],
    });

    const req = new Request(
      `http://localhost/api/ui/threads/${threadId}/resolve`,
      { method: "POST" },
    );
    const res = await resolvePOST(req);
    expect(res.status).toBe(200);
    const { md: onDisk } = await backend.readDoc("workspaces/ws/docs/a.md");
    expect(onDisk).toBe("hello world"); // unchanged — agent will make the edit
    const thread = await backend.readThread(threadId);
    expect(thread.status).toBe("accepted");
  });

  it("leaves a doc-scope doc untouched when resolved", async () => {
    const threadId = await backend.addThread({
      targets: [{ path: docPath, scope: "doc" }],
      message: "rewrite",
      author: "user",
    });
    await backend.attachDraftPayload(threadId, {
      author: "agent",
      draft_options: [
        { name: "minimal", new_md: "# A\nMinimal.\n" },
        { name: "verbose", new_md: "# A\nVery verbose version.\n" },
      ],
    });

    const req = new Request(
      `http://localhost/api/ui/threads/${threadId}/resolve`,
      { method: "POST" },
    );
    const res = await resolvePOST(req);
    expect(res.status).toBe(200);
    const { md: onDisk } = await backend.readDoc("workspaces/ws/docs/a.md");
    expect(onDisk).toBe("hello world"); // unchanged
  });

  it("ignores stale ?option_index/?apply query params (accepts, no doc change)", async () => {
    // Clients from before phase 2 may still send `?option_index=1&apply=true`.
    // The route no longer reads them: the resolve must succeed and the doc must
    // stay untouched (the params are silently ignored, not an error).
    const threadId = await backend.addThread({
      targets: [{ path: docPath, scope: "range", char_range: { from: 0, to: 5 } }],
      message: "fix",
      author: "user",
    });
    await backend.attachDraftPayload(threadId, {
      author: "agent",
      draft_options: [
        { name: "a", new_md: "AAA" },
        { name: "b", new_md: "BBB" },
      ],
    });

    const req = new Request(
      `http://localhost/api/ui/threads/${threadId}/resolve?option_index=1&apply=true`,
      { method: "POST" },
    );
    const res = await resolvePOST(req);
    expect(res.status).toBe(200);
    const { md: onDisk } = await backend.readDoc("workspaces/ws/docs/a.md");
    expect(onDisk).toBe("hello world"); // unchanged — params ignored
    expect((await backend.readThread(threadId)).status).toBe("accepted");
  });
});

describe("backend read/write result shapes", () => {
  let root: string;
  let backend: StubBackend;
  const doc = "workspaces/ws/docs/a.md";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-tools-"));
    await fs.mkdir(path.join(root, "workspaces", "ws", "docs"), {
      recursive: true,
    });
    await fs.writeFile(path.join(root, doc), "# a\n");
    backend = new StubBackend(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("readDoc returns just the markdown", async () => {
    expect(await backend.readDoc(doc)).toEqual({ md: "# a\n" });
  });

  it("writeDoc / editDoc resolve to nothing", async () => {
    expect(await backend.writeDoc(doc, "# a v2\n")).toBeUndefined();
    expect(await backend.editDoc(doc, "v2", "v3", false)).toBeUndefined();
    expect((await backend.readDoc(doc)).md).toBe("# a v3\n");
  });
});

describe("op_id idempotency (op log)", () => {
  let root: string;
  const doc = "note.md";
  const opLogFile = () => path.join(root, ".op_log.json");
  const readOpLogFile = async () =>
    JSON.parse(await fs.readFile(opLogFile(), "utf8")) as Record<
      string,
      unknown
    >;

  /** A backend over `root` that counts the `doc_changed` events it emits. */
  function countingBackend(): { backend: StubBackend; changes: () => number } {
    const backend = new StubBackend(root);
    let n = 0;
    backend.subscribe((e) => {
      if (e.kind === "doc_changed") n += 1;
    });
    return { backend, changes: () => n };
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-oplog-"));
    await fs.writeFile(path.join(root, doc), "x");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("a repeated writeDoc op_id is a no-op and records the op as applied", async () => {
    const { backend, changes } = countingBackend();
    await backend.writeDoc(doc, "first", "op-w");
    await backend.writeDoc(doc, "second", "op-w");
    expect((await backend.readDoc(doc)).md).toBe("first");
    expect(changes()).toBe(1);
    const log = await readOpLogFile();
    expect(Object.keys(log)).toEqual(["op-w"]);
    expect(log["op-w"]).toEqual({ applied_at: expect.any(Number) });
  });

  it("a repeated editDoc op_id does not re-apply the edit", async () => {
    const { backend, changes } = countingBackend();
    await backend.editDoc(doc, "x", "xy", false, "op-e");
    // Re-applying would match the leading `x` again and yield "xyy".
    await backend.editDoc(doc, "x", "xy", false, "op-e");
    expect((await backend.readDoc(doc)).md).toBe("xy");
    expect(changes()).toBe(1);
  });

  it("dedups across backend instances (the op log is persisted)", async () => {
    await new StubBackend(root).writeDoc(doc, "first", "op-p");
    const { backend, changes } = countingBackend();
    await backend.writeDoc(doc, "second", "op-p");
    expect((await backend.readDoc(doc)).md).toBe("first");
    expect(changes()).toBe(0);
  });

  it("does not record a failed write, so a retry can still apply", async () => {
    const backend = new StubBackend(root);
    await expect(
      backend.editDoc(doc, "missing", "y", false, "op-f"),
    ).rejects.toMatchObject({ code: "edit_no_match" });
    await backend.writeDoc(doc, "missing", undefined);
    await backend.editDoc(doc, "missing", "found", false, "op-f");
    expect((await backend.readDoc(doc)).md).toBe("found");
  });

  it("treats an op id that shadows an Object.prototype key as unapplied", async () => {
    const backend = new StubBackend(root);
    await backend.writeDoc(doc, "applied", "constructor");
    expect((await backend.readDoc(doc)).md).toBe("applied");
  });

  it("loads a legacy `{ version_token }` op log and still dedups its ids", async () => {
    await fs.writeFile(
      opLogFile(),
      JSON.stringify({ "op-old": { version_token: "v-0123456789ab" } }),
    );
    const { backend, changes } = countingBackend();
    // The legacy id counts as applied: replaying it is a no-op.
    await backend.writeDoc(doc, "replayed", "op-old");
    expect((await backend.readDoc(doc)).md).toBe("x");
    expect(changes()).toBe(0);
    // New ids still apply, and the rewrite normalizes the legacy entry.
    await backend.writeDoc(doc, "fresh", "op-new");
    expect((await backend.readDoc(doc)).md).toBe("fresh");
    expect(await readOpLogFile()).toEqual({
      "op-old": { applied_at: 0 },
      "op-new": { applied_at: expect.any(Number) },
    });
  });
});

describe("backend.listDocs", () => {
  let root: string;
  let backend: StubBackend;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-tools-"));
    // Docs at the vault root, in a plain folder, and under the (now ordinary)
    // workspaces/ folder — all visible, all discoverable.
    await fs.writeFile(path.join(root, "README.md"), "# readme\n");
    for (const dir of ["notes", path.join("workspaces", "alpha", "docs")]) {
      await fs.mkdir(path.join(root, dir), { recursive: true });
      await fs.writeFile(path.join(root, dir, "x.md"), `# ${dir}/x\n`);
    }
    // Infra / hidden dirs must never surface.
    await fs.mkdir(path.join(root, ".obsidian"), { recursive: true });
    await fs.writeFile(path.join(root, ".obsidian", "config.md"), "# hidden\n");
    backend = new StubBackend(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("lists every visible doc and skips dot-dirs", async () => {
    const docs = await backend.listDocs();
    // Sorted by localeCompare (case-insensitive): "notes" < "README".
    expect(docs.map((d) => d.path)).toEqual([
      "notes/x.md",
      "README.md",
      "workspaces/alpha/docs/x.md",
    ]);
  });

  it("filters by path prefix", async () => {
    const notes = await backend.listDocs("notes/");
    expect(notes.map((d) => d.path)).toEqual(["notes/x.md"]);
    const ws = await backend.listDocs("workspaces/alpha");
    expect(ws.map((d) => d.path)).toEqual(["workspaces/alpha/docs/x.md"]);
  });
});

describe("operates on any vault doc (not just workspaces/)", () => {
  let root: string;
  let backend: StubBackend;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-any-doc-"));
    await fs.writeFile(path.join(root, "note.md"), "hello world");
    await fs.mkdir(path.join(root, "notes"), { recursive: true });
    await fs.writeFile(path.join(root, "notes", "x.md"), "hello world");
    backend = new StubBackend(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reads and edits a root-level doc", async () => {
    expect((await backend.readDoc("note.md")).md).toBe("hello world");
    await backend.editDoc("note.md", "world", "vault", false);
    const onDisk = await fs.readFile(path.join(root, "note.md"), "utf8");
    expect(onDisk).toBe("hello vault");
  });

  it("AddThread on a non-workspaces doc stores the thread inline in the doc", async () => {
    const id = await backend.addThread({
      targets: [{ path: "notes/x.md", scope: "doc" }],
      message: "comment on any doc",
      author: "user",
    });
    // No sidecar dir — the thread lives in the doc's RFM endmatter.
    await expect(
      fs.stat(path.join(root, "notes", "x.threads")),
    ).rejects.toThrow();
    const raw = await fs.readFile(path.join(root, "notes", "x.md"), "utf8");
    expect(raw).toContain(id);
    expect(raw).toContain("comment on any doc");
    // The clean prose is unchanged by the doc-level comment.
    expect((await backend.readDoc("notes/x.md")).md).toBe("hello world");
    const threads = await backend.listThreads({ path: "notes/x.md" });
    expect(threads.map((t) => t.id)).toContain(id);
  });

  it("rejects writes to dot-prefixed (infra) paths", async () => {
    await expect(
      backend.writeDoc(".git/evil.md", "x"),
    ).rejects.toThrow();
    await expect(
      backend.writeDoc(".obsidian/x.md", "x"),
    ).rejects.toThrow();
  });
});

describe("backend.subscribe agent_presence", () => {
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

    // presence replay plus the stream_reset every fresh subscribe receives
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: "agent_presence",
      connected: false,
    });
    expect(events[1]).toMatchObject({ kind: "stream_reset" });
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

describe("emit does not echo agent-origin mutations back to the agent", () => {
  let root: string;
  let backend: StubBackend;
  const docPath = "workspaces/ws/docs/a.md";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-echo-"));
    await fs.mkdir(path.join(root, "workspaces", "ws", "docs"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, "workspaces", "ws", "docs", "a.md"),
      "hello world",
    );
    backend = new StubBackend(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("suppresses an agent-origin edit for the agent but not the UI", async () => {
    const uiEvents: BackendEvent[] = [];
    const agentEvents: BackendEvent[] = [];
    backend.subscribe((e) => uiEvents.push(e), { role: "ui" });
    backend.subscribe((e) => agentEvents.push(e), { role: "agent" });

    await backend.writeDoc(docPath, "v2", undefined, "agent");
    expect(uiEvents.filter((e) => e.kind === "doc_changed")).toHaveLength(1);
    expect(agentEvents.filter((e) => e.kind === "doc_changed")).toHaveLength(0);

    // A user-origin edit (default) is still delivered to the agent.
    await backend.writeDoc(docPath, "v3");
    expect(agentEvents.filter((e) => e.kind === "doc_changed")).toHaveLength(1);
  });

  it("delivers a user comment to the agent but not the agent's own reply", async () => {
    const agentEvents: BackendEvent[] = [];
    backend.subscribe((e) => agentEvents.push(e), { role: "agent" });

    const id = await backend.addThread({
      targets: [{ path: docPath, scope: "doc" }],
      message: "do something",
      author: "user",
    });
    await backend.replyThread(id, "on it", { author: "agent", origin: "agent" });

    // Only the user's addThread should reach the agent — not its own reply.
    expect(agentEvents.filter((e) => e.kind === "thread_changed")).toHaveLength(1);
  });
});

describe("resumable event stream (sinceId replay)", () => {
  let root: string;
  let backend: StubBackend;
  const docPath = "workspaces/ws/docs/a.md";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-resume-"));
    await fs.mkdir(path.join(root, "workspaces", "ws", "docs"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, "workspaces", "ws", "docs", "a.md"),
      "hello world",
    );
    backend = new StubBackend(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("replays events missed between unsubscribe and resubscribe", async () => {
    let lastId: string | undefined;
    const unsub = backend.subscribe((_e, id) => {
      if (id) lastId = id;
    });
    await backend.writeDoc(docPath, "v2");
    expect(lastId).toBeDefined();
    unsub();

    // Missed while disconnected.
    await backend.writeDoc(docPath, "v3");

    const resumed: BackendEvent[] = [];
    backend.subscribe((e) => resumed.push(e), { sinceId: lastId });
    expect(resumed.filter((e) => e.kind === "doc_changed")).toHaveLength(1);
    expect(resumed.filter((e) => e.kind === "stream_reset")).toHaveLength(0);
  });

  it("does not replay agent-origin events to a resumed agent subscriber", async () => {
    let lastId: string | undefined;
    const unsub = backend.subscribe(
      (_e, id) => {
        if (id) lastId = id;
      },
      { role: "agent" },
    );
    await backend.writeDoc(docPath, "v2");
    unsub();

    // Missed while disconnected: one of the agent's own, one from the user.
    await backend.writeDoc(docPath, "v3", undefined, "agent");
    await backend.writeDoc(docPath, "v4");

    const resumed: BackendEvent[] = [];
    backend.subscribe((e) => resumed.push(e), {
      role: "agent",
      sinceId: lastId,
    });
    // Only the user-origin write is replayed — same rule as live delivery.
    expect(resumed.filter((e) => e.kind === "doc_changed")).toHaveLength(1);
  });

  it("sends stream_reset for an id from another backend instance", async () => {
    const events: BackendEvent[] = [];
    backend.subscribe((e) => events.push(e), { sinceId: "deadbeef.3" });
    expect(events.filter((e) => e.kind === "stream_reset")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "doc_changed")).toHaveLength(0);
  });

  it("sends stream_reset when the resume position fell out of the buffer", async () => {
    let firstId: string | undefined;
    const unsub = backend.subscribe((_e, id) => {
      firstId = firstId ?? id;
    });
    await backend.writeDoc(docPath, "v2");
    unsub();

    // Push the first id past the replay-buffer horizon.
    for (let i = 0; i < 300; i++) {
      await backend.writeDoc(docPath, `v${i + 3}`);
    }

    const events: BackendEvent[] = [];
    backend.subscribe((e) => events.push(e), { sinceId: firstId });
    expect(events.filter((e) => e.kind === "stream_reset")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "doc_changed")).toHaveLength(0);
  });
});

describe("backend.attachDraftPayload", () => {
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

  const seedThread = () =>
    backend.addThread({
      targets: [{ path: DOC, char_range: { from: 9, to: 17 } }],
      message: "tighten",
      author: "user",
    });

  it("appends a system-style message carrying the single `draft` payload and emits thread_changed", async () => {
    const id = await seedThread();

    const events: BackendEvent[] = [];
    backend.subscribe((e) => events.push(e), { role: "ui" });
    events.length = 0;

    await backend.attachDraftPayload(id, {
      message: "cut ~40%, same beats",
      draft: { new_md: "tightened body\n" },
    });

    const after = await backend.readThread(id);
    const last = after.messages[after.messages.length - 1];
    expect(last.body).toBe("cut ~40%, same beats");
    expect(last.draft).toEqual({ new_md: "tightened body\n" });
    expect(last.draft_options).toBeUndefined();
    expect(last.author).toBe("system");

    const changed = events.filter((e) => e.kind === "thread_changed");
    expect(changed).toHaveLength(1);
  });

  it("appends a system-style message carrying multi-leaf `draft_options`", async () => {
    const id = await seedThread();

    await backend.attachDraftPayload(id, {
      message: "two angles; pick one",
      draft_options: [
        { name: "option a", description: "deeper, longer", new_md: "depth\n" },
        { name: "option b", new_md: "breadth\n" },
      ],
    });

    const after = await backend.readThread(id);
    const last = after.messages[after.messages.length - 1];
    // The optional per-option `description` round-trips; absent on others.
    expect(last.draft_options).toEqual([
      { name: "option a", description: "deeper, longer", new_md: "depth\n" },
      { name: "option b", new_md: "breadth\n" },
    ]);
    expect(last.draft).toBeUndefined();
  });

  it("rejects calls with neither `draft` nor `draft_options` set", async () => {
    const id = await seedThread();
    await expect(
      backend.attachDraftPayload(id, { message: "no payload" }),
    ).rejects.toThrow();
  });

  it("rejects calls with both `draft` and `draft_options` set simultaneously", async () => {
    const id = await seedThread();
    await expect(
      backend.attachDraftPayload(id, {
        draft: { new_md: "x\n" },
        draft_options: [
          { name: "a", new_md: "x\n" },
          { name: "b", new_md: "y\n" },
        ],
      }),
    ).rejects.toThrow();
  });
});

describe("backend.reopenThread (thread-on-doc)", () => {
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

  it("unresolves a resolved thread with a bare `reopened` message (no leaf)", async () => {
    const id = await backend.addThread({
      targets: [{ path: DOC, char_range: { from: 9, to: 17 } }],
      message: "tighten",
      author: "user",
    });
    await backend.resolveThread(id);
    expect((await backend.readThread(id)).status).toBe("accepted");

    const events: BackendEvent[] = [];
    backend.subscribe((e) => events.push(e), { role: "ui" });
    events.length = 0;

    await backend.reopenThread(id);

    const after = await backend.readThread(id);
    expect(after.status).toBe("open");
    const last = after.messages[after.messages.length - 1];
    expect(last.author).toBe("system");
    expect(last.body).toBe("reopened");
    expect(last.draft_options).toBeUndefined();
    expect(last.draft).toBeUndefined();

    const changed = events.filter((e) => e.kind === "thread_changed");
    expect(changed).toHaveLength(1);
  });

  it("rejects reopening an already-open thread", async () => {
    const id = await backend.addThread({
      targets: [{ path: DOC, char_range: { from: 9, to: 17 } }],
      message: "tighten",
      author: "user",
    });
    await expect(backend.reopenThread(id)).rejects.toThrow();
  });
});

describe("POST /api/ui/threads/[id]/reopen", () => {
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
    const id = await backend.addThread({
      targets: [{ path: DOC, char_range: { from: 0, to: 3 } }],
      message: "scope",
      author: "user",
    });
    await backend.resolveThread(id);

    const req = new Request(`http://localhost/api/ui/threads/${id}/reopen`, {
      method: "POST",
    });
    const res = await reopenPOST(req);
    expect(res.status).toBe(200);
  });

  it("returns 404 on missing thread", async () => {
    const id = "thrd_doesnotexist";
    const req = new Request(`http://localhost/api/ui/threads/${id}/reopen`, {
      method: "POST",
    });
    const res = await reopenPOST(req);
    expect(res.status).toBe(404);
  });
});

describe("thread-on-doc loop end-to-end (main)", () => {
  let root: string;
  let backend: StubBackend;
  const DOC = "workspaces/ws/docs/a.md";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-loop-"));
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

  it("add → list → show → reply → AttachDraftPayload(options) → resolve → reopen; stored thread has no draft_id", async () => {
    // add (REST, origin ui) — no ?ref
    const addReq = new Request("http://localhost/api/ui/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: DOC,
        targets: [{ char_range: { from: 9, to: 17 } }],
        message: "tighten this passage",
      }),
    });
    const addRes = await threadsPOST(addReq);
    expect(addRes.status).toBe(201);
    const id = ((await addRes.json()) as { thread_id: string }).thread_id;

    // list (REST GET, no ?ref)
    const listReq = new Request(
      `http://localhost/api/ui/threads?path=${encodeURIComponent(DOC)}`,
    );
    const listRes = await threadsGET(listReq);
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as { threads: { id: string }[] };
    expect(listed.threads.map((t) => t.id)).toContain(id);

    // show (backend read) — a stored thread carries NO draft_id field
    const shown = await backend.readThread(id);
    expect(shown.messages[0].body).toBe("tighten this passage");
    expect(Object.keys(shown)).not.toContain("draft_id");
    expect((shown as { draft_id?: unknown }).draft_id).toBeUndefined();

    // reply (REST, origin ui)
    const replyReq = new Request(
      `http://localhost/api/ui/threads/${id}/reply`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "any angle is fine" }),
      },
    );
    expect((await replyPOST(replyReq)).status).toBe(200);

    // AttachDraftPayload with options (agent) — a preview, not applied
    await backend.attachDraftPayload(id, {
      author: "agent",
      message: "two takes",
      draft_options: [
        { name: "punchy", new_md: "punchy body\n" },
        { name: "measured", new_md: "measured body\n" },
      ],
    });
    const withOptions = await backend.readThread(id);
    const lastOpt = withOptions.messages[withOptions.messages.length - 1];
    expect(lastOpt.draft_options?.map((o) => o.name)).toEqual([
      "punchy",
      "measured",
    ]);

    // resolve (REST) — flips status, never writes the preview to the doc
    const resolveReq = new Request(
      `http://localhost/api/ui/threads/${id}/resolve`,
      { method: "POST" },
    );
    expect((await resolvePOST(resolveReq)).status).toBe(200);
    expect((await backend.readThread(id)).status).toBe("accepted");
    expect((await backend.readDoc(DOC)).md).toBe(
      "# title\n\nbody one\n\nbody two\n",
    );

    // reopen (REST) — back to open with a bare system message
    const reopenReq = new Request(
      `http://localhost/api/ui/threads/${id}/reopen`,
      { method: "POST" },
    );
    expect((await reopenPOST(reopenReq)).status).toBe(200);
    const reopened = await backend.readThread(id);
    expect(reopened.status).toBe("open");
    expect(reopened.messages[reopened.messages.length - 1].body).toBe(
      "reopened",
    );

    // The on-disk thread format never carries draft_id.
    const onDisk = await fs.readFile(
      path.join(root, "workspaces", "ws", "docs", "a.md"),
      "utf8",
    );
    expect(onDisk).not.toContain("draft_id");
  });
});

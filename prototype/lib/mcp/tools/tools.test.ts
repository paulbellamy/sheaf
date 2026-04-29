import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StubBackend } from "../backend/stub";
import {
  GET as threadsGET,
  POST as threadsPOST,
} from "../../../app/api/ui/threads/route";

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

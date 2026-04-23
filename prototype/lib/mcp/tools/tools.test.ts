import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StubBackend } from "../backend/stub";

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

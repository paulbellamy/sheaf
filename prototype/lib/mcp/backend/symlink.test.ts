import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StubBackend } from "./stub";

describe("StubBackend symlink safety", () => {
  let root: string;
  let backend: StubBackend;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-stub-"));
    await fs.mkdir(path.join(root, "workspaces", "ws", "docs"), {
      recursive: true,
    });
    backend = new StubBackend(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("rejects reading a symlinked doc", async () => {
    const target = "/etc/passwd";
    const docPath = "workspaces/ws/docs/evil.md";
    // If /etc/passwd doesn't exist (unusual), skip.
    try {
      await fs.stat(target);
    } catch {
      return;
    }
    await fs.symlink(target, path.join(root, docPath));
    await expect(backend.readDoc(docPath, "main")).rejects.toThrow();
  });

  it("walk skips symlinks so listDocs does not surface them", async () => {
    await fs.writeFile(
      path.join(root, "workspaces", "ws", "docs", "real.md"),
      "# real\n",
    );
    await fs.symlink(
      "/etc/passwd",
      path.join(root, "workspaces", "ws", "docs", "link.md"),
    );
    const docs = await backend.listDocs("ws");
    const paths = docs.map((d) => d.path);
    expect(paths).toContain("workspaces/ws/docs/real.md");
    expect(paths).not.toContain("workspaces/ws/docs/link.md");
  });
});

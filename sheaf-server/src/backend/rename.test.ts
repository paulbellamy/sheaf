import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StubBackend } from "./stub";

describe("StubBackend.renameDoc", () => {
  let root: string;
  let backend: StubBackend;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-rename-"));
    await fs.mkdir(path.join(root, "notes"), { recursive: true });
    await fs.writeFile(
      path.join(root, "notes", "old.md"),
      "# Old\n\nhello world\n",
    );
    backend = new StubBackend(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("moves a doc's threads onto the new path", async () => {
    const id = await backend.addThread({
      ref: "main",
      author: "user",
      message: "a comment",
      targets: [{ path: "notes/old.md", scope: "range", char_range: { from: 9, to: 14 } }],
    });

    // Simulate the vault's own rename of the `.md`.
    await fs.rename(
      path.join(root, "notes", "old.md"),
      path.join(root, "notes", "new.md"),
    );

    const moved = await backend.renameDoc("notes/old.md", "notes/new.md");
    expect(moved).toEqual([id]);

    const onOld = await backend.listThreads({ path: "notes/old.md", ref: "main" });
    expect(onOld).toHaveLength(0);

    const onNew = await backend.listThreads({ path: "notes/new.md", ref: "main" });
    expect(onNew.map((t) => t.id)).toEqual([id]);

    const thread = await backend.readThread(id);
    expect(thread.targets[0].path).toBe("notes/new.md");

    // The stale sidecar dir is gone; the new one holds the moved thread.
    await expect(
      fs.stat(path.join(root, "notes", "old.threads")),
    ).rejects.toThrow();
    await expect(
      fs.stat(path.join(root, "notes", "new.threads", `${id}.yaml`)),
    ).resolves.toBeTruthy();
  });

  it("emits thread_changed pointing at the new path", async () => {
    const id = await backend.addThread({
      ref: "main",
      author: "user",
      message: "a comment",
      targets: [{ path: "notes/old.md", scope: "doc" }],
    });

    const events: { thread_id: string; target_paths: string[] }[] = [];
    backend.subscribe((e) => {
      if (e.kind === "thread_changed") {
        events.push({ thread_id: e.thread_id, target_paths: e.target_paths });
      }
    });

    await backend.renameDoc("notes/old.md", "notes/new.md");
    expect(events).toContainEqual({
      thread_id: id,
      target_paths: ["notes/new.md"],
    });
  });

  it("is a no-op when from === to", async () => {
    const moved = await backend.renameDoc("notes/old.md", "notes/old.md");
    expect(moved).toEqual([]);
  });

  it("repoints a draft's base_path and touches", async () => {
    const [draftId] = await backend.fork("notes/old.md", 1);
    await backend.writeDoc("notes/old.md", draftId, "# Old\n\nedited\n");

    await backend.renameDoc("notes/old.md", "notes/new.md");

    const drafts = await backend.listDrafts();
    const d = drafts.find((x) => x.draft_id === draftId)!;
    expect(d.base_path).toBe("notes/new.md");
    expect(d.touches).toContain("notes/new.md");
    expect(d.touches).not.toContain("notes/old.md");

    // The draft's working copy followed the rename, so it still reads back.
    const view = await backend.readDoc("notes/new.md", draftId);
    expect(view.md).toContain("edited");
  });

  it("rejects infra paths", async () => {
    await expect(
      backend.renameDoc("notes/old.md", ".drafts/sneaky.md"),
    ).rejects.toThrow();
  });
});

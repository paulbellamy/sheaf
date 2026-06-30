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

    // The thread travelled inline with the doc's bytes; its stored target was
    // remapped to the new path. No sidecar dirs exist either way.
    await expect(
      fs.stat(path.join(root, "notes", "old.threads")),
    ).rejects.toThrow();
    const raw = await fs.readFile(path.join(root, "notes", "new.md"), "utf8");
    expect(raw).toContain(id);
    expect(raw).toContain("notes/new.md");
    expect(raw).not.toContain("notes/old.md");
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

  it("remaps every descendant when a folder is renamed", async () => {
    await fs.mkdir(path.join(root, "notes", "sub"), { recursive: true });
    await fs.writeFile(path.join(root, "notes", "sub", "b.md"), "# B\n\ndeep\n");

    const idA = await backend.addThread({
      ref: "main",
      author: "user",
      message: "on a",
      targets: [{ path: "notes/old.md", scope: "doc" }],
    });
    const idB = await backend.addThread({
      ref: "main",
      author: "user",
      message: "on b",
      targets: [{ path: "notes/sub/b.md", scope: "doc" }],
    });

    // Simulate the vault's folder rename: the OS moves the whole tree (each
    // doc's inline threads travel with it), but the endmatter records still
    // carry the old `notes/…` target paths.
    await fs.rename(path.join(root, "notes"), path.join(root, "archive"));

    const moved = await backend.renameDoc("notes", "archive");
    expect(moved.sort()).toEqual([idA, idB].sort());

    const a = await backend.readThread(idA);
    expect(a.targets[0].path).toBe("archive/old.md");
    const b = await backend.readThread(idB);
    expect(b.targets[0].path).toBe("archive/sub/b.md");

    expect(
      await backend.listThreads({ path: "archive/old.md", ref: "main" }),
    ).toHaveLength(1);
    expect(
      await backend.listThreads({ path: "archive/sub/b.md", ref: "main" }),
    ).toHaveLength(1);
    expect(
      await backend.listThreads({ path: "notes/old.md", ref: "main" }),
    ).toHaveLength(0);
  });

  it("repoints a draft override sitting under a renamed folder", async () => {
    const [draftId] = await backend.fork("notes/old.md", 1);
    await backend.writeDoc("notes/old.md", draftId, "# Old\n\ndraft edit\n");

    // Folder rename moves the visible tree but never the hidden `.drafts/`.
    await fs.rename(path.join(root, "notes"), path.join(root, "archive"));

    await backend.renameDoc("notes", "archive");

    const d = (await backend.listDrafts()).find((x) => x.draft_id === draftId)!;
    expect(d.base_path).toBe("archive/old.md");
    expect(d.touches).toContain("archive/old.md");
    const view = await backend.readDoc("archive/old.md", draftId);
    expect(view.md).toContain("draft edit");
  });

  it("carries the version counter onto the new path", async () => {
    // Read inits the counter to 1; a main write bumps it to 2.
    await backend.readDoc("notes/old.md", "main");
    await backend.writeDoc("notes/old.md", "main", "# Old\n\nbumped\n");

    await fs.rename(
      path.join(root, "notes", "old.md"),
      path.join(root, "notes", "new.md"),
    );
    await backend.renameDoc("notes/old.md", "notes/new.md");

    // 2 proves the counter moved — a fresh init for a non-empty doc would be 1.
    const doc = await backend.readDoc("notes/new.md", "main");
    expect(doc.version_counter).toBe(2);
  });

  it("leaves a sibling with an overlapping prefix untouched", async () => {
    await fs.writeFile(path.join(root, "notesextra.md"), "# Extra\n\nsibling\n");
    const sib = await backend.addThread({
      ref: "main",
      author: "user",
      message: "on sibling",
      targets: [{ path: "notesextra.md", scope: "doc" }],
    });
    const inside = await backend.addThread({
      ref: "main",
      author: "user",
      message: "inside folder",
      targets: [{ path: "notes/old.md", scope: "doc" }],
    });

    // `notesextra.md` shares the `notes` prefix but is not under the folder.
    await fs.rename(path.join(root, "notes"), path.join(root, "archive"));
    const moved = await backend.renameDoc("notes", "archive");

    expect(moved).toEqual([inside]);
    const s = await backend.readThread(sib);
    expect(s.targets[0].path).toBe("notesextra.md");
    expect(
      await backend.listThreads({ path: "notesextra.md", ref: "main" }),
    ).toHaveLength(1);
  });

  it("rewrites only the affected target of a multi-target thread", async () => {
    await fs.writeFile(path.join(root, "other.md"), "# Other\n\nelsewhere\n");
    const id = await backend.addThread({
      ref: "main",
      author: "user",
      message: "spans two docs",
      targets: [
        { path: "other.md", scope: "doc" },
        { path: "notes/old.md", scope: "doc" },
      ],
    });

    await fs.rename(
      path.join(root, "notes", "old.md"),
      path.join(root, "notes", "new.md"),
    );
    await backend.renameDoc("notes/old.md", "notes/new.md");

    const t = await backend.readThread(id);
    expect(t.targets.map((x) => x.path)).toEqual(["other.md", "notes/new.md"]);
    const onNew = await backend.listThreads({ path: "notes/new.md", ref: "main" });
    expect(onNew.map((x) => x.id)).toContain(id);
    expect(
      await backend.listThreads({ path: "notes/old.md", ref: "main" }),
    ).toHaveLength(0);
  });

  it("rejects infra paths", async () => {
    await expect(
      backend.renameDoc("notes/old.md", ".drafts/sneaky.md"),
    ).rejects.toThrow();
  });
});

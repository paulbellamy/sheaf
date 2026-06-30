import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StubBackend } from "./stub";

/**
 * Rename cases specific to inline-RFM storage: the home doc's bytes (and its
 * inline markers) move with the file, while target paths recorded in endmatter
 * — including secondary targets and draft overrides — must be reconciled.
 */
describe("renameDoc — inline markers + cross-target reconciliation", () => {
  let root: string;
  let backend: StubBackend;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-rename-inline-"));
    backend = new StubBackend(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("remaps a secondary range target in the renamed doc, leaving the home record in place", async () => {
    await backend.writeDoc("A.md", "main", "alpha home doc text\n");
    await backend.writeDoc("B.md", "main", "bravo secondary target text\n");

    // Thread homed in A (targets[0]) with a SECONDARY range target into B.
    const id = await backend.addThread({
      ref: "main",
      author: "user",
      message: "spans A and B",
      targets: [
        { path: "A.md", scope: "range", char_range: { from: 0, to: 5 } },
        { path: "B.md", scope: "range", char_range: { from: 0, to: 5 } },
      ],
    });

    // Homed in A; B carries no record.
    expect(await fs.readFile(path.join(root, "A.md"), "utf8")).toContain(id);
    expect(
      await fs.readFile(path.join(root, "B.md"), "utf8"),
    ).not.toContain(id);

    await fs.rename(path.join(root, "B.md"), path.join(root, "Bnew.md"));
    expect(await backend.renameDoc("B.md", "Bnew.md")).toEqual([id]);

    const t = await backend.readThread(id);
    expect(t.targets.map((x) => x.path)).toEqual(["A.md", "Bnew.md"]);
    expect(
      (await backend.listThreads({ path: "Bnew.md", ref: "main" })).map((x) => x.id),
    ).toContain(id);

    const aRaw = await fs.readFile(path.join(root, "A.md"), "utf8");
    expect(aRaw).toContain("Bnew.md");
    expect(aRaw).not.toContain("B.md\n");
  });

  it("keeps the inline marker when the home doc itself is renamed", async () => {
    await backend.writeDoc("A.md", "main", "alpha home doc text\n");
    await backend.addThread({
      ref: "main",
      author: "user",
      message: "anchored here",
      targets: [{ path: "A.md", scope: "range", char_range: { from: 0, to: 5 } }],
    });
    expect(await fs.readFile(path.join(root, "A.md"), "utf8")).toContain(
      "{==alpha==}",
    );

    await fs.rename(path.join(root, "A.md"), path.join(root, "Anew.md"));
    await backend.renameDoc("A.md", "Anew.md");

    const after = await fs.readFile(path.join(root, "Anew.md"), "utf8");
    expect(after).toContain("{==alpha==}");
    expect(after).toContain("Anew.md");
    expect(after).not.toContain('"A.md"');
  });

  it("re-homes the inline marker when the home is renamed and a secondary target is not", async () => {
    await backend.writeDoc("A.md", "main", "alpha home doc text\n");
    await backend.writeDoc("C.md", "main", "charlie other text\n");
    const id = await backend.addThread({
      ref: "main",
      author: "user",
      message: "home A plus C",
      targets: [
        { path: "A.md", scope: "range", char_range: { from: 0, to: 5 } },
        { path: "C.md", scope: "doc" },
      ],
    });

    await fs.rename(path.join(root, "A.md"), path.join(root, "Anew.md"));
    await backend.renameDoc("A.md", "Anew.md");

    expect(
      await fs.readFile(path.join(root, "Anew.md"), "utf8"),
    ).toContain("{==alpha==}");
    expect((await backend.readThread(id)).targets.map((x) => x.path)).toEqual([
      "Anew.md",
      "C.md",
    ]);
  });

  it("remaps home + secondary both under a renamed folder", async () => {
    await fs.mkdir(path.join(root, "notes"), { recursive: true });
    await backend.writeDoc("notes/a.md", "main", "alpha text here\n");
    await backend.writeDoc("notes/b.md", "main", "bravo text here\n");
    const id = await backend.addThread({
      ref: "main",
      author: "user",
      message: "spans two in folder",
      targets: [
        { path: "notes/a.md", scope: "range", char_range: { from: 0, to: 5 } },
        { path: "notes/b.md", scope: "doc" },
      ],
    });

    await fs.rename(path.join(root, "notes"), path.join(root, "arch"));
    await backend.renameDoc("notes", "arch");

    expect((await backend.readThread(id)).targets.map((x) => x.path)).toEqual([
      "arch/a.md",
      "arch/b.md",
    ]);
    expect(
      await fs.readFile(path.join(root, "arch", "a.md"), "utf8"),
    ).toContain("{==alpha==}");
  });

  it("moves a draft override and re-homes its thread when the doc is renamed", async () => {
    await backend.writeDoc("A.md", "main", "alpha main text\n");
    const [draftId] = await backend.fork("A.md", 1);
    await backend.writeDoc("A.md", draftId, "alpha draft text\n");
    const id = await backend.addThread({
      ref: draftId,
      author: "user",
      message: "on draft",
      targets: [{ path: "A.md", scope: "range", char_range: { from: 0, to: 5 } }],
    });

    await fs.rename(path.join(root, "A.md"), path.join(root, "Anew.md"));
    await backend.renameDoc("A.md", "Anew.md");

    expect(
      (await backend.listThreads({ path: "Anew.md", ref: draftId })).map((x) => x.id),
    ).toContain(id);
    const draftRaw = await fs.readFile(
      path.join(root, ".drafts", draftId, "Anew.md"),
      "utf8",
    );
    expect(draftRaw).toContain(id);
    expect(draftRaw).toContain("{==alpha==}");
  });
});

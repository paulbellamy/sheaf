import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StubBackend } from "./stub";

describe("renameDoc probes", () => {
  let root: string;
  let backend: StubBackend;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-probe-"));
    backend = new StubBackend(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  // Scenario 3: thread homed in A (targets[0]=A) with SECONDARY range target
  // in renamed doc B. Rename B->B'. Expect: only B's target remapped, A's file
  // rewritten, thread still found by listThreads(path=B').
  it("scenario3: secondary target in renamed doc", async () => {
    await backend.writeDoc("A.md", "main", "alpha home doc text\n");
    await backend.writeDoc("B.md", "main", "bravo secondary target text\n");

    // Thread homed in A, but with a SECONDARY RANGE target into B.
    const id = await backend.addThread({
      ref: "main",
      author: "user",
      message: "spans A and B",
      targets: [
        { path: "A.md", scope: "range", char_range: { from: 0, to: 5 } },
        { path: "B.md", scope: "range", char_range: { from: 0, to: 5 } },
      ],
    });

    // Confirm it's homed in A.
    const aRawBefore = await fs.readFile(path.join(root, "A.md"), "utf8");
    expect(aRawBefore).toContain(id);
    // B should NOT carry the record (home is targets[0]=A).
    const bRawBefore = await fs.readFile(path.join(root, "B.md"), "utf8");
    expect(bRawBefore).not.toContain(id);

    // vault moves B.md -> Bnew.md
    await fs.rename(path.join(root, "B.md"), path.join(root, "Bnew.md"));
    const moved = await backend.renameDoc("B.md", "Bnew.md");
    console.log("scenario3 moved:", moved);

    const t = await backend.readThread(id);
    console.log("scenario3 targets:", t.targets.map((x) => x.path));
    expect(t.targets.map((x) => x.path)).toEqual(["A.md", "Bnew.md"]);

    const onBnew = await backend.listThreads({ path: "Bnew.md", ref: "main" });
    console.log("scenario3 listThreads(Bnew):", onBnew.map((x) => x.id));
    expect(onBnew.map((x) => x.id)).toContain(id);

    // A's file should still carry the record and now reference Bnew.md.
    const aRawAfter = await fs.readFile(path.join(root, "A.md"), "utf8");
    expect(aRawAfter).toContain(id);
    expect(aRawAfter).toContain("Bnew.md");
    expect(aRawAfter).not.toContain("B.md\n"); // crude
  });

  // Scenario 6 candidate: the HOME doc A itself is renamed. targets[0] range
  // anchor must still project an inline marker at the new home.
  it("scenario6: home doc renamed keeps inline marker", async () => {
    await backend.writeDoc("A.md", "main", "alpha home doc text\n");
    const id = await backend.addThread({
      ref: "main",
      author: "user",
      message: "anchored here",
      targets: [{ path: "A.md", scope: "range", char_range: { from: 0, to: 5 } }],
    });
    const before = await fs.readFile(path.join(root, "A.md"), "utf8");
    expect(before).toContain("{==alpha==}");

    await fs.rename(path.join(root, "A.md"), path.join(root, "Anew.md"));
    await backend.renameDoc("A.md", "Anew.md");

    const after = await fs.readFile(path.join(root, "Anew.md"), "utf8");
    console.log("scenario6 after:\n", after);
    // Inline marker must survive the home rename.
    expect(after).toContain("{==alpha==}");
    expect(after).toContain("Anew.md");
    expect(after).not.toContain('"A.md"');
  });

  // Scenario 6 deeper: home doc A renamed AND it also has a secondary target.
  // The secondary target sits in a DIFFERENT unrenamed doc. Make sure home
  // remap + serialize keeps the inline marker (homePath === new targets[0]).
  it("scenario6b: home renamed with secondary unrenamed target", async () => {
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

    const after = await fs.readFile(path.join(root, "Anew.md"), "utf8");
    console.log("scenario6b after:\n", after);
    expect(after).toContain("{==alpha==}");
    const t = await backend.readThread(id);
    expect(t.targets.map((x) => x.path)).toEqual(["Anew.md", "C.md"]);
  });

  // Folder rename where the renamed folder contains the HOME doc, and a thread
  // homed there has a secondary target also inside the folder.
  it("scenario-folder: home + secondary both under renamed folder", async () => {
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
    const moved = await backend.renameDoc("notes", "arch");
    console.log("scenario-folder moved:", moved);

    const t = await backend.readThread(id);
    console.log("scenario-folder targets:", t.targets.map((x) => x.path));
    expect(t.targets.map((x) => x.path)).toEqual(["arch/a.md", "arch/b.md"]);
    const after = await fs.readFile(path.join(root, "arch", "a.md"), "utf8");
    expect(after).toContain("{==alpha==}");
  });

  // Draft override move under .drafts when the doc is renamed.
  it("scenario-draft: override moves and thread re-homes in draft", async () => {
    await backend.writeDoc("A.md", "main", "alpha main text\n");
    const [draftId] = await backend.fork("A.md", 1);
    await backend.writeDoc("A.md", draftId, "alpha draft text\n");
    // Thread on the DRAFT, homed at A.md (draft override).
    const id = await backend.addThread({
      ref: draftId,
      author: "user",
      message: "on draft",
      targets: [{ path: "A.md", scope: "range", char_range: { from: 0, to: 5 } }],
    });

    await fs.rename(path.join(root, "A.md"), path.join(root, "Anew.md"));
    const moved = await backend.renameDoc("A.md", "Anew.md");
    console.log("scenario-draft moved:", moved);

    // Thread should be found on the draft at the new path.
    const onNew = await backend.listThreads({ path: "Anew.md", ref: draftId });
    console.log("scenario-draft listThreads(Anew, draft):", onNew.map((x) => x.id));
    expect(onNew.map((x) => x.id)).toContain(id);

    // And the draft override .md should now sit at the new path under .drafts.
    const draftRaw = await fs.readFile(
      path.join(root, ".drafts", draftId, "Anew.md"),
      "utf8",
    );
    expect(draftRaw).toContain(id);
    expect(draftRaw).toContain("{==alpha==}");
  });
});

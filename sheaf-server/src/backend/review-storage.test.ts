import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StubBackend } from "./stub";

/**
 * End-to-end coverage for the inline-RFM thread storage: threads live in the
 * doc's markdown (CriticMarkup + YAML endmatter), readDoc returns clean prose,
 * and the Thread API round-trips through the endmatter.
 */
describe("inline RFM thread storage", () => {
  let root: string;
  let backend: StubBackend;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-rfm-"));
    backend = new StubBackend(root);
    await backend.writeDoc("doc.md", "main", "The quick brown fox.\n");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const raw = () => fs.readFile(path.join(root, "doc.md"), "utf8");

  it("stores an anchored comment inline and reads back clean prose", async () => {
    const id = await backend.addThread({
      ref: "main",
      author: "user",
      message: "needs a citation",
      targets: [{ path: "doc.md", scope: "range", char_range: { from: 4, to: 9 } }],
    });

    const onDisk = await raw();
    expect(onDisk).toContain("{==quick==}");
    expect(onDisk).toContain(`{#${id}}`);
    expect(onDisk).toContain("\n---\ncomments:");

    // No prose drift: the canonical text is exactly what was written.
    expect((await backend.readDoc("doc.md", "main")).md).toBe(
      "The quick brown fox.\n",
    );

    const thread = await backend.readThread(id);
    expect(thread.status).toBe("open");
    expect(thread.targets[0].scope).toBe("range");
    if (thread.targets[0].scope === "range") {
      expect(thread.targets[0].anchor.anchored_text).toBe("quick");
    }
    expect(thread.messages[0].body).toBe("needs a citation");
  });

  it("renders a single-draft thread as an inline substitution", async () => {
    await backend.addThread({
      ref: "main",
      author: "user",
      message: "tighten",
      draft: { new_md: "swift" },
      targets: [{ path: "doc.md", scope: "range", char_range: { from: 4, to: 9 } }],
    });

    const onDisk = await raw();
    expect(onDisk).toContain("{~~quick~>swift~~}");
    expect(onDisk).toContain("\n---\nsuggestions:");
    // The as-is projection keeps the old word — the change isn't applied yet.
    expect((await backend.readDoc("doc.md", "main")).md).toBe(
      "The quick brown fox.\n",
    );
  });

  it("preserves a thread across a prose edit and relocates its anchor", async () => {
    const id = await backend.addThread({
      ref: "main",
      author: "user",
      message: "note",
      targets: [{ path: "doc.md", scope: "range", char_range: { from: 4, to: 9 } }],
    });

    await backend.editDoc("doc.md", "main", "brown", "red", false);

    expect((await backend.readDoc("doc.md", "main")).md).toBe(
      "The quick red fox.\n",
    );
    const threads = await backend.listThreads({ path: "doc.md", ref: "main" });
    expect(threads.map((t) => t.id)).toEqual([id]);
    expect(await raw()).toContain("{==quick==}");
  });

  it("appends replies into the endmatter", async () => {
    const id = await backend.addThread({
      ref: "main",
      author: "user",
      message: "first",
      targets: [{ path: "doc.md", scope: "doc" }],
    });
    await backend.replyThread(id, "second", { author: "agent" });

    const thread = await backend.readThread(id);
    expect(thread.messages.map((m) => m.body)).toEqual(["first", "second"]);
    expect(thread.messages.map((m) => m.author)).toEqual(["user", "agent"]);
  });

  it("round-trips draft_options and resolved status", async () => {
    const id = await backend.addThread({
      ref: "main",
      author: "user",
      message: "options?",
      targets: [{ path: "doc.md", scope: "doc" }],
    });
    await backend.attachDraftPayload(id, {
      author: "agent",
      message: "two takes",
      draft_options: [
        { name: "a", new_md: "Alpha" },
        { name: "b", new_md: "Bravo" },
      ],
    });
    await backend.resolveThread(id);

    const thread = await backend.readThread(id);
    expect(thread.status).toBe("accepted");
    const last = thread.messages[thread.messages.length - 1];
    expect(last.draft_options?.map((o) => o.name)).toEqual(["a", "b"]);
    expect(last.draft_options?.map((o) => o.new_md)).toEqual(["Alpha", "Bravo"]);
  });

  it("keeps review markup out of grep results", async () => {
    await backend.addThread({
      ref: "main",
      author: "user",
      message: "ZZSECRETZZ marker only in the comment",
      targets: [{ path: "doc.md", scope: "range", char_range: { from: 4, to: 9 } }],
    });

    const hidden = await backend.grep({
      pattern: "ZZSECRETZZ",
      output_mode: "files_with_matches",
    });
    expect(hidden).toEqual({ mode: "files_with_matches", paths: [] });

    const prose = await backend.grep({
      pattern: "quick",
      output_mode: "files_with_matches",
    });
    expect(prose.mode === "files_with_matches" && prose.paths).toContain(
      "doc.md",
    );
  });

  it("lands a draft's clean prose on main without its review markup", async () => {
    const [draftId] = await backend.fork("doc.md", 1);
    await backend.writeDoc("doc.md", draftId, "The swift brown fox.\n");
    const threadId = await backend.addThread({
      ref: draftId,
      author: "user",
      message: "on the draft",
      targets: [{ path: "doc.md", scope: "doc" }],
    });
    await backend.resolveThread(threadId); // clear the accept gate
    await backend.propose(draftId);
    await backend.merge(draftId);

    expect((await backend.readDoc("doc.md", "main")).md).toBe(
      "The swift brown fox.\n",
    );
    const mainRaw = await raw();
    expect(mainRaw).not.toContain(threadId);
    expect(mainRaw).not.toContain("---\ncomments:");
    expect(mainRaw).not.toContain("---\nsuggestions:");
    // The draft still owns its thread.
    expect(
      (await backend.listThreads({ ref: draftId })).map((t) => t.id),
    ).toContain(threadId);
  });
});

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
    await backend.writeDoc("doc.md", "The quick brown fox.\n");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const raw = () => fs.readFile(path.join(root, "doc.md"), "utf8");

  it("stores an anchored comment inline and reads back clean prose", async () => {
    const id = await backend.addThread({
      author: "user",
      message: "needs a citation",
      targets: [{ path: "doc.md", scope: "range", char_range: { from: 4, to: 9 } }],
    });

    const onDisk = await raw();
    expect(onDisk).toContain("{==quick==}");
    expect(onDisk).toContain(`{#${id}}`);
    expect(onDisk).toContain("\n---\ncomments:");

    // No prose drift: the canonical text is exactly what was written.
    expect((await backend.readDoc("doc.md")).md).toBe("The quick brown fox.\n");

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
      author: "user",
      message: "tighten",
      draft: { new_md: "swift" },
      targets: [{ path: "doc.md", scope: "range", char_range: { from: 4, to: 9 } }],
    });

    const onDisk = await raw();
    expect(onDisk).toContain("{~~quick~>swift~~}");
    expect(onDisk).toContain("\n---\nsuggestions:");
    // The as-is projection keeps the old word — the change isn't applied yet.
    expect((await backend.readDoc("doc.md")).md).toBe("The quick brown fox.\n");
  });

  it("preserves a thread across a prose edit and relocates its anchor", async () => {
    const id = await backend.addThread({
      author: "user",
      message: "note",
      targets: [{ path: "doc.md", scope: "range", char_range: { from: 4, to: 9 } }],
    });

    await backend.editDoc("doc.md", "brown", "red", false);

    expect((await backend.readDoc("doc.md")).md).toBe("The quick red fox.\n");
    const threads = await backend.listThreads({ path: "doc.md" });
    expect(threads.map((t) => t.id)).toEqual([id]);
    expect(await raw()).toContain("{==quick==}");
  });

  it("appends replies into the endmatter", async () => {
    const id = await backend.addThread({
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

  it("does not leak markup when a thread anchors inside a code fence", async () => {
    const doc = "Example:\n```\nconst x = 1;\n```\nDone.\n";
    await backend.writeDoc("code.md", doc);
    const from = doc.indexOf("const x = 1;");
    const id = await backend.addThread({
      author: "user",
      message: "explain this",
      targets: [
        { path: "code.md", scope: "range", char_range: { from, to: from + 12 } },
      ],
    });
    // The inline marker is skipped inside the fence (strip honors fences), so
    // the clean prose is unchanged; the thread lives in the endmatter.
    expect((await backend.readDoc("code.md")).md).toBe(doc);
    expect(
      (await backend.listThreads({ path: "code.md" })).map((t) => t.id),
    ).toContain(id);
  });

  it("preserves literal CriticMarkup in a doc that has no threads", async () => {
    const lit = "Use {==this==} and {~~a~>b~~} literally.\n";
    await backend.writeDoc("lit.md", lit);
    expect((await backend.readDoc("lit.md")).md).toBe(lit);
    await backend.editDoc("lit.md", "literally", "verbatim", false);
    expect((await backend.readDoc("lit.md")).md).toBe(
      "Use {==this==} and {~~a~>b~~} verbatim.\n",
    );
  });

  it("preserves hand-typed CriticMarkup even after a thread is added", async () => {
    const doc = "The {==highlight==} syntax marks a span here.\n";
    await backend.writeDoc("about.md", doc);
    // No endmatter yet, so the literal markup reads back verbatim.
    expect((await backend.readDoc("about.md")).md).toBe(doc);
    const from = doc.indexOf("span");
    await backend.addThread({
      author: "user",
      message: "explain",
      targets: [
        { path: "about.md", scope: "range", char_range: { from, to: from + 4 } },
      ],
    });
    // The thread renders an id-terminated marker on "span"; the hand-typed
    // {==highlight==} has no id, so it survives the clean read intact.
    expect((await backend.readDoc("about.md")).md).toBe(doc);
  });

  it("stores a thread with no draft_id field (canonical JSON key order)", async () => {
    const id = await backend.addThread({
      author: "user",
      message: "on main",
      targets: [{ path: "doc.md", scope: "doc" }],
    });
    // The on-disk thread format no longer carries draft_id.
    expect(Object.keys(await backend.readThread(id))).toEqual([
      "id",
      "created",
      "status",
      "targets",
      "messages",
    ]);
    const onDisk = await raw();
    expect(onDisk).not.toContain("draft_id");
  });

  it("round-trips a comment on a selection larger than the old 10k cap (F4)", async () => {
    const big = "x".repeat(12_000);
    await backend.writeDoc("big.md", big + "\nEND\n");
    const id = await backend.addThread({
      author: "user",
      message: "huge selection",
      targets: [
        { path: "big.md", scope: "range", char_range: { from: 0, to: 12_000 } },
      ],
    });

    // The stored anchored_text is >10k chars: it must read back, not fail the
    // schema and get dropped (then deleted on the next write).
    const thread = await backend.readThread(id);
    expect(thread.targets[0].scope).toBe("range");
    if (thread.targets[0].scope === "range") {
      expect(thread.targets[0].anchor.anchored_text.length).toBe(12_000);
    }

    // An unrelated later edit must not erase the drifted-cap thread.
    await backend.editDoc("big.md", "END", "DONE", false);
    expect(
      (await backend.listThreads({ path: "big.md" })).map((t) => t.id),
    ).toEqual([id]);
  });
});

import { describe, expect, it } from "vitest";

import { DocStore, type VaultFs } from "./doc-store";

/** In-memory VaultFs for tests, with the backing maps exposed for assertions. */
function fakeFs(seedText: Record<string, string> = {}): VaultFs & {
  texts: Map<string, string>;
  bins: Map<string, Uint8Array>;
} {
  const texts = new Map<string, string>(Object.entries(seedText));
  const bins = new Map<string, Uint8Array>();
  return {
    texts,
    bins,
    async exists(p) {
      return texts.has(p) || bins.has(p);
    },
    async readText(p) {
      const v = texts.get(p);
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    async writeText(p, d) {
      texts.set(p, d);
    },
    async readBinary(p) {
      const v = bins.get(p);
      if (!v) throw new Error(`ENOENT ${p}`);
      return v;
    },
    async writeBinary(p, d) {
      bins.set(p, d);
    },
  };
}

const A = "notes/a.md";
const YCRDT_A = ".sheaf/ycrdt/notes/a.md.ycrdt";

describe("DocStore — client-write path", () => {
  it("read reflects an existing markdown file when there's no snapshot yet", async () => {
    const fs = fakeFs({ [A]: "hello from disk" });
    const store = new DocStore(fs);
    expect(await store.read(A)).toBe("hello from disk");
  });

  it("read of an unknown doc is empty", async () => {
    const store = new DocStore(fakeFs());
    expect(await store.read("notes/missing.md")).toBe("");
  });

  it("write persists rendered markdown and a hidden ycrdt snapshot", async () => {
    const fs = fakeFs({ [A]: "v1" });
    const store = new DocStore(fs);
    await store.write(A, "v2 content");

    expect(fs.texts.get(A)).toBe("v2 content");
    expect(fs.bins.has(YCRDT_A)).toBe(true); // snapshot in the infra mirror
    expect(await store.read(A)).toBe("v2 content");
  });

  it("survives a reload from the snapshot (ydoc is the merge truth)", async () => {
    const fs = fakeFs({ [A]: "original" });
    await new DocStore(fs).write(A, "edited body");

    // A fresh store over the same fs must see the edited content via the ycrdt.
    const reopened = new DocStore(fs);
    expect(await reopened.read(A)).toBe("edited body");
  });

  it("reconciles when the markdown drifted from the snapshot (out-of-band edit)", async () => {
    const fs = fakeFs({ [A]: "start" });
    await new DocStore(fs).write(A, "agent version");
    // User edits the .md directly in Obsidian, behind the snapshot's back.
    fs.texts.set(A, "user typed this directly");

    const reopened = new DocStore(fs);
    expect(await reopened.read(A)).toBe("user typed this directly");
  });

  it("rebuilds from markdown when the snapshot is corrupt", async () => {
    const fs = fakeFs({ [A]: "the markdown" });
    fs.bins.set(YCRDT_A, new Uint8Array([1, 2, 3, 4])); // not a valid ydoc update
    const store = new DocStore(fs);
    expect(await store.read(A)).toBe("the markdown");
  });

  it("honors a custom ycrdtPathFor", async () => {
    const fs = fakeFs({ [A]: "x" });
    const store = new DocStore(fs, {
      ycrdtPathFor: (p) => `snapshots/${p}.bin`,
    });
    await store.write(A, "y");
    expect(fs.bins.has("snapshots/notes/a.md.bin")).toBe(true);
    expect(fs.bins.has(YCRDT_A)).toBe(false);
  });

  it("write then write reconciles to the latest content", async () => {
    const fs = fakeFs();
    const store = new DocStore(fs);
    await store.write(A, "first draft of the section");
    await store.write(A, "first draft of the chapter");
    expect(await store.read(A)).toBe("first draft of the chapter");
  });
});

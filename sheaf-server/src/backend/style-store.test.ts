import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StubBackend } from "./stub";
import { loadOrRefreshProfile, selectCorpus } from "../style/corpus";
import { VOICE_GUIDE_PATH, defaultStyleConfig } from "../style/profile";

describe("StubBackend style store", () => {
  let root: string;
  let backend: StubBackend;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-style-"));
    await fs.mkdir(path.join(root, "notes"), { recursive: true });
    await fs.writeFile(
      path.join(root, "notes", "a.md"),
      "# A\nThe team shipped it. Users were happy. We moved on.\n",
    );
    await fs.writeFile(
      path.join(root, "notes", "b.md"),
      "# B\nKeep sentences short. Say the thing. Then stop.\n",
    );
    backend = new StubBackend(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("statCorpus lists visible md with size + mtime and skips dot-dirs", async () => {
    await fs.mkdir(path.join(root, ".drafts"), { recursive: true });
    await fs.writeFile(path.join(root, ".drafts", "x.md"), "# hidden\n");
    const files = await backend.statCorpus();
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual(["notes/a.md", "notes/b.md"]);
    expect(files[0].size).toBeGreaterThan(0);
    expect(files[0].mtime_ms).toBeGreaterThan(0);
  });

  it("returns default config when none is stored and round-trips a saved one", async () => {
    const def = await backend.readStyleConfig();
    expect(def.enabled).toBe(true);

    const next = defaultStyleConfig();
    next.enabled = false;
    next.exemplar_count = 2;
    next.exclude_globs = ["**/Private/**"];
    await backend.writeStyleConfig(next);

    const read = await backend.readStyleConfig();
    expect(read.enabled).toBe(false);
    expect(read.exemplar_count).toBe(2);
    expect(read.exclude_globs).toEqual(["**/Private/**"]);
  });

  it("round-trips a computed profile and keeps it out of the doc list", async () => {
    const load = await loadOrRefreshProfile(backend, await backend.readStyleConfig());
    expect(load.profile.metrics.word_count).toBeGreaterThan(0);

    const reread = await backend.readStyleProfile();
    expect(reread).not.toBeNull();
    expect(reread!.fingerprint.digest).toBe(load.profile.fingerprint.digest);

    // The cache file lives under .sheaf/ and must be invisible to docs/glob.
    const docs = await backend.listDocs();
    expect(docs.some((d) => d.path.includes(".sheaf"))).toBe(false);
    const globbed = await backend.glob("**/*.json");
    expect(globbed).toHaveLength(0);
  });

  it("treats a corrupt profile file as no-profile", async () => {
    await fs.mkdir(path.join(root, ".sheaf"), { recursive: true });
    await fs.writeFile(path.join(root, ".sheaf", "style-profile.json"), "{ not valid");
    expect(await backend.readStyleProfile()).toBeNull();
  });

  it("excludes the mirrored voice guide from the corpus", async () => {
    await backend.writeDoc(VOICE_GUIDE_PATH, "main", "# Voice\nfeeds itself", undefined, "agent");
    const docs = await backend.listDocs();
    expect(docs.some((d) => d.path === VOICE_GUIDE_PATH)).toBe(true); // visible

    const corpus = selectCorpus(await backend.statCorpus(), defaultStyleConfig());
    expect(corpus.some((f) => f.path === VOICE_GUIDE_PATH)).toBe(false); // not in corpus
  });
});

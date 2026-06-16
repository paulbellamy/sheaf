import { describe, expect, it } from "vitest";

import type { GrepOptions, GrepResult, Ref } from "../backend/index";
import {
  type StyleIO,
  loadOrRefreshProfile,
  selectCorpus,
  selectExemplars,
} from "./corpus";
import { type CorpusFile, type StyleProfile, defaultStyleConfig } from "./profile";

class FakeIO implements StyleIO {
  profile: StyleProfile | null = null;
  writes = 0;
  reads = 0;

  constructor(
    public files: CorpusFile[],
    public docs: Record<string, string>,
  ) {}

  async statCorpus(): Promise<CorpusFile[]> {
    return this.files;
  }

  async readDoc(path: string, _ref?: Ref): Promise<{ md: string }> {
    this.reads++;
    const md = this.docs[path];
    if (md === undefined) throw new Error(`no doc ${path}`);
    return { md };
  }

  async grep(opts: GrepOptions): Promise<GrepResult> {
    const keywords = opts.pattern.toLowerCase().split("|");
    const paths = Object.entries(this.docs)
      .filter(([, md]) => keywords.some((k) => md.toLowerCase().includes(k)))
      .map(([p]) => p);
    return { mode: "files_with_matches", paths };
  }

  async readStyleProfile(): Promise<StyleProfile | null> {
    return this.profile;
  }

  async writeStyleProfile(p: StyleProfile): Promise<void> {
    this.profile = p;
    this.writes++;
  }
}

const PROSE = (topic: string) =>
  `This note is about ${topic}. It runs a few sentences so the metrics have something to chew on. ` +
  `The writer keeps things plain and direct, and avoids fancy words. That is the whole point here.`;

function corpus(): { files: CorpusFile[]; docs: Record<string, string> } {
  const docs: Record<string, string> = {
    "notes/alpha.md": PROSE("databases and indexes"),
    "notes/beta.md": PROSE("gardening and soil"),
    "journal/2026-01.md": PROSE("travel and trains"),
    "Sheaf/Voice Guide.md": "# Voice\nshould be excluded from the corpus",
    "Templates/daily.md": "# {{date}}\n- [ ] task",
  };
  const files: CorpusFile[] = [
    { path: "notes/alpha.md", mtime_ms: 5000, size: docs["notes/alpha.md"].length },
    { path: "notes/beta.md", mtime_ms: 3000, size: docs["notes/beta.md"].length },
    { path: "journal/2026-01.md", mtime_ms: 9000, size: docs["journal/2026-01.md"].length },
    { path: "Sheaf/Voice Guide.md", mtime_ms: 9999, size: docs["Sheaf/Voice Guide.md"].length },
    { path: "Templates/daily.md", mtime_ms: 1000, size: docs["Templates/daily.md"].length },
  ];
  return { files, docs };
}

describe("selectCorpus", () => {
  it("excludes the voice guide and configured globs", () => {
    const { files } = corpus();
    const selected = selectCorpus(files, defaultStyleConfig());
    const paths = selected.map((f) => f.path).sort();
    expect(paths).toEqual([
      "journal/2026-01.md",
      "notes/alpha.md",
      "notes/beta.md",
    ]);
  });
});

describe("loadOrRefreshProfile", () => {
  it("computes metrics on first call and caches by fingerprint", async () => {
    const { files, docs } = corpus();
    const io = new FakeIO(files, docs);
    const config = defaultStyleConfig();

    const first = await loadOrRefreshProfile(io, config);
    expect(first.recomputed).toBe(true);
    expect(io.writes).toBe(1);
    expect(first.profile.metrics.word_count).toBeGreaterThan(0);
    // doc_count reflects the selected corpus (3), not the analyzed slice.
    expect(first.profile.metrics.doc_count).toBe(3);

    const second = await loadOrRefreshProfile(io, config);
    expect(second.recomputed).toBe(false);
    expect(io.writes).toBe(1);
  });

  it("recomputes when the corpus drifts", async () => {
    const { files, docs } = corpus();
    const io = new FakeIO(files, docs);
    const config = defaultStyleConfig();

    await loadOrRefreshProfile(io, config);
    expect(io.writes).toBe(1);

    // Edit a doc: mtime + size change -> fingerprint changes.
    io.files = io.files.map((f) =>
      f.path === "notes/alpha.md"
        ? { ...f, mtime_ms: 12000, size: f.size + 50 }
        : f,
    );
    const after = await loadOrRefreshProfile(io, config);
    expect(after.recomputed).toBe(true);
    expect(io.writes).toBe(2);
  });

  it("recomputes when the config changes", async () => {
    const { files, docs } = corpus();
    const io = new FakeIO(files, docs);

    await loadOrRefreshProfile(io, defaultStyleConfig());
    expect(io.writes).toBe(1);

    const changed = defaultStyleConfig();
    changed.exclude_globs = [...changed.exclude_globs, "journal/**"];
    const after = await loadOrRefreshProfile(io, changed);
    expect(after.recomputed).toBe(true);
    expect(after.profile.metrics.doc_count).toBe(2);
  });

  it("flags a low corpus", async () => {
    const io = new FakeIO(
      [{ path: "notes/tiny.md", mtime_ms: 1, size: 10 }],
      { "notes/tiny.md": "Just a bit." },
    );
    const load = await loadOrRefreshProfile(io, defaultStyleConfig());
    expect(load.low_corpus).toBe(true);
  });
});

describe("selectExemplars", () => {
  it("biases toward the topic and caps the count", async () => {
    const { files, docs } = corpus();
    const io = new FakeIO(files, docs);
    const config = defaultStyleConfig();
    config.exemplar_count = 2;
    const selected = selectCorpus(files, config);

    const exemplars = await selectExemplars(io, config, selected, "gardening", 10000);
    expect(exemplars.length).toBeLessThanOrEqual(2);
    // The gardening note should rank first on topic match.
    expect(exemplars[0].path).toBe("notes/beta.md");
    for (const e of exemplars) {
      expect(e.excerpt.split(" ").length).toBeLessThanOrEqual(125);
    }
  });

  it("falls back to recency without a topic", async () => {
    const { files, docs } = corpus();
    const io = new FakeIO(files, docs);
    const config = defaultStyleConfig();
    config.exemplar_count = 1;
    const selected = selectCorpus(files, config);

    const exemplars = await selectExemplars(io, config, selected, undefined, 10000);
    expect(exemplars).toHaveLength(1);
    // journal note has the newest mtime among selected corpus.
    expect(exemplars[0].path).toBe("journal/2026-01.md");
  });
});

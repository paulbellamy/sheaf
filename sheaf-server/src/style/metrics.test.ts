import { describe, expect, it } from "vitest";

import {
  compareMetrics,
  computeMetrics,
  renderMetricsSummary,
  splitSentences,
  stripMarkdown,
  styleCheck,
  tokenizeWords,
  type StylePrefsLite,
} from "./metrics";

const DEFAULT_PREFS: StylePrefsLite = {
  em_dash: "either",
  oxford_comma: "either",
  contractions: "either",
  banned_phrases: [],
};

describe("stripMarkdown", () => {
  it("drops frontmatter, code, and markers but keeps prose + link text", () => {
    const md = [
      "---",
      "title: x",
      "tag: y",
      "---",
      "# Heading",
      "Some prose with a [link](http://example.com) inside it here.",
      "",
      "- bullet one",
      "- bullet two",
      "",
      "```",
      "secret_code_here()",
      "```",
    ].join("\n");
    const { prose, structure } = stripMarkdown(md);
    expect(prose).toContain("Heading");
    expect(prose).toContain("link");
    expect(prose).not.toContain("secret_code_here");
    expect(prose).not.toContain("title: x");
    expect(structure.heading_lines).toBe(1);
    expect(structure.bullet_lines).toBe(2);
    expect(structure.code_fences).toBe(2);
  });
});

describe("splitSentences", () => {
  it("splits on terminal punctuation", () => {
    expect(splitSentences("I like cats. I like dogs too! Do you?")).toEqual([
      "I like cats.",
      "I like dogs too!",
      "Do you?",
    ]);
  });

  it("does not split on abbreviations or decimals", () => {
    expect(splitSentences("See e.g. the value 3.14 holds. Done.")).toEqual([
      "See e.g. the value 3.14 holds.",
      "Done.",
    ]);
  });
});

describe("tokenizeWords", () => {
  it("lowercases and keeps contractions", () => {
    expect(tokenizeWords("Don't STOP, really.")).toEqual([
      "don't",
      "stop",
      "really",
    ]);
  });
});

describe("computeMetrics", () => {
  it("is deterministic and counts words/sentences", () => {
    const a = computeMetrics(["I like cats. I like dogs too! Do you?"]);
    const b = computeMetrics(["I like cats. I like dogs too! Do you?"]);
    expect(a).toEqual(b);
    expect(a.word_count).toBe(9);
    expect(a.sentence.mean_len).toBe(3);
    expect(a.sentence.burstiness).toBeGreaterThan(0);
    expect(a.function_words.i).toBeGreaterThan(0);
  });

  it("handles empty input without dividing by zero", () => {
    const m = computeMetrics([]);
    expect(m.word_count).toBe(0);
    expect(m.sentence.mean_len).toBe(0);
    expect(m.sentence.burstiness).toBe(0);
    expect(m.type_token_ratio).toBe(0);
    expect(m.punctuation.em_dash).toBe(0);
  });

  it("detects punctuation habits and AI tells", () => {
    const m = computeMetrics([
      "We should delve into this — it is a testament to robust design. Furthermore, leverage the realm.",
    ]);
    expect(m.punctuation.em_dash).toBeGreaterThan(0);
    expect(m.ai_tells["delve"]).toBeGreaterThan(0);
    expect(m.ai_tells["leverage"]).toBeGreaterThan(0);
    expect(m.ai_tells["furthermore"]).toBeGreaterThan(0);
  });

  it("measures contraction rate", () => {
    const withContractions = computeMetrics(["I can't go and won't try."]);
    const without = computeMetrics(["I cannot go and will not try."]);
    expect(withContractions.contraction_rate).toBeGreaterThan(0.5);
    expect(without.contraction_rate).toBeLessThan(0.5);
  });
});

describe("styleCheck", () => {
  it("flags banned phrases as off", () => {
    const r = styleCheck("This is very unique and special.", null, {
      ...DEFAULT_PREFS,
      banned_phrases: ["very unique"],
    });
    expect(r.hits.banned_phrases).toEqual([{ phrase: "very unique", count: 1 }]);
    expect(r.verdict).toBe("off");
  });

  it("flags em-dashes when the user bans them", () => {
    const r = styleCheck("First point — then another.", null, {
      ...DEFAULT_PREFS,
      em_dash: "no",
    });
    expect(r.hits.em_dash).toBeGreaterThan(0);
    expect(r.verdict).toBe("off");
    expect(r.suggestions.join(" ")).toMatch(/em-dash/i);
  });

  it("flags heavy AI-tell phrasing", () => {
    const r = styleCheck(
      "Let us delve into the realm. Furthermore, this is a testament to robust, seamless design.",
      null,
      DEFAULT_PREFS,
    );
    expect(r.hits.ai_tells.length).toBeGreaterThanOrEqual(3);
    expect(r.verdict).toBe("off");
  });

  it("passes clean prose with no profile", () => {
    const r = styleCheck(
      "The cat sat on the mat. It was a warm day.",
      null,
      DEFAULT_PREFS,
    );
    expect(r.verdict).toBe("close");
    expect(r.has_profile).toBe(false);
    expect(r.suggestions).toHaveLength(0);
  });

  it("reports near-zero function-word drift for matching text", () => {
    const profile = computeMetrics([
      "The team shipped the feature. The users liked it. We moved on to the next thing and it was fine.",
    ]);
    const r = styleCheck(
      "The team shipped the feature. The users liked it. We moved on to the next thing and it was fine.",
      profile,
      DEFAULT_PREFS,
    );
    expect(r.has_profile).toBe(true);
    expect(r.deviations.function_word_drift).toBeLessThan(0.05);
  });
});

describe("compareMetrics", () => {
  it("is ~zero for identical corpora and non-zero for divergent ones", () => {
    const a = computeMetrics([
      "The team shipped the feature. The users liked it. We moved on quickly.",
    ]);
    const same = compareMetrics(a, a);
    expect(same.function_word_drift).toBeLessThan(0.01);
    expect(same.sentence_mean_delta).toBe(0);

    const terse = computeMetrics(["Ship it. Watch. Repeat."]);
    const verbose = computeMetrics([
      "When we finally decided to ship the feature, after much deliberation and several rounds of review, the whole team gathered to watch the dashboards together.",
    ]);
    const cmp = compareMetrics(terse, verbose);
    expect(cmp.sentence_mean_delta).toBeLessThan(0); // terse has shorter sentences
    expect(Math.abs(cmp.function_word_drift)).toBeGreaterThan(0);
  });
});

describe("renderMetricsSummary", () => {
  it("produces a compact multi-line digest", () => {
    const m = computeMetrics(["The cat sat. The dog ran. We watched them both."]);
    const summary = renderMetricsSummary(m, DEFAULT_PREFS);
    expect(summary).toMatch(/Sentences:/);
    expect(summary).toMatch(/Punctuation/);
    expect(summary.split("\n").length).toBeGreaterThanOrEqual(8);
  });

  it("notes an empty corpus", () => {
    expect(renderMetricsSummary(computeMetrics([]), DEFAULT_PREFS)).toMatch(
      /no corpus/i,
    );
  });
});

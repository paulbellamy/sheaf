import { describe, expect, it } from "vitest";

import {
  ACP_AGENTS,
  ACP_EFFORTS,
  DEFAULT_ACP_AGENT_ID,
  getAcpAgent,
} from "./registry";

describe("ACP agent registry", () => {
  it("ships the Claude Code and Codex adapters", () => {
    const ids = ACP_AGENTS.map((a) => a.id);
    expect(ids).toContain("claude-code");
    expect(ids).toContain("codex");
  });

  it("has unique ids and a default that exists", () => {
    const ids = ACP_AGENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(getAcpAgent(DEFAULT_ACP_AGENT_ID)).toBeDefined();
  });

  it("every entry has a spawnable command and an install hint", () => {
    for (const a of ACP_AGENTS) {
      expect(a.command.length).toBeGreaterThan(0);
      expect(a.args.length).toBeGreaterThan(0);
      expect(a.installHint.length).toBeGreaterThan(0);
    }
  });

  it("looks up by id and returns undefined for unknown ids", () => {
    expect(getAcpAgent("claude-code")?.displayName).toBe("Claude Code");
    expect(getAcpAgent("nope")).toBeUndefined();
  });
});

describe("ACP effort → env mapping", () => {
  it("exposes Claude Code's real modes", () => {
    expect([...ACP_EFFORTS]).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("claude-code maps every mode to CLAUDE_CODE_EFFORT_LEVEL verbatim", () => {
    const claude = getAcpAgent("claude-code")!;
    for (const e of ACP_EFFORTS) {
      expect(claude.effortEnv?.(e)).toEqual({ CLAUDE_CODE_EFFORT_LEVEL: e });
    }
  });

  it("codex passes low/medium/high through and clamps xhigh/max to high", () => {
    const codex = getAcpAgent("codex")!;
    const effort = (e: (typeof ACP_EFFORTS)[number]) =>
      JSON.parse(codex.effortEnv!(e).CODEX_CONFIG).model_reasoning_effort;
    expect(effort("low")).toBe("low");
    expect(effort("medium")).toBe("medium");
    expect(effort("high")).toBe("high");
    expect(effort("xhigh")).toBe("high");
    expect(effort("max")).toBe("high");
  });
});

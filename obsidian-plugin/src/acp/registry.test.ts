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
  it("exposes default/low/medium/high", () => {
    expect([...ACP_EFFORTS]).toEqual(["default", "low", "medium", "high"]);
  });

  it("default returns no env override for either agent", () => {
    for (const a of ACP_AGENTS) {
      expect(a.effortEnv?.("default")).toEqual({});
    }
  });

  it("claude-code maps effort to CLAUDE_CODE_EFFORT_LEVEL", () => {
    expect(getAcpAgent("claude-code")?.effortEnv?.("high")).toEqual({
      CLAUDE_CODE_EFFORT_LEVEL: "high",
    });
  });

  it("codex maps effort to CODEX_CONFIG json", () => {
    expect(getAcpAgent("codex")?.effortEnv?.("medium")).toEqual({
      CODEX_CONFIG: JSON.stringify({ model_reasoning_effort: "medium" }),
    });
  });
});

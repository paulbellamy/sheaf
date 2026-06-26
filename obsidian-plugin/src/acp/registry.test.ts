import { describe, expect, it } from "vitest";

import {
  ACP_AGENTS,
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

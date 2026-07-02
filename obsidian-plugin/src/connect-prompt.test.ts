import { describe, expect, it } from "vitest";

import { agentConnectPrompt } from "./connect-prompt";

describe("agentConnectPrompt", () => {
  it("is the whole-vault prompt when no doc is open", () => {
    const prompt = agentConnectPrompt();
    expect(prompt).toContain("watch for events");
    expect(prompt).toContain("keep handling new ones until I stop you");
    // No doc → no "currently working on" clause.
    expect(prompt).not.toContain("currently working on");
  });

  it("treats null/empty the same as no doc (whole-vault)", () => {
    const base = agentConnectPrompt();
    expect(agentConnectPrompt(null)).toBe(base);
    expect(agentConnectPrompt("")).toBe(base);
  });

  it("names the current doc as the starting point when one is open", () => {
    const prompt = agentConnectPrompt("notes/foo.md");
    expect(prompt).toContain('currently working on "notes/foo.md"');
    expect(prompt).toContain("start with its open threads");
  });

  it("stays less restrictive than ACP — still watches the whole vault", () => {
    // The doc is a *starting point*, not a scope: the whole-vault watch and the
    // "keep handling new ones" instruction survive alongside the named doc.
    const prompt = agentConnectPrompt("notes/foo.md");
    expect(prompt).toContain("watch for events");
    expect(prompt).toContain("keep handling new ones until I stop you");
  });
});

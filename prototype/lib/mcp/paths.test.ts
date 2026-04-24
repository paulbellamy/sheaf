import { describe, expect, it } from "vitest";

import {
  assertDraftId,
  assertReadablePath,
  assertThreadId,
  assertWorkspacePath,
  isPluginPath,
  safeJoin,
} from "./paths";

describe("assertWorkspacePath", () => {
  it("accepts a clean workspace path", () => {
    expect(() =>
      assertWorkspacePath("workspaces/infra/docs/proposal.md"),
    ).not.toThrow();
  });

  it("accepts legitimate double-dots in a segment", () => {
    expect(() =>
      assertWorkspacePath("workspaces/foo/..bar/doc.md"),
    ).not.toThrow();
  });

  it("rejects paths that do not start with workspaces/", () => {
    expect(() => assertWorkspacePath("etc/passwd")).toThrow();
    expect(() => assertWorkspacePath(".drafts/x/meta.json")).toThrow();
  });

  it("rejects traversal segments", () => {
    expect(() => assertWorkspacePath("workspaces/../etc/passwd")).toThrow();
    expect(() => assertWorkspacePath("workspaces/foo/../../etc")).toThrow();
  });

  it("rejects null-byte injection", () => {
    expect(() => assertWorkspacePath("workspaces/\0/x.md")).toThrow();
  });

  it("rejects absolute paths", () => {
    expect(() => assertWorkspacePath("/workspaces/x.md")).toThrow();
    expect(() => assertWorkspacePath("C:\\workspaces\\x.md")).toThrow();
  });

  it("rejects empty and non-string inputs", () => {
    expect(() => assertWorkspacePath("")).toThrow();
    // @ts-expect-error runtime fuzz
    expect(() => assertWorkspacePath(undefined)).toThrow();
  });
});

describe("assertReadablePath", () => {
  it("accepts workspace paths", () => {
    expect(() =>
      assertReadablePath("workspaces/infra/docs/proposal.md"),
    ).not.toThrow();
  });

  it("accepts plugin paths", () => {
    expect(() =>
      assertReadablePath(".claude-plugin/skills/sheaf-event-watcher/SKILL.md"),
    ).not.toThrow();
    expect(() =>
      assertReadablePath(".claude-plugin/scripts/watch-events.mjs"),
    ).not.toThrow();
  });

  it("rejects paths that match neither prefix", () => {
    expect(() => assertReadablePath("etc/passwd")).toThrow();
    expect(() => assertReadablePath(".drafts/x/meta.json")).toThrow();
    expect(() => assertReadablePath(".claude/settings.json")).toThrow();
  });

  it("rejects traversal segments under either prefix", () => {
    expect(() => assertReadablePath("workspaces/../etc/passwd")).toThrow();
    expect(() =>
      assertReadablePath(".claude-plugin/../etc/passwd"),
    ).toThrow();
    expect(() =>
      assertReadablePath(".claude-plugin/foo/../../etc"),
    ).toThrow();
  });

  it("rejects null-byte injection", () => {
    expect(() => assertReadablePath(".claude-plugin/\0/x")).toThrow();
  });

  it("rejects absolute paths", () => {
    expect(() => assertReadablePath("/.claude-plugin/x")).toThrow();
  });
});

describe("isPluginPath", () => {
  it("detects the plugin prefix", () => {
    expect(isPluginPath(".claude-plugin/skills/foo/SKILL.md")).toBe(true);
  });

  it("returns false for workspace paths", () => {
    expect(isPluginPath("workspaces/infra/docs/proposal.md")).toBe(false);
  });

  it("returns false for non-string inputs", () => {
    // @ts-expect-error runtime fuzz
    expect(isPluginPath(undefined)).toBe(false);
  });
});

describe("safeJoin", () => {
  it("resolves a relative path under the root", () => {
    const root = "/tmp/root";
    expect(safeJoin(root, "a/b.md")).toBe("/tmp/root/a/b.md");
  });

  it("rejects null-byte rels", () => {
    expect(() => safeJoin("/tmp/root", "a/\0b.md")).toThrow();
  });

  it("rejects escape via ..", () => {
    expect(() => safeJoin("/tmp/root", "../outside")).toThrow();
  });

  it("rejects absolute rels outside root", () => {
    expect(() => safeJoin("/tmp/root", "/etc/passwd")).toThrow();
  });
});

describe("assertDraftId / assertThreadId", () => {
  it("accepts the canonical form", () => {
    expect(() =>
      assertDraftId("draft_00000000-0000-4000-8000-000000000000"),
    ).not.toThrow();
    expect(() =>
      assertThreadId("thrd_00000000-0000-4000-8000-000000000000"),
    ).not.toThrow();
  });

  it("rejects empty / path-escape forms", () => {
    expect(() => assertDraftId("draft_-")).toThrow();
    expect(() => assertDraftId("draft_../etc")).toThrow();
    expect(() => assertDraftId("draft_")).toThrow();
    expect(() => assertThreadId("thrd_../etc")).toThrow();
  });
});

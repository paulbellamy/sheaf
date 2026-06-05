import { describe, expect, it } from "vitest";

import {
  assertDraftId,
  assertReadablePath,
  assertThreadId,
  assertVaultPath,
  isPluginPath,
  safeJoin,
} from "./paths";

describe("assertVaultPath", () => {
  it("accepts any visible vault path", () => {
    expect(() => assertVaultPath("notes/proposal.md")).not.toThrow();
    expect(() => assertVaultPath("README.md")).not.toThrow();
    // `workspaces/` is just an ordinary folder now.
    expect(() => assertVaultPath("workspaces/infra/docs/proposal.md")).not.toThrow();
    expect(() => assertVaultPath("etc/passwd")).not.toThrow();
  });

  it("rejects dot-prefixed segments (infra + Obsidian-hidden)", () => {
    expect(() => assertVaultPath(".drafts/x/meta.json")).toThrow();
    expect(() => assertVaultPath(".obsidian/workspace.json")).toThrow();
    expect(() => assertVaultPath("notes/.hidden/x.md")).toThrow();
    // A leading-dot segment anywhere is hidden by Obsidian, so rejected.
    expect(() => assertVaultPath("workspaces/foo/..bar/doc.md")).toThrow();
  });

  it("rejects traversal segments", () => {
    expect(() => assertVaultPath("workspaces/../etc/passwd")).toThrow();
    expect(() => assertVaultPath("workspaces/foo/../../etc")).toThrow();
    expect(() => assertVaultPath("../outside.md")).toThrow();
  });

  it("rejects empty segments", () => {
    expect(() => assertVaultPath("notes//x.md")).toThrow();
    expect(() => assertVaultPath("notes/")).toThrow();
  });

  it("rejects null-byte injection", () => {
    expect(() => assertVaultPath("notes/\0/x.md")).toThrow();
  });

  it("rejects absolute paths", () => {
    expect(() => assertVaultPath("/notes/x.md")).toThrow();
    expect(() => assertVaultPath("C:\\notes\\x.md")).toThrow();
  });

  it("rejects empty and non-string inputs", () => {
    expect(() => assertVaultPath("")).toThrow();
    // @ts-expect-error runtime fuzz
    expect(() => assertVaultPath(undefined)).toThrow();
  });
});

describe("assertReadablePath", () => {
  it("accepts vault paths", () => {
    expect(() => assertReadablePath("notes/proposal.md")).not.toThrow();
    expect(() => assertReadablePath("README.md")).not.toThrow();
  });

  it("accepts plugin paths", () => {
    expect(() =>
      assertReadablePath(".claude-plugin/skills/sheaf-event-watcher/SKILL.md"),
    ).not.toThrow();
    expect(() =>
      assertReadablePath(".claude-plugin/scripts/watch-events.mjs"),
    ).not.toThrow();
  });

  it("rejects non-plugin dot-prefixed paths", () => {
    expect(() => assertReadablePath(".drafts/x/meta.json")).toThrow();
    expect(() => assertReadablePath(".claude/settings.json")).toThrow();
  });

  it("rejects traversal segments under either prefix", () => {
    expect(() => assertReadablePath("notes/../etc/passwd")).toThrow();
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

  it("returns false for vault paths", () => {
    expect(isPluginPath("notes/proposal.md")).toBe(false);
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

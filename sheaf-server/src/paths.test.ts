import { describe, expect, it } from "vitest";

import {
  assertDraftId,
  assertThreadId,
  assertVaultPath,
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

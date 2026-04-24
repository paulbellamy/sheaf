import { describe, expect, it } from "vitest";

import {
  assertDraftId,
  assertThreadId,
  assertWorkspacePath,
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

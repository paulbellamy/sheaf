import { describe, expect, it } from "vitest";

import { makeToVaultPath } from "./vault-fs";

/**
 * The absolute→vault-relative mapper is security-relevant: it's what stops the
 * agent (which speaks absolute ACP paths) from reaching outside the vault. Pure,
 * so unit-tested directly (the VaultFs adapter over Obsidian's DataAdapter is
 * typecheck-only).
 */
describe("makeToVaultPath", () => {
  const toVault = makeToVaultPath("/home/u/vault");

  it("maps an in-vault absolute path to a forward-slash relative path", () => {
    expect(toVault("/home/u/vault/notes/a.md")).toBe("notes/a.md");
    expect(toVault("/home/u/vault/a.md")).toBe("a.md");
  });

  it("rejects the vault root itself", () => {
    expect(toVault("/home/u/vault")).toBeNull();
  });

  it("rejects paths outside the vault", () => {
    expect(toVault("/home/u/other/x.md")).toBeNull();
    expect(toVault("/etc/passwd")).toBeNull();
  });

  it("rejects traversal that escapes the vault", () => {
    expect(toVault("/home/u/vault/../secret.md")).toBeNull();
    expect(toVault("/home/u/vault/sub/../../secret.md")).toBeNull();
  });

  it("keeps an in-vault path that contains a harmless .. that stays inside", () => {
    // /home/u/vault/a/../b.md resolves to /home/u/vault/b.md — still in vault.
    expect(toVault("/home/u/vault/a/../b.md")).toBe("b.md");
  });
});

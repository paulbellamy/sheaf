import * as path from "node:path";

/**
 * Build the absolute→vault-relative mapper for {@link AcpConnection}. ACP paths
 * are absolute (cwd = vault root); sheaf paths are vault-relative with forward
 * slashes. Returns null for anything outside the vault (and for the root itself
 * and `..` traversal).
 *
 * Pure and security-relevant — it's what stops the agent (which speaks absolute
 * ACP paths) from reaching outside the vault — so it lives apart from the
 * Obsidian-glue {@link obsidianVaultFs} and is unit-tested directly.
 *
 * NOTE: this is a lexical check — it does not resolve symlinks, so an in-vault
 * symlink pointing outside the vault would not be caught here. Acceptable for
 * the local, user-launched prototype (Obsidian itself follows such links); a
 * hardened version would `fs.realpath` before comparing.
 */
export function makeToVaultPath(
  vaultRoot: string,
): (absPath: string) => string | null {
  return (absPath: string): string | null => {
    const rel = path.relative(vaultRoot, absPath);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join("/");
  };
}

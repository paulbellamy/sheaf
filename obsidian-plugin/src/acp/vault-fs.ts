import * as path from "node:path";
import type { DataAdapter } from "obsidian";

import type { VaultFs } from "./doc-store";

/**
 * A {@link VaultFs} backed by Obsidian's vault `DataAdapter`. Paths are
 * vault-relative (the adapter's native form). Parent folders are created on
 * write so the hidden `.sheaf/ycrdt/` snapshot mirror materializes on demand.
 */
export function obsidianVaultFs(adapter: DataAdapter): VaultFs {
  return {
    exists: (p) => adapter.exists(p),
    readText: (p) => adapter.read(p),
    async writeText(p, data) {
      await ensureParent(adapter, p);
      await adapter.write(p, data);
    },
    async readBinary(p) {
      return new Uint8Array(await adapter.readBinary(p));
    },
    async writeBinary(p, data) {
      await ensureParent(adapter, p);
      await adapter.writeBinary(p, toArrayBuffer(data));
    },
  };
}

async function ensureParent(adapter: DataAdapter, p: string): Promise<void> {
  const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
  if (dir && !(await adapter.exists(dir))) {
    await adapter.mkdir(dir);
  }
}

function toArrayBuffer(d: Uint8Array): ArrayBuffer {
  return d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer;
}

/**
 * Build the absolute→vault-relative mapper for {@link AcpConnection}. ACP paths
 * are absolute (cwd = vault root); sheaf paths are vault-relative with forward
 * slashes. Returns null for anything outside the vault.
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

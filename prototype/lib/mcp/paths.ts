import * as path from "node:path";

import { err } from "./errors";

/**
 * Path + id validators shared by the backend and UI route handlers.
 *
 * These are the single trust boundary for user-controlled strings that are
 * later used in `path.join`, directory walks, or filesystem reads. The guiding
 * invariants:
 *
 * - Workspace doc paths MUST resolve under `<root>/workspaces/`.
 * - Draft ids MUST match `DRAFT_ID_RE` before being used as path segments.
 * - Thread ids MUST match `THREAD_ID_RE` before being used as path segments.
 *
 * Substring checks like `startsWith("workspaces/")` or `!includes("..")` are
 * insufficient: null bytes, Unicode dot variants (U+2024), and percent-encoded
 * traversal all bypass them.
 */

// Keep tight: alphanumerics, underscores, hyphens, and dots for segment
// separators. Length-bound to prevent pathological inputs.
export const DRAFT_ID_RE =
  /^draft_[A-Za-z0-9]{6,64}(?:-[A-Za-z0-9]{1,64}){0,8}$/;

export const THREAD_ID_RE =
  /^thrd_[A-Za-z0-9]{6,64}(?:-[A-Za-z0-9]{1,64}){0,8}$/;

/**
 * Resolve `rel` against `rootAbs` and assert the result stays within
 * `rootAbs`. Rejects null bytes up front because Node's path APIs silently
 * truncate at them.
 *
 * Returns an absolute path safe to pass to `fs.*`.
 */
export function safeJoin(rootAbs: string, rel: string): string {
  if (typeof rel !== "string" || rel.length === 0) throw err.invalidPath(rel);
  if (rel.includes("\0")) throw err.invalidPath(rel);
  const abs = path.resolve(rootAbs, rel);
  const rel2 = path.relative(rootAbs, abs);
  if (rel2.startsWith("..") || path.isAbsolute(rel2)) {
    throw err.invalidPath(rel);
  }
  return abs;
}

/**
 * Assert a path is a well-formed workspace doc path. Workspace paths are
 * stored/passed as repo-root-relative strings under `workspaces/` and must
 * not contain null bytes, absolute segments, or parent-traversal segments.
 *
 * This check is invariant-only — it does not touch the filesystem.
 */
export function assertWorkspacePath(p: string): void {
  assertPathWithPrefixes(p, ["workspaces/"]);
}

/**
 * Plugin paths live at the repo root (not under the data root) and are
 * served read-only. They carry the bundled skills and scripts so agents can
 * discover how to use the MCP without installing the plugin locally.
 */
export const PLUGIN_PATH_PREFIX = ".claude-plugin/";

export function isPluginPath(p: string): boolean {
  if (typeof p !== "string") return false;
  return path.posix.normalize(p).startsWith(PLUGIN_PATH_PREFIX);
}

/**
 * Assert a path is readable via the MCP. Accepts either a workspace doc
 * path or a plugin-tree path. Use for read-only tool inputs; mutations must
 * still call `assertWorkspacePath` so they cannot target the plugin tree.
 */
export function assertReadablePath(p: string): void {
  assertPathWithPrefixes(p, ["workspaces/", PLUGIN_PATH_PREFIX]);
}

function assertPathWithPrefixes(p: string, prefixes: string[]): void {
  if (typeof p !== "string" || p.length === 0) throw err.invalidPath(p);
  if (p.includes("\0")) throw err.invalidPath(p);
  // Normalize using posix-style rules; we store paths with forward slashes.
  const normalized = path.posix.normalize(p);
  const matched = prefixes.find((prefix) => normalized.startsWith(prefix));
  if (
    !matched ||
    // A bare `<prefix>..` normalizes to the prefix's parent — reject it.
    normalized === matched.slice(0, -1) + "/.." ||
    normalized.split("/").some((seg) => seg === "..")
  ) {
    throw err.invalidPath(p);
  }
  if (path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p)) {
    throw err.invalidPath(p);
  }
}

export function assertDraftId(id: string): void {
  if (typeof id !== "string" || !DRAFT_ID_RE.test(id)) {
    throw err.invalidRef(String(id));
  }
}

export function assertThreadId(id: string): void {
  if (typeof id !== "string" || !THREAD_ID_RE.test(id)) {
    throw err.invalidThreadId(String(id));
  }
}

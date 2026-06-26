import * as path from "node:path";

import { err } from "./errors";

/**
 * Path + id validators shared by the backend and UI route handlers.
 *
 * These are the single trust boundary for user-controlled strings that are
 * later used in `path.join`, directory walks, or filesystem reads. The guiding
 * invariants:
 *
 * - Doc paths MUST be repo-root-relative and contain no `.`-prefixed segment.
 *   Obsidian hides anything beginning with a dot, so this one rule scopes
 *   sheaf to the *visible* vault and simultaneously blocks `..` traversal and
 *   infra dirs (`.drafts/`, `.op_log.json`, `.obsidian/`, `.git/`, `.trash/`).
 * - Draft ids MUST match `DRAFT_ID_RE` before being used as path segments.
 * - Thread ids MUST match `THREAD_ID_RE` before being used as path segments.
 *
 * A bare `!includes("..")` check is insufficient: null bytes and absolute
 * segments must be rejected explicitly, which is why we split-and-inspect
 * every segment rather than substring-match.
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
 * Assert a path is a well-formed vault doc path: a repo-root-relative string
 * with forward slashes whose every segment is a "visible" name. Obsidian hides
 * anything starting with `.`, so rejecting `.`-prefixed segments both scopes
 * sheaf to the visible vault and rules out `..` traversal, null bytes, and the
 * infra trees in one pass.
 *
 * This check is invariant-only — it does not touch the filesystem.
 */
export function assertVaultPath(p: string): void {
  if (typeof p !== "string" || p.length === 0) throw err.invalidPath(p);
  if (p.includes("\0")) throw err.invalidPath(p);
  if (path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p)) throw err.invalidPath(p);
  // Inspect the raw (pre-normalize) segments: a leading `.` covers dotfiles,
  // `.drafts`, `.obsidian`, and `..` traversal; an empty segment covers `//`
  // and trailing slashes. Don't normalize first — that would silently resolve
  // `a/../b` into a path we never validated.
  if (p.split("/").some((seg) => seg.length === 0 || seg.startsWith("."))) {
    throw err.invalidPath(p);
  }
}

/**
 * Remap `p` when it sits at or under a renamed path `from` → `to`. Returns the
 * rewritten path, or null when `p` is unaffected. One routine covers both
 * Obsidian rename shapes: a file rename (`p === from`) and a folder rename
 * (`p` is a descendant of the folder, `from + "/…"`). Pure string logic — the
 * caller decides what to do with the result.
 */
export function remapRenamedPath(
  p: string,
  from: string,
  to: string,
): string | null {
  if (p === from) return to;
  if (p.startsWith(from + "/")) return to + p.slice(from.length);
  return null;
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
 * Assert a path is readable via the MCP. Accepts either a vault doc path or a
 * plugin-tree path. Use for read-only tool inputs; mutations must still call
 * `assertVaultPath` so they cannot target the (dot-prefixed) plugin tree.
 */
export function assertReadablePath(p: string): void {
  if (isPluginPath(p)) {
    assertPathWithPrefixes(p, [PLUGIN_PATH_PREFIX]);
    return;
  }
  assertVaultPath(p);
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

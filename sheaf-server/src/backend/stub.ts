import { promises as fs, constants as fsConstants } from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import {
  type Backend,
  type BackendEvent,
  type DocContent,
  type DocPath,
  type DocSummary,
  type DraftId,
  type DraftSummary,
  type GrepMatch,
  type GrepOptions,
  type GrepResult,
  type OpId,
  type Origin,
  type Ref,
  type Thread,
  type ThreadAnchor,
  type ThreadDraftBody,
  type ThreadId,
  type ThreadSummary,
  type VersionHistoryEntry,
  type WriteResult,
} from "./index";
import { McpError, err, type MergeConflictDetail } from "../errors";
import { globToRegex } from "../glob";
import {
  DRAFT_ID_RE,
  PLUGIN_PATH_PREFIX,
  assertDraftId,
  assertReadablePath,
  assertThreadId,
  assertVaultPath,
  isPluginPath,
  remapRenamedPath,
  safeJoin,
} from "../paths";
import { draftMetaSchema, opLogSchema } from "../persistence-schemas";
import {
  cleanProse,
  parseReviewDoc,
  serializeReviewDoc,
} from "./review-doc";
import {
  type CorpusFile,
  type StyleConfig,
  type StyleProfile,
  defaultStyleConfig,
} from "../style/profile";
import { styleConfigSchema, styleProfileSchema } from "../style/schemas";

/**
 * Filesystem-backed stub backend for the prototype.
 *
 * `<root>` is the Obsidian vault root. Any visible markdown file under it is a
 * sheaf doc — `<dir>/<name>.md` at any depth. Dot-prefixed entries (`.drafts/`,
 * `.op_log.json`, `.obsidian/`, …) are infra and never surfaced as docs.
 *
 * Layout (all under `<root>`):
 *   <dir>/<name>.md                                        # prose + inline RFM review markup
 *   .drafts/<draft_id>/meta.json
 *   .drafts/<draft_id>/<dir>/<name>.md                     # changed files only
 *   .op_log.json
 *
 * Threads live inline in the doc markdown (CriticMarkup spans + a YAML
 * endmatter block — see `review-doc.ts`), not in sidecar files. `readDoc`
 * returns the clean prose with that markup stripped; the thread methods
 * read/write the endmatter directly.
 *
 * No yjs, no git, no case-2 sync. Every "commit" is a new uuid so clients
 * that cache by commit hash behave correctly.
 */

type DraftMeta = {
  draft_id: DraftId;
  base_path: DocPath;
  /** Natural-language intent — set at Fork, editable at Propose. */
  intent?: string;
  author: string;
  state: "open" | "submitted" | "accepted" | "declined";
  created_at: number;
  submitted_at?: number;
  name?: string;
  display_name?: string;
  touches?: DocPath[];
  base_version?: number;
  parent_draft_id?: DraftId;
};

type OpLog = Record<string, WriteResult>;

function assertDraftRef(ref: Ref): asserts ref is DraftId {
  if (ref === "main") throw err.writeToMainForbidden();
  assertDraftId(ref);
}

/**
 * Bump the per-doc version counter on a main write. Direct edits to main
 * (Obsidian-prototype mode: agent writes land without a draft round-trip)
 * still want a monotonic version number so callers can stale-check.
 */
function bumpCounter(
  counters: Map<DocPath, number>,
  p: DocPath,
): void {
  counters.set(p, (counters.get(p) ?? 0) + 1);
}

/**
 * `<name> #<4hex>` per the resolved-decisions rule. Suffix comes from the
 * first 4 chars of `draft_id` after stripping the `draft_` prefix; the id
 * remains the unique key, the suffix is just the human-legible disambiguator.
 */
function renderDisplayName(name: string, draftId: DraftId): string {
  const suffix = draftId.startsWith("draft_")
    ? draftId.slice("draft_".length, "draft_".length + 4)
    : draftId.slice(0, 4);
  return `${name} #${suffix}`;
}

function titleFromMd(md: string, fallback: string): string {
  const line = md.split("\n").find((l) => l.trim().length > 0) ?? "";
  const m = line.match(/^#+\s+(.+)$/);
  return (m?.[1] ?? fallback).trim();
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      // Skip dot-prefixed entries: Obsidian hides them, and they hold our own
      // infra (`.drafts/`, `.op_log.json`) plus vault config (`.obsidian/`).
      // This is what scopes the vault walk to visible docs. The `.drafts` and
      // plugin trees are walked from inside (their roots are passed in), so
      // their non-dot contents are unaffected.
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      // Silently skip symlinks/devices/sockets/FIFOs — `isFile()` /
      // `isDirectory()` already return false for them, but the explicit
      // symlink check documents the invariant.
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) out.push(full);
    }
  }
  return out;
}

/**
 * Symlink-hostile file read. Opens with `O_NOFOLLOW` so a symlink planted at
 * the final path component fails with ELOOP instead of being silently
 * dereferenced into (e.g.) `/etc/passwd`.
 */
/** Largest file we're willing to read into memory. See MAX_DISK_BYTES in
 *  persistence-schemas.ts for the matching "structured" cap. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

async function readFileNoFollow(abs: string): Promise<string> {
  const fh = await fs.open(
    abs,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const st = await fh.stat();
    if (st.size > MAX_FILE_BYTES) {
      throw err.payloadTooLarge(`file ${abs}`, MAX_FILE_BYTES);
    }
    const buf = await fh.readFile();
    return buf.toString("utf8");
  } finally {
    await fh.close();
  }
}

/**
 * Symlink-hostile file write. Rejects pre-existing symlinks up front; then
 * opens with `O_NOFOLLOW | O_CREAT | O_WRONLY | O_TRUNC` so any race-created
 * symlink between the lstat and the open still fails.
 */
async function writeFileNoFollow(abs: string, content: string): Promise<void> {
  try {
    const st = await fs.lstat(abs);
    if (st.isSymbolicLink()) throw err.invalidPath(abs);
  } catch (e) {
    if (e instanceof McpError) throw e;
    // ENOENT is fine — we're about to create.
  }
  const fh = await fs.open(
    abs,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_TRUNC |
      fsConstants.O_NOFOLLOW,
    0o644,
  );
  try {
    await fh.writeFile(content, "utf8");
  } finally {
    await fh.close();
  }
}

/**
 * Symlink-hostile copy. Rejects symlinks at both ends.
 */
async function copyFileNoFollow(src: string, dest: string): Promise<void> {
  const srcStat = await fs.lstat(src);
  if (!srcStat.isFile()) throw err.invalidPath(src);
  const content = await readFileNoFollow(src);
  await writeFileNoFollow(dest, content);
}

export class StubBackend implements Backend {
  private root: string;
  /**
   * Repo-root dir that holds `.claude-plugin/`. Exposed read-only so remote
   * agents can discover the bundled skills + scripts through `Read`/`Glob`/
   * `Grep` without installing the plugin locally.
   */
  private pluginRoot: string;
  private opLogPath: string;
  /** Hidden cache for the style profile + bridged config (see `.sheaf/`). */
  private styleProfilePath: string;
  private styleConfigPath: string;
  private opLogCache: OpLog | null = null;
  private lockChain: Promise<unknown> = Promise.resolve();
  private subscribers = new Set<(event: BackendEvent) => void>();
  /**
   * Subset of `subscribers` registered with `role: "agent"`. Tracked so the
   * `agent_presence` event reflects watcher/MCP sessions only — UI tabs
   * don't mark themselves as connected agents.
   */
  private agentSubscribers = new Set<(event: BackendEvent) => void>();
  /** Unix-ms of the last moment an agent subscriber was registered. */
  private agentLastSeen: number | undefined;
  /**
   * Per-doc monotonic version counter. Initialized to 1 the first time a doc
   * with prose is read on main; bumped on draft accept (Phase I wires the
   * bump). In-memory only — production will derive from accept-commit
   * metadata.
   */
  private versionCounters = new Map<DocPath, number>();
  /**
   * Phase K: per-doc accepted-draft history. Appended in `merge()` for each
   * touched path. The initial v1 has no entry — readers should treat the
   * absence as "no draft produced this version".
   */
  private versionHistory = new Map<DocPath, VersionHistoryEntry[]>();

  constructor(root: string, pluginRoot?: string) {
    this.root = root;
    this.pluginRoot = pluginRoot ?? path.resolve(root, "..");
    this.opLogPath = path.join(root, ".op_log.json");
    this.styleProfilePath = path.join(root, ".sheaf", "style-profile.json");
    this.styleConfigPath = path.join(root, ".sheaf", "config.json");
  }

  subscribe(
    listener: (event: BackendEvent) => void,
    opts?: { role?: "ui" | "agent" },
  ): () => void {
    const role = opts?.role ?? "ui";
    this.subscribers.add(listener);
    if (role === "agent") {
      const wasEmpty = this.agentSubscribers.size === 0;
      this.agentSubscribers.add(listener);
      if (wasEmpty) {
        // 0 -> 1 transition: notify everyone (including this fresh listener).
        this.emit({ kind: "agent_presence", connected: true });
      }
    } else {
      // Replay current presence to the new UI listener so the dock indicator
      // resolves on connect rather than waiting for the next transition.
      try {
        listener({
          kind: "agent_presence",
          connected: this.agentSubscribers.size > 0,
          last_seen: this.agentLastSeen,
        });
      } catch {
        /* listener errors must not break callers */
      }
    }
    return () => {
      this.subscribers.delete(listener);
      if (role === "agent") {
        this.agentSubscribers.delete(listener);
        if (this.agentSubscribers.size === 0) {
          this.agentLastSeen = Date.now();
          // 1 -> 0 transition: tell remaining (UI) subscribers the agent left.
          this.emit({
            kind: "agent_presence",
            connected: false,
            last_seen: this.agentLastSeen,
          });
        }
      }
    };
  }

  private emit(event: BackendEvent, origin: Origin = "ui"): void {
    for (const listener of this.subscribers) {
      // Don't echo an agent's own mutations back to agent subscribers: the
      // event-watcher would otherwise wake the agent on its own edits and
      // replies. UI subscribers still see everything (they want the agent's
      // edits to land in the panel). User-originated events (default origin)
      // reach everyone, including the agent.
      if (origin === "agent" && this.agentSubscribers.has(listener)) continue;
      try {
        listener(event);
      } catch {
        // listener errors must not break callers
      }
    }
  }

  /** Serialize all mutating operations to keep the on-disk store consistent. */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lockChain.then(fn, fn);
    this.lockChain = next.catch(() => {});
    return next;
  }

  private absMain(p: DocPath): string {
    assertVaultPath(p);
    return safeJoin(this.root, p);
  }

  private absDraft(draftId: DraftId, p: DocPath): string {
    assertDraftId(draftId);
    assertVaultPath(p);
    const draftRoot = path.join(this.root, ".drafts", draftId);
    return safeJoin(draftRoot, p);
  }

  private absDraftMeta(draftId: DraftId): string {
    assertDraftId(draftId);
    const draftRoot = path.join(this.root, ".drafts", draftId);
    return safeJoin(draftRoot, "meta.json");
  }

  private async ensureDir(p: string): Promise<void> {
    await fs.mkdir(p, { recursive: true });
  }

  /** Read a file's raw bytes, or null when it doesn't exist. */
  private async readRawMaybe(abs: string): Promise<string | null> {
    try {
      return await readFileNoFollow(abs);
    } catch {
      return null;
    }
  }

  /** Absolute path of the file that homes a doc on `main` or a draft override. */
  private homeAbs(p: DocPath, draftId?: DraftId): string {
    return draftId ? this.absDraft(draftId, p) : this.absMain(p);
  }

  /**
   * Write clean prose to a doc while preserving the review threads already
   * homed in it: re-project their inline markup over the new prose and re-emit
   * the endmatter. Used by `writeDoc`/`editDoc`/`merge` so a prose change never
   * drops the doc's threads.
   */
  private async persistDoc(
    abs: string,
    prose: string,
    homePath: DocPath,
    draftId?: DraftId,
  ): Promise<void> {
    const raw = await this.readRawMaybe(abs);
    const existing = raw ? parseReviewDoc(raw, draftId).threads : [];
    await this.ensureDir(path.dirname(abs));
    await writeFileNoFollow(abs, serializeReviewDoc(prose, existing, homePath));
  }

  /**
   * Every doc file that may carry review threads: visible vault docs (main,
   * `draftId` undefined) and per-draft override copies under `.drafts/`. The
   * file's location is authoritative for a thread's `draft_id`.
   */
  private async allReviewDocFiles(): Promise<
    { abs: string; homePath: DocPath; draftId?: DraftId }[]
  > {
    const out: { abs: string; homePath: DocPath; draftId?: DraftId }[] = [];
    for (const f of await walk(this.root)) {
      if (!f.endsWith(".md")) continue;
      out.push({ abs: f, homePath: path.relative(this.root, f).replace(/\\/g, "/") });
    }
    const draftsRoot = path.join(this.root, ".drafts");
    for (const f of await walk(draftsRoot)) {
      if (!f.endsWith(".md")) continue;
      const parts = path.relative(draftsRoot, f).split(path.sep);
      const draftId = parts[0];
      if (!draftId || !DRAFT_ID_RE.test(draftId)) continue;
      out.push({ abs: f, homePath: parts.slice(1).join("/"), draftId });
    }
    return out;
  }

  private async readOpLog(): Promise<OpLog> {
    if (this.opLogCache) return this.opLogCache;
    try {
      const raw = await readFileNoFollow(this.opLogPath);
      const parsed = opLogSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        this.opLogCache = parsed.data as OpLog;
      } else {
        // Corrupt or drifted on-disk shape — keep going with an empty log
        // rather than crashing the whole backend.
        console.error("[stub] op_log failed schema validation; resetting");
        this.opLogCache = {};
      }
    } catch {
      this.opLogCache = {};
    }
    return this.opLogCache;
  }

  private async writeOpLog(log: OpLog): Promise<void> {
    this.opLogCache = log;
    await this.ensureDir(path.dirname(this.opLogPath));
    await writeFileNoFollow(this.opLogPath, JSON.stringify(log, null, 2));
  }

  private async cachedWrite(
    opId: OpId | undefined,
    run: () => Promise<WriteResult>,
  ): Promise<WriteResult> {
    if (!opId) return run();
    const log = await this.readOpLog();
    if (log[opId]) return log[opId];
    const result = await run();
    log[opId] = result;
    await this.writeOpLog(log);
    return result;
  }

  private async loadDraftMeta(draftId: DraftId): Promise<DraftMeta> {
    assertDraftId(draftId);
    let raw: string;
    try {
      raw = await readFileNoFollow(this.absDraftMeta(draftId));
    } catch {
      throw err.draftNotFound(draftId);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw err.draftNotFound(draftId);
    }
    const validated = draftMetaSchema.safeParse(parsed);
    if (!validated.success) throw err.draftNotFound(draftId);
    // Normalize legacy on-disk shapes: older files may carry `seed_prompt`
    // or `note`; collapse both onto `intent` (first non-empty wins).
    const data = validated.data;
    const intent = data.intent ?? data.seed_prompt ?? data.note;
    return {
      draft_id: data.draft_id,
      base_path: data.base_path,
      intent,
      author: data.author,
      state: data.state,
      created_at: data.created_at,
      submitted_at: data.submitted_at,
      name: data.name,
      display_name: data.display_name,
      touches: data.touches,
      base_version: data.base_version,
      parent_draft_id: data.parent_draft_id,
    } satisfies DraftMeta;
  }

  private async saveDraftMeta(meta: DraftMeta): Promise<void> {
    const p = this.absDraftMeta(meta.draft_id);
    await this.ensureDir(path.dirname(p));
    await writeFileNoFollow(p, JSON.stringify(meta, null, 2));
  }

  /**
   * Phase H: append `paths` to the draft's `touches` list (deduped). Loads,
   * mutates, and persists meta inside the caller's lock — every call site
   * (`writeDoc`, `editDoc`, `addThread`) is already holding `withLock`.
   * No-op when every path is already tracked.
   */
  private async addTouches(
    draftId: DraftId,
    paths: DocPath[],
  ): Promise<void> {
    const meta = await this.loadDraftMeta(draftId);
    const current = meta.touches ?? [meta.base_path];
    const set = new Set(current);
    let changed = false;
    for (const p of paths) {
      if (!set.has(p)) {
        set.add(p);
        current.push(p);
        changed = true;
      }
    }
    if (!changed) return;
    meta.touches = current;
    await this.saveDraftMeta(meta);
  }

  /**
   * Every visible markdown doc on main. `walk` already skips dot-prefixed
   * entries (`.drafts/`, `.obsidian/`, …), so this is the whole vault minus
   * infra. The single source of truth for discovery (`listDocs`, `listAllDocs`).
   */
  private async listMainDocs(): Promise<DocSummary[]> {
    const files = await walk(this.root);
    const results: DocSummary[] = [];
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const rel = path.relative(this.root, f).replace(/\\/g, "/");
      const stat = await fs.lstat(f);
      const md = await readFileNoFollow(f);
      results.push({
        path: rel,
        title: titleFromMd(md, path.basename(f, ".md")),
        updated_at: stat.mtimeMs,
      });
    }
    return results.sort((a, b) => a.path.localeCompare(b.path));
  }

  async listDocs(prefix?: string): Promise<DocSummary[]> {
    const docs = await this.listMainDocs();
    return prefix ? docs.filter((d) => d.path.startsWith(prefix)) : docs;
  }

  async glob(pattern: string, ref: Ref = "main"): Promise<DocSummary[]> {
    const re = globToRegex(pattern);
    const all = await this.listAllDocs(ref);
    return all.filter((d) => re.test(d.path));
  }

  private async listAllDocs(ref: Ref): Promise<DocSummary[]> {
    const main = await this.listMainDocs();
    const plugin = await this.listPluginFiles();
    if (ref === "main") return [...main, ...plugin];
    const meta = await this.loadDraftMeta(ref);
    const draftBase = path.join(this.root, ".drafts", meta.draft_id);
    const draftFiles = await walk(draftBase);
    const overridden = new Map<DocPath, DocSummary>();
    for (const f of draftFiles) {
      if (!f.endsWith(".md")) continue;
      const rel = path.relative(draftBase, f).replace(/\\/g, "/");
      const stat = await fs.lstat(f);
      const md = await readFileNoFollow(f);
      overridden.set(rel, {
        path: rel,
        title: titleFromMd(md, path.basename(f, ".md")),
        updated_at: stat.mtimeMs,
      });
    }
    return [...main.map((d) => overridden.get(d.path) ?? d), ...plugin];
  }

  /**
   * Walk the repo-root `.claude-plugin/` tree and return one entry per file.
   * No extension filter — plugin bundles include `.md`, `.mjs`, `.json`, etc.
   * Always served as `origin: main`; drafts never shadow these paths.
   */
  private async listPluginFiles(): Promise<DocSummary[]> {
    const base = path.join(this.pluginRoot, PLUGIN_PATH_PREFIX);
    let files: string[];
    try {
      files = await walk(base);
    } catch {
      return [];
    }
    const results: DocSummary[] = [];
    for (const f of files) {
      const rel = path.relative(this.pluginRoot, f).replace(/\\/g, "/");
      if (!rel.startsWith(PLUGIN_PATH_PREFIX)) continue;
      let stat: import("node:fs").Stats;
      try {
        stat = await fs.lstat(f);
      } catch {
        continue;
      }
      results.push({
        path: rel,
        title: path.basename(rel),
        updated_at: stat.mtimeMs,
      });
    }
    return results.sort((a, b) => a.path.localeCompare(b.path));
  }

  async grep(opts: GrepOptions): Promise<GrepResult> {
    const ref = opts.ref ?? "main";
    const re = new RegExp(
      opts.pattern,
      (opts.case_insensitive ? "i" : "") + (opts.multiline ? "s" : ""),
    );
    // Pre-compile the global variant once for count mode; the previous code
    // rebuilt it on every iteration.
    const globalRe = new RegExp(re.source, re.flags + "g");
    let candidates = await this.listAllDocs(ref);
    if (opts.path) candidates = candidates.filter((d) => d.path === opts.path);
    if (opts.glob) {
      const gre = globToRegex(opts.glob);
      candidates = candidates.filter((d) => gre.test(d.path));
    }
    const mode = opts.output_mode ?? "files_with_matches";
    const before = Math.max(0, opts.before_context ?? 0);
    const after = Math.max(0, opts.after_context ?? 0);
    const limit = opts.head_limit ?? Infinity;
    // Soft wall-clock budget to bound catastrophic-backtracking regex input.
    // A real fix needs `re2-wasm` or a worker-thread abort; this at least
    // keeps a single malicious pattern from hanging the main loop forever.
    const deadline = Date.now() + 500;
    const checkDeadline = () => {
      if (Date.now() > deadline) throw err.grepTimeout();
    };
    if (mode === "files_with_matches") {
      const paths: DocPath[] = [];
      for (const d of candidates) {
        checkDeadline();
        const { md } = await this.readDoc(d.path, ref);
        if (re.test(md)) paths.push(d.path);
        if (paths.length >= limit) break;
      }
      return { mode: "files_with_matches", paths };
    }
    if (mode === "count") {
      const counts: { path: DocPath; count: number }[] = [];
      for (const d of candidates) {
        checkDeadline();
        const { md } = await this.readDoc(d.path, ref);
        globalRe.lastIndex = 0;
        const m = md.match(globalRe);
        if (m && m.length > 0)
          counts.push({ path: d.path, count: m.length });
        if (counts.length >= limit) break;
      }
      return { mode: "count", counts };
    }
    const matches: GrepMatch[] = [];
    for (const d of candidates) {
      checkDeadline();
      const { md } = await this.readDoc(d.path, ref);
      const lines = md.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (i % 64 === 0) checkDeadline();
        if (re.test(lines[i])) {
          matches.push({
            path: d.path,
            line: i + 1,
            text: lines[i],
            before:
              before > 0
                ? lines.slice(Math.max(0, i - before), i)
                : undefined,
            after:
              after > 0
                ? lines.slice(i + 1, Math.min(lines.length, i + 1 + after))
                : undefined,
          });
          if (matches.length >= limit) break;
        }
      }
      if (matches.length >= limit) break;
    }
    return { mode: "content", matches };
  }

  async readDoc(p: DocPath, ref: Ref = "main"): Promise<DocContent> {
    assertReadablePath(p);
    let abs: string;
    let origin: "main" | "draft";
    if (isPluginPath(p)) {
      // Plugin tree is main-only: drafts never shadow it.
      abs = safeJoin(this.pluginRoot, p);
      origin = "main";
    } else if (ref === "main") {
      abs = this.absMain(p);
      origin = "main";
    } else {
      await this.loadDraftMeta(ref);
      const draftAbs = this.absDraft(ref, p);
      try {
        await fs.stat(draftAbs);
        abs = draftAbs;
        origin = "draft";
      } catch {
        abs = this.absMain(p);
        origin = "main";
      }
    }
    let raw: string;
    try {
      raw = await readFileNoFollow(abs);
    } catch (e) {
      if (e instanceof McpError) throw e;
      throw err.docNotFound(p);
    }
    // The on-disk file carries inline review markup; readers see clean prose.
    const md = cleanProse(raw);
    // Initialize the counter the first time we surface a doc with prose. The
    // counter is keyed off the workspace-relative path so drafts and main
    // share the same counter (the doc's identity is the path, not the ref).
    let version_counter = this.versionCounters.get(p);
    if (version_counter === undefined && md.length > 0) {
      version_counter = 1;
      this.versionCounters.set(p, version_counter);
    }
    return {
      md,
      version_token: `v-${sha(md).slice(0, 12)}`,
      version_counter: version_counter ?? 0,
      origin,
    };
  }

  renameDoc(from: DocPath, to: DocPath, origin: Origin = "ui"): Promise<ThreadId[]> {
    return this.withLock(async () => {
      assertVaultPath(from);
      assertVaultPath(to);
      if (from === to) return [];

      // `from`/`to` may name a single doc or a whole folder — `remapRenamedPath`
      // covers both, reconciling every descendant in one pass. The vault has
      // already moved the visible bytes, and a doc's threads now travel inside
      // its `.md` (no sidecars), so we only fix what the vault can't see: our
      // hidden `.drafts/` overrides, the per-doc counters, and the target paths
      // recorded inside each doc's review endmatter.

      // 1. Repoint each draft's meta and move its override `.md` working copies
      //    under `.drafts/` (the vault never touches that hidden tree). Do this
      //    before the endmatter remap so overrides sit at their new paths.
      for (const d of await this.listDrafts()) {
        const meta = await this.loadDraftMeta(d.draft_id);
        const touches = meta.touches ?? [meta.base_path];
        let metaChanged = false;
        for (const tp of touches) {
          const np = remapRenamedPath(tp, from, to);
          if (np === null) continue;
          const src = this.absDraft(d.draft_id, tp);
          try {
            await fs.stat(src);
            const dest = this.absDraft(d.draft_id, np);
            await this.ensureDir(path.dirname(dest));
            await copyFileNoFollow(src, dest);
            await fs.rm(src, { force: true });
          } catch {
            // No override on disk for this path — meta repoint is enough.
          }
        }
        const nbp = remapRenamedPath(meta.base_path, from, to);
        if (nbp !== null) {
          meta.base_path = nbp;
          metaChanged = true;
        }
        if (meta.touches) {
          const rewritten = meta.touches.map(
            (p) => remapRenamedPath(p, from, to) ?? p,
          );
          if (rewritten.some((p, i) => p !== meta.touches![i])) {
            meta.touches = rewritten;
            metaChanged = true;
          }
        }
        if (metaChanged) await this.saveDraftMeta(meta);
      }

      // 2. Rewrite the target paths stored in every doc's endmatter. The byte
      //    move already carried each home doc (threads and all) to its new
      //    path; only the paths recorded inside the records are stale.
      const moved: { id: ThreadId; target_paths: DocPath[] }[] = [];
      for (const file of await this.allReviewDocFiles()) {
        const raw = await this.readRawMaybe(file.abs);
        if (raw === null) continue;
        const { prose, threads } = parseReviewDoc(raw, file.draftId);
        let changed = false;
        for (const t of threads) {
          let tChanged = false;
          t.targets = t.targets.map((tg) => {
            const np = remapRenamedPath(tg.path, from, to);
            if (np === null) return tg;
            tChanged = true;
            return { ...tg, path: np };
          }) as Thread["targets"];
          if (tChanged) {
            changed = true;
            moved.push({
              id: t.id,
              target_paths: t.targets.map((tg) => tg.path),
            });
          }
        }
        if (changed) {
          await writeFileNoFollow(
            file.abs,
            serializeReviewDoc(prose, threads, file.homePath),
          );
        }
      }

      // 3. Carry per-doc version counters + history onto their new paths (the
      //    doc's identity is its path). Don't clobber an existing destination.
      this.remapMapKeys(this.versionCounters, from, to);
      this.remapMapKeys(this.versionHistory, from, to);

      // 4. Tell every consumer (UI panels + the connected agent) the threads
      //    now live on their new paths so they re-resolve.
      for (const m of moved) {
        this.emit(
          { kind: "thread_changed", thread_id: m.id, target_paths: m.target_paths },
          origin,
        );
      }
      return moved.map((m) => m.id);
    });
  }

  /**
   * Move every key of `map` that sits at or under `from` onto its remapped
   * path, in place. Skips a destination that already has a value (a real
   * collision shouldn't happen — the vault wouldn't allow two docs at one
   * path — but we don't overwrite if it does).
   */
  private remapMapKeys<V>(
    map: Map<DocPath, V>,
    from: DocPath,
    to: DocPath,
  ): void {
    for (const [p, v] of [...map]) {
      const np = remapRenamedPath(p, from, to);
      if (np === null) continue;
      map.delete(p);
      if (!map.has(np)) map.set(np, v);
    }
  }

  writeDoc(
    p: DocPath,
    ref: Ref,
    content: string,
    opId?: OpId,
    origin: Origin = "ui",
  ): Promise<WriteResult> {
    return this.withLock(() =>
      this.cachedWrite(opId, async () => {
        assertVaultPath(p);
        if (ref === "main") {
          await this.persistDoc(this.absMain(p), content, p);
          bumpCounter(this.versionCounters, p);
          this.emit({ kind: "doc_changed", path: p }, origin);
          return { version_token: `v-${sha(content).slice(0, 12)}` };
        }
        assertDraftRef(ref);
        await this.loadDraftMeta(ref);
        await this.persistDoc(this.absDraft(ref, p), content, p, ref);
        await this.addTouches(ref, [p]);
        const result: WriteResult = {
          version_token: `v-${sha(content).slice(0, 12)}`,
        };
        this.emit({ kind: "draft_changed", draft_id: ref, path: p }, origin);
        return result;
      }),
    );
  }

  editDoc(
    p: DocPath,
    ref: Ref,
    oldString: string,
    newString: string,
    replaceAll: boolean,
    opId?: OpId,
    origin: Origin = "ui",
  ): Promise<WriteResult> {
    return this.withLock(() =>
      this.cachedWrite(opId, async () => {
        assertVaultPath(p);
        if (ref !== "main") {
          assertDraftRef(ref);
          await this.loadDraftMeta(ref);
        }
        const current = await this.readDoc(p, ref);
        let next: string;
        if (replaceAll) {
          if (!current.md.includes(oldString)) throw err.editNoMatch(p);
          next = current.md.split(oldString).join(newString);
        } else {
          const first = current.md.indexOf(oldString);
          if (first === -1) throw err.editNoMatch(p);
          const second = current.md.indexOf(oldString, first + oldString.length);
          if (second !== -1) {
            let n = 1;
            let i = first;
            while (
              (i = current.md.indexOf(oldString, i + oldString.length)) !== -1
            )
              n++;
            throw err.editAmbiguous(p, n + 1);
          }
          next =
            current.md.slice(0, first) +
            newString +
            current.md.slice(first + oldString.length);
        }
        if (ref === "main") {
          await this.persistDoc(this.absMain(p), next, p);
          bumpCounter(this.versionCounters, p);
          this.emit({ kind: "doc_changed", path: p }, origin);
          return { version_token: `v-${sha(next).slice(0, 12)}` };
        }
        await this.persistDoc(this.absDraft(ref, p), next, p, ref);
        await this.addTouches(ref, [p]);
        const result: WriteResult = {
          version_token: `v-${sha(next).slice(0, 12)}`,
        };
        this.emit({ kind: "draft_changed", draft_id: ref, path: p }, origin);
        return result;
      }),
    );
  }

  fork(
    p: DocPath,
    n: number,
    intent?: string,
    author = "agent",
    parent?: DraftId,
  ): Promise<DraftId[]> {
    return this.withLock(async () => {
      assertVaultPath(p);
      let parentMeta: DraftMeta | undefined;
      let seedContent: string | undefined;
      if (parent !== undefined) {
        assertDraftId(parent);
        parentMeta = await this.loadDraftMeta(parent);
        // Sub-drafts inherit the parent's doc identity. The plan calls out
        // `base_path = parent.base_path`; the explicit `path` arg is kept
        // for parity with the existing one-arg signature but must agree
        // with the parent's base_path so we don't accidentally seed a
        // sub-draft with content from a different doc.
        if (parentMeta.base_path !== p) {
          throw err.invalidPayload(
            `fork(parent=${parent}) path mismatch: parent.base_path is ${parentMeta.base_path}, got ${p}`,
          );
        }
        // Seed from the parent's current view of the doc (override if it
        // exists, otherwise main). readDoc(p, parent) walks that fall-through
        // for us so the sub-draft sees the parent's edits.
        const parentView = await this.readDoc(p, parent);
        seedContent = parentView.md;
      } else {
        await this.readDoc(p, "main");
      }
      const baseVersion =
        parentMeta?.base_version ?? this.versionCounters.get(p) ?? 1;
      const ids: DraftId[] = [];
      for (let i = 0; i < n; i++) {
        const draftId = `draft_${randomUUID()}`;
        const meta: DraftMeta = {
          draft_id: draftId,
          base_path: p,
          intent,
          author,
          state: "open",
          created_at: Date.now(),
          touches: [p],
          base_version: baseVersion,
          parent_draft_id: parent,
        };
        await this.saveDraftMeta(meta);
        // Materialize the parent's current bytes into the sub-draft's
        // override tree so its working ycrdt is independent of the parent.
        // No write for top-level drafts (they fall through to main on read).
        if (seedContent !== undefined) {
          const abs = this.absDraft(draftId, p);
          await this.ensureDir(path.dirname(abs));
          await writeFileNoFollow(abs, seedContent);
        }
        this.emit({
          kind: "draft_created",
          draft_id: draftId,
          base_path: p,
        });
        ids.push(draftId);
      }
      return ids;
    });
  }

  /**
   * Cascade-decline all sub-drafts of `parentDraftId` that aren't already
   * accepted. Used by Phase I's `merge()` to tombstone unaccepted siblings
   * when the parent draft is merged. Declined sub-draft refs persist in
   * git history per the resolved-decision on rejected-alternatives storage.
   *
   * Exposed as a public method so Phase I can wire it into the merge flow
   * without re-deriving the predicate. Intentionally not part of the
   * `Backend` interface — this is a stub-internal helper.
   */
  async _cascadeDeclineSubDrafts(parentDraftId: DraftId): Promise<DraftId[]> {
    assertDraftId(parentDraftId);
    const all = await this.listDrafts();
    const declined: DraftId[] = [];
    for (const d of all) {
      if (d.parent_draft_id !== parentDraftId) continue;
      if (d.state === "accepted") continue;
      if (d.state === "declined") continue;
      await this.declineDraft(d.draft_id);
      declined.push(d.draft_id);
    }
    return declined;
  }

  async forkAndAttachThreads(opts: {
    base_path: DocPath;
    base_version?: number;
    name: string;
    author?: string;
    intent?: string;
    initial_threads: {
      targets: ThreadAnchor[];
      message: string;
      draft?: ThreadDraftBody;
    }[];
  }): Promise<{
    draft_id: DraftId;
    display_name: string;
    base_version: number;
  }> {
    assertVaultPath(opts.base_path);
    // Create the draft inside the lock so the meta is committed before any
    // thread save races against listing.
    const author = opts.author ?? "user";
    const draftIdHolder: { id?: DraftId; baseVersion?: number; displayName?: string } = {};
    await this.withLock(async () => {
      await this.readDoc(opts.base_path, "main");
      const counter = this.versionCounters.get(opts.base_path) ?? 1;
      const baseVersion = opts.base_version ?? counter;
      const draftId: DraftId = `draft_${randomUUID()}`;
      const displayName = renderDisplayName(opts.name, draftId);
      const meta: DraftMeta = {
        draft_id: draftId,
        base_path: opts.base_path,
        intent: opts.intent,
        author,
        state: "open",
        created_at: Date.now(),
        name: opts.name,
        display_name: displayName,
        touches: [opts.base_path],
        base_version: baseVersion,
      };
      await this.saveDraftMeta(meta);
      this.emit({
        kind: "draft_created",
        draft_id: draftId,
        base_path: opts.base_path,
      });
      draftIdHolder.id = draftId;
      draftIdHolder.baseVersion = baseVersion;
      draftIdHolder.displayName = displayName;
    });
    const draftId = draftIdHolder.id!;
    // Each addThread call takes the lock itself, so we do them sequentially
    // outside the outer lock — yielding inside withLock would deadlock.
    for (const t of opts.initial_threads) {
      await this.addThread({
        targets: t.targets,
        message: t.message,
        draft: t.draft,
        ref: draftId,
        author,
      });
    }
    return {
      draft_id: draftId,
      display_name: draftIdHolder.displayName!,
      base_version: draftIdHolder.baseVersion!,
    };
  }

  propose(
    draftId: DraftId,
    intent?: string,
    name?: string,
  ): Promise<{ diff_url: string }> {
    return this.withLock(async () => {
      const meta = await this.loadDraftMeta(draftId);
      meta.state = "submitted";
      meta.submitted_at = Date.now();
      if (intent !== undefined) meta.intent = intent;
      if (name !== undefined) meta.name = name;
      await this.saveDraftMeta(meta);
      this.emit({
        kind: "draft_state",
        draft_id: draftId,
        state: "submitted",
      });
      return { diff_url: `/drafts/${draftId}` };
    });
  }

  async merge(draftId: DraftId): Promise<{
    commit: string;
    versions: { path: DocPath; from: number; to: number }[];
  }> {
    assertDraftId(draftId);
    const result = await this.withLock(async () => {
      const meta = await this.loadDraftMeta(draftId);
      // Merge must go through Propose first. Otherwise `Fork` + `Write` +
      // `Merge` lands arbitrary content on main without passing any review
      // gate. `accepted` is idempotent; anything else is a misuse.
      if (meta.state !== "submitted" && meta.state !== "accepted") {
        throw err.draftNotSubmitted(draftId, meta.state);
      }
      // Phase J: server-side Accept gating. The UI button is disabled while
      // any thread on the draft is open, but agents (and direct API callers)
      // can bypass that — refuse the merge unless every thread is terminal.
      // `accepted` is idempotent above; skip the gate so re-accepts don't
      // require re-resolving (the threads are already terminal anyway).
      if (meta.state === "submitted") {
        const threads = await this.listThreads({ ref: draftId });
        const openCount = threads.filter((t) => t.status === "open").length;
        if (openCount > 0) throw err.acceptBlocked(openCount);
      }
      const baseVersion = meta.base_version ?? 1;
      const touches = meta.touches ?? [meta.base_path];
      const draftRoot = path.join(this.root, ".drafts", draftId);

      // Plan a copy for every touched path that has an override on disk.
      // Collect plans first so a conflict on any path aborts the whole batch
      // before any write to main.
      const plans: { rel: DocPath; src: string; dest: string }[] = [];
      const seen = new Set<DocPath>();
      const considerPath = async (rel: DocPath): Promise<void> => {
        if (seen.has(rel)) return;
        seen.add(rel);
        if (!rel.endsWith(".md")) return;
        assertVaultPath(rel);
        const src = this.absDraft(draftId, rel);
        try {
          const stat = await fs.lstat(src);
          if (!stat.isFile()) return;
        } catch {
          return;
        }
        plans.push({ rel, src, dest: safeJoin(this.root, rel) });
      };
      for (const rel of touches) await considerPath(rel);
      // Cover legacy drafts whose `touches` may be missing override files
      // landed under the draft tree (defensive against drift).
      const draftFiles = await walk(draftRoot);
      for (const f of draftFiles) {
        const rel = path.relative(draftRoot, f).replace(/\\/g, "/");
        await considerPath(rel);
      }

      // Conflict check: any planned path whose main counter has advanced
      // past the draft's base_version is treated as overlapping. Stub-grade
      // heuristic per the plan; production will use real yjs op metadata.
      const conflicts: MergeConflictDetail[] = [];
      for (const plan of plans) {
        const mainCounter = this.versionCounters.get(plan.rel);
        if (mainCounter !== undefined && mainCounter > baseVersion) {
          conflicts.push({
            path: plan.rel,
            base_version: baseVersion,
            main_version: mainCounter,
          });
        }
      }
      if (conflicts.length > 0) throw err.mergeConflict(conflicts);

      // No conflicts: stage every planned write, then bump counters.
      const versions: { path: DocPath; from: number; to: number }[] = [];
      const acceptedAt = Date.now();
      for (const plan of plans) {
        // Land the draft's clean prose on main (its review markup stays behind
        // in the draft override); preserve any threads already homed on main.
        const draftRaw = await this.readRawMaybe(plan.src);
        const draftProse = draftRaw !== null ? cleanProse(draftRaw) : "";
        await this.persistDoc(plan.dest, draftProse, plan.rel);
        const from = this.versionCounters.get(plan.rel) ?? baseVersion;
        const to = from + 1;
        this.versionCounters.set(plan.rel, to);
        versions.push({ path: plan.rel, from, to });
        const history = this.versionHistory.get(plan.rel) ?? [];
        history.push({ version: to, draft_id: draftId, accepted_at: acceptedAt });
        this.versionHistory.set(plan.rel, history);
      }

      meta.state = "accepted";
      await this.saveDraftMeta(meta);
      this.emit({
        kind: "draft_state",
        draft_id: draftId,
        state: "accepted",
      });
      // draft_merged is distinct from draft_state=accepted: Propose-accept
      // flips state without touching main; merge() is the one that actually
      // lands bytes. UI that cares about "main has changed" listens here.
      this.emit({
        kind: "draft_merged",
        draft_id: draftId,
        target_paths: versions.map((v) => v.path),
        versions,
      });
      return {
        commit: `c-${sha(`merge:${draftId}:${Date.now()}`).slice(0, 12)}`,
        versions,
      };
    });
    // Cascade-decline any unaccepted sub-drafts after releasing the merge
    // lock — `_cascadeDeclineSubDrafts` calls `declineDraft` which itself
    // takes the lock, so this must run outside `withLock` to avoid a
    // self-chained deadlock (same pattern as `forkAndAttachThreads`).
    await this._cascadeDeclineSubDrafts(draftId);
    return result;
  }

  declineDraft(draftId: DraftId): Promise<void> {
    assertDraftId(draftId);
    return this.withLock(async () => {
      const meta = await this.loadDraftMeta(draftId);
      meta.state = "declined";
      await this.saveDraftMeta(meta);
      this.emit({
        kind: "draft_state",
        draft_id: draftId,
        state: "declined",
      });
    });
  }

  async listVersionHistory(p: DocPath): Promise<VersionHistoryEntry[]> {
    assertVaultPath(p);
    const entries = this.versionHistory.get(p) ?? [];
    return entries.slice();
  }

  async draftChanges(
    draftId: DraftId,
  ): Promise<{ path: DocPath; main_md: string; draft_md: string }[]> {
    const meta = await this.loadDraftMeta(draftId);
    const touches = meta.touches ?? [meta.base_path];
    const draftRoot = path.join(this.root, ".drafts", draftId);
    const out: { path: DocPath; main_md: string; draft_md: string }[] = [];
    for (const rel of touches) {
      if (!rel.endsWith(".md")) continue;
      const mainRaw = await this.readRawMaybe(this.absMain(rel));
      const main_md = mainRaw !== null ? cleanProse(mainRaw) : "";
      const draftRaw = await this.readRawMaybe(safeJoin(draftRoot, rel));
      // No override on disk — the path was added to touches by addThread
      // without an edit landing yet. Show main prose on both sides.
      const draft_md = draftRaw !== null ? cleanProse(draftRaw) : main_md;
      out.push({ path: rel, main_md, draft_md });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async listDrafts(p?: DocPath): Promise<DraftSummary[]> {
    const dir = path.join(this.root, ".drafts");
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: DraftSummary[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (!DRAFT_ID_RE.test(e.name)) continue;
      try {
        const meta = await this.loadDraftMeta(e.name);
        if (p && meta.base_path !== p) continue;
        const touches = meta.touches ?? [meta.base_path];
        const baseVersion = meta.base_version ?? 1;
        const mainCounter = this.versionCounters.get(meta.base_path) ?? baseVersion;
        const versionsBehind = Math.max(0, mainCounter - baseVersion);
        out.push({
          draft_id: meta.draft_id,
          base_path: meta.base_path,
          intent: meta.intent,
          author: meta.author,
          state: meta.state,
          created_at: meta.created_at,
          submitted_at: meta.submitted_at,
          name: meta.name,
          display_name: meta.display_name,
          touches,
          base_version: baseVersion,
          parent_draft_id: meta.parent_draft_id,
          versions_behind: versionsBehind,
        });
      } catch {
        continue;
      }
    }
    return out.sort((a, b) => b.created_at - a.created_at);
  }

  private async loadThread(id: ThreadId): Promise<Thread> {
    assertThreadId(id);
    for (const file of await this.allReviewDocFiles()) {
      const raw = await this.readRawMaybe(file.abs);
      if (raw === null) continue;
      const { threads } = parseReviewDoc(raw, file.draftId);
      const found = threads.find((t) => t.id === id);
      if (found) return found;
    }
    throw err.threadNotFound(id);
  }

  /**
   * Upsert a thread into its home doc's endmatter. The home doc is
   * `targets[0].path` on `main` or the thread's draft override. A draft
   * override that doesn't exist yet is seeded from the draft's current view of
   * the doc so the thread has prose to anchor against.
   */
  private async saveThread(t: Thread): Promise<void> {
    if (t.targets.length === 0) {
      throw new McpError("invalid_path", "thread has no targets to save");
    }
    const homePath = t.targets[0].path;
    assertVaultPath(homePath);
    assertThreadId(t.id);
    const abs = this.homeAbs(homePath, t.draft_id);
    const raw = await this.readRawMaybe(abs);
    let prose: string;
    let threads: Thread[];
    if (raw !== null) {
      ({ prose, threads } = parseReviewDoc(raw, t.draft_id));
    } else {
      // Only legitimate for a not-yet-materialized draft override: seed prose
      // from the draft's current view (which falls through to main).
      prose = (await this.readDoc(homePath, t.draft_id ?? "main")).md;
      threads = [];
    }
    const next = [...threads.filter((x) => x.id !== t.id), t].sort(
      (a, b) => a.created - b.created,
    );
    await this.ensureDir(path.dirname(abs));
    await writeFileNoFollow(abs, serializeReviewDoc(prose, next, homePath));
  }

  async listThreads(opts: {
    path?: DocPath;
    thread_id?: ThreadId;
    ref?: Ref;
  }): Promise<ThreadSummary[]> {
    const wantDraftId =
      opts.ref === undefined || opts.ref === "main" ? undefined : opts.ref;
    const out: ThreadSummary[] = [];
    for (const file of await this.allReviewDocFiles()) {
      // The file's location is authoritative for a thread's draft scoping.
      if (opts.ref !== undefined && file.draftId !== wantDraftId) continue;
      const raw = await this.readRawMaybe(file.abs);
      if (raw === null) continue;
      const { threads } = parseReviewDoc(raw, file.draftId);
      for (const t of threads) {
        if (opts.thread_id && t.id !== opts.thread_id) continue;
        const paths = t.targets.map((tg) => tg.path);
        if (opts.path && !paths.includes(opts.path)) continue;
        const last = t.messages[t.messages.length - 1];
        out.push({
          id: t.id,
          status: t.status,
          created: t.created,
          draft_id: file.draftId,
          target_paths: paths,
          message_count: t.messages.length,
          last_message_preview: last ? last.body.slice(0, 120) : "",
        });
      }
    }
    return out.sort((a, b) => b.created - a.created);
  }

  readThread(id: ThreadId): Promise<Thread> {
    return this.loadThread(id);
  }

  addThread(opts: {
    targets: ThreadAnchor[];
    message: string;
    author?: string;
    draft?: ThreadDraftBody;
    ref?: Ref;
    origin?: Origin;
  }): Promise<ThreadId> {
    return this.withLock(async () => {
      if (opts.targets.length === 0) {
        throw new McpError("invalid_path", "at least one target is required");
      }
      const ref: Ref = opts.ref ?? "main";
      let draftId: DraftId | undefined;
      if (ref !== "main") {
        assertDraftRef(ref);
        await this.loadDraftMeta(ref);
        draftId = ref;
      }
      const id: ThreadId = `thrd_${randomUUID()}`;
      const targets: Thread["targets"] = [];
      for (const t of opts.targets) {
        if (t.scope === "doc") {
          // Doc-level: no anchor. Verify the doc exists so we don't store
          // threads pointing at nothing.
          await this.readDoc(t.path, ref);
          targets.push({ path: t.path, scope: "doc" });
          continue;
        }
        const { md } = await this.readDoc(t.path, ref);
        const from = Math.max(0, Math.min(t.char_range.from, md.length));
        const to = Math.max(from, Math.min(t.char_range.to, md.length));
        const anchored = md.slice(from, to);
        const before = md.slice(Math.max(0, from - 64), from);
        const after = md.slice(to, Math.min(md.length, to + 64));
        targets.push({
          path: t.path,
          scope: "range",
          anchor: {
            rel_pos: Buffer.from(
              JSON.stringify({ from, to }),
              "utf8",
            ).toString("base64"),
            content_hash: sha(before + anchored + after),
            anchored_text: anchored,
            context_before: before,
            context_after: after,
          },
        });
      }
      const now = Date.now();
      const thread: Thread = {
        id,
        created: now,
        status: "open",
        draft_id: draftId,
        targets,
        messages: [
          {
            author: opts.author ?? "agent",
            ts: now,
            body: opts.message,
            draft: opts.draft,
          },
        ],
      };
      await this.saveThread(thread);
      if (draftId) {
        await this.addTouches(
          draftId,
          thread.targets.map((t) => t.path),
        );
      }
      this.emit(
        {
          kind: "thread_changed",
          thread_id: id,
          target_paths: thread.targets.map((t) => t.path),
        },
        opts.origin,
      );
      return id;
    });
  }

  replyThread(
    id: ThreadId,
    message: string,
    opts?: { author?: string; draft?: ThreadDraftBody; origin?: Origin },
  ): Promise<void> {
    return this.withLock(async () => {
      const thread = await this.loadThread(id);
      thread.messages.push({
        author: opts?.author ?? "agent",
        ts: Date.now(),
        body: message,
        draft: opts?.draft,
      });
      await this.saveThread(thread);
      this.emit(
        {
          kind: "thread_changed",
          thread_id: id,
          target_paths: thread.targets.map((t) => t.path),
        },
        opts?.origin,
      );
    });
  }

  resolveThread(id: ThreadId, origin: Origin = "ui"): Promise<void> {
    return this.withLock(async () => {
      const thread = await this.loadThread(id);
      thread.status = "accepted";
      await this.saveThread(thread);
      this.emit(
        {
          kind: "thread_changed",
          thread_id: id,
          target_paths: thread.targets.map((t) => t.path),
        },
        origin,
      );
    });
  }

  reopenThread(threadId: ThreadId): Promise<void> {
    return this.withLock(async () => {
      const thread = await this.loadThread(threadId);
      if (thread.status === "open") {
        throw err.invalidPayload(
          `thread ${threadId} is already open`,
        );
      }
      if (thread.status === "declined") {
        throw err.invalidPayload(
          `thread ${threadId} is declined; declined threads cannot be reopened`,
        );
      }
      // Snapshot the current draft prose for the thread's primary target so
      // reviewers can compare past options against current state. v0 uses
      // target[0] only; multi-target snapshots are deferred polish. Doc-level
      // targets don't have an anchor; snapshot is empty in that case.
      const target = thread.targets[0];
      let currentMd = target.scope === "range" ? target.anchor.anchored_text : "";
      if (target.scope === "range" && thread.draft_id) {
        try {
          const view = await this.readDoc(target.path, thread.draft_id);
          const decoded = JSON.parse(
            Buffer.from(target.anchor.rel_pos, "base64").toString("utf8"),
          ) as { from: number; to: number };
          const from = Math.max(0, Math.min(decoded.from, view.md.length));
          const to = Math.max(from, Math.min(decoded.to, view.md.length));
          currentMd = view.md.slice(from, to);
        } catch {
          // Fall back to the anchored text if rel_pos drifted; the leaf is
          // still useful as the historical snapshot of what reviewers saw.
        }
      }
      thread.status = "open";
      thread.messages.push({
        author: "system",
        ts: Date.now(),
        body: "reopened",
        draft_options: [{ name: "current", new_md: currentMd }],
      });
      await this.saveThread(thread);
      this.emit({
        kind: "thread_changed",
        thread_id: threadId,
        target_paths: thread.targets.map((t) => t.path),
      });
    });
  }

  attachDraftPayload(
    threadId: ThreadId,
    opts: {
      message?: string;
      draft?: ThreadDraftBody;
      draft_options?: ThreadDraftBody[];
      author?: string;
      origin?: Origin;
    },
  ): Promise<void> {
    return this.withLock(async () => {
      // Exactly one of `draft` / `draft_options` must be set. The two-leaf-or-
      // more case is canonically `draft_options`; the single-leaf shortcut is
      // `draft`. Rejecting both-or-neither up front keeps the on-disk shape
      // unambiguous for readers.
      const hasDraft = opts.draft !== undefined;
      const hasOptions =
        opts.draft_options !== undefined && opts.draft_options.length > 0;
      if (!hasDraft && !hasOptions) {
        throw err.invalidPayload(
          "attachDraftPayload requires `draft` or `draft_options`",
        );
      }
      if (hasDraft && hasOptions) {
        throw err.invalidPayload(
          "attachDraftPayload accepts `draft` (1 leaf) OR `draft_options` (>1); not both",
        );
      }
      const thread = await this.loadThread(threadId);
      thread.messages.push({
        author: opts.author ?? "system",
        ts: Date.now(),
        body: opts.message ?? "",
        draft: opts.draft,
        draft_options: opts.draft_options,
      });
      await this.saveThread(thread);
      this.emit(
        {
          kind: "thread_changed",
          thread_id: threadId,
          target_paths: thread.targets.map((t) => t.path),
        },
        opts.origin,
      );
    });
  }

  // --- Style / voice matching -------------------------------------------

  /**
   * Every visible `*.md` doc with mtime + size, no content read. `walk` skips
   * dot-dirs, so `.sheaf/` and `.drafts/` are excluded automatically. This is
   * the cheap primitive `style/corpus.ts` fingerprints the corpus from.
   */
  async statCorpus(): Promise<CorpusFile[]> {
    const files = await walk(this.root);
    const out: CorpusFile[] = [];
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      try {
        const st = await fs.lstat(f);
        if (!st.isFile()) continue;
        out.push({
          path: path.relative(this.root, f).replace(/\\/g, "/"),
          mtime_ms: st.mtimeMs,
          size: st.size,
        });
      } catch {
        continue;
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async readStyleConfig(): Promise<StyleConfig> {
    let raw: string;
    try {
      raw = await readFileNoFollow(this.styleConfigPath);
    } catch {
      return defaultStyleConfig();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return defaultStyleConfig();
    }
    const validated = styleConfigSchema.safeParse(parsed);
    if (!validated.success) {
      console.error("[stub] style config failed schema validation; using defaults");
      return defaultStyleConfig();
    }
    return validated.data as StyleConfig;
  }

  writeStyleConfig(config: StyleConfig): Promise<void> {
    return this.withLock(async () => {
      const validated = styleConfigSchema.parse(config);
      await this.ensureDir(path.dirname(this.styleConfigPath));
      await writeFileNoFollow(
        this.styleConfigPath,
        JSON.stringify(validated, null, 2),
      );
    });
  }

  async readStyleProfile(): Promise<StyleProfile | null> {
    let raw: string;
    try {
      raw = await readFileNoFollow(this.styleProfilePath);
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    const validated = styleProfileSchema.safeParse(parsed);
    if (!validated.success) {
      console.error("[stub] style profile failed schema validation; ignoring");
      return null;
    }
    return validated.data as StyleProfile;
  }

  writeStyleProfile(profile: StyleProfile): Promise<void> {
    return this.withLock(async () => {
      const validated = styleProfileSchema.parse(profile);
      await this.ensureDir(path.dirname(this.styleProfilePath));
      await writeFileNoFollow(
        this.styleProfilePath,
        JSON.stringify(validated, null, 2),
      );
    });
  }
}

/**
 * Deprecated re-export. The factory lives in `./factory.ts` — new consumers
 * should import from there. This shim keeps existing app/api callers
 * compiling while migration rolls through.
 */
export { getBackend } from "./factory";

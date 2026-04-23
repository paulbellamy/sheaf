import { promises as fs, constants as fsConstants } from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import * as yaml from "yaml";

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
  type Ref,
  type Thread,
  type ThreadAnchor,
  type ThreadDraftBody,
  type ThreadId,
  type ThreadSummary,
  type WriteResult,
  type Workspace,
} from "./index";
import { McpError, err } from "../errors";
import {
  DRAFT_ID_RE,
  assertDraftId,
  assertThreadId,
  assertWorkspacePath,
  safeJoin,
} from "../paths";

/**
 * Filesystem-backed stub backend for the prototype.
 *
 * Layout (all under `<root>`, default `<repo>/prototype/data`):
 *   workspaces/<ws>/docs/<name>.md
 *   workspaces/<ws>/docs/<name>.threads/thrd_<id>.yaml
 *   .drafts/<draft_id>/meta.json
 *   .drafts/<draft_id>/workspaces/<ws>/docs/<name>.md         # changed files only
 *   .drafts/<draft_id>/workspaces/<ws>/docs/<name>.threads/thrd_<id>.yaml
 *   .op_log.json
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
};

type OpLog = Record<string, WriteResult>;

function assertDraftRef(ref: Ref): asserts ref is DraftId {
  if (ref === "main") throw err.writeToMainForbidden();
  assertDraftId(ref);
}

function titleFromMd(md: string, fallback: string): string {
  const line = md.split("\n").find((l) => l.trim().length > 0) ?? "";
  const m = line.match(/^#+\s+(.+)$/);
  return (m?.[1] ?? fallback).trim();
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function globToRegex(glob: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 3;
      } else {
        re += ".*";
        i += 2;
      }
    } else if (c === "*") {
      re += "[^/]*";
      i += 1;
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else if (".+^$()|[]{}\\".includes(c)) {
      re += `\\${c}`;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  re += "$";
  return new RegExp(re);
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
async function readFileNoFollow(abs: string): Promise<string> {
  const fh = await fs.open(
    abs,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
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
  private opLogPath: string;
  private opLogCache: OpLog | null = null;
  private lockChain: Promise<unknown> = Promise.resolve();
  private subscribers = new Set<(event: BackendEvent) => void>();

  constructor(root: string) {
    this.root = root;
    this.opLogPath = path.join(root, ".op_log.json");
  }

  subscribe(listener: (event: BackendEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  private emit(event: BackendEvent): void {
    for (const listener of this.subscribers) {
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
    assertWorkspacePath(p);
    return safeJoin(this.root, p);
  }

  private absDraft(draftId: DraftId, p: DocPath): string {
    assertDraftId(draftId);
    assertWorkspacePath(p);
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

  private async readOpLog(): Promise<OpLog> {
    if (this.opLogCache) return this.opLogCache;
    try {
      const raw = await readFileNoFollow(this.opLogPath);
      this.opLogCache = JSON.parse(raw) as OpLog;
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
    try {
      const raw = await readFileNoFollow(this.absDraftMeta(draftId));
      return JSON.parse(raw) as DraftMeta;
    } catch {
      throw err.draftNotFound(draftId);
    }
  }

  private async saveDraftMeta(meta: DraftMeta): Promise<void> {
    const p = this.absDraftMeta(meta.draft_id);
    await this.ensureDir(path.dirname(p));
    await writeFileNoFollow(p, JSON.stringify(meta, null, 2));
  }

  async listWorkspaces(): Promise<Workspace[]> {
    const wsRoot = path.join(this.root, "workspaces");
    try {
      const entries = await fs.readdir(wsRoot, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => ({ name: e.name, path: `workspaces/${e.name}` }));
    } catch {
      return [];
    }
  }

  async listDocs(workspace: string, prefix?: string): Promise<DocSummary[]> {
    const base = path.join(this.root, "workspaces", workspace);
    const files = await walk(base);
    const results: DocSummary[] = [];
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const rel = path.relative(this.root, f).replace(/\\/g, "/");
      if (prefix && !rel.startsWith(prefix)) continue;
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

  async glob(pattern: string, ref: Ref = "main"): Promise<DocSummary[]> {
    const re = globToRegex(pattern);
    const all = await this.listAllDocs(ref);
    return all.filter((d) => re.test(d.path));
  }

  private async listAllDocs(ref: Ref): Promise<DocSummary[]> {
    const main: DocSummary[] = [];
    const workspaces = await this.listWorkspaces();
    for (const ws of workspaces) {
      const docs = await this.listDocs(ws.name);
      for (const d of docs) main.push(d);
    }
    if (ref === "main") return main;
    const meta = await this.loadDraftMeta(ref);
    const draftBase = path.join(this.root, ".drafts", meta.draft_id);
    const draftFiles = await walk(draftBase);
    const overridden = new Map<DocPath, DocSummary>();
    for (const f of draftFiles) {
      if (!f.endsWith(".md")) continue;
      const rel = path.relative(draftBase, f).replace(/\\/g, "/");
      if (!rel.startsWith("workspaces/")) continue;
      const stat = await fs.lstat(f);
      const md = await readFileNoFollow(f);
      overridden.set(rel, {
        path: rel,
        title: titleFromMd(md, path.basename(f, ".md")),
        updated_at: stat.mtimeMs,
      });
    }
    return main.map((d) => overridden.get(d.path) ?? d);
  }

  async grep(opts: GrepOptions): Promise<GrepResult> {
    const ref = opts.ref ?? "main";
    const re = new RegExp(
      opts.pattern,
      (opts.case_insensitive ? "i" : "") + (opts.multiline ? "s" : ""),
    );
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
    if (mode === "files_with_matches") {
      const paths: DocPath[] = [];
      for (const d of candidates) {
        const { md } = await this.readDoc(d.path, ref);
        if (re.test(md)) paths.push(d.path);
        if (paths.length >= limit) break;
      }
      return { mode: "files_with_matches", paths };
    }
    if (mode === "count") {
      const counts: { path: DocPath; count: number }[] = [];
      for (const d of candidates) {
        const { md } = await this.readDoc(d.path, ref);
        const m = md.match(new RegExp(re.source, re.flags + "g"));
        if (m && m.length > 0)
          counts.push({ path: d.path, count: m.length });
        if (counts.length >= limit) break;
      }
      return { mode: "count", counts };
    }
    const matches: GrepMatch[] = [];
    for (const d of candidates) {
      const { md } = await this.readDoc(d.path, ref);
      const lines = md.split("\n");
      for (let i = 0; i < lines.length; i++) {
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
    assertWorkspacePath(p);
    let abs: string;
    let origin: "main" | "draft";
    if (ref === "main") {
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
    let md: string;
    try {
      md = await readFileNoFollow(abs);
    } catch (e) {
      if (e instanceof McpError) throw e;
      throw err.docNotFound(p);
    }
    return {
      md,
      version: `v-${sha(md).slice(0, 12)}`,
      origin,
    };
  }

  writeDoc(
    p: DocPath,
    ref: Ref,
    content: string,
    opId?: OpId,
  ): Promise<WriteResult> {
    return this.withLock(() =>
      this.cachedWrite(opId, async () => {
        assertWorkspacePath(p);
        assertDraftRef(ref);
        await this.loadDraftMeta(ref);
        const abs = this.absDraft(ref, p);
        await this.ensureDir(path.dirname(abs));
        await writeFileNoFollow(abs, content);
        const result: WriteResult = {
          version: `v-${sha(content).slice(0, 12)}`,
        };
        this.emit({ kind: "draft_changed", draft_id: ref, path: p });
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
  ): Promise<WriteResult> {
    return this.withLock(() =>
      this.cachedWrite(opId, async () => {
        assertWorkspacePath(p);
        assertDraftRef(ref);
        await this.loadDraftMeta(ref);
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
        const abs = this.absDraft(ref, p);
        await this.ensureDir(path.dirname(abs));
        await writeFileNoFollow(abs, next);
        const result: WriteResult = {
          version: `v-${sha(next).slice(0, 12)}`,
        };
        this.emit({ kind: "draft_changed", draft_id: ref, path: p });
        return result;
      }),
    );
  }

  fork(
    p: DocPath,
    n: number,
    intent?: string,
    author = "agent",
  ): Promise<DraftId[]> {
    return this.withLock(async () => {
      assertWorkspacePath(p);
      await this.readDoc(p, "main");
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
        };
        await this.saveDraftMeta(meta);
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

  merge(draftId: DraftId): Promise<{ commit: string }> {
    assertDraftId(draftId);
    return this.withLock(async () => {
      const meta = await this.loadDraftMeta(draftId);
      const draftRoot = path.join(this.root, ".drafts", draftId);
      const draftFiles = await walk(draftRoot);
      const mergedPaths: DocPath[] = [];
      for (const f of draftFiles) {
        const rel = path.relative(draftRoot, f).replace(/\\/g, "/");
        if (!rel.startsWith("workspaces/")) continue;
        // Re-validate before writing into main: the draft tree is a trust
        // boundary and a stray symlink or crafted rel path must never escape.
        assertWorkspacePath(rel);
        const dest = safeJoin(this.root, rel);
        await this.ensureDir(path.dirname(dest));
        await copyFileNoFollow(f, dest);
        if (rel.endsWith(".md")) mergedPaths.push(rel);
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
        target_paths: mergedPaths,
      });
      return {
        commit: `c-${sha(`merge:${draftId}:${Date.now()}`).slice(0, 12)}`,
      };
    });
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

  async draftChanges(
    draftId: DraftId,
  ): Promise<{ path: DocPath; main_md: string; draft_md: string }[]> {
    await this.loadDraftMeta(draftId);
    const draftRoot = path.join(this.root, ".drafts", draftId);
    const files = await walk(draftRoot);
    const out: { path: DocPath; main_md: string; draft_md: string }[] = [];
    for (const f of files) {
      const rel = path.relative(draftRoot, f).replace(/\\/g, "/");
      if (!rel.startsWith("workspaces/") || !rel.endsWith(".md")) continue;
      const draft_md = await readFileNoFollow(f);
      let main_md = "";
      try {
        main_md = await readFileNoFollow(this.absMain(rel));
      } catch {
        main_md = "";
      }
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
        out.push({
          draft_id: meta.draft_id,
          base_path: meta.base_path,
          intent: meta.intent,
          author: meta.author,
          state: meta.state,
          created_at: meta.created_at,
          submitted_at: meta.submitted_at,
          name: meta.name,
        });
      } catch {
        continue;
      }
    }
    return out.sort((a, b) => b.created_at - a.created_at);
  }

  private threadSidecarPath(homeDoc: DocPath, t: Thread): string {
    assertWorkspacePath(homeDoc);
    assertThreadId(t.id);
    const base = homeDoc.replace(/\.md$/, ".threads");
    const rel = `${base}/${t.id}.yaml`;
    if (t.draft_id) {
      assertDraftId(t.draft_id);
      const draftRoot = path.join(this.root, ".drafts", t.draft_id);
      return safeJoin(draftRoot, rel);
    }
    return safeJoin(this.root, rel);
  }

  private async allThreadFiles(): Promise<string[]> {
    const mainFiles = await walk(path.join(this.root, "workspaces"));
    const draftFiles = await walk(path.join(this.root, ".drafts"));
    return [...mainFiles, ...draftFiles].filter((f) =>
      /\.threads\/thrd_[A-Za-z0-9-]+\.yaml$/.test(f),
    );
  }

  // The file's on-disk location is authoritative: a thread under .drafts/<id>/
  // is scoped to that draft, everything else is main. The YAML may carry a
  // stale draft_id from a pre-fix run; trust the path instead.
  private draftIdFromFilePath(file: string): DraftId | undefined {
    const rel = path.relative(this.root, file);
    const parts = rel.split(path.sep);
    if (parts[0] !== ".drafts") return undefined;
    const id = parts[1];
    return id && DRAFT_ID_RE.test(id) ? id : undefined;
  }

  private async loadThread(id: ThreadId): Promise<Thread> {
    assertThreadId(id);
    const files = await this.allThreadFiles();
    for (const f of files) {
      if (path.basename(f) === `${id}.yaml`) {
        const raw = await readFileNoFollow(f);
        const t = yaml.parse(raw) as Thread;
        t.draft_id = this.draftIdFromFilePath(f);
        return t;
      }
    }
    throw err.threadNotFound(id);
  }

  private async saveThread(t: Thread): Promise<void> {
    if (t.targets.length === 0) {
      throw new McpError("invalid_path", "thread has no targets to save");
    }
    assertWorkspacePath(t.targets[0].path);
    assertThreadId(t.id);
    const sidecar = this.threadSidecarPath(t.targets[0].path, t);
    await this.ensureDir(path.dirname(sidecar));
    await writeFileNoFollow(sidecar, yaml.stringify(t));
  }

  async listThreads(opts: {
    path?: DocPath;
    thread_id?: ThreadId;
    ref?: Ref;
  }): Promise<ThreadSummary[]> {
    const files = await this.allThreadFiles();
    const wantDraftId =
      opts.ref === undefined || opts.ref === "main" ? undefined : opts.ref;
    const out: ThreadSummary[] = [];
    for (const f of files) {
      const raw = await readFileNoFollow(f);
      const t = yaml.parse(raw) as Thread;
      const draftId = this.draftIdFromFilePath(f);
      if (opts.thread_id && t.id !== opts.thread_id) continue;
      if (opts.ref !== undefined && draftId !== wantDraftId) continue;
      const paths = t.targets.map((tg) => tg.path);
      if (opts.path && !paths.includes(opts.path)) continue;
      const last = t.messages[t.messages.length - 1];
      out.push({
        id: t.id,
        status: t.status,
        created: t.created,
        draft_id: draftId,
        target_paths: paths,
        message_count: t.messages.length,
        last_message_preview: last
          ? last.body.slice(0, 120)
          : "",
      });
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
        const { md } = await this.readDoc(t.path, ref);
        const from = Math.max(0, Math.min(t.char_range.from, md.length));
        const to = Math.max(from, Math.min(t.char_range.to, md.length));
        const anchored = md.slice(from, to);
        const before = md.slice(Math.max(0, from - 64), from);
        const after = md.slice(to, Math.min(md.length, to + 64));
        targets.push({
          path: t.path,
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
      this.emit({
        kind: "thread_changed",
        thread_id: id,
        target_paths: thread.targets.map((t) => t.path),
      });
      return id;
    });
  }

  replyThread(
    id: ThreadId,
    message: string,
    opts?: { author?: string; draft?: ThreadDraftBody },
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
      this.emit({
        kind: "thread_changed",
        thread_id: id,
        target_paths: thread.targets.map((t) => t.path),
      });
    });
  }

  resolveThread(id: ThreadId): Promise<void> {
    return this.withLock(async () => {
      const thread = await this.loadThread(id);
      thread.status = "accepted";
      await this.saveThread(thread);
      this.emit({
        kind: "thread_changed",
        thread_id: id,
        target_paths: thread.targets.map((t) => t.path),
      });
    });
  }
}

/**
 * Deprecated re-export. The factory lives in `./factory.ts` — new consumers
 * should import from there. This shim keeps existing app/api callers
 * compiling while migration rolls through.
 */
export { getBackend } from "./factory";

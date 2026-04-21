import { promises as fs } from "node:fs";
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
  seed_prompt?: string;
  author: string;
  state: "open" | "submitted" | "accepted" | "declined";
  created_at: number;
  submitted_at?: number;
  note?: string;
  name?: string;
};

type OpLog = Record<string, WriteResult>;

const DRAFT_ID_RE = /^draft_[A-Za-z0-9-]+$/;

function assertDraftRef(ref: Ref): asserts ref is DraftId {
  if (ref === "main") throw err.writeToMainForbidden();
  if (!DRAFT_ID_RE.test(ref)) throw err.invalidRef(ref);
}

function assertWorkspacePath(p: string): void {
  if (!p.startsWith("workspaces/") || p.includes("..")) {
    throw err.invalidPath(p);
  }
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
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) out.push(full);
    }
  }
  return out;
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
    return path.join(this.root, p);
  }

  private absDraft(draftId: DraftId, p: DocPath): string {
    return path.join(this.root, ".drafts", draftId, p);
  }

  private absDraftMeta(draftId: DraftId): string {
    return path.join(this.root, ".drafts", draftId, "meta.json");
  }

  private async ensureDir(p: string): Promise<void> {
    await fs.mkdir(p, { recursive: true });
  }

  private async readOpLog(): Promise<OpLog> {
    if (this.opLogCache) return this.opLogCache;
    try {
      const raw = await fs.readFile(this.opLogPath, "utf8");
      this.opLogCache = JSON.parse(raw) as OpLog;
    } catch {
      this.opLogCache = {};
    }
    return this.opLogCache;
  }

  private async writeOpLog(log: OpLog): Promise<void> {
    this.opLogCache = log;
    await this.ensureDir(path.dirname(this.opLogPath));
    await fs.writeFile(this.opLogPath, JSON.stringify(log, null, 2), "utf8");
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
    if (!DRAFT_ID_RE.test(draftId)) throw err.invalidRef(draftId);
    try {
      const raw = await fs.readFile(this.absDraftMeta(draftId), "utf8");
      return JSON.parse(raw) as DraftMeta;
    } catch {
      throw err.draftNotFound(draftId);
    }
  }

  private async saveDraftMeta(meta: DraftMeta): Promise<void> {
    const p = this.absDraftMeta(meta.draft_id);
    await this.ensureDir(path.dirname(p));
    await fs.writeFile(p, JSON.stringify(meta, null, 2), "utf8");
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
      const stat = await fs.stat(f);
      const md = await fs.readFile(f, "utf8");
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
      const stat = await fs.stat(f);
      const md = await fs.readFile(f, "utf8");
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
    if (ref === "main") {
      abs = this.absMain(p);
    } else {
      await this.loadDraftMeta(ref);
      const draftAbs = this.absDraft(ref, p);
      try {
        await fs.stat(draftAbs);
        abs = draftAbs;
      } catch {
        abs = this.absMain(p);
      }
    }
    let md: string;
    try {
      md = await fs.readFile(abs, "utf8");
    } catch {
      throw err.docNotFound(p);
    }
    return {
      md,
      ycrdt_version: `v-${sha(md).slice(0, 12)}`,
      head_commit: `c-${sha(`${ref}:${p}:${md}`).slice(0, 12)}`,
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
        await fs.writeFile(abs, content, "utf8");
        const result = {
          commit: `c-${sha(`${ref}:${p}:${content}:${Date.now()}`).slice(0, 12)}`,
          ycrdt_version: `v-${sha(content).slice(0, 12)}`,
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
        await fs.writeFile(abs, next, "utf8");
        const result = {
          commit: `c-${sha(`${ref}:${p}:${next}:${Date.now()}`).slice(0, 12)}`,
          ycrdt_version: `v-${sha(next).slice(0, 12)}`,
        };
        this.emit({ kind: "draft_changed", draft_id: ref, path: p });
        return result;
      }),
    );
  }

  fork(
    p: DocPath,
    n: number,
    seedPrompt?: string,
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
          seed_prompt: seedPrompt,
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
    note?: string,
    draftName?: string,
  ): Promise<{ diff_url: string }> {
    return this.withLock(async () => {
      const meta = await this.loadDraftMeta(draftId);
      meta.state = "submitted";
      meta.submitted_at = Date.now();
      if (note !== undefined) meta.note = note;
      if (draftName !== undefined) meta.name = draftName;
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
    return this.withLock(async () => {
      const meta = await this.loadDraftMeta(draftId);
      const draftRoot = path.join(this.root, ".drafts", draftId);
      const draftFiles = await walk(draftRoot);
      for (const f of draftFiles) {
        const rel = path.relative(draftRoot, f).replace(/\\/g, "/");
        if (!rel.startsWith("workspaces/")) continue;
        const dest = path.join(this.root, rel);
        await this.ensureDir(path.dirname(dest));
        await fs.copyFile(f, dest);
      }
      meta.state = "accepted";
      await this.saveDraftMeta(meta);
      this.emit({
        kind: "draft_state",
        draft_id: draftId,
        state: "accepted",
      });
      return {
        commit: `c-${sha(`merge:${draftId}:${Date.now()}`).slice(0, 12)}`,
      };
    });
  }

  declineDraft(draftId: DraftId): Promise<void> {
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
      const draft_md = await fs.readFile(f, "utf8");
      let main_md = "";
      try {
        main_md = await fs.readFile(this.absMain(rel), "utf8");
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
          seed_prompt: meta.seed_prompt,
          author: meta.author,
          state: meta.state,
          created_at: meta.created_at,
          submitted_at: meta.submitted_at,
          note: meta.note,
          name: meta.name,
        });
      } catch {
        continue;
      }
    }
    return out.sort((a, b) => b.created_at - a.created_at);
  }

  private threadSidecarPath(homeDoc: DocPath, t: Thread): string {
    const base = homeDoc.replace(/\.md$/, ".threads");
    const file = `${t.id}.yaml`;
    if (t.draft_id) {
      return path.join(this.root, ".drafts", t.draft_id, base, file);
    }
    return path.join(this.root, base, file);
  }

  private async allThreadFiles(): Promise<string[]> {
    const mainFiles = await walk(path.join(this.root, "workspaces"));
    const draftFiles = await walk(path.join(this.root, ".drafts"));
    return [...mainFiles, ...draftFiles].filter((f) =>
      /\.threads\/thrd_[A-Za-z0-9-]+\.yaml$/.test(f),
    );
  }

  private async loadThread(id: ThreadId): Promise<Thread> {
    const files = await this.allThreadFiles();
    for (const f of files) {
      if (path.basename(f) === `${id}.yaml`) {
        const raw = await fs.readFile(f, "utf8");
        return yaml.parse(raw) as Thread;
      }
    }
    throw err.threadNotFound(id);
  }

  private async saveThread(t: Thread): Promise<void> {
    if (t.targets.length === 0) {
      throw new McpError("invalid_path", "thread has no targets to save");
    }
    const sidecar = this.threadSidecarPath(t.targets[0].path, t);
    await this.ensureDir(path.dirname(sidecar));
    await fs.writeFile(sidecar, yaml.stringify(t), "utf8");
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
      const raw = await fs.readFile(f, "utf8");
      const t = yaml.parse(raw) as Thread;
      if (opts.thread_id && t.id !== opts.thread_id) continue;
      if (opts.ref !== undefined && t.draft_id !== wantDraftId) continue;
      const paths = t.targets.map((tg) => tg.path);
      if (opts.path && !paths.includes(opts.path)) continue;
      const last = t.messages[t.messages.length - 1];
      out.push({
        id: t.id,
        status: t.status,
        created: t.created,
        draft_id: t.draft_id,
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
      this.emit({ kind: "thread_changed", thread_id: id });
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
      this.emit({ kind: "thread_changed", thread_id: id });
    });
  }

  resolveThread(id: ThreadId): Promise<void> {
    return this.withLock(async () => {
      const thread = await this.loadThread(id);
      thread.status = "accepted";
      await this.saveThread(thread);
      this.emit({ kind: "thread_changed", thread_id: id });
    });
  }
}

let cachedBackend: Backend | null = null;

export function getBackend(): Backend {
  if (cachedBackend) return cachedBackend;
  const root =
    process.env.SHEAF_DATA_ROOT ??
    path.join(process.cwd(), "data");
  cachedBackend = new StubBackend(root);
  return cachedBackend;
}

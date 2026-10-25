import { promises as fs, constants as fsConstants } from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import {
  type Backend,
  type BackendEvent,
  type DocContent,
  type DocPath,
  type DocSummary,
  type GrepMatch,
  type GrepOptions,
  type GrepResult,
  type OpId,
  type Origin,
  type Thread,
  type ThreadAnchor,
  type ThreadDraftBody,
  type ThreadId,
  type ThreadSummary,
} from "./index";
import { McpError, err } from "../errors";
import { globToRegex } from "../glob";
import {
  assertThreadId,
  assertVaultPath,
  safeJoin,
} from "../paths";
import { opLogSchema } from "../persistence-schemas";
import {
  cleanProse,
  parseReviewDoc,
  serializeReviewDoc,
} from "./review-doc";

/**
 * Filesystem-backed stub backend — the one `StubBackend` the daemon owns per
 * vault (the CLI constructs it directly as `new StubBackend(vault)`).
 *
 * `<root>` is the vault root. Any visible markdown file under it is a
 * sheaf doc — `<dir>/<name>.md` at any depth. Dot-prefixed entries
 * (`.op_log.json`, `.obsidian/`, …) are infra and never surfaced as docs.
 *
 * Layout (all under `<root>`):
 *   <dir>/<name>.md                                        # prose + inline RFM review markup
 *   .op_log.json
 *
 * Threads live inline in the doc markdown (CriticMarkup + a YAML endmatter
 * block — see `review-doc.ts`), not in sidecars; `readDoc` returns clean prose
 * with that markup stripped.
 */

/**
 * The applied-`op_id` set backing idempotent writes (`.op_log.json`, shape in
 * `opLogSchema`): each applied op id → when it was applied. A Map (not a plain
 * object) so an op id like `constructor` can't hit an inherited key.
 */
type OpLog = Map<OpId, { applied_at: number }>;

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
      // infra (`.op_log.json`) plus vault config (`.obsidian/`). This is what
      // scopes the vault walk to visible docs.
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
/** Largest file we're willing to read into memory. Inline review state now
 *  lives in the doc itself, so a doc with many threads (each carrying up to a
 *  1MB draft) is larger than clean prose alone — the cap is sized to hold a
 *  realistic annotated doc while still bounding a pathological read. */
const MAX_FILE_BYTES = 16 * 1024 * 1024;

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
  // Write a sibling temp file, then rename over `abs`. A doc's prose and all
  // its threads now share one file, so an in-place O_TRUNC write torn mid-way
  // would lose both; rename is atomic, so a concurrent reader (or a crash) sees
  // either the old file or the fully-written new one, never a truncated hybrid.
  // O_EXCL | O_NOFOLLOW keeps the temp create symlink-hostile, and the dot
  // prefix keeps a leftover temp out of the vault walk.
  const dir = path.dirname(abs);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(abs)}.tmp-${randomUUID()}`);
  const fh = await fs.open(
    tmp,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_NOFOLLOW,
    0o644,
  );
  try {
    await fh.writeFile(content, "utf8");
  } finally {
    await fh.close();
  }
  try {
    await fs.rename(tmp, abs);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

/**
 * Replay-buffer depth for resumable SSE subscriptions. Sized for the gap a
 * reconnect loop actually spans (about a second, plus a debounce window) —
 * a subscriber further behind than this gets a `stream_reset` and re-syncs
 * from the store.
 */
const MAX_REPLAY_EVENTS = 256;

export class StubBackend implements Backend {
  private root: string;
  private opLogPath: string;
  private opLogCache: OpLog | null = null;
  private lockChain: Promise<unknown> = Promise.resolve();
  private subscribers = new Set<(event: BackendEvent, eventId?: string) => void>();
  /**
   * Subset of `subscribers` registered with `role: "agent"`. Tracked so the
   * `agent_presence` event reflects watcher/MCP sessions only — UI tabs
   * don't mark themselves as connected agents.
   */
  private agentSubscribers = new Set<(event: BackendEvent, eventId?: string) => void>();
  /** Unix-ms of the last moment an agent subscriber was registered. */
  private agentLastSeen: number | undefined;
  /**
   * Resumable-stream state. Every mutation event gets an id
   * `<epoch>.<seq>` (the SSE `id:` field) and a slot in a bounded replay
   * buffer, so a subscriber that reconnects with `sinceId` gets the events
   * it missed instead of a silent gap. The epoch is random per backend
   * instance: an id minted by a previous instance (a daemon restart)
   * is detectably non-resumable and yields a `stream_reset` instead of a
   * wrong replay. Lifecycle events (`agent_presence`, `stream_reset`) are
   * connection state, not mutations — they get no id and aren't buffered
   * (current presence is already replayed to fresh UI subscribers).
   */
  private streamEpoch = randomUUID().slice(0, 8);
  private streamSeq = 0;
  private eventLog: { seq: number; origin: Origin; event: BackendEvent }[] = [];

  constructor(root: string) {
    this.root = root;
    this.opLogPath = path.join(root, ".op_log.json");
  }

  subscribe(
    listener: (event: BackendEvent, eventId?: string) => void,
    opts?: { role?: "ui" | "agent"; sinceId?: string },
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
    // Resume or reset. Replay everything after `sinceId` that this role
    // would have received live; when the position can't be honored (no id,
    // another instance's epoch, or evicted from the buffer), send one
    // `stream_reset` so the consumer knows to re-sync from the store instead
    // of trusting the stream.
    try {
      const resumeFrom = this.resumePoint(opts?.sinceId);
      if (resumeFrom === null) {
        listener({ kind: "stream_reset" });
      } else {
        for (const entry of this.eventLog) {
          if (entry.seq <= resumeFrom) continue;
          if (entry.origin === "agent" && role === "agent") continue;
          listener(entry.event, `${this.streamEpoch}.${entry.seq}`);
        }
      }
    } catch {
      /* listener errors must not break callers */
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

  /**
   * Seq of the last event the subscriber has proven it saw, or null when the
   * stream can't resume from `sinceId` (absent, minted by another instance's
   * epoch, or already evicted from the bounded buffer).
   */
  private resumePoint(sinceId: string | undefined): number | null {
    if (!sinceId) return null;
    const dot = sinceId.lastIndexOf(".");
    if (dot === -1 || sinceId.slice(0, dot) !== this.streamEpoch) return null;
    const seq = Number(sinceId.slice(dot + 1));
    if (!Number.isInteger(seq) || seq < 0 || seq > this.streamSeq) return null;
    // Everything after `seq` must still be buffered for the replay to be gapless.
    const oldestBuffered = this.eventLog[0]?.seq ?? this.streamSeq + 1;
    return seq >= oldestBuffered - 1 ? seq : null;
  }

  private emit(event: BackendEvent, origin: Origin = "ui"): void {
    // Mutation events get a resume id and a replay-buffer slot; presence is
    // connection lifecycle, replayed as current state on subscribe instead.
    let eventId: string | undefined;
    if (event.kind !== "agent_presence") {
      this.streamSeq += 1;
      eventId = `${this.streamEpoch}.${this.streamSeq}`;
      this.eventLog.push({ seq: this.streamSeq, origin, event });
      if (this.eventLog.length > MAX_REPLAY_EVENTS) this.eventLog.shift();
    }
    for (const listener of this.subscribers) {
      // Don't echo an agent's own mutations back to agent subscribers: the
      // event-watcher would otherwise wake the agent on its own edits and
      // replies. UI subscribers still see everything (they want the agent's
      // edits to land in the panel). User-originated events (default origin)
      // reach everyone, including the agent.
      if (origin === "agent" && this.agentSubscribers.has(listener)) continue;
      try {
        listener(event, eventId);
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

  private async ensureDir(p: string): Promise<void> {
    await fs.mkdir(p, { recursive: true });
  }

  /** Null on any read failure — for discovery/listing, where one bad doc must
   *  not abort the whole walk. */
  private async readRawMaybe(abs: string): Promise<string | null> {
    try {
      return await readFileNoFollow(abs);
    } catch {
      return null;
    }
  }

  /**
   * Read a doc we're about to rewrite. Returns null only when the file is
   * genuinely absent (ENOENT); any other failure (e.g. it exceeds the read cap)
   * is rethrown, so a rewrite never silently overwrites a doc's threads with an
   * empty endmatter just because its bytes couldn't be read.
   */
  private async readRawForRewrite(abs: string): Promise<string | null> {
    try {
      return await readFileNoFollow(abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw e;
    }
  }

  /**
   * Write clean prose while preserving the threads already homed in the doc, so
   * a prose change never drops them. Used by `writeDoc`/`editDoc`.
   */
  private async persistDoc(
    abs: string,
    prose: string,
    homePath: DocPath,
  ): Promise<void> {
    const raw = await this.readRawForRewrite(abs);
    const existing = raw ? parseReviewDoc(raw).threads : [];
    await this.ensureDir(path.dirname(abs));
    await writeFileNoFollow(abs, serializeReviewDoc(prose, existing, homePath));
  }

  /**
   * Every visible vault doc file that may carry threads.
   */
  private async allReviewDocFiles(): Promise<
    { abs: string; homePath: DocPath }[]
  > {
    const out: { abs: string; homePath: DocPath }[] = [];
    for (const f of await walk(this.root)) {
      if (!f.endsWith(".md")) continue;
      out.push({
        abs: f,
        homePath: path.relative(this.root, f).replace(/\\/g, "/"),
      });
    }
    return out;
  }

  private async readOpLog(): Promise<OpLog> {
    if (this.opLogCache) return this.opLogCache;
    try {
      const raw = await readFileNoFollow(this.opLogPath);
      const parsed = opLogSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        this.opLogCache = new Map(Object.entries(parsed.data));
      } else {
        // Corrupt on-disk shape (not a string-keyed object) — keep going with
        // an empty log rather than crashing the whole backend.
        console.error("[stub] op_log failed schema validation; resetting");
        this.opLogCache = new Map();
      }
    } catch {
      this.opLogCache = new Map();
    }
    return this.opLogCache;
  }

  private async writeOpLog(log: OpLog): Promise<void> {
    this.opLogCache = log;
    await this.ensureDir(path.dirname(this.opLogPath));
    await writeFileNoFollow(
      this.opLogPath,
      JSON.stringify(Object.fromEntries(log), null, 2),
    );
  }

  /**
   * Run a write at most once per `opId`. A repeat of an op id already in the op
   * log is a no-op — the write isn't re-run and no event fires. The id is only
   * recorded after `run` succeeds, so a failed write can be retried. Without an
   * `opId` the write always runs.
   */
  private async applyOnce(
    opId: OpId | undefined,
    run: () => Promise<void>,
  ): Promise<void> {
    if (!opId) return run();
    const log = await this.readOpLog();
    if (log.has(opId)) return;
    await run();
    log.set(opId, { applied_at: Date.now() });
    await this.writeOpLog(log);
  }

  /**
   * Every visible markdown doc on main. `walk` already skips dot-prefixed
   * entries (`.obsidian/`, …), so this is the whole vault minus infra. The
   * single source of truth for discovery (`listDocs`, `glob`).
   */
  private async listMainDocs(): Promise<DocSummary[]> {
    const files = await walk(this.root);
    const results: DocSummary[] = [];
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      // Skip an unreadable/oversized doc rather than aborting the whole listing.
      const raw = await this.readRawMaybe(f);
      if (raw === null) continue;
      let stat: import("node:fs").Stats;
      try {
        stat = await fs.lstat(f);
      } catch {
        continue;
      }
      const rel = path.relative(this.root, f).replace(/\\/g, "/");
      results.push({
        path: rel,
        title: titleFromMd(cleanProse(raw), path.basename(f, ".md")),
        updated_at: stat.mtimeMs,
      });
    }
    return results.sort((a, b) => a.path.localeCompare(b.path));
  }

  async listDocs(prefix?: string): Promise<DocSummary[]> {
    const docs = await this.listMainDocs();
    return prefix ? docs.filter((d) => d.path.startsWith(prefix)) : docs;
  }

  async glob(pattern: string): Promise<DocSummary[]> {
    const re = globToRegex(pattern);
    const all = await this.listMainDocs();
    return all.filter((d) => re.test(d.path));
  }

  async grep(opts: GrepOptions): Promise<GrepResult> {
    const re = new RegExp(
      opts.pattern,
      (opts.case_insensitive ? "i" : "") + (opts.multiline ? "s" : ""),
    );
    // Pre-compile the global variant once for count mode; the previous code
    // rebuilt it on every iteration.
    const globalRe = new RegExp(re.source, re.flags + "g");
    let candidates = await this.listMainDocs();
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
        const { md } = await this.readDoc(d.path);
        if (re.test(md)) paths.push(d.path);
        if (paths.length >= limit) break;
      }
      return { mode: "files_with_matches", paths };
    }
    if (mode === "count") {
      const counts: { path: DocPath; count: number }[] = [];
      for (const d of candidates) {
        checkDeadline();
        const { md } = await this.readDoc(d.path);
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
      const { md } = await this.readDoc(d.path);
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

  async readDoc(p: DocPath): Promise<DocContent> {
    assertVaultPath(p);
    const abs = this.absMain(p);
    let raw: string;
    try {
      raw = await readFileNoFollow(abs);
    } catch (e) {
      if (e instanceof McpError) throw e;
      throw err.docNotFound(p);
    }
    // The on-disk file carries inline review markup; readers see clean prose.
    return { md: cleanProse(raw) };
  }

  writeDoc(
    p: DocPath,
    content: string,
    opId?: OpId,
    origin: Origin = "ui",
  ): Promise<void> {
    return this.withLock(() =>
      this.applyOnce(opId, async () => {
        assertVaultPath(p);
        await this.persistDoc(this.absMain(p), content, p);
        this.emit({ kind: "doc_changed", path: p }, origin);
      }),
    );
  }

  editDoc(
    p: DocPath,
    oldString: string,
    newString: string,
    replaceAll: boolean,
    opId?: OpId,
    origin: Origin = "ui",
  ): Promise<void> {
    return this.withLock(() =>
      this.applyOnce(opId, async () => {
        assertVaultPath(p);
        const current = await this.readDoc(p);
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
        await this.persistDoc(this.absMain(p), next, p);
        this.emit({ kind: "doc_changed", path: p }, origin);
      }),
    );
  }

  private async loadThread(id: ThreadId): Promise<Thread> {
    assertThreadId(id);
    for (const file of await this.allReviewDocFiles()) {
      const raw = await this.readRawMaybe(file.abs);
      if (raw === null) continue;
      const { threads } = parseReviewDoc(raw);
      const found = threads.find((t) => t.id === id);
      if (found) return found;
    }
    throw err.threadNotFound(id);
  }

  /**
   * Upsert a thread into its home doc's endmatter (home = `targets[0].path`).
   */
  private async saveThread(t: Thread): Promise<void> {
    if (t.targets.length === 0) {
      throw new McpError("invalid_path", "thread has no targets to save");
    }
    const homePath = t.targets[0].path;
    assertVaultPath(homePath);
    assertThreadId(t.id);
    const abs = this.absMain(homePath);
    const raw = await this.readRawForRewrite(abs);
    let prose: string;
    let threads: Thread[];
    if (raw !== null) {
      ({ prose, threads } = parseReviewDoc(raw));
    } else {
      // A missing file is only legitimate for a doc that exists in prose but
      // couldn't be read — seed from the current view so the thread has prose
      // to anchor to.
      prose = (await this.readDoc(homePath)).md;
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
  }): Promise<ThreadSummary[]> {
    const out: ThreadSummary[] = [];
    for (const file of await this.allReviewDocFiles()) {
      const raw = await this.readRawMaybe(file.abs);
      if (raw === null) continue;
      const { threads } = parseReviewDoc(raw);
      for (const t of threads) {
        if (opts.thread_id && t.id !== opts.thread_id) continue;
        const paths = t.targets.map((tg) => tg.path);
        if (opts.path && !paths.includes(opts.path)) continue;
        const last = t.messages[t.messages.length - 1];
        out.push({
          id: t.id,
          status: t.status,
          created: t.created,
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

  /**
   * Batch full-detail read — mirrors {@link listThreads}'s filtering/order but
   * returns the whole parsed `Thread` (messages, targets, anchors, drafts)
   * instead of a summary. Single pass over the review docs, so it avoids the
   * N+1 file scans a ListThreads + per-id ReadThread loop would incur.
   */
  async readThreads(opts: {
    path?: DocPath;
    thread_id?: ThreadId;
  }): Promise<Thread[]> {
    const out: Thread[] = [];
    for (const file of await this.allReviewDocFiles()) {
      const raw = await this.readRawMaybe(file.abs);
      if (raw === null) continue;
      const { threads } = parseReviewDoc(raw);
      for (const t of threads) {
        if (opts.thread_id && t.id !== opts.thread_id) continue;
        if (opts.path && !t.targets.some((tg) => tg.path === opts.path)) {
          continue;
        }
        out.push(t);
      }
    }
    return out.sort((a, b) => b.created - a.created);
  }

  addThread(opts: {
    targets: ThreadAnchor[];
    message: string;
    author?: string;
    draft?: ThreadDraftBody;
    origin?: Origin;
  }): Promise<ThreadId> {
    return this.withLock(async () => {
      if (opts.targets.length === 0) {
        throw new McpError("invalid_path", "at least one target is required");
      }
      const id: ThreadId = `thrd_${randomUUID()}`;
      const targets: Thread["targets"] = [];
      for (const t of opts.targets) {
        if (t.scope === "doc") {
          // Doc-level: no anchor. Verify the doc exists so we don't store
          // threads pointing at nothing.
          await this.readDoc(t.path);
          targets.push({ path: t.path, scope: "doc" });
          continue;
        }
        const { md } = await this.readDoc(t.path);
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

  reopenThread(threadId: ThreadId, origin: Origin = "ui"): Promise<void> {
    return this.withLock(async () => {
      const thread = await this.loadThread(threadId);
      if (thread.status === "open") {
        throw err.invalidPayload(
          `thread ${threadId} is already open`,
        );
      }

      // Plain "unresolve": resurrect the thread straight back to open so it
      // re-enters the queue as an outstanding item — the escape hatch for an
      // agent that resolved too eagerly. No payload leaf: a lone option would
      // misrender as a one-choice picker in the panel.
      thread.status = "open";
      thread.messages.push({
        author: "system",
        ts: Date.now(),
        body: "reopened",
      });

      await this.saveThread(thread);
      this.emit(
        {
          kind: "thread_changed",
          thread_id: threadId,
          target_paths: thread.targets.map((t) => t.path),
        },
        origin,
      );
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
}

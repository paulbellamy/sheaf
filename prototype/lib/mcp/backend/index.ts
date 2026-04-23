/**
 * Backend interface for the sheaf MCP server.
 *
 * This interface is the boundary between MCP tool handlers and the storage
 * substrate. The prototype (stub.ts) implements it over the local filesystem
 * with no real CRDT or git; the production backend will plug in yjs, git,
 * and case-2 sync (design §4.2) without touching any tool code.
 *
 * Paths are always repo-root-relative, e.g. "workspaces/infra/docs/proposal.md".
 * Refs are either "main" or a draft id of the form "draft_<uuid>".
 */

export type Ref = "main" | string;

export type DocPath = string;
export type DraftId = string;
export type ThreadId = string;
export type OpId = string;

export type Workspace = { name: string; path: string };

export type DocSummary = {
  path: DocPath;
  title: string;
  updated_at: number;
};

export type DocContent = {
  md: string;
  /**
   * Opaque version token. Meaningful only to the backend that emitted it;
   * callers may round-trip it as a stale-check handle but must not parse it.
   */
  version: string;
  /**
   * Which tree the bytes actually came from. `readDoc(path, draftId)` falls
   * through to main when the draft has no override; `origin` tells callers
   * which tree they're looking at without another round-trip.
   */
  origin: "main" | "draft";
};

export type WriteResult = {
  /** Opaque version token. Same semantics as DocContent.version. */
  version: string;
};

export type GrepMatch = {
  path: DocPath;
  line: number;
  text: string;
  before?: string[];
  after?: string[];
};

export type GrepOptions = {
  pattern: string;
  path?: DocPath;
  glob?: string;
  output_mode?: "content" | "files_with_matches" | "count";
  case_insensitive?: boolean;
  show_line_numbers?: boolean;
  before_context?: number;
  after_context?: number;
  multiline?: boolean;
  head_limit?: number;
  ref?: Ref;
};

export type GrepResult =
  | { mode: "content"; matches: GrepMatch[] }
  | { mode: "files_with_matches"; paths: DocPath[] }
  | { mode: "count"; counts: { path: DocPath; count: number }[] };

export type DraftSummary = {
  draft_id: DraftId;
  base_path: DocPath;
  /**
   * Natural-language description of the draft's intent. Set at Fork time,
   * editable at Propose time. Replaces the previous `seed_prompt`+`note`
   * split — both were always shown to the same reviewer audience.
   */
  intent?: string;
  author: string;
  state: "open" | "submitted" | "accepted" | "declined";
  created_at: number;
  submitted_at?: number;
  /** Human-friendly label shown in the review queue. */
  name?: string;
};

export type ThreadAnchor = {
  path: DocPath;
  char_range: { from: number; to: number };
};

export type ThreadDraftBody = { new_md: string };

export type ThreadMessage = {
  author: string;
  ts: number;
  body: string;
  draft?: ThreadDraftBody;
};

export type ThreadTarget = {
  path: DocPath;
  anchor: {
    rel_pos: string;
    content_hash: string;
    anchored_text: string;
    context_before: string;
    context_after: string;
  };
};

export type ThreadStatus = "open" | "accepted" | "declined" | "archived";

export type Thread = {
  id: ThreadId;
  created: number;
  status: ThreadStatus;
  draft_id?: DraftId;
  targets: ThreadTarget[];
  messages: ThreadMessage[];
};

export type ThreadSummary = {
  id: ThreadId;
  status: ThreadStatus;
  created: number;
  draft_id?: DraftId;
  target_paths: DocPath[];
  message_count: number;
  last_message_preview: string;
};

export interface Backend {
  listWorkspaces(): Promise<Workspace[]>;
  listDocs(workspace: string, prefix?: string): Promise<DocSummary[]>;

  glob(pattern: string, ref?: Ref): Promise<DocSummary[]>;
  grep(opts: GrepOptions): Promise<GrepResult>;

  readDoc(path: DocPath, ref?: Ref): Promise<DocContent>;

  writeDoc(
    path: DocPath,
    ref: Ref,
    content: string,
    opId?: OpId,
  ): Promise<WriteResult>;

  editDoc(
    path: DocPath,
    ref: Ref,
    oldString: string,
    newString: string,
    replaceAll: boolean,
    opId?: OpId,
  ): Promise<WriteResult>;

  fork(
    path: DocPath,
    n: number,
    intent?: string,
    author?: string,
  ): Promise<DraftId[]>;

  propose(
    draftId: DraftId,
    intent?: string,
    name?: string,
  ): Promise<{ diff_url: string }>;

  merge(draftId: DraftId): Promise<{ commit: string }>;

  declineDraft(draftId: DraftId): Promise<void>;

  listDrafts(path?: DocPath): Promise<DraftSummary[]>;

  /** Files changed in a draft relative to main, for UI diff rendering. */
  draftChanges(
    draftId: DraftId,
  ): Promise<{ path: DocPath; main_md: string; draft_md: string }[]>;

  listThreads(opts: {
    path?: DocPath;
    thread_id?: ThreadId;
    ref?: Ref;
  }): Promise<ThreadSummary[]>;

  readThread(id: ThreadId): Promise<Thread>;

  addThread(opts: {
    targets: ThreadAnchor[];
    message: string;
    author?: string;
    draft?: ThreadDraftBody;
    ref?: Ref;
  }): Promise<ThreadId>;

  replyThread(
    id: ThreadId,
    message: string,
    opts?: { author?: string; draft?: ThreadDraftBody },
  ): Promise<void>;

  resolveThread(id: ThreadId): Promise<void>;

  /**
   * Subscribe to mutation events. Returns an unsubscribe function.
   *
   * Used by the SSE route to push live updates to the /doc browser UI.
   * Emitted from any mutation that changes what a reviewer would see:
   * Fork, Write, Edit, Propose, Merge, declineDraft.
   */
  subscribe(listener: (event: BackendEvent) => void): () => void;
}

import { z } from "zod";

/**
 * Backend events.
 *
 * Modeled as a zod discriminated union so:
 *  - Every `switch (event.kind)` is exhaustive-checked by TS.
 *  - SSE frames are runtime-validated via `backendEventSchema.safeParse`;
 *    corrupt payloads surface as errors rather than silent drops.
 *
 * `target_paths` on thread events lets UI consumers scope their refetches
 * to the affected docs instead of refetching globally on any thread change.
 */
export const backendEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("draft_created"),
    draft_id: z.string(),
    base_path: z.string(),
  }),
  z.object({
    kind: z.literal("draft_changed"),
    draft_id: z.string(),
    path: z.string(),
  }),
  z.object({
    kind: z.literal("draft_state"),
    draft_id: z.string(),
    state: z.enum(["open", "submitted", "accepted", "declined"]),
  }),
  z.object({
    kind: z.literal("draft_merged"),
    draft_id: z.string(),
    /** Paths merged into main. */
    target_paths: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("thread_changed"),
    thread_id: z.string(),
    /** Docs the thread anchors onto; consumers scope refetches by these. */
    target_paths: z.array(z.string()),
  }),
]);

export type BackendEvent = z.infer<typeof backendEventSchema>;

/**
 * Deferred for the real backend:
 *   - yjs / ycrdt doc synthesis and state-vector accounting
 *   - case-2 sync (diff md -> yjs ops -> verify render) from design §4.2
 *   - git commits (paired md + ycrdt) and branch storage
 *   - artifact-fs cold mount
 *   - multi-agent shared drafts (design §8)
 *   - authentication / authorization
 */

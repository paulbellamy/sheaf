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
  version_token: string;
  /**
   * Monotonic per-doc version counter. Bumped atomically on draft accept
   * (Phase I); surfaced as the `vN` badge in the UI. Distinct from
   * `version_token`, which is an opaque stale-check handle.
   */
  version_counter: number;
  /**
   * Which tree the bytes actually came from. `readDoc(path, draftId)` falls
   * through to main when the draft has no override; `origin` tells callers
   * which tree they're looking at without another round-trip.
   */
  origin: "main" | "draft";
};

export type WriteResult = {
  /** Opaque version token. Same semantics as DocContent.version_token. */
  version_token: string;
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
  /**
   * Server-rendered display name: `"<name> #<4hex>"`, where the suffix is
   * the first 4 chars of `draft_id` after the `draft_` prefix. Set when the
   * draft is created via `forkAndAttachThreads` (Phase C); absent on legacy
   * drafts created via the bare `fork()` MCP path until they're touched.
   */
  display_name?: string;
  /**
   * Workspace paths the draft has touched. Initialized to `[base_path]` at
   * fork time; Phase H expands as cross-cutting edits land.
   */
  touches: DocPath[];
  /**
   * Per-doc version counter of `base_path` at fork time. Surfaced as
   * "based on v<base_version>" in the draft-mode banner.
   */
  base_version: number;
  /**
   * When set, this draft was forked off another draft (a sub-draft used for
   * multi-option exploration; Phase G). Sub-drafts share lineage with their
   * parent all the way back to main: `base_version` still tracks main, not
   * the parent. On parent merge (Phase I), all sub-drafts where
   * `parent_draft_id === parent` and `state !== "accepted"` are
   * cascade-declined; declined sub-draft refs persist in git history per the
   * resolved decision on rejected-alternatives storage.
   */
  parent_draft_id?: DraftId;
};

export type ThreadAnchor = {
  path: DocPath;
  char_range: { from: number; to: number };
};

/**
 * One proposed leaf attached to a thread message. `name` is set on each leaf
 * when a message carries multiple options (so the UI can label them); single-
 * payload uses don't bother with a name.
 */
export type ThreadDraftBody = { new_md: string; name?: string };

export type ThreadMessage = {
  author: string;
  ts: number;
  body: string;
  /**
   * Single-leaf shortcut. Kept for back-compat with existing α flows that
   * attach exactly one redline payload.
   */
  draft?: ThreadDraftBody;
  /**
   * Canonical multi-option payload. `draft_options` is the going-forward way
   * to attach proposed leaves to a message; reviewers pick one. Set this for
   * 2+ options, set `draft` for 1.
   */
  draft_options?: ThreadDraftBody[];
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

  /**
   * Fork the doc at `path` into `n` parallel drafts.
   *
   * When `parent` is omitted, each new draft branches off `main` with
   * `parent_draft_id` unset. When `parent` is set (Phase G: multi-option
   * exploration), each new draft is a sub-draft branched off the parent's
   * current draft content for that path — the parent's edits are visible
   * to the sub-draft as its starting point. `base_path` is inherited from
   * the parent (same doc identity); `base_version` is inherited too, so
   * sub-drafts share lineage with the parent all the way back to main.
   *
   * Acceptance lifecycle: on parent merge (Phase I), all sub-drafts where
   * `parent_draft_id === parent` and `state !== "accepted"` are
   * cascade-declined. Phase G exposes `_cascadeDeclineSubDrafts` for that
   * call; Phase I wires it into `merge()`.
   */
  fork(
    path: DocPath,
    n: number,
    intent?: string,
    author?: string,
    parent?: DraftId,
  ): Promise<DraftId[]>;

  /**
   * Atomic Start-Draft primitive: forks a single draft off `base_path` and
   * persists `initial_threads` against the new draft ref in one shot. Used
   * by the UI's `POST /api/ui/drafts` (Phase C) so the alice-clicks-Start-Draft
   * gesture creates draft + threads as one transaction.
   *
   * Distinct from `fork()` so the MCP tool's existing one-arg surface stays
   * untouched — callers there don't need the threads-in-one-shot semantics.
   */
  forkAndAttachThreads(opts: {
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
  }>;

  propose(
    draftId: DraftId,
    intent?: string,
    name?: string,
  ): Promise<{ diff_url: string }>;

  /**
   * Atomic accept of every path in the draft's `touches`. On success, every
   * touched path's `version_counter` is bumped by one and a single
   * `draft_merged` event is emitted carrying the per-path `{from, to}`
   * versions. Returns the resulting `commit` (pseudo id in the stub) plus
   * the per-path version transitions.
   *
   * Atomic on conflict: if any touched path has overlapping changes (Phase I
   * stub heuristic: main's `version_counter[path]` has advanced past the
   * draft's `base_version`), the call throws a `merge_conflict` SheafError
   * with per-path details and *nothing* is committed — no main writes, no
   * version bumps, no events.
   */
  merge(draftId: DraftId): Promise<{
    commit: string;
    versions: { path: DocPath; from: number; to: number }[];
  }>;

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
   * Append a system-style message to an existing thread carrying one or more
   * proposed leaves. Phase F: this is how claude attaches an α-style payload
   * to an existing thread instead of spawning a sibling redline thread.
   *
   * Exactly one of `draft` or `draft_options` must be set. `draft_options` is
   * canonical for >1 leaf; `draft` is the single-leaf shortcut. Implementations
   * MUST reject a call with both missing or both set.
   */
  attachDraftPayload(
    threadId: ThreadId,
    opts: {
      message?: string;
      draft?: ThreadDraftBody;
      draft_options?: ThreadDraftBody[];
      author?: string;
    },
  ): Promise<void>;

  /**
   * Subscribe to mutation events. Returns an unsubscribe function.
   *
   * Used by the SSE route to push live updates to the /doc browser UI.
   * Emitted from any mutation that changes what a reviewer would see:
   * Fork, Write, Edit, Propose, Merge, declineDraft.
   *
   * `role` distinguishes UI subscribers (passive observers, the default)
   * from agent subscribers (the MCP/event-watcher session). Only `"agent"`
   * subscribers count toward `agent_presence`; otherwise a single browser
   * tab would mark itself as a connected agent.
   */
  subscribe(
    listener: (event: BackendEvent) => void,
    opts?: { role?: "ui" | "agent" },
  ): () => void;
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
    /**
     * Per-path version transitions. Phase I: `from` is main's pre-merge
     * counter, `to` is `from + 1`. Same length and order as `target_paths`.
     */
    versions: z.array(
      z.object({
        path: z.string(),
        from: z.number(),
        to: z.number(),
      }),
    ),
  }),
  z.object({
    kind: z.literal("thread_changed"),
    thread_id: z.string(),
    /** Docs the thread anchors onto; consumers scope refetches by these. */
    target_paths: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("agent_presence"),
    /** True when at least one `role: "agent"` subscriber is active. */
    connected: z.boolean(),
    /**
     * Unix-ms timestamp of the most recent moment the agent was connected.
     * Set on the disconnect transition (and replayed to UI subscribers on
     * connect so they render "last seen" without waiting for a transition).
     */
    last_seen: z.number().optional(),
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

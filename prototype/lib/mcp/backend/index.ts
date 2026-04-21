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
  ycrdt_version: string;
  head_commit: string;
};

export type WriteResult = {
  commit: string;
  ycrdt_version: string;
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
  seed_prompt?: string;
  author: string;
  state: "open" | "submitted" | "accepted" | "declined";
  created_at: number;
  submitted_at?: number;
  note?: string;
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
  targets: ThreadTarget[];
  messages: ThreadMessage[];
};

export type ThreadSummary = {
  id: ThreadId;
  status: ThreadStatus;
  created: number;
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
    seedPrompt?: string,
    author?: string,
  ): Promise<DraftId[]>;

  propose(
    draftId: DraftId,
    note?: string,
    draftName?: string,
  ): Promise<{ diff_url: string }>;

  merge(draftId: DraftId): Promise<{ commit: string }>;

  listDrafts(path?: DocPath): Promise<DraftSummary[]>;

  listThreads(opts: {
    path?: DocPath;
    thread_id?: ThreadId;
  }): Promise<ThreadSummary[]>;

  readThread(id: ThreadId): Promise<Thread>;

  addThread(opts: {
    targets: ThreadAnchor[];
    message: string;
    author?: string;
    draft?: ThreadDraftBody;
  }): Promise<ThreadId>;

  replyThread(
    id: ThreadId,
    message: string,
    opts?: { author?: string; draft?: ThreadDraftBody },
  ): Promise<void>;

  resolveThread(id: ThreadId): Promise<void>;
}

/**
 * Deferred for the real backend:
 *   - yjs / ycrdt doc synthesis and state-vector accounting
 *   - case-2 sync (diff md -> yjs ops -> verify render) from design §4.2
 *   - git commits (paired md + ycrdt) and branch storage
 *   - artifact-fs cold mount
 *   - multi-agent shared drafts (design §8)
 *   - authentication / authorization
 */

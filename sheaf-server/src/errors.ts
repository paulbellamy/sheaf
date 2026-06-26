export type SheafErrorCode =
  | "doc_not_found"
  | "draft_not_found"
  | "thread_not_found"
  | "write_to_main_forbidden"
  | "edit_no_match"
  | "edit_ambiguous"
  | "invalid_path"
  | "invalid_ref"
  | "invalid_thread_id"
  | "invalid_payload"
  | "out_of_scope"
  | "draft_not_submitted"
  | "draft_already_submitted"
  | "merge_conflict"
  | "accept_blocked"
  | "anchor_orphaned"
  | "grep_timeout"
  | "payload_too_large";

export type MergeConflictDetail = {
  path: string;
  base_version: number;
  main_version: number;
};

/**
 * Thrown by the sheaf backend and tool layer. Surfaces through MCP
 * `toToolError` to agents and through `errorResult` to UI route handlers.
 *
 * Previously named `McpError`; kept as an export alias for back-compat while
 * existing imports migrate.
 */
export class SheafError extends Error {
  code: SheafErrorCode;
  /**
   * Phase I: populated only on `merge_conflict`. Lists the touched paths
   * whose main has advanced past the draft's `base_version`, so callers can
   * render a per-path conflict banner without re-querying.
   */
  conflicts?: MergeConflictDetail[];
  /**
   * Phase J: populated only on `accept_blocked`. Number of open threads on
   * the draft at the moment Accept was attempted, so callers can render
   * `<N> threads still open · cannot accept` without re-querying.
   */
  open_count?: number;

  constructor(
    code: SheafErrorCode,
    message: string,
    extras?: { conflicts?: MergeConflictDetail[]; open_count?: number },
  ) {
    super(message);
    this.name = "SheafError";
    this.code = code;
    if (extras?.conflicts) this.conflicts = extras.conflicts;
    if (extras?.open_count !== undefined) this.open_count = extras.open_count;
  }
}

/**
 * Back-compat alias. Existing `import { McpError } from "../errors"` sites
 * keep working while callers migrate to the new name.
 */
export const McpError = SheafError;
export type McpError = SheafError;
export type McpErrorCode = SheafErrorCode;

export const err = {
  docNotFound: (path: string) =>
    new SheafError("doc_not_found", `no doc at ${path}`),
  draftNotFound: (draftId: string) =>
    new SheafError("draft_not_found", `no draft ${draftId}`),
  threadNotFound: (id: string) =>
    new SheafError("thread_not_found", `no thread ${id}`),
  writeToMainForbidden: () =>
    new SheafError(
      "write_to_main_forbidden",
      "writes require a draft ref; call Fork first and pass ref=draft_id",
    ),
  editNoMatch: (path: string) =>
    new SheafError(
      "edit_no_match",
      `old_string not found in ${path}; read the doc first to get exact whitespace/line endings`,
    ),
  editAmbiguous: (path: string, n: number) =>
    new SheafError(
      "edit_ambiguous",
      `old_string matches ${n} times in ${path}; pass replace_all=true, or provide more surrounding context to make it unique`,
    ),
  invalidPath: (path: string) =>
    new SheafError(
      "invalid_path",
      `path must be a repo-root-relative vault path with no '.'-prefixed segment (no dotfiles, no '..'): got ${path}`,
    ),
  invalidRef: (ref: string) =>
    new SheafError(
      "invalid_ref",
      `ref must be "main" or a draft_<uuid>: got ${ref}`,
    ),
  invalidThreadId: (id: string) =>
    new SheafError(
      "invalid_thread_id",
      `thread id must match thrd_<uuid>: got ${id}`,
    ),
  invalidPayload: (reason: string) =>
    new SheafError("invalid_payload", reason),
  outOfScope: (subject: string, scope: string) =>
    new SheafError(
      "out_of_scope",
      `${subject} is outside this connection's doc scope (${scope})`,
    ),
  draftNotSubmitted: (id: string, state: string) =>
    new SheafError(
      "draft_not_submitted",
      `draft ${id} cannot be merged from state=${state}; call Propose first`,
    ),
  draftAlreadySubmitted: (id: string) =>
    new SheafError(
      "draft_already_submitted",
      `draft ${id} is already submitted`,
    ),
  acceptBlocked: (openCount: number): SheafError =>
    new SheafError(
      "accept_blocked",
      `accept blocked: ${openCount} open thread${openCount === 1 ? "" : "s"} on the draft; resolve before accepting`,
      { open_count: openCount },
    ),
  mergeConflict: (
    conflicts: MergeConflictDetail[] | string,
  ): SheafError => {
    if (typeof conflicts === "string") {
      return new SheafError(
        "merge_conflict",
        `conflict merging ${conflicts}; re-fork off latest main and retry`,
      );
    }
    const summary = conflicts
      .map(
        (c) =>
          `${c.path}: main is at v${c.main_version}, draft based on v${c.base_version}`,
      )
      .join("; ");
    return new SheafError(
      "merge_conflict",
      `conflict on ${conflicts.length} path${conflicts.length === 1 ? "" : "s"} (${summary}); re-fork off latest main and retry`,
      { conflicts },
    );
  },
  anchorOrphaned: (threadId: string) =>
    new SheafError(
      "anchor_orphaned",
      `thread ${threadId} anchor no longer resolves against the current doc`,
    ),
  grepTimeout: () =>
    new SheafError(
      "grep_timeout",
      "grep exceeded time budget; tighten the pattern",
    ),
  payloadTooLarge: (field: string, limit: number) =>
    new SheafError("payload_too_large", `${field} exceeds ${limit} byte limit`),
};

/**
 * Map a `SheafErrorCode` to the canonical HTTP status.
 *
 * Single source of truth for UI routes — the previous per-route hand-rolled
 * switch statements had drift (e.g. `doc_not_found` returned 400 in some
 * routes and 404 in others).
 */
export function statusForCode(code: SheafErrorCode): number {
  switch (code) {
    case "doc_not_found":
    case "draft_not_found":
    case "thread_not_found":
      return 404;
    case "invalid_path":
    case "invalid_ref":
    case "invalid_thread_id":
    case "invalid_payload":
    case "edit_no_match":
    case "edit_ambiguous":
    case "payload_too_large":
      return 400;
    case "out_of_scope":
      return 403;
    case "write_to_main_forbidden":
    case "draft_not_submitted":
    case "draft_already_submitted":
    case "merge_conflict":
    case "anchor_orphaned":
      return 409;
    case "accept_blocked":
      return 422;
    case "grep_timeout":
      return 504;
    default: {
      // exhaustiveness guard
      const _exhaustive: never = code;
      void _exhaustive;
      return 500;
    }
  }
}

/**
 * Result of a UI handler that errored: an HTTP status plus the JSON body.
 * Framework-agnostic — both the Next route adapters and the Fastify routes
 * serialize this the same way, so the error shape + status mapping has a
 * single source of truth.
 */
export type ErrorResult = {
  status: number;
  json: {
    error: string;
    code: string;
    conflicts?: MergeConflictDetail[];
    open_count?: number;
  };
};

/**
 * Convert any thrown value into an `{status, json}` error result. Use at the
 * top of every `/api/ui/*` catch block to keep error shape + status mapping
 * consistent across runtimes.
 */
export function errorResult(e: unknown): ErrorResult {
  if (e instanceof SheafError) {
    const json: ErrorResult["json"] = { error: e.message, code: e.code };
    if (e.conflicts) json.conflicts = e.conflicts;
    if (e.open_count !== undefined) json.open_count = e.open_count;
    return { status: statusForCode(e.code), json };
  }
  if (e instanceof Error) {
    console.error("[ui] internal error", e);
  } else {
    console.error("[ui] internal error (non-Error thrown)", e);
  }
  return {
    status: 500,
    json: { error: "internal server error", code: "internal" },
  };
}

/**
 * Build a CallToolResult-compatible error object.
 *
 * MCP tool errors are returned in-band (isError: true) rather than as JSON-RPC
 * errors, so the model can see the error text and self-correct.
 *
 * Non-SheafError exceptions surface as a generic `internal` code with a fixed
 * message — raw `.message` leaks host FS paths (ENOENT stack traces include
 * the full path) and noisy implementation details. SheafError messages are
 * considered curated and safe to pass through.
 */
export function toToolError(e: unknown): {
  content: { type: "text"; text: string }[];
  isError: true;
  structuredContent: { code: string; message: string };
} {
  if (e instanceof SheafError) {
    return {
      content: [{ type: "text", text: `${e.code}: ${e.message}` }],
      isError: true,
      structuredContent: { code: e.code, message: e.message },
    };
  }
  if (e instanceof Error) {
    console.error("[mcp] internal error", e);
  } else {
    console.error("[mcp] internal error (non-Error thrown)", e);
  }
  const safe = "internal server error";
  return {
    content: [{ type: "text", text: `internal: ${safe}` }],
    isError: true,
    structuredContent: { code: "internal", message: safe },
  };
}

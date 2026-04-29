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
  | "draft_not_submitted"
  | "draft_already_submitted"
  | "merge_conflict"
  | "anchor_orphaned"
  | "grep_timeout"
  | "payload_too_large";

/**
 * Thrown by the sheaf backend and tool layer. Surfaces through MCP
 * `toToolError` to agents and through `respondError` to UI route handlers.
 *
 * Previously named `McpError`; kept as an export alias for back-compat while
 * existing imports migrate.
 */
export class SheafError extends Error {
  code: SheafErrorCode;

  constructor(code: SheafErrorCode, message: string) {
    super(message);
    this.name = "SheafError";
    this.code = code;
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
      `path must be repo-root-relative under workspaces/: got ${path}`,
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
  mergeConflict: (path: string) =>
    new SheafError(
      "merge_conflict",
      `conflict merging ${path}; re-fork off latest main and retry`,
    ),
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
    case "write_to_main_forbidden":
    case "draft_not_submitted":
    case "draft_already_submitted":
    case "merge_conflict":
    case "anchor_orphaned":
      return 409;
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
 * Convert any thrown value into a JSON `Response`. Use at the top of every
 * `/api/ui/*` catch block to keep error shape + status mapping consistent.
 */
export function respondError(e: unknown): Response {
  if (e instanceof SheafError) {
    return Response.json(
      { error: e.message, code: e.code },
      { status: statusForCode(e.code) },
    );
  }
  if (e instanceof Error) {
    console.error("[ui] internal error", e);
  } else {
    console.error("[ui] internal error (non-Error thrown)", e);
  }
  return Response.json(
    { error: "internal server error", code: "internal" },
    { status: 500 },
  );
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

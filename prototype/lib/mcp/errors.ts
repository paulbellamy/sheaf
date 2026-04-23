export type McpErrorCode =
  | "doc_not_found"
  | "draft_not_found"
  | "thread_not_found"
  | "write_to_main_forbidden"
  | "edit_no_match"
  | "edit_ambiguous"
  | "invalid_path"
  | "invalid_ref"
  | "invalid_thread_id"
  | "op_conflict";

export class McpError extends Error {
  code: McpErrorCode;

  constructor(code: McpErrorCode, message: string) {
    super(message);
    this.name = "McpError";
    this.code = code;
  }
}

export const err = {
  docNotFound: (path: string) =>
    new McpError("doc_not_found", `no doc at ${path}`),
  draftNotFound: (draftId: string) =>
    new McpError("draft_not_found", `no draft ${draftId}`),
  threadNotFound: (id: string) =>
    new McpError("thread_not_found", `no thread ${id}`),
  writeToMainForbidden: () =>
    new McpError(
      "write_to_main_forbidden",
      "writes require a draft ref; call Fork first and pass ref=draft_id",
    ),
  editNoMatch: (path: string) =>
    new McpError(
      "edit_no_match",
      `old_string not found in ${path}; read the doc first to get exact whitespace/line endings`,
    ),
  editAmbiguous: (path: string, n: number) =>
    new McpError(
      "edit_ambiguous",
      `old_string matches ${n} times in ${path}; pass replace_all=true, or provide more surrounding context to make it unique`,
    ),
  invalidPath: (path: string) =>
    new McpError(
      "invalid_path",
      `path must be repo-root-relative under workspaces/: got ${path}`,
    ),
  invalidRef: (ref: string) =>
    new McpError(
      "invalid_ref",
      `ref must be "main" or a draft_<uuid>: got ${ref}`,
    ),
  invalidThreadId: (id: string) =>
    new McpError(
      "invalid_thread_id",
      `thread id must match thrd_<uuid>: got ${id}`,
    ),
};

/**
 * Build a CallToolResult-compatible error object.
 *
 * MCP tool errors are returned in-band (isError: true) rather than as JSON-RPC
 * errors, so the model can see the error text and self-correct.
 */
export function toToolError(e: unknown): {
  content: { type: "text"; text: string }[];
  isError: true;
  structuredContent: { code: string; message: string };
} {
  if (e instanceof McpError) {
    return {
      content: [{ type: "text", text: `${e.code}: ${e.message}` }],
      isError: true,
      structuredContent: { code: e.code, message: e.message },
    };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return {
    content: [{ type: "text", text: `internal: ${msg}` }],
    isError: true,
    structuredContent: { code: "internal", message: msg },
  };
}

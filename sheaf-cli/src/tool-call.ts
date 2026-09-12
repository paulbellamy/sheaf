/**
 * Helpers for driving the daemon's MCP tool surface from a domain verb.
 *
 * The read verbs (`read`/`grep`/`glob`/`thread list`/`thread show`) and the
 * `--as agent` mutations all reach the backend through `client.mcp().callTool`
 * (docs/sheaf-cli-v0.1.md "Wire protocol"). Two shapes recur across every one of
 * them, so they live here rather than being re-derived per verb:
 *
 *   - {@link callTool} runs a tool and turns an *in-band* tool error into a
 *     {@link CliError}. MCP tool failures are returned as a normal result with
 *     `isError: true` (so an agent can read and self-correct — see the server's
 *     `toToolError`), NOT as a thrown protocol error. A CLI verb wants the
 *     opposite: a failed `Read`/`Grep`/`AddThread` must exit non-zero with the
 *     server's `{code}` preserved, exactly like the REST path's error mapping.
 *   - {@link firstText} pulls the first text content block (the human-readable
 *     rendering the tool already produced) for verbs whose text output is just
 *     "what the tool said".
 *
 * `structuredContent` (the machine-readable payload the tool attaches alongside
 * its text) is read directly by callers that need typed data — it is the raw
 * object a verb emits under `--format json`.
 */
import type { McpSession } from "./client";
import { CliError, EXIT } from "./io";

/**
 * The subset of an MCP `CallToolResult` the verbs read. `content` is the block
 * array (text blocks carry `text`); `structuredContent` is the tool's typed
 * payload; `isError` marks an in-band tool failure.
 */
export interface ToolResult {
  content: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

/**
 * Call an MCP tool and return its result, converting an in-band tool error
 * (`isError: true`) into a {@link CliError} (exit 1) that preserves the server's
 * error `code`. A transport/protocol failure (dead daemon, etc.) is already
 * mapped to a `CliError` by {@link McpSession.callTool} itself.
 */
export async function callTool(
  mcp: McpSession,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const result = (await mcp.callTool(name, args)) as ToolResult;
  if (result.isError) {
    // `toToolError` stamps `structuredContent: { code, message }`; fall back to
    // the first text block, then a generic message, if a tool ever omits it.
    const sc = result.structuredContent as
      | { code?: unknown; message?: unknown }
      | undefined;
    const code = typeof sc?.code === "string" ? sc.code : "tool_error";
    const message =
      typeof sc?.message === "string"
        ? sc.message
        : (firstText(result) ?? `${name} failed`);
    throw new CliError(message, code, EXIT.GENERIC);
  }
  return result;
}

/** The first text content block's text, or `undefined` if the tool sent none. */
export function firstText(result: ToolResult): string | undefined {
  for (const block of result.content ?? []) {
    if (block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return undefined;
}

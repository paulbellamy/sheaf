/**
 * sheaf-server — the shared backend, MCP server, and HTTP API logic.
 *
 * The Fastify app (`buildSheafApp`) lives behind the `sheaf-server/app`
 * subpath so importing this entry never pulls Fastify into a consumer's
 * graph (the Next prototype reuses the handlers/transport cores directly and
 * doesn't want Fastify in its bundle).
 */

// Backend interface, types, and the filesystem-backed implementation.
export * from "./backend/index";
export { StubBackend } from "./backend/stub";
export { getBackend, setBackend } from "./backend/factory";

// MCP server (tool definitions). Transport is supplied per-runtime.
export { buildServer } from "./server";

// Framework-agnostic UI route logic.
export * from "./handlers";

// SSE event-stream core.
export { pipeEvents, reserveSseClient, type SseSink } from "./events";

// Errors and result/status mapping.
export {
  SheafError,
  McpError,
  type SheafErrorCode,
  type McpErrorCode,
  type MergeConflictDetail,
  err,
  statusForCode,
  errorResult,
  type ErrorResult,
  toToolError,
} from "./errors";

// Path validation helpers.
export {
  assertThreadId,
  assertDraftId,
  assertVaultPath,
  assertReadablePath,
  isPluginPath,
  safeJoin,
} from "./paths";

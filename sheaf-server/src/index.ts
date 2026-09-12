/**
 * sheaf-server — the shared backend, MCP server, and HTTP API logic.
 *
 * The Fastify app (`buildSheafApp`) lives behind the `sheaf-server/app`
 * subpath so importing this entry never pulls Fastify into a consumer's graph
 * that only needs the backend, tool, or handler cores.
 */

// Backend interface, types, and the filesystem-backed implementation. The CLI
// constructs its own `StubBackend(vault, vault)` directly — there is no backend
// factory; the daemon owns the one instance per vault.
export * from "./backend/index";
export { StubBackend } from "./backend/stub";

// MCP server (tool definitions). Transport is supplied per-runtime.
export {
  buildServer,
  type BuildServerOptions,
  type ToolSurface,
} from "./server";

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
  safeJoin,
} from "./paths";

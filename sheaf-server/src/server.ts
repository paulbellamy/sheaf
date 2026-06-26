import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Backend } from "./backend/index";
import { getBackend } from "./backend/factory";
import { registerDeclineDraft } from "./tools/decline";
import { registerDraftChanges } from "./tools/draft-changes";
import { registerEdit } from "./tools/edit";
import { registerFork } from "./tools/fork";
import { registerGlob } from "./tools/glob";
import { registerGrep } from "./tools/grep";
import { registerListDocs } from "./tools/list-docs";
import { registerMerge } from "./tools/merge";
import { registerPropose } from "./tools/propose";
import { registerRead } from "./tools/read";
import { registerReadMe } from "./tools/readme";
import { registerThreadTools } from "./tools/threads";
import { registerWorkspaceTools } from "./tools/workspaces";
import { registerWrite } from "./tools/write";

/**
 * Which tool surface to expose.
 *
 * - `"full"` (default) — every tool, including the draft-workflow tools. Used
 *   by the web prototype, which drives the fork/propose/merge flow.
 * - `"thread-only"` — omits the draft-workflow tools (Fork, Propose, Merge,
 *   DeclineDraft, DraftChanges). Used by the Obsidian plugin, which runs in
 *   thread-on-doc mode and never touches drafts. The draft tools stay in the
 *   backend (the prototype needs them); they're just not registered here.
 */
export type ToolSurface = "full" | "thread-only";

export interface BuildServerOptions {
  tools?: ToolSurface;
  /**
   * Clamp the thread tools to a single doc path (a per-connection scope). When
   * set, `ListThreads` only returns that doc's threads and the id-keyed thread
   * tools reject threads that don't target it. Undefined (default) = no scope,
   * global behavior unchanged. See docs/sheaf-acp-v0.1.md §3.1.
   */
  docScope?: string;
}

/**
 * Build an MCP server instance with sheaf tools registered.
 *
 * Factory because the Streamable HTTP transport creates a fresh server per
 * request in stateless mode. The Backend itself is module-scoped and shared
 * across requests (see getBackend() in backend/factory.ts).
 *
 * `opts.tools` selects the tool surface (see {@link ToolSurface}); it defaults
 * to `"full"` so existing callers (`buildServer()`) are unchanged.
 */
export function buildServer(
  backend: Backend = getBackend(),
  opts: BuildServerOptions = {},
): McpServer {
  const { tools = "full", docScope } = opts;
  const server = new McpServer(
    {
      name: "sheaf",
      version: "0.1.0",
    },
    {
      capabilities: { tools: { listChanged: false } },
      instructions:
        "Call `ReadMe` before anything else. It's a single tool call that returns the full operating guide — the loop, the tools to use, and how to subscribe to live events. Everything else flows from there.",
    },
  );

  registerReadMe(server);
  registerRead(server, backend);
  registerWrite(server, backend);
  registerEdit(server, backend);
  registerGlob(server, backend);
  registerGrep(server, backend);
  if (tools !== "thread-only") {
    registerFork(server, backend);
    registerPropose(server, backend);
    registerMerge(server, backend);
    registerDeclineDraft(server, backend);
    registerDraftChanges(server, backend);
  }
  registerListDocs(server, backend);
  registerWorkspaceTools(server, backend);
  registerThreadTools(server, backend, docScope);

  return server;
}

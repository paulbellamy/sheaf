import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Backend } from "./backend/index";
import { registerEdit } from "./tools/edit";
import { registerGlob } from "./tools/glob";
import { registerGrep } from "./tools/grep";
import { registerListDocs } from "./tools/list-docs";
import { registerRead } from "./tools/read";
import { registerReadMe } from "./tools/readme";
import { registerThreadTools } from "./tools/threads";
import { registerWorkspaceTools } from "./tools/workspaces";
import { registerWrite } from "./tools/write";

export interface BuildServerOptions {
  /**
   * Clamp the thread tools to a single doc path (a per-connection scope). When
   * set, `ListThreads` only returns that doc's threads and the id-keyed thread
   * tools reject threads that don't target it. Undefined (default) = no scope,
   * global behavior unchanged. See docs/sheaf-acp-v0.1.md §3.1.
   */
  docScope?: string;
  /**
   * The server's real, reachable origin (`http://host:port`), interpolated into
   * the ReadMe's raw-curl event-loop fallback so it points at the actual daemon
   * rather than a guessed port. `sheaf serve` threads its bound address through
   * `buildSheafApp`; the standalone `sheaf mcp --no-daemon` bridge omits it, and
   * the ReadMe falls back to a sensible default. See `tools/readme.ts`.
   */
  publicUrl?: string;
  /**
   * Set by `sheaf mcp --no-daemon`: this server is a lone in-process backend
   * with no daemon and no cross-process event stream, so the ReadMe replaces its
   * "Subscribe to events" section with a poll-`ListThreads` note rather than
   * pointing the agent at `sheaf events follow` / a curl loop that can't work
   * here. See `tools/readme.ts`.
   */
  standalone?: boolean;
}

/**
 * Build an MCP server instance with sheaf tools registered.
 *
 * A factory because the Streamable HTTP transport creates a fresh server per
 * request in stateless mode. The caller supplies the `backend`, which is shared
 * across those per-request servers so on-disk (and in-memory) state carries
 * across requests.
 */
export function buildServer(
  backend: Backend,
  opts: BuildServerOptions = {},
): McpServer {
  const { docScope, publicUrl, standalone } = opts;
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

  registerReadMe(server, { publicUrl, standalone });
  registerRead(server, backend);
  registerWrite(server, backend);
  registerEdit(server, backend);
  registerGlob(server, backend);
  registerGrep(server, backend);
  registerListDocs(server, backend);
  registerWorkspaceTools(server, backend);
  registerThreadTools(server, backend, docScope);

  return server;
}

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
import { registerThreadTools } from "./tools/threads";
import { registerWorkspaceTools } from "./tools/workspaces";
import { registerWrite } from "./tools/write";

/**
 * Build an MCP server instance with all sheaf tools registered.
 *
 * Factory because the Streamable HTTP transport creates a fresh server per
 * request in stateless mode. The Backend itself is module-scoped and shared
 * across requests (see getBackend() in backend/factory.ts).
 */
export function buildServer(backend: Backend = getBackend()): McpServer {
  const server = new McpServer(
    {
      name: "sheaf",
      version: "0.1.0",
    },
    {
      capabilities: { tools: { listChanged: false } },
      instructions:
        "Sheaf is a collaborative spec-editing system. Docs live at repo-relative paths under 'workspaces/'. Bundled skills and scripts are served read-only under '.claude-plugin/' via Read/Glob/Grep. Before anything else, run `Glob .claude-plugin/skills/**/SKILL.md` and `Read` each result — in particular `.claude-plugin/skills/sheaf-event-watcher/SKILL.md`, which tells you how to stay reactive to thread submissions and draft/doc changes while idle. Two mutation modes: (a) draft flow — call Fork(path, n) to create a draft, pass the draft_id as `ref` on Write/Edit, finalize with Propose; (b) thread-on-doc — write directly to ref='main' (the Obsidian-plugin prototype mode), threads attach to the doc without a draft. Threads anchor conversations (and optional sub-drafts) to char ranges in docs.",
    },
  );

  registerRead(server, backend);
  registerWrite(server, backend);
  registerEdit(server, backend);
  registerGlob(server, backend);
  registerGrep(server, backend);
  registerFork(server, backend);
  registerPropose(server, backend);
  registerMerge(server, backend);
  registerDeclineDraft(server, backend);
  registerDraftChanges(server, backend);
  registerListDocs(server, backend);
  registerWorkspaceTools(server, backend);
  registerThreadTools(server, backend);

  return server;
}

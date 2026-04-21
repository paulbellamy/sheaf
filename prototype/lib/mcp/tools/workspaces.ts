import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Backend } from "../backend/index";
import { pathArg } from "../schemas";
import { toToolError } from "../errors";

/**
 * Discovery tools: list available workspaces and active drafts.
 */
export function registerWorkspaceTools(
  server: McpServer,
  backend: Backend,
): void {
  server.registerTool(
    "ListWorkspaces",
    {
      title: "ListWorkspaces",
      description: "List the sheaf workspaces available to the agent.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const ws = await backend.listWorkspaces();
        return {
          content: [
            {
              type: "text",
              text: ws.length
                ? ws.map((w) => `${w.name}  (${w.path})`).join("\n")
                : "(no workspaces)",
            },
          ],
          structuredContent: { workspaces: ws },
        };
      } catch (e) {
        return toToolError(e);
      }
    },
  );

  server.registerTool(
    "ListDrafts",
    {
      title: "ListDrafts",
      description:
        "List active drafts (own + submitted for review). Optionally filter by doc path.",
      inputSchema: {
        path: pathArg.optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path: p }) => {
      try {
        const drafts = await backend.listDrafts(p);
        const text = drafts
          .map(
            (d) =>
              `${d.draft_id}  ${d.state.padEnd(10)} ${d.base_path}  by ${d.author}${d.name ? ` — ${d.name}` : ""}`,
          )
          .join("\n");
        return {
          content: [
            { type: "text", text: drafts.length ? text : "(no drafts)" },
          ],
          structuredContent: { drafts },
        };
      } catch (e) {
        return toToolError(e);
      }
    },
  );
}

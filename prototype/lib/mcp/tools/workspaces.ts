import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Backend } from "../backend/index";
import { pathArg } from "../schemas";
import { toToolError } from "../errors";

/**
 * Discovery tool: list active drafts. (Docs are discovered via ListDocs /
 * Glob / Grep; there is no workspace concept — any visible vault doc counts.)
 */
export function registerWorkspaceTools(
  server: McpServer,
  backend: Backend,
): void {
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

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Backend } from "../backend/index";
import { toToolError } from "../errors";

/**
 * ListDocs — mirrors the UI `/api/ui/docs` surface so agents can enumerate
 * docs by workspace without pattern-matching `workspaces/<ws>/**\/*.md`.
 *
 * Returned items include the `workspace` name so callers can filter/group
 * without re-parsing the path.
 */
export function registerListDocs(server: McpServer, backend: Backend): void {
  server.registerTool(
    "ListDocs",
    {
      title: "ListDocs",
      description:
        "List docs on main, optionally filtered to one workspace. Each item includes path, title, workspace, updated_at.",
      inputSchema: {
        workspace: z
          .string()
          .regex(/^[A-Za-z0-9._-]{1,64}$/)
          .optional()
          .describe("Optional workspace name to filter to."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ workspace }) => {
      try {
        const workspaces = await backend.listWorkspaces();
        const targets = workspace
          ? workspaces.filter((w) => w.name === workspace)
          : workspaces;
        const docs: {
          path: string;
          title: string;
          workspace: string;
          updated_at: number;
        }[] = [];
        for (const ws of targets) {
          const wsDocs = await backend.listDocs(ws.name);
          for (const d of wsDocs) {
            docs.push({
              path: d.path,
              title: d.title,
              workspace: ws.name,
              updated_at: d.updated_at,
            });
          }
        }
        docs.sort((a, b) => a.path.localeCompare(b.path));
        const text = docs
          .map((d) => `${d.path}  (${d.workspace}) — ${d.title}`)
          .join("\n");
        return {
          content: [
            { type: "text", text: docs.length ? text : "(no docs)" },
          ],
          structuredContent: { docs },
        };
      } catch (e) {
        return toToolError(e);
      }
    },
  );
}

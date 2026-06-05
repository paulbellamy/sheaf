import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Backend } from "../backend/index";
import { toToolError } from "../errors";

/**
 * ListDocs — mirrors the UI `/api/ui/docs` surface so agents can enumerate
 * docs without pattern-matching `**\/*.md`.
 *
 * Returned items include a `folder` label (the doc's top-level folder, or
 * "(root)") so callers can group without re-parsing the path.
 */
function folderOf(p: string): string {
  return p.includes("/") ? p.slice(0, p.indexOf("/")) : "(root)";
}

export function registerListDocs(server: McpServer, backend: Backend): void {
  server.registerTool(
    "ListDocs",
    {
      title: "ListDocs",
      description:
        "List docs on main, optionally filtered to a path prefix. Each item includes path, title, folder, updated_at.",
      inputSchema: {
        prefix: z
          .string()
          .max(256)
          .optional()
          .describe("Optional repo-root-relative path prefix to filter to, e.g. 'notes/'."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ prefix }) => {
      try {
        const found = await backend.listDocs(prefix);
        const docs = found.map((d) => ({
          path: d.path,
          title: d.title,
          folder: folderOf(d.path),
          updated_at: d.updated_at,
        }));
        const text = docs
          .map((d) => `${d.path}  (${d.folder}) — ${d.title}`)
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

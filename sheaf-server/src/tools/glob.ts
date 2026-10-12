import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Backend } from "../backend/index";
import { toToolError } from "../errors";

/**
 * Glob — mirrors Claude Code's Glob. Matches doc paths anywhere in the vault,
 * e.g. **\/*.md. Threads are surfaced via ListThreads / ReadThread, not Glob.
 */
export function registerGlob(server: McpServer, backend: Backend): void {
  server.registerTool(
    "Glob",
    {
      title: "Glob",
      description:
        "Find sheaf docs by glob pattern, e.g. '**/*.md' or 'notes/**/*.md'.",
      inputSchema: {
        pattern: z
          .string()
          .describe("Glob pattern. Supports *, ?, and ** segments."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ pattern }) => {
      try {
        const results = await backend.glob(pattern);
        const text = results
          .map((d) => `${d.path}  —  ${d.title}`)
          .join("\n");
        return {
          content: [
            {
              type: "text",
              text: results.length ? text : "(no matches)",
            },
          ],
          structuredContent: { matches: results },
        };
      } catch (e) {
        return toToolError(e);
      }
    },
  );
}

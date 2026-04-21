import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Backend } from "../backend/index";
import { refOptionalArg } from "../schemas";
import { toToolError } from "../errors";

/**
 * Glob — mirrors Claude Code's Glob. Matches paths inside the sheaf repo
 * (workspaces/**.md + thread sidecars).
 */
export function registerGlob(server: McpServer, backend: Backend): void {
  server.registerTool(
    "Glob",
    {
      title: "Glob",
      description:
        "Find sheaf docs by glob pattern, e.g. 'workspaces/**/*.md'. Pass ref to glob inside a draft (draft file overrides take precedence over main).",
      inputSchema: {
        pattern: z
          .string()
          .describe("Glob pattern. Supports *, ?, and ** segments."),
        ref: refOptionalArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ pattern, ref }) => {
      try {
        const results = await backend.glob(pattern, ref);
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

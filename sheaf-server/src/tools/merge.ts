import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Backend } from "../backend/index";
import { draftIdArg } from "../schemas";
import { toToolError } from "../errors";

/**
 * Merge — accept a draft onto main.
 *
 * Usually human-gated; exposed for automation cases. Real backend runs
 * case-2 sync (design §4.2) before committing.
 */
export function registerMerge(server: McpServer, backend: Backend): void {
  server.registerTool(
    "Merge",
    {
      title: "Merge",
      description:
        "Accept a draft onto main. This is typically human-gated; use sparingly from automation.",
      inputSchema: {
        draft_id: draftIdArg,
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async ({ draft_id }) => {
      try {
        const result = await backend.merge(draft_id);
        return {
          content: [
            {
              type: "text",
              text: `merged ${draft_id}  commit=${result.commit}`,
            },
          ],
          structuredContent: { draft_id, ...result },
        };
      } catch (e) {
        return toToolError(e);
      }
    },
  );
}

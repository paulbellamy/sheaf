import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Backend } from "../backend/index";
import { draftIdArg } from "../schemas";
import { toToolError } from "../errors";

/**
 * Propose — finalize a draft into the review queue.
 *
 * After Propose the draft is visible to human reviewers with `state=submitted`.
 * Merging it is a separate step (usually human-gated).
 */
export function registerPropose(server: McpServer, backend: Backend): void {
  server.registerTool(
    "Propose",
    {
      title: "Propose",
      description:
        "Finalize a draft so reviewers can see it. Draft state transitions to 'submitted'. Does not merge to main — use Merge for that.",
      inputSchema: {
        draft_id: draftIdArg,
        note: z
          .string()
          .optional()
          .describe(
            "Cover note for reviewers explaining the draft's intent and any context they'll need.",
          ),
        draft_name: z
          .string()
          .optional()
          .describe("Human-friendly name shown in the review queue."),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ draft_id, note, draft_name }) => {
      try {
        const result = await backend.propose(draft_id, note, draft_name);
        return {
          content: [
            {
              type: "text",
              text: `proposed ${draft_id}  →  ${result.diff_url}`,
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

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Backend } from "../backend/index";
import { draftIdArg } from "../schemas";
import { toToolError } from "../errors";

/**
 * DeclineDraft — close a draft as declined without merging.
 *
 * Mirrors the UI decline button so agents can clean up their own drafts
 * or (in multi-agent flows) decline peer drafts. Irreversible in the
 * prototype; the real backend may allow re-opening.
 */
export function registerDeclineDraft(server: McpServer, backend: Backend): void {
  server.registerTool(
    "DeclineDraft",
    {
      title: "DeclineDraft",
      description:
        "Close a draft as declined. Does not merge to main. Safe to call on a draft the agent owns; peer drafts require review conventions outside the tool layer.",
      inputSchema: {
        draft_id: draftIdArg,
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async ({ draft_id }) => {
      try {
        await backend.declineDraft(draft_id);
        return {
          content: [{ type: "text", text: `declined ${draft_id}` }],
          structuredContent: { draft_id, state: "declined" },
        };
      } catch (e) {
        return toToolError(e);
      }
    },
  );
}

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Backend } from "../backend/index";
import { authorArg, draftIdArg, intentArg, pathArg } from "../schemas";
import { toToolError } from "../errors";

/**
 * Fork — the sheaf primitive for "try N drafts of this doc in parallel."
 * Returns n draft ids; agent then calls Read/Write/Edit with ref=<draft_id>.
 */
export function registerFork(server: McpServer, backend: Backend): void {
  server.registerTool(
    "Fork",
    {
      title: "Fork",
      description:
        "Create one or more draft branches of a doc. Without `parent`, branches off main. With `parent` set to an existing draft id, creates sub-drafts that branch off the parent's current draft content (used for multi-option exploration on a thread). Returns draft ids to pass as `ref` on subsequent Read/Write/Edit/Propose calls. Use n>1 to produce parallel variants for the reviewer to pick between.",
      inputSchema: {
        path: pathArg,
        n: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .default(1)
          .describe("How many parallel drafts to create."),
        intent: intentArg.describe(
          "Optional natural-language intent for the draft; persisted with the draft for reviewer context. Editable at Propose time.",
        ),
        author: authorArg,
        parent: draftIdArg
          .optional()
          .describe(
            "Optional parent draft id. When set, the new drafts are sub-drafts that branch off the parent's current content (Phase G). When omitted, drafts branch off main. `path` must equal the parent's `base_path`.",
          ),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ path: p, n, intent, author, parent }) => {
      try {
        const ids = await backend.fork(p, n ?? 1, intent, author, parent);
        return {
          content: [
            {
              type: "text",
              text: `created ${ids.length} draft${ids.length === 1 ? "" : "s"}:\n${ids.join("\n")}`,
            },
          ],
          structuredContent: { draft_ids: ids },
        };
      } catch (e) {
        return toToolError(e);
      }
    },
  );
}

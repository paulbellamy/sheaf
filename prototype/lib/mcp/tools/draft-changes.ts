import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Backend } from "../backend/index";
import { draftIdArg } from "../schemas";
import { toToolError, err } from "../errors";

/**
 * DraftChanges — returns the diff payload the /review UI uses so an agent
 * reviewing a peer draft can fetch everything in one round-trip instead of
 * `ListDrafts` + `N * 2` Read calls.
 */
export function registerDraftChanges(server: McpServer, backend: Backend): void {
  server.registerTool(
    "DraftChanges",
    {
      title: "DraftChanges",
      description:
        "Return a draft's metadata plus the pairs of (main markdown, draft markdown) for every doc changed in the draft. Useful for reviewing peer drafts without chasing individual Read calls.",
      inputSchema: {
        draft_id: draftIdArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ draft_id }) => {
      try {
        const drafts = await backend.listDrafts();
        const meta = drafts.find((d) => d.draft_id === draft_id);
        if (!meta) throw err.draftNotFound(draft_id);
        const changes = await backend.draftChanges(draft_id);
        const summary = changes.length
          ? changes
              .map(
                (c) =>
                  `${c.path}  (${c.main_md.length}B main, ${c.draft_md.length}B draft)`,
              )
              .join("\n")
          : "(no changes)";
        return {
          content: [
            {
              type: "text",
              text: `${draft_id}  state=${meta.state}\n${summary}`,
            },
          ],
          structuredContent: { draft: meta, changes },
        };
      } catch (e) {
        return toToolError(e);
      }
    },
  );
}

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Backend } from "../backend/index";
import { LIMITS, opIdArg, pathArg, refArg } from "../schemas";
import { toToolError } from "../errors";

/**
 * Edit — mirrors Claude Code's Edit. Exact-string replace on a draft ref.
 */
export function registerEdit(server: McpServer, backend: Backend): void {
  server.registerTool(
    "Edit",
    {
      title: "Edit",
      description:
        "Exact-string replace in a sheaf doc on a draft ref. old_string must occur exactly once unless replace_all is true. Errors when the match is missing or ambiguous so you can read the doc and retry.",
      inputSchema: {
        file_path: pathArg,
        old_string: z
          .string()
          .max(LIMITS.content)
          .describe("Text to replace (must match exactly)."),
        new_string: z
          .string()
          .max(LIMITS.content)
          .describe("Replacement text (must differ from old_string)."),
        replace_all: z
          .boolean()
          .optional()
          .default(false)
          .describe("Replace every occurrence instead of requiring unique match."),
        ref: refArg,
        op_id: opIdArg,
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async ({ file_path, old_string, new_string, replace_all, ref, op_id }) => {
      try {
        if (old_string === new_string) {
          return {
            content: [
              {
                type: "text",
                text: "old_string and new_string are identical; nothing to do.",
              },
            ],
            isError: true,
          };
        }
        const result = await backend.editDoc(
          file_path,
          ref,
          old_string,
          new_string,
          !!replace_all,
          op_id,
        );
        return {
          content: [
            {
              type: "text",
              text: `edited ${file_path} @ ${ref}  version=${result.version}`,
            },
          ],
          structuredContent: result,
        };
      } catch (e) {
        return toToolError(e);
      }
    },
  );
}

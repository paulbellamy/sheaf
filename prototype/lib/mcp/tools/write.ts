import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Backend } from "../backend/index";
import { contentArg, opIdArg, pathArg, refArg } from "../schemas";
import { toToolError } from "../errors";

/**
 * Write — mirrors Claude Code's Write. Full-doc rewrite on a draft ref.
 * Writing to main is rejected; Fork first to obtain a draft id.
 */
export function registerWrite(server: McpServer, backend: Backend): void {
  server.registerTool(
    "Write",
    {
      title: "Write",
      description:
        "Overwrite a sheaf doc's full markdown on a draft ref. Writing to main is rejected — call Fork first and pass the returned draft_id as ref.",
      inputSchema: {
        file_path: pathArg,
        content: contentArg,
        ref: refArg,
        op_id: opIdArg,
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async ({ file_path, content, ref, op_id }) => {
      try {
        const result = await backend.writeDoc(file_path, ref, content, op_id);
        return {
          content: [
            {
              type: "text",
              text: `wrote ${file_path} @ ${ref}  version=${result.version}`,
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

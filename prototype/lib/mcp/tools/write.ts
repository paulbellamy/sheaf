import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Backend } from "../backend/index";
import { contentArg, opIdArg, pathArg, refArg } from "../schemas";
import { toToolError } from "../errors";

/**
 * Write — mirrors Claude Code's Write. Full-doc rewrite. Pass a draft ref for
 * the standard fork-propose-merge flow; pass ref="main" (or omit) to land the
 * edit directly on the doc (thread-on-doc prototype mode).
 */
export function registerWrite(server: McpServer, backend: Backend): void {
  server.registerTool(
    "Write",
    {
      title: "Write",
      description:
        "Overwrite a sheaf doc's full markdown. Pass a draft_id as `ref` to write to a draft; omit `ref` (or pass 'main') to land the edit directly on the doc and emit `doc_changed`.",
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
              text: `wrote ${file_path} @ ${ref}  version_token=${result.version_token}`,
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

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Backend } from "../backend/index";
import { contentArg, opIdArg, pathArg } from "../schemas";
import { toToolError } from "../errors";

/**
 * Write — mirrors Claude Code's Write. Full-doc rewrite landed directly on the
 * doc; emits `doc_changed`.
 */
export function registerWrite(server: McpServer, backend: Backend): void {
  server.registerTool(
    "Write",
    {
      title: "Write",
      description:
        "Overwrite a sheaf doc's full markdown. Lands the edit directly on the doc and emits `doc_changed`.",
      inputSchema: {
        file_path: pathArg,
        content: contentArg,
        op_id: opIdArg,
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async ({ file_path, content, op_id }) => {
      try {
        await backend.writeDoc(file_path, content, op_id, "agent");
        return {
          content: [{ type: "text", text: `wrote ${file_path}` }],
        };
      } catch (e) {
        return toToolError(e);
      }
    },
  );
}

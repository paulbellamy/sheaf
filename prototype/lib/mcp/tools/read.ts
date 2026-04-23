import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Backend } from "../backend/index";
import { pathArg, refOptionalArg } from "../schemas";
import { toToolError } from "../errors";

/**
 * Read — mirrors Claude Code's Read for sheaf docs.
 *
 * `ref` selects main or a draft. Threads are not exposed through Read;
 * use ListThreads / ReadThread.
 */
export function registerRead(server: McpServer, backend: Backend): void {
  server.registerTool(
    "Read",
    {
      title: "Read",
      description:
        "Read a sheaf doc's markdown. Pass ref to read from a draft; omit for main.",
      inputSchema: {
        file_path: pathArg,
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("1-based starting line number."),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Max lines to return."),
        ref: refOptionalArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ file_path, offset, limit, ref }) => {
      try {
        const { md, version, origin } = await backend.readDoc(file_path, ref);
        return {
          content: [
            { type: "text", text: sliceText(md, offset, limit) },
            {
              type: "text",
              text: `\n--\nref: ${ref ?? "main"}  version: ${version}  origin: ${origin}`,
            },
          ],
        };
      } catch (e) {
        return toToolError(e);
      }
    },
  );
}

function sliceText(text: string, offset?: number, limit?: number): string {
  if (offset === undefined && limit === undefined) return text;
  const lines = text.split("\n");
  const start = offset ? Math.max(0, offset - 1) : 0;
  const end = limit ? Math.min(lines.length, start + limit) : lines.length;
  return lines.slice(start, end).join("\n");
}

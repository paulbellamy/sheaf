import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import * as yaml from "yaml";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { Backend } from "../backend/index";
import { pathArg, refOptionalArg } from "../schemas";
import { toToolError } from "../errors";

/**
 * Read — mirrors Claude Code's Read for sheaf docs.
 *
 * Extra: `ref` selects main or a draft. Thread sidecar yaml files are readable
 * directly so agents can inspect threads as plain text if they want.
 */
export function registerRead(server: McpServer, backend: Backend): void {
  server.registerTool(
    "Read",
    {
      title: "Read",
      description:
        "Read a sheaf doc's markdown, or a thread sidecar yaml file. Pass ref to read from a draft; omit for main.",
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
        if (file_path.includes(".threads/") && file_path.endsWith(".yaml")) {
          const root =
            process.env.SHEAF_DATA_ROOT ?? path.join(process.cwd(), "data");
          const abs = path.join(root, file_path);
          const raw = await fs.readFile(abs, "utf8");
          yaml.parse(raw);
          return {
            content: [{ type: "text", text: sliceText(raw, offset, limit) }],
          };
        }
        const { md, ycrdt_version, head_commit } = await backend.readDoc(
          file_path,
          ref,
        );
        return {
          content: [
            { type: "text", text: sliceText(md, offset, limit) },
            {
              type: "text",
              text: `\n--\nref: ${ref ?? "main"}  version: ${ycrdt_version}  commit: ${head_commit}`,
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

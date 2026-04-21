import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Backend } from "../backend/index";
import { pathArg, refOptionalArg } from "../schemas";
import { toToolError } from "../errors";

/**
 * Grep — mirrors Claude Code's Grep (ripgrep-shaped) for sheaf doc content.
 */
export function registerGrep(server: McpServer, backend: Backend): void {
  server.registerTool(
    "Grep",
    {
      title: "Grep",
      description:
        "Search sheaf doc content with a regex. Output modes match Claude Code's Grep: files_with_matches (default), content, or count.",
      inputSchema: {
        pattern: z.string().describe("Regular expression."),
        path: pathArg.optional().describe("Limit to a single doc."),
        glob: z
          .string()
          .optional()
          .describe("Limit to paths matching this glob."),
        output_mode: z
          .enum(["content", "files_with_matches", "count"])
          .optional()
          .default("files_with_matches"),
        "-i": z
          .boolean()
          .optional()
          .describe("Case-insensitive match."),
        "-n": z
          .boolean()
          .optional()
          .describe("Show line numbers (content mode)."),
        "-A": z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Lines of context after each match."),
        "-B": z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Lines of context before each match."),
        "-C": z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Alias for -A and -B."),
        multiline: z.boolean().optional(),
        head_limit: z.number().int().min(1).optional(),
        ref: refOptionalArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const context = args["-C"];
        const result = await backend.grep({
          pattern: args.pattern,
          path: args.path,
          glob: args.glob,
          output_mode: args.output_mode,
          case_insensitive: args["-i"],
          show_line_numbers: args["-n"],
          before_context: args["-B"] ?? context,
          after_context: args["-A"] ?? context,
          multiline: args.multiline,
          head_limit: args.head_limit,
          ref: args.ref,
        });
        return {
          content: [{ type: "text", text: formatGrep(result, !!args["-n"]) }],
          structuredContent: result,
        };
      } catch (e) {
        return toToolError(e);
      }
    },
  );
}

function formatGrep(
  result: Awaited<ReturnType<Backend["grep"]>>,
  showLineNumbers: boolean,
): string {
  if (result.mode === "files_with_matches") {
    return result.paths.length ? result.paths.join("\n") : "(no matches)";
  }
  if (result.mode === "count") {
    return result.counts.length
      ? result.counts.map((c) => `${c.path}:${c.count}`).join("\n")
      : "(no matches)";
  }
  return result.matches.length
    ? result.matches
        .map((m) => {
          const head = showLineNumbers
            ? `${m.path}:${m.line}:${m.text}`
            : `${m.path}:${m.text}`;
          const before = m.before?.length
            ? m.before.map((l) => `  ${l}`).join("\n") + "\n"
            : "";
          const after = m.after?.length
            ? "\n" + m.after.map((l) => `  ${l}`).join("\n")
            : "";
          return `${before}${head}${after}`;
        })
        .join("\n--\n")
    : "(no matches)";
}

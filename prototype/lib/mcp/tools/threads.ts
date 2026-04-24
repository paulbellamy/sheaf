import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Backend } from "../backend/index";
import {
  anchorSchema,
  authorArg,
  messageArg,
  pathArg,
  refOptionalArg,
  threadDraftSchema,
  threadIdArg,
} from "../schemas";
import { toToolError } from "../errors";

/**
 * Thread tools. Threads are first-class in sheaf: conversation + optional
 * attached drafts, anchored to char ranges in one or more docs. The server
 * computes `rel_pos` and `content_hash` from the submitted char_range.
 */
export function registerThreadTools(
  server: McpServer,
  backend: Backend,
): void {
  server.registerTool(
    "ListThreads",
    {
      title: "ListThreads",
      description:
        "List thread summaries. Filter by doc path or by a specific thread id.",
      inputSchema: {
        path: pathArg.optional(),
        thread_id: threadIdArg.optional(),
        ref: refOptionalArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path: p, thread_id, ref }) => {
      try {
        const threads = await backend.listThreads({
          path: p,
          thread_id,
          ref,
        });
        const text = threads
          .map(
            (t) =>
              `${t.id}  ${t.status.padEnd(8)} ${t.target_paths.join(", ")}  (${t.message_count} msg) — ${t.last_message_preview}`,
          )
          .join("\n");
        return {
          content: [
            {
              type: "text",
              text: threads.length ? text : "(no threads)",
            },
          ],
          structuredContent: { threads },
        };
      } catch (e) {
        return toToolError(e);
      }
    },
  );

  server.registerTool(
    "ReadThread",
    {
      title: "ReadThread",
      description:
        "Read a thread's full content: messages, targets, anchors, and any attached drafts.",
      inputSchema: { thread_id: threadIdArg },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ thread_id }) => {
      try {
        const thread = await backend.readThread(thread_id);
        return {
          content: [
            { type: "text", text: formatThread(thread) },
          ],
          structuredContent: thread,
        };
      } catch (e) {
        return toToolError(e);
      }
    },
  );

  server.registerTool(
    "AddThread",
    {
      title: "AddThread",
      description:
        "Start a new thread anchored to char ranges in one or more docs. Optionally attach a draft (counter-proposal).",
      inputSchema: {
        targets: z
          .array(anchorSchema)
          .min(1)
          .max(16)
          .describe("Target anchors — one per affected doc."),
        message: messageArg.describe("First message in the thread."),
        author: authorArg,
        draft: threadDraftSchema.optional(),
        ref: refOptionalArg,
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ targets, message, author, draft, ref }) => {
      try {
        const id = await backend.addThread({
          targets,
          message,
          author,
          draft,
          ref,
        });
        return {
          content: [{ type: "text", text: `created thread ${id}` }],
          structuredContent: { thread_id: id },
        };
      } catch (e) {
        return toToolError(e);
      }
    },
  );

  server.registerTool(
    "ReplyThread",
    {
      title: "ReplyThread",
      description:
        "Append a message to an existing thread. Optionally attach a draft as a counter-proposal / sub-draft.",
      inputSchema: {
        thread_id: threadIdArg,
        message: messageArg,
        author: authorArg,
        draft: threadDraftSchema.optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ thread_id, message, author, draft }) => {
      try {
        await backend.replyThread(thread_id, message, { author, draft });
        return {
          content: [{ type: "text", text: `replied on ${thread_id}` }],
          structuredContent: { thread_id },
        };
      } catch (e) {
        return toToolError(e);
      }
    },
  );

  server.registerTool(
    "ResolveThread",
    {
      title: "ResolveThread",
      description: "Mark a thread as accepted (closes the conversation).",
      inputSchema: { thread_id: threadIdArg },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ thread_id }) => {
      try {
        await backend.resolveThread(thread_id);
        return {
          content: [{ type: "text", text: `resolved ${thread_id}` }],
          structuredContent: { thread_id },
        };
      } catch (e) {
        return toToolError(e);
      }
    },
  );
}

function formatThread(
  thread: Awaited<ReturnType<Backend["readThread"]>>,
): string {
  const lines: string[] = [];
  lines.push(`${thread.id}  [${thread.status}]  ${fmtTs(thread.created)}`);
  lines.push("targets:");
  for (const t of thread.targets) {
    lines.push(
      `  ${t.path}  "${t.anchor.anchored_text.slice(0, 60)}${t.anchor.anchored_text.length > 60 ? "…" : ""}"`,
    );
  }
  lines.push("messages:");
  for (const m of thread.messages) {
    lines.push(`  [${fmtTs(m.ts)}] ${m.author}: ${m.body}`);
    if (m.draft) {
      lines.push(
        `    draft: ${m.draft.new_md.slice(0, 80)}${m.draft.new_md.length > 80 ? "…" : ""}`,
      );
    }
  }
  return lines.join("\n");
}

function fmtTs(ts: number): string {
  return new Date(ts).toISOString();
}

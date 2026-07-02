import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Backend } from "../backend/index";
import {
  anchorSchema,
  authorArg,
  messageArg,
  pathArg,
  refOptionalArg,
  threadDraftOptionSchema,
  threadDraftSchema,
  threadIdArg,
} from "../schemas";
import { err, toToolError } from "../errors";

/**
 * When the connection is scoped to a doc, throw unless `threadId` targets it.
 * A multi-target (cross-cutting) thread matches if ANY of its targets is the
 * scope doc — the same membership rule `ListThreads` uses. No scope => no-op.
 * Propagates `thread_not_found` if the id doesn't exist.
 */
async function assertThreadInScope(
  backend: Backend,
  threadId: string,
  docScope: string | undefined,
): Promise<void> {
  if (!docScope) return;
  const thread = await backend.readThread(threadId);
  if (!thread.targets.some((t) => t.path === docScope)) {
    throw err.outOfScope(`thread ${threadId}`, docScope);
  }
}

/**
 * Thread tools. Threads are first-class in sheaf: conversation + optional
 * attached drafts, anchored to char ranges in one or more docs. The server
 * computes `rel_pos` and `content_hash` from the submitted char_range.
 *
 * `docScope`, when set, clamps every thread tool to a single doc (a
 * per-connection scope; see docs/sheaf-acp-v0.1.md §3.1): `ListThreads` is
 * forced to that path, and the id-keyed tools reject threads that don't target
 * it. Undefined leaves the global behavior untouched.
 */
export function registerThreadTools(
  server: McpServer,
  backend: Backend,
  docScope?: string,
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
          // Scoped connections are clamped to their doc — a wider `path` from
          // the agent is ignored so the queue can't leak other docs' threads.
          path: docScope ?? p,
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
        if (docScope && !thread.targets.some((t) => t.path === docScope)) {
          throw err.outOfScope(`thread ${thread_id}`, docScope);
        }
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
    "ReadThreads",
    {
      title: "ReadThreads",
      description:
        "Read the full content (messages, targets, anchors, attached drafts) of every thread on a doc in one call — the batch form of ReadThread. Prefer this over ListThreads followed by a ReadThread per id when you want a doc's whole queue.",
      inputSchema: {
        path: pathArg.optional(),
        ref: refOptionalArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path: p, ref }) => {
      try {
        const threads = await backend.readThreads({
          // Scoped connections are clamped to their doc (see ListThreads).
          path: docScope ?? p,
          ref,
        });
        return {
          content: [
            {
              type: "text",
              text: threads.length
                ? threads.map(formatThread).join("\n\n")
                : "(no threads)",
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
        if (docScope) {
          const outside = [
            ...new Set(
              targets.map((t) => t.path).filter((p) => p !== docScope),
            ),
          ];
          if (outside.length > 0) {
            throw err.outOfScope(`target path(s) ${outside.join(", ")}`, docScope);
          }
        }
        const id = await backend.addThread({
          targets,
          message,
          author,
          draft,
          ref,
          origin: "agent",
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
        await assertThreadInScope(backend, thread_id, docScope);
        await backend.replyThread(thread_id, message, {
          author,
          draft,
          origin: "agent",
        });
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
    "AttachDraftPayload",
    {
      title: "AttachDraftPayload",
      description:
        "Attach one or more proposed leaves (α-style payload) to an existing thread. Pass `draft` for a single leaf, `draft_options` for two or more. The thread message becomes a redline (single) or a leaf selector (multi).",
      inputSchema: {
        thread_id: threadIdArg,
        message: messageArg.optional(),
        draft: threadDraftSchema.optional(),
        draft_options: z
          .array(threadDraftOptionSchema)
          .min(2)
          .max(8)
          .optional()
          .describe(
            "Two or more option leaves. Each must carry a `name` so the reviewer can label them.",
          ),
        author: authorArg,
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ thread_id, message, draft, draft_options, author }) => {
      try {
        await assertThreadInScope(backend, thread_id, docScope);
        await backend.attachDraftPayload(thread_id, {
          message,
          draft,
          draft_options,
          author,
          origin: "agent",
        });
        return {
          content: [
            { type: "text", text: `attached payload to ${thread_id}` },
          ],
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
      description:
        "Mark a thread as accepted (closes the conversation). Only resolve once all the work is done — the requested change has landed (or none was needed) and there are no outstanding questions or follow-ups for the user. If you asked a clarifying question, presented options to pick, or flagged a broader change, leave the thread open instead.",
      inputSchema: { thread_id: threadIdArg },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ thread_id }) => {
      try {
        await assertThreadInScope(backend, thread_id, docScope);
        await backend.resolveThread(thread_id, "agent");
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
    if (t.scope === "doc") {
      lines.push(`  ${t.path}  (doc-level)`);
    } else {
      lines.push(
        `  ${t.path}  "${t.anchor.anchored_text.slice(0, 60)}${t.anchor.anchored_text.length > 60 ? "…" : ""}"`,
      );
    }
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

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * ReadMe — the agent calls this once on connect to learn the workflow.
 *
 * Self-contained on purpose: no skill install, no external script, no
 * AGENTS.md lookup. Everything the agent needs to react to user comments
 * and edit the doc lives in this string.
 */
export function registerReadMe(server: McpServer): void {
  server.registerTool(
    "ReadMe",
    {
      title: "ReadMe",
      description:
        "Operating guide for the sheaf MCP server. Call this once on connect before doing anything else; it explains the loop, the tools to use, and how to subscribe to live events.",
      inputSchema: {},
      annotations: { destructiveHint: false, openWorldHint: false, readOnlyHint: true },
    },
    async () => ({
      content: [{ type: "text", text: README }],
    }),
  );
}

const README = `# Sheaf MCP — operating guide

You're connected to sheaf. A user is editing a markdown doc somewhere
(typically in Obsidian via the sheaf plugin). When they highlight a passage
and write a comment, sheaf records it as a **thread** anchored to that
character range. Your job: react to those threads by editing the doc, then
mark the thread resolved. The user sees your edits land in their editor live.

## The loop

1. **Subscribe** to events (one-time, see below).
2. On each \`thread_changed\` event:
   a. \`ReadThread(thread_id)\` to get the brief and the anchored text.
   b. \`Edit\` (or \`Write\`) the doc with \`ref="main"\` to apply the change.
   c. \`ResolveThread(thread_id)\` to mark it done.
3. Stop with \`TaskStop\` when the session ends.

If the brief is too vague to act on (e.g. *"tighten this"* with no length
target), \`ReplyThread\` with a clarifying question and skip; do not resolve.

## Subscribe to events

Run this once with the \`Monitor\` tool. It connects to the SSE event stream
and emits one JSON line per event; \`Monitor\` wakes the session on each line:

\`\`\`
Monitor({
  command: "while true; do curl -sN 'http://localhost:3000/api/ui/drafts/stream?role=agent' | sed -n -u 's/^data: //p'; sleep 1; done",
  description: "sheaf events",
  persistent: true,
})
\`\`\`

If sheaf isn't on \`localhost:3000\`, swap the URL. The \`role=agent\` query
param is what makes the user's plugin show "agent connected" in its status
bar — keep it.

Each notification is one event of the form:

\`\`\`
{"kind":"thread_changed","thread_id":"thrd_...","target_paths":["workspaces/.../foo.md"]}
{"kind":"doc_changed","path":"workspaces/.../foo.md"}
{"kind":"agent_presence","connected":true}
\`\`\`

Branch on \`kind\`:
- **thread_changed** — the user posted (or you resolved) a thread. Investigate.
- **doc_changed** — a write landed on a doc; usually emitted by your own Edit/Write. Ignore unless you're tracking concurrent activity.
- **agent_presence** — connection lifecycle for the watcher itself. Ignore.

Other event kinds may arrive (\`draft_*\`); they're not part of this workflow
and can be ignored.

## Tools you'll use

- \`ReadThread(thread_id)\` — full thread including \`targets[i].anchor.anchored_text\` (what the user selected) and \`messages[]\` (what they wrote).
- \`ListThreads({path, ref:"main"})\` — enumerate threads on a doc; useful when you want context beyond the one event.
- \`Read(file_path)\` — full doc contents. \`ref\` defaults to \`"main"\`.
- \`Edit(file_path, old_string, new_string)\` — surgical replace. Pass \`ref="main"\` (or omit). Prefer this for small changes; \`old_string\` should be unique in the doc.
- \`Write(file_path, content)\` — full-doc rewrite. Pass \`ref="main"\` (or omit). Use sparingly.
- \`ReplyThread(thread_id, message)\` — add a message to the thread. Use for clarifying questions.
- \`ResolveThread(thread_id)\` — mark thread done. Call this once your edit has landed.
- \`Glob(pattern)\` / \`Grep({pattern, ...})\` — search the workspace.

## Anchored edits

The thread's anchored text is the most useful starting point for an \`Edit\`
call: \`old_string = thread.targets[0].anchor.anchored_text\`, \`new_string =
your revision\`. If the anchored text isn't unique in the doc (you'll get
\`edit_ambiguous\`), include surrounding context from
\`anchor.context_before\` / \`anchor.context_after\` to disambiguate.

## What not to do

- Don't call \`Fork\`, \`Propose\`, \`Merge\`, \`DeclineDraft\`, or
  \`AttachDraftPayload\`. Those tools exist for a different sheaf workflow
  that this prototype doesn't use.
- Don't write outside \`workspaces/\` — those paths are rejected.
- Don't loop on \`doc_changed\` events you emitted yourself.

That's the whole workflow. Subscribe, react, edit, resolve.`;

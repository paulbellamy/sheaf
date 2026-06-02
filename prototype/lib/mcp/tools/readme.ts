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
2. On each \`thread_changed\` event for a thread you don't already own:
   a. \`ReadThread(thread_id)\` to get the brief, the targets, and the message.
   b. **Acknowledge immediately**: \`ReplyThread(thread_id, "on it")\` (or a
      short paraphrase of what you're about to do). This is the signal the
      plugin shows as "agent working" — without it the user has no feedback
      between posting the comment and seeing the edit land.
   c. Decide: **present options for the user to choose, or commit a single
      edit?** The test is whether the user should make a choice: if the brief
      has more than one reasonable answer (most prose work does), give them
      options. If there's one clear change, just make it.
      - **Present 2-4 options** — whenever the user should pick between
        approaches — via a **single \`AttachDraftPayload\` call**. Put every
        option into the \`draft_options\` array on that one call — do **not**
        send each option as a separate ReplyThread message, and do **not**
        make multiple AttachDraftPayload calls. The plugin renders one card
        per option from the latest message's \`draft_options\`. Extra messages
        just add narration without producing extra cards. Each leaf needs a
        short \`name\` like \`"punchier"\`, \`"leads with the cost"\`,
        \`"hedged"\`, \`"cut entirely"\`, and a \`new_md\` that **shows the
        user what that direction reads like** — a representative sample is
        fine; it does **not** have to be the final, literal replacement text.

        Correct shape:
        \`\`\`
        AttachDraftPayload({
          thread_id: "thrd_...",
          message: "three takes",
          draft_options: [
            { name: "A: enumerate", new_md: "..." },
            { name: "B: graduated trust", new_md: "..." },
            { name: "C: scope-bound", new_md: "..." },
          ],
        })
        \`\`\`

        **Then stop — do not resolve.** Presenting options is asking a
        question, not landing a change. Nothing is written to the doc yet.
        The user's pick comes back as the *next* \`thread_changed\`: a new
        user reply on the thread reading *Selected option N: "<name>"*. Only
        then do you make the real edit and resolve (step d). Treat the chosen
        sample as the **direction to execute**, not bytes to paste.
      - **Commit a single edit** (no options) when there's just one clear
        change — the brief is fully specified ("rename Foo to Bar", "fix
        this typo"), or one approach is plainly right. Use \`Edit\`/\`Write\`
        with \`ref="main"\` then \`ResolveThread\`.
   d. **When the user picks an option** (a *Selected option N* reply on a
      thread where you proposed options), make the actual change now, scoped
      to the first target — then \`ResolveThread\`:
      - \`scope: "range"\` — \`Edit\` the anchored passage only. Keep it the
        size of the highlight.
      - \`scope: "doc"\` — \`Write\` the whole doc.
      Produce the real, final text here (the option's \`new_md\` was only a
      preview); the doc is **not** updated until you make this edit.
3. Stop with \`TaskStop\` when the session ends.

If the brief is too vague even for variants (e.g. *"rework §4"* with no
angle), \`ReplyThread\` with a clarifying question and skip. The reply
itself flips the thread into "agent working" — fine, the user can see
you're waiting on them.

## Restraint

For range-anchored threads, your \`Edit\` (or each variant's \`new_md\`) should
only touch the anchored passage. If the brief implies broader changes —
e.g., "tighten this and update the intro to match" — split it: act on the
anchored part, and \`ReplyThread\` noting what broader change you'd recommend
so the user can post a follow-up thread on the right anchor.

The agent edits the thing asked for, not the thing it noticed.

## Skip when another agent is already working

Multiple agents may be subscribed to the same sheaf. Check the thread's
latest message author before acting:
- If the latest message is from the user → it's yours to pick up.
- If the latest message is from another agent → another agent is on it; skip.
- If the latest message is from you (echo of your own ReplyThread) → skip.

The plugin uses the same "any non-user message on an open thread" signal to
show "agent working", so this convention also keeps the UI honest.

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
{"kind":"thread_changed","thread_id":"thrd_...","target_paths":["notes/foo.md"]}
{"kind":"doc_changed","path":"notes/foo.md"}
{"kind":"agent_presence","connected":true}
\`\`\`

Branch on \`kind\`:
- **thread_changed** — the user posted (or you resolved) a thread. Investigate.
- **doc_changed** — a write landed on a doc; usually emitted by your own Edit/Write. Ignore unless you're tracking concurrent activity.
- **agent_presence** — connection lifecycle for the watcher itself. Ignore.

Other event kinds may arrive (\`draft_*\`); they're not part of this workflow
and can be ignored.

## Tools you'll use

- \`ReadThread(thread_id)\` — full thread. Each target has a \`scope\` field: \`"range"\` carries an \`anchor\` (\`anchored_text\`, \`context_before/after\`, \`rel_pos\`); \`"doc"\` has no anchor.
- \`ListThreads({path, ref:"main"})\` — enumerate threads on a doc; useful when you want context beyond the one event.
- \`Read(file_path)\` — full doc contents. \`ref\` defaults to \`"main"\`.
- \`Edit(file_path, old_string, new_string)\` — surgical replace. Pass \`ref="main"\` (or omit). Prefer this for small changes; \`old_string\` should be unique in the doc.
- \`Write(file_path, content)\` — full-doc rewrite. Pass \`ref="main"\` (or omit). Use this for doc-level briefs or when many edits would be needed.
- \`ReplyThread(thread_id, message)\` — add a message to the thread. Use for clarifying questions.
- \`ResolveThread(thread_id)\` — mark thread done. Call this once your edit has landed.
- \`Glob(pattern)\` / \`Grep({pattern, ...})\` — search the vault.

## Range vs doc-level

**Range targets** (\`scope: "range"\`) are the common case: the user highlighted
text and commented on it. Use \`target.anchor.anchored_text\` as \`old_string\`
in an \`Edit\`. If the anchored text isn't unique in the doc (\`edit_ambiguous\`),
include surrounding context from \`anchor.context_before\` / \`anchor.context_after\`
to disambiguate.

**Doc-level targets** (\`scope: "doc"\`) carry no anchor — the comment is about
the doc as a whole (e.g. *"rewrite this for tone"*, *"add a conclusion"*). Read
the doc first, then make the change with \`Write\` (full rewrite) or several
\`Edit\` calls. There is no anchored text to use as \`old_string\`.

## What not to do

- Don't call \`Fork\`, \`Propose\`, \`Merge\`, or \`DeclineDraft\` — those drive
  the draft-review workflow this prototype doesn't use. (\`AttachDraftPayload\`
  is *not* in that list: it's how you present options — see the loop above.)
- Don't write to \`.\`-prefixed paths (dotfiles, \`.drafts/\`, \`.obsidian/\`) — those are rejected.
- Don't loop on \`doc_changed\` events you emitted yourself.

That's the whole workflow. Subscribe, react, edit, resolve.`;

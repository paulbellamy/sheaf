<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Reacting to /doc submissions

To react to thread submissions and other backend mutations while the agent is idle, use the `sheaf-event-watcher` skill (installed via the repo-root `.claude-plugin/`). It runs `scripts/watch-events.mjs` under `Monitor` and wakes the session on each event.

If the plugin is not installed, run the script directly:

```
Monitor({
  command: "node ../.claude-plugin/scripts/watch-events.mjs",
  description: "sheaf backend events",
  persistent: true,
})
```

Each notification is one `BackendEvent` JSON line (`thread_changed`, `draft_changed`, `draft_state`, `draft_created`). On `thread_changed`, call `ListThreads` / `ReadThread` via MCP. Stop with `TaskStop` when done.

# Drafts are agent-originated

Drafts are produced by agents (via `Fork` → `Write`/`Edit` → `Propose`). Human reviewers accept or decline them from the /review UI. The UI has no "new draft" button and is unlikely to grow one; if a human needs to propose a change by hand they write a thread instead.

That asymmetry is intentional:
- Agent-originated edits are the thing we want to review, so they deserve the heavier flow (draft + diff).
- Human-originated conversation is the thing we want to keep lightweight, so threads are UI-first.

The MCP tool surface covers the full draft lifecycle — `Fork`, `Write`, `Edit`, `Propose`, `Merge`, `DeclineDraft` — so agents never have to reach into the UI REST endpoints to close out their own drafts.

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

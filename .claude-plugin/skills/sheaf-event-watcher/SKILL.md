---
name: sheaf-event-watcher
description: React to sheaf backend events (thread submissions, draft edits, draft state changes) as they happen. Use when the user wants the agent to watch a /doc page, respond to thread submissions immediately, or otherwise stay reactive to backend mutations while idle. Also use when the user says "watch threads", "react to submissions", or "watch sheaf events".
allowed-tools:
  - Bash(${CLAUDE_PLUGIN_ROOT}/scripts/watch-events.mjs:*)
  - Monitor
  - TaskStop
---

# Sheaf event watcher

Use this skill when the user wants the agent to react immediately to events from the sheaf backend — thread submissions, draft edits, draft state transitions — without them having to type to trigger a turn.

## How it works

`scripts/watch-events.mjs` connects to the sheaf SSE endpoint (`/api/ui/drafts/stream` by default) and emits one JSON line per `BackendEvent` to stdout. Claude Code's `Monitor` tool treats each stdout line as a notification, which wakes an idle session and starts a fresh turn.

Event shape (from `prototype/lib/mcp/backend/index.ts`):

```
{"kind":"thread_changed","thread_id":"thrd_..."}
{"kind":"draft_changed","draft_id":"drft_...","path":"..."}
{"kind":"draft_state","draft_id":"drft_...","state":"submitted|accepted|declined|open"}
{"kind":"draft_created","draft_id":"drft_...","base_path":"..."}
```

## Usage

Start the watcher with `Monitor` at the beginning of a reactive session:

```
Monitor({
  command: "node ${CLAUDE_PLUGIN_ROOT}/scripts/watch-events.mjs",
  description: "sheaf backend events",
  persistent: true,
})
```

Optional: override the endpoint with `SHEAF_STREAM_URL=... node ...` if the dev server is not on `http://localhost:3000`.

On each notification, parse the JSON line and respond:

- `thread_changed` → call the sheaf MCP `ReadThread` (or `ListThreads` if you need context) and act on the new/updated thread.
- `draft_changed` → re-read the doc via sheaf MCP `Read` if you are tracking it.
- `draft_state` → handle submit/accept/decline transitions.
- `draft_created` → pick up the new draft if it is in-scope.

Stop with `TaskStop` when the reactive session ends. The watcher auto-reconnects on SSE drops, so you do not need to restart it.

## Preconditions

- A sheaf dev server (or prod) reachable from the agent host. Default URL: `http://localhost:3000/api/ui/drafts/stream`.
- Node 20+ on the agent host (the script uses `fetch` streaming).

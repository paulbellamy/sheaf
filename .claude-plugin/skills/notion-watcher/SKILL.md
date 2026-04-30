---
name: notion-watcher
description: React to new comments on a Notion page as they arrive, and respond by editing the page, posting a proposal, asking a clarifying question, or sketching a plan — whichever the comment calls for. Use when the user asks the agent to watch a Notion page, react to comments live, or stay reactive to a Notion doc while idle. Also use when the user says "watch this Notion page", "respond to comments on this doc", or pastes a Notion page URL/ID and asks the agent to engage with it.
allowed-tools:
  - Bash(${CLAUDE_PLUGIN_ROOT}/scripts/notion-watch.mjs:*)
  - Bash(node:*)
  - Monitor
  - TaskStop
---

# Notion comment watcher

Use this skill when the user wants the agent to react to comments on a Notion page in near real-time — without having to type a message to trigger each turn.

## How it works

`scripts/notion-watch.mjs` polls a single Notion page every 10 seconds via the `notion` MCP server (the same one wired into `.mcp.json`). It emits one JSON line per comment event to stdout. Claude Code's `Monitor` tool treats each line as a notification that wakes an idle session.

State is kept in `.context/notion-seen-<page_id>.json`, so events seen in earlier runs do not re-fire.

Three event kinds, all matching [Notion's webhook envelope](https://developers.notion.com/reference/webhooks-events-delivery) with an `x_sheaf` extension carrying the comment body inline. Same shape, only `type` differs:

- **`comment.created`** — a new comment appeared on the page.
- **`comment.updated`** — the body of a known comment changed.
- **`comment.deleted`** — a previously-seen comment is gone. Notion's API only lists *un-resolved* comments, so this also fires when the user resolves a discussion. `authors`, `data.parent`, `x_sheaf.discussion_id`, and `x_sheaf.body` reflect the **last-known** snapshot before disappearance, so the agent can locate what was removed.

```json
{
  "id": "<uuid>",
  "timestamp": "<iso>",
  "workspace_id": "<uuid|null>",
  "type": "comment.created | comment.updated | comment.deleted",
  "authors": [{ "id": "<user-uuid>", "type": "person" }],
  "attempt_number": 1,
  "entity": { "id": "<comment-uuid>", "type": "comment" },
  "data": {
    "page_id": "<page-uuid>",
    "parent": { "id": "<block-uuid>", "type": "block" }
  },
  "x_sheaf": {
    "source": "polling",
    "discussion_id": "<uuid|null>",
    "body": "<plain text>"
  }
}
```

## Usage

Start the watcher with `Monitor` at the beginning of a reactive session, passing either a Notion page id or the page URL the user gave you:

```
Monitor({
  command: "node ${CLAUDE_PLUGIN_ROOT}/scripts/notion-watch.mjs <page_id_or_url>",
  description: "notion page comments",
  persistent: true,
})
```

The watcher accepts a bare UUID (`12345678-90ab-cdef-1234-567890abcdef`), a 32-char hex id, or a full Notion URL.

To watch multiple pages, run multiple `Monitor` instances — one per page.

Stop with `TaskStop` when the reactive session ends.

## On session start

The watcher does **not** replay existing comments — the first poll snapshots silently and only emits new comments going forward. So immediately after starting `Monitor`, fetch existing open comments (`notion-get-comments`) once to seed your context. Everything after that arrives via the event stream.

## Responding to a comment

On each notification, you have the full `notion` MCP toolset (`notion-fetch`, `notion-get-comments`, `notion-create-comment`, `notion-update-page`, `notion-search`, ...). What you do depends on what the comment is asking. Pick one:

- **Edit the block.** The comment is an unambiguous mechanical instruction ("fix this typo", "rename X to Y"). Apply the change with `notion-update-page`, then `notion-create-comment` on the same `discussion_id` saying briefly what you did. The user reverts via Notion's page history if they dislike it.
- **Propose a rewrite.** The comment asks for substantive prose change ("rework this paragraph", "tighten §3"). Post the proposed replacement inside a code block in a reply on the same `discussion_id`. Do not edit the page until the user confirms.
- **Ask a clarifying question.** The comment is ambiguous ("tighten this" with no target length). Reply with one focused question. Skip the comment for now; the user's reply will re-fire the loop.
- **Sketch a plan.** The comment is too broad to address in one go ("rework §3–§5"). Reply with a short numbered plan, then wait for the user to greenlight or split the work.

When in doubt, prefer proposing over directly editing — proposals are reviewable; edits land immediately.

`comment.updated` flips the meaning of an in-flight reply — reread the new body before acting; an updated comment is the user revising their ask, not a separate request. `comment.deleted` is usually "ignore" — the user retracted the thread (or resolved it); don't reply, just drop any pending proposal tied to that `discussion_id`.

## Reading context

Before responding, fetch the surrounding block via `notion-fetch` so you understand what's being commented on. Notion anchors comments at block level, not character range — if the user wants precision, they'll quote the snippet inside the comment body.

## Stop conditions

- User says they're done with the page.
- User runs `TaskStop`.
- Watcher exits with a non-recoverable error (it auto-retries on transient failures).

## Preconditions

- One of: `NOTION_TOKEN` set in the shell that launched Claude Code, OR Claude Code has an authorized Notion MCP connection at `~/.config/mcp/auth/notion.json` (run `claude mcp` once to set it up). The watcher prefers `NOTION_TOKEN` and falls back to the OAuth bearer.
- The Notion integration (or Claude's OAuth app) has been added to the watched page via Notion's "Connections" menu (otherwise comments are not visible).
- Node 20+ on the agent host.

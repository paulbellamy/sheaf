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

`scripts/notion-watch.mjs` polls a single Notion page every 10 seconds via the `notion` MCP server (which must be configured in `.mcp.json`). It emits one JSON line per *new* comment to stdout. Claude Code's `Monitor` tool treats each line as a notification that wakes an idle session.

State is kept in `.context/notion-seen-<page_id>.json`, so comments seen in earlier runs do not re-fire.

Event shape:

```
{"kind":"comment_created","page_id":"<id>","comment_id":"<id>","discussion_id":"<id>","parent_block_id":"<id>","author_id":"<id>","body":"<text>"}
```

## Usage

Start the watcher with `Monitor` at the beginning of a reactive session, passing the page id the user gave you:

```
Monitor({
  command: "node ${CLAUDE_PLUGIN_ROOT}/scripts/notion-watch.mjs <page_id>",
  description: "notion page comments",
  persistent: true,
})
```

To watch multiple pages, run multiple `Monitor` instances — one per page.

Stop with `TaskStop` when the reactive session ends.

## Responding to a comment

On each notification, you have the full `notion` MCP toolset (`notion-fetch`, `notion-get-comments`, `notion-create-comment`, `notion-update-page`, `notion-search`, ...). What you do depends on what the comment is asking. Pick one:

- **Edit the block.** The comment is an unambiguous mechanical instruction ("fix this typo", "rename X to Y"). Apply the change with `notion-update-page`, then `notion-create-comment` on the same `discussion_id` saying briefly what you did. The user reverts via Notion's page history if they dislike it.
- **Propose a rewrite.** The comment asks for substantive prose change ("rework this paragraph", "tighten §3"). Post the proposed replacement inside a code block in a reply on the same `discussion_id`. Do not edit the page until the user confirms.
- **Ask a clarifying question.** The comment is ambiguous ("tighten this" with no target length, "rework §4" with no angle). Reply with one focused question. Skip the comment for now; the user's reply will re-fire the loop.
- **Sketch a plan.** The comment is too broad to address in one go ("rework middle §3–§5"). Reply with a short numbered plan, then wait for the user to greenlight or split the work.

When in doubt, prefer proposing over directly editing — proposals are reviewable; edits land immediately.

## Reading context first

Before responding, fetch the surrounding block via `notion-fetch` so you understand what's being commented on. Notion API anchors comments at block level, not character range — if the user wants precision, they'll quote the snippet inside the comment body.

## Stop conditions

- User says they're done with the page.
- User runs `TaskStop`.
- Watcher exits with a non-recoverable error (it auto-retries on transient failures).

## Preconditions

- One of: `NOTION_TOKEN` set in the shell that launched Claude Code, OR Claude Code has an authorized Notion MCP connection at `~/.config/mcp/auth/notion.json` (run `claude mcp` once to set it up). The watcher prefers `NOTION_TOKEN` and falls back to the OAuth bearer.
- The Notion integration (or Claude's OAuth app) has been added to the watched page via Notion's "Connections" menu (otherwise comments are not visible).
- Node 20+ on the agent host.

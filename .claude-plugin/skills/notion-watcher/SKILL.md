---
name: notion-watcher
description: React to live changes on a Notion page — both new comments and direct page edits — so the user and the agent can edit the doc in parallel and stay in sync. The agent responds by editing, proposing, asking, or planning depending on what the comment or edit calls for. Use when the user asks the agent to watch a Notion page, collaborate on a doc live, react to comments, or stay reactive to a Notion page while idle. Also use when the user says "watch this Notion page", "respond to comments on this doc", or pastes a Notion page URL/ID and asks the agent to engage with it.
allowed-tools:
  - Bash(${CLAUDE_PLUGIN_ROOT}/scripts/notion-watch.mjs:*)
  - Bash(node:*)
  - Monitor
  - TaskStop
---

# Notion page watcher

Use this skill when the user wants the agent to collaborate on a Notion page in near real-time — reacting to comments and to direct page edits without having to type a message to trigger each turn.

## How it works

`scripts/notion-watch.mjs` polls a single Notion page every 10 seconds via the Notion REST API (using the same auth as the `notion` MCP server). It emits one JSON line per event to stdout. Claude Code's `Monitor` tool treats each line as a notification that wakes an idle session.

State is kept in `.context/notion-seen-<page_id>.json`, so events seen in earlier runs do not re-fire.

Four event kinds, all shaped to match [Notion's webhook envelope](https://developers.notion.com/reference/webhooks-events-delivery) — a `x_sheaf` extension carries inline content snapshots that real Notion webhooks omit:

**`page.content_updated`** — one event per debounced burst of block edits (see "Debouncing" below).

```json
{
  "id": "<uuid>",
  "timestamp": "<iso>",
  "workspace_id": "<uuid|null>",
  "type": "page.content_updated",
  "authors": [{ "id": "<user-uuid>", "type": "person" }],
  "attempt_number": 1,
  "entity": { "id": "<page-uuid>", "type": "page" },
  "data": {
    "updated_blocks": [{ "id": "<block-uuid>", "type": "block" }],
    "parent": { "id": "<page-uuid>", "type": "page" }
  },
  "x_sheaf": {
    "source": "polling",
    "blocks": [{
      "id": "<block-uuid>",
      "action": "added|updated|removed",
      "block_type": "paragraph",
      "last_edited_time": "<iso>",
      "last_edited_by_id": "<user-uuid>",
      "content": { /* type-keyed Notion block payload, or null for removed */ }
    }]
  }
}
```

**`comment.created`** / **`comment.updated`** — one event per new or edited comment, no debounce. Same envelope shape, only `type` differs. `x_sheaf.body` carries the current text.

```json
{
  "id": "<uuid>",
  "timestamp": "<iso>",
  "workspace_id": "<uuid|null>",
  "type": "comment.created",
  "authors": [{ "id": "<user-uuid>", "type": "person" }],
  "attempt_number": 1,
  "entity": { "id": "<comment-uuid>", "type": "comment" },
  "data": {
    "page_id": "<page-uuid>",
    "parent": { "id": "<block-or-page-uuid>", "type": "block|page" }
  },
  "x_sheaf": {
    "source": "polling",
    "discussion_id": "<uuid|null>",
    "body": "<plain text>"
  }
}
```

**`comment.deleted`** — fires when a comment disappears from the page. `authors`, `data.parent`, `x_sheaf.discussion_id`, and `x_sheaf.body` reflect the **last-known** snapshot before deletion, so the agent can locate what was removed.

```json
{
  "id": "<uuid>",
  "timestamp": "<iso>",
  "workspace_id": "<uuid|null>",
  "type": "comment.deleted",
  "authors": [{ "id": "<user-uuid>", "type": "person" }],
  "attempt_number": 1,
  "entity": { "id": "<comment-uuid>", "type": "comment" },
  "data": {
    "page_id": "<page-uuid>",
    "parent": { "id": "<block-or-page-uuid>", "type": "block|page" }
  },
  "x_sheaf": {
    "source": "polling",
    "discussion_id": "<uuid|null>",
    "body": "<last-known plain text>"
  }
}
```

> Caveat: Notion's REST API only lists **un-resolved** comments, so `comment.deleted` also fires when a discussion is resolved. Treat both as "no longer live" — the comment doesn't need a reply either way.

## Usage

Start the watcher with `Monitor` at the beginning of a reactive session, passing either a Notion page id or the page URL the user gave you:

```
Monitor({
  command: "node ${CLAUDE_PLUGIN_ROOT}/scripts/notion-watch.mjs <page_id_or_url>",
  description: "notion page edits + comments",
  persistent: true,
})
```

The watcher accepts a bare UUID (`12345678-90ab-cdef-1234-567890abcdef`), a 32-char hex id, or a full Notion URL.

To watch multiple pages, run multiple `Monitor` instances — one per page.

Stop with `TaskStop` when the reactive session ends.

## On session start

The watcher does **not** replay existing state — first poll snapshots silently and only emits deltas going forward. So immediately after starting `Monitor`, fetch the current page (`notion-fetch`) and existing open comments (`notion-get-comments`) once to seed your context. Everything after that arrives via the event stream.

## Recognizing your own writes

The watcher cannot tell your edits apart from the user's — the auth identity may be the same person if the user is on a personal OAuth token. **You are the only thing that knows what you just wrote.** Filter accordingly.

Maintain a small **recent-writes log** in your working context. Every time you call `notion-update-page` or `notion-create-comment`, record `{block_id or comment_id, content fingerprint, time}`. Keep the last ~20 entries; older entries can age out.

On each `page.content_updated`, walk `x_sheaf.blocks[]`:

- If a block ID matches a recent self-write AND the new `content` matches what you wrote (modulo trivial whitespace), drop it from the burst — it's your own echo.
- Whatever's left is the user's edit. React to that.

On each `comment.created`, `comment.updated`, or `comment.deleted`, compare `entity.id` and `x_sheaf.body` to your recent-comments log. Match → ignore. If you edit or delete a comment yourself (via `notion-update-page`-style writes against the comments API, or by resolving a discussion), log that too so the resulting echo is filtered.

If the burst is empty after filtering, do nothing. `authors[]` and `last_edited_by_id` are useful supplementary signals (especially when multiple humans are on the page) but not load-bearing for echo cancellation.

## Debouncing

Block edits are coalesced. The watcher holds pending changes until the user has been quiet for ~5s, or the burst has been running for ~30s, then flushes one event listing all changed blocks. So:

- One event per editing burst, not per keystroke.
- A single typo fix arrives ~5s after the user stops typing.
- A long continuous edit gets flushed every ~30s while still being typed.

Comments are **not** debounced — each comment fires its own event immediately.

## Reacting to a page edit

After echo-filtering, if a `page.content_updated` event has remaining changes, use `x_sheaf.blocks[*].content` to update your model directly. (If `x_sheaf` is absent — a future world where this skill consumes real Notion webhooks — fall back to `notion-fetch` per block id.)

Pick **one** response per burst, not per block:

- **Silent merge.** User revised their own prose. Update your mental model, no reply.
- **Acknowledge.** User accepted/rejected something you proposed. Reply briefly on the relevant `discussion_id`.
- **Reconcile.** User edited a block where you had a pending proposal. Drop the proposal; address the new state.
- **Question.** The edit creates ambiguity with an earlier instruction. Ask one focused question.

Default is silent merge. Don't comment on every burst.

## Responding to a comment

Pick one:

- **Edit the block.** Comment is an unambiguous mechanical instruction ("fix this typo", "rename X to Y"). Apply with `notion-update-page`, then `notion-create-comment` on the same `discussion_id` briefly noting what you did. User reverts via Notion's page history if they dislike it.
- **Propose a rewrite.** Comment asks for substantive prose change ("rework this paragraph", "tighten §3"). Post the proposed replacement inside a code block in a reply on the same `discussion_id`. Do not edit until the user confirms.
- **Ask a clarifying question.** Comment is ambiguous ("tighten this" with no target length). Reply with one focused question.
- **Sketch a plan.** Comment is too broad to address in one go ("rework §3–§5"). Reply with a short numbered plan, then wait for greenlight or splitting.

When in doubt, prefer proposing over directly editing — proposals are reviewable; edits land immediately.

`comment.updated` events flip the meaning of an in-flight reply. Reread the new body before acting; an updated comment is the user revising their ask, not a separate request. `comment.deleted` events are usually "ignore" — the user retracted the thread; don't reply, just drop any pending proposal tied to that `discussion_id`.

## Reading context

Notion anchors comments at block level, not character range — if the user wants precision, they'll quote the snippet inside the comment body. For page edits, `x_sheaf.blocks[*].content` is the new state; if you need surrounding context, `notion-fetch` the parent.

## Stop conditions

- User says they're done with the page.
- User runs `TaskStop`.
- Watcher exits with a non-recoverable error (it auto-retries on transient failures).

## Preconditions

- `NOTION_TOKEN` set to a Notion internal integration secret in the shell that launched Claude Code. The watcher hits `api.notion.com` directly for raw block data, so Claude Code's hosted-MCP OAuth bearer is not sufficient — it has to be an integration secret.
- The integration has been added to the watched page via Notion's "Connections" menu (otherwise the API can't see the page).
- Node 20+ on the agent host.

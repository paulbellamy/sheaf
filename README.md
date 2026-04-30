# Sheaf

A Claude Code plugin that turns a Notion page into a live, two-way agent collaboration surface. Comment on a block or edit the page directly, and the agent reacts — edits, posts a proposal, asks a clarifying question, or sketches a plan, depending on what the change calls for. The user and the agent can edit the doc in parallel and stay in sync.

Two pieces:

1. The official [`@notionhq/notion-mcp-server`](https://github.com/makenotion/notion-mcp-server), wired into `.mcp.json`. Gives the agent the Notion read/write toolkit (`notion-fetch`, `notion-get-comments`, `notion-create-comment`, `notion-update-page`, ...).
2. The `notion-watcher` skill (this repo). Polls a single Notion page every 10 seconds against Notion's REST API directly (using the same auth as the MCP server), emits a JSON line per event — both new comments and debounced bursts of block edits — and wakes the agent under Claude Code's `Monitor` tool. Events are shaped to match [Notion's webhook envelope](https://developers.notion.com/reference/webhooks-events-delivery), so a future swap from polling to real webhooks needs no consumer changes.

## Setup

1. **Create a Notion integration token.** Notion → Settings → Integrations → Develop or manage integrations → New internal integration. Give it `read` + `update` content and `read` + `insert` comment capabilities. Copy the secret and `export NOTION_TOKEN=ntn_...`. The watcher and the agent both use this one variable.

   The watcher hits `https://api.notion.com/v1` directly (it needs raw block data with timestamps, which the hosted Notion MCP at `mcp.notion.com` does not expose). Claude Code's hosted-MCP OAuth bearer is **not** sufficient — you need an integration secret.

2. **Grant the integration access to the page.** Open the Notion page → top-right `...` menu → Connections → Add connections → pick the integration. Without this, the API can't see the page or its comments.

3. **Install dependencies.**

   ```sh
   pnpm install
   ```

4. **Open the repo in Claude Code.** The `.mcp.json` at the root registers the `notion` MCP server automatically. The `notion-watcher` skill is installed via `.claude-plugin/`.

## Usage

Tell the agent to watch a page:

> Watch this Notion page for comments and respond: `<page_id_or_url>`

The agent will launch the watcher under `Monitor`:

```
Monitor({
  command: "node ${CLAUDE_PLUGIN_ROOT}/scripts/notion-watch.mjs <page_id>",
  description: "notion page edits + comments",
  persistent: true,
})
```

Now edit the page or leave a comment in Notion. Within ~10–15 seconds the agent wakes:

- new, edited, and deleted comments each fire immediately on the next poll
- block edits are debounced — one event per editing burst once the user has been quiet for ~5s (or the burst has been running ~30s), so rapid typing doesn't spam the agent

The agent responds based on the SKILL.md playbook:

- comment with mechanical instruction → edit the block, reply "done"
- comment with substantive prose change → reply with a proposed rewrite in a code block
- ambiguous comment → reply with one clarifying question
- broad comment → reply with a short numbered plan
- direct page edit → silent merge by default; reconcile with any pending proposals; ask if the edit creates ambiguity

Stop with `TaskStop` when done.

## Limits and tradeoffs

- **Block-level anchoring only.** Notion's API anchors comments to blocks, not character ranges. If you need to point at a specific phrase, quote it inside the comment body.
- **No atomic accept.** Each block edit is its own API call; if you don't like an edit, revert via Notion's page history.
- **Polling, not webhooks.** Webhooks would need a public HTTPS endpoint; a local Claude Code session has none. 10-second latency is fine for single-user.
- **One page per watcher.** To watch multiple pages, run multiple `Monitor` instances.

## Layout

```
.claude-plugin/
  plugin.json             # plugin manifest
  marketplace.json        # marketplace metadata
  scripts/
    notion-watch.mjs      # polls a page, emits page.content_updated and comment.{created,updated,deleted} events
  skills/
    notion-watcher/
      SKILL.md            # when to invoke, how to respond
.mcp.json                 # registers @notionhq/notion-mcp-server
docs/                     # design archive (sheaf-design-v0.1.md)
```

## Design archive

`docs/sheaf-design-v0.1.md` is the design doc for the v1 implementation, which was a custom Next.js + Yjs CRDT + Tiptap app with text-range anchors, atomic merges, and parallel forks. The current implementation drops that complexity in favor of Notion's hosted UI; the doc remains as a conceptual reference.

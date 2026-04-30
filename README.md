# Sheaf

A Claude Code plugin that turns a Notion page into a live agent feedback loop. Comment on a block, the agent reacts — edits the page, posts a proposal, asks a clarifying question, or sketches a plan, depending on what the comment is asking.

Two pieces:

1. The official [`@notionhq/notion-mcp-server`](https://github.com/makenotion/notion-mcp-server), wired into `.mcp.json`. Gives the agent the Notion read/write toolkit (`notion-fetch`, `notion-get-comments`, `notion-create-comment`, `notion-update-page`, ...).
2. The `notion-watcher` skill (this repo). Polls a single Notion page every 10 seconds via the MCP server, emits one JSON line per new comment, wakes the agent under Claude Code's `Monitor` tool.

## Setup

1. **Get a Notion API token.**
   If you already have one (from another MCP integration, a script, etc.), reuse it. If not: in Notion → Settings → Integrations → Develop or manage integrations → New internal integration. Give it `read` + `update` content and `read` + `insert` comment capabilities. Copy the secret.

2. **Set it in your shell.**

   ```sh
   export NOTION_TOKEN=ntn_...
   ```

   Both `notion-mcp-server` (called by Claude) and the watcher (run under `Monitor`) read this from the environment. One variable, one source of auth.

3. **Grant the integration access to the page.**
   Open the Notion page → top-right `...` menu → Connections → Add connections → pick the integration the token belongs to. Without this, the API can't see the page or its comments.

4. **Install dependencies.**

   ```sh
   pnpm install
   ```

5. **Open the repo in Claude Code.** The `.mcp.json` at the root registers the `notion` MCP server automatically. The `notion-watcher` skill is installed via `.claude-plugin/`.

## Usage

Tell the agent to watch a page:

> Watch this Notion page for comments and respond: `<page_id_or_url>`

The agent will launch the watcher under `Monitor`:

```
Monitor({
  command: "node ${CLAUDE_PLUGIN_ROOT}/scripts/notion-watch.mjs <page_id>",
  description: "notion page comments",
  persistent: true,
})
```

Now leave a comment on a block in Notion. Within ~10 seconds the agent wakes and responds based on the SKILL.md playbook:

- mechanical instruction → edit the block, reply "done"
- substantive prose change → reply with a proposed rewrite in a code block
- ambiguous request → reply with one clarifying question
- broad request → reply with a short numbered plan

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
    notion-watch.mjs      # polls a page, emits new comments as JSON lines
  skills/
    notion-watcher/
      SKILL.md            # when to invoke, how to respond
.mcp.json                 # registers @notionhq/notion-mcp-server
docs/                     # design archive (sheaf-design-v0.1.md)
```

## Design archive

`docs/sheaf-design-v0.1.md` is the design doc for the v1 implementation, which was a custom Next.js + Yjs CRDT + Tiptap app with text-range anchors, atomic merges, and parallel forks. The current implementation drops that complexity in favor of Notion's hosted UI; the doc remains as a conceptual reference.

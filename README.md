# Sheaf

A Claude Code plugin that turns a Notion page into a live agent feedback loop. Comment on a block, the agent reacts — edits the page, posts a proposal, asks a clarifying question, or sketches a plan, depending on what the comment is asking.

Two pieces:

1. The official [`@notionhq/notion-mcp-server`](https://github.com/makenotion/notion-mcp-server), wired into `.mcp.json`. Gives the agent the Notion read/write toolkit (`notion-fetch`, `notion-get-comments`, `notion-create-comment`, `notion-update-page`, ...).
2. The `notion-watcher` skill (this repo). Polls a single Notion page every 10 seconds via the MCP server, emits one JSON line per new comment, wakes the agent under Claude Code's `Monitor` tool.

## Setup

1. **Pick an auth source.** The watcher accepts either:

   - **`NOTION_TOKEN` (internal integration secret).** Notion → Settings → Integrations → Develop or manage integrations → New internal integration. Give it `read` + `update` content and `read` + `insert` comment capabilities. Copy the secret and `export NOTION_TOKEN=ntn_...`. With this set, the watcher spawns `@notionhq/notion-mcp-server` over stdio.
   - **Claude Code's existing OAuth token.** If `NOTION_TOKEN` is unset, the watcher falls back to `~/.config/mcp/auth/notion.json` — the bearer Claude already holds after running `claude mcp` and authorizing Notion. With this fallback, the watcher talks to the hosted MCP at `https://mcp.notion.com/mcp`. Refresh by re-running `claude mcp` if the token expires.

2. **Grant the integration (or Claude's OAuth app) access to the page.**
   Open the Notion page → top-right `...` menu → Connections → Add connections → pick the integration that owns the token you're using. Without this, the API can't see the page or its comments.

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

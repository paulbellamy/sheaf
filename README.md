# Sheaf

A Claude Code plugin that turns a Notion page into a live agent feedback loop. Comment on a block, and the agent reacts — edits, posts a proposal, asks a clarifying question, or sketches a plan, depending on what the comment is asking.

Two pieces:

1. The official [`@notionhq/notion-mcp-server`](https://github.com/makenotion/notion-mcp-server), wired into `.mcp.json`. Gives the agent the Notion read/write toolkit (`notion-fetch`, `notion-get-comments`, `notion-create-comment`, `notion-update-page`, ...).
2. The `notion-watcher` skill (this repo). Polls a single Notion page every 10 seconds via the same MCP server, emits a JSON line per comment event (`comment.created`, `comment.updated`, `comment.deleted`), and wakes the agent under Claude Code's `Monitor` tool. Events are shaped to match [Notion's webhook envelope](https://developers.notion.com/reference/webhooks-events-delivery), so a future swap from polling to real webhooks needs no consumer changes.

## Setup

1. **Authorize Notion for the agent.** Either:
   - Run `claude mcp` once and authorize the hosted Notion MCP — Claude Code stores the OAuth bearer at `~/.config/mcp/auth/notion.json` and the watcher reuses it. No env var needed.
   - Or create a Notion internal integration (Notion → Settings → Integrations → New internal integration), give it `read` + `update` content and `read` + `insert` comment capabilities, and `export NOTION_TOKEN=ntn_...`. The watcher prefers `NOTION_TOKEN` when it's set; otherwise it falls back to the OAuth bearer.

2. **Grant access to the page.** Open the Notion page → top-right `...` menu → Connections → Add connections → pick whichever Notion app you authorized in step 1 (Claude's OAuth app, or your internal integration). Without this, comments are not visible to the watcher.

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

Now leave (or edit, or delete) a comment in Notion. Within ~10 seconds the agent wakes and responds based on the SKILL.md playbook:

- mechanical instruction → edit the block, reply "done"
- substantive prose change → reply with a proposed rewrite in a code block
- ambiguous comment → reply with one clarifying question
- broad comment → reply with a short numbered plan
- edited comment → reread, treat as the user revising their ask
- deleted/resolved comment → drop any pending proposal on that thread

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
    notion-watch.mjs      # polls a page, emits comment.{created,updated,deleted} events
  skills/
    notion-watcher/
      SKILL.md            # when to invoke, how to respond
.mcp.json                 # registers @notionhq/notion-mcp-server
docs/                     # design archive (sheaf-design-v0.1.md)
```

## Design archive

`docs/sheaf-design-v0.1.md` is the design doc for the v1 implementation, which was a custom Next.js + Yjs CRDT + Tiptap app with text-range anchors, atomic merges, and parallel forks. The current implementation drops that complexity in favor of Notion's hosted UI; the doc remains as a conceptual reference.

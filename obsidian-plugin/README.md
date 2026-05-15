# sheaf-obsidian

Prototype Obsidian plugin for [sheaf](../prototype). Pair-write with a Claude
Code agent on the same markdown file: you select text, write a comment, hit
send — the agent (running externally with sheaf's MCP server attached) reads
the thread, edits the doc, and resolves. You see the edits land in the
editor.

Thread-on-doc mode only — no drafts, no propose, no merge. This is the
"see how it feels" prototype the plan file describes.

## Setup

### 1. Run sheaf

```
cd ../prototype
pnpm install
pnpm dev
```

The server listens on http://localhost:3000 by default.

### 2. Point sheaf at your vault

Sheaf treats `prototype/data/` as the workspace root by default. To use your
Obsidian vault, set `SHEAF_DATA_ROOT` (or symlink/move your vault under
`prototype/data/workspaces/<workspace_name>/docs/`). The default workspace
name the plugin uses is `obsidian` — change it in settings if you want a
different one.

> The vault path → sheaf path mapping is
> `<vault>/<note>.md` → `workspaces/<workspace_name>/docs/<note>.md`.

### 3. Install the plugin into your vault

```
pnpm install
pnpm build
mkdir -p <vault>/.obsidian/plugins/sheaf
cp manifest.json main.js <vault>/.obsidian/plugins/sheaf/
```

Or for dev with hot reload, `pnpm dev` (watches and writes `main.js`); use a
symlink instead of `cp`.

Enable the plugin from Settings → Community plugins.

### 4. Run a Claude Code session

In a separate terminal:

```
claude mcp add --transport http sheaf http://localhost:3000/api/mcp
claude
```

Then in the session:

```
> use the sheaf MCP and watch for events
```

The agent calls sheaf's `ReadMe` tool on connect, which returns the full
operating guide (the loop, the tools to use, the one-liner Monitor command
that subscribes to live events). No skill install or AGENTS.md needed —
the MCP server tells the agent everything.

## Use

1. Open a markdown file under your vault.
2. Select a passage you want the agent to work on.
3. Right-click → "Sheaf: Comment for agent" (or command palette →
   "Sheaf: Comment for agent").
4. Type the brief, hit Send.
5. Watch the right-panel threads view and your editor. Within seconds the
   agent should pick up the thread, edit the doc, and tick the thread off.

## Status

Throwaway prototype. Set `isDesktopOnly: true`. No mobile support, no auth,
no draft UI, no inline anchor highlights yet (planned). The point is to
feel out the human+agent racing UX; expect rough edges and last-write-wins
on concurrent saves.

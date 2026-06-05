# sheaf-obsidian

Prototype Obsidian plugin for [sheaf](../prototype). Pair-write with a Claude
Code agent on the same markdown file: you select text, write a comment, hit
send — the agent reads the thread, edits the doc, and resolves. You see the
edits land in the editor.

**The plugin runs the whole sheaf server itself** — backend, MCP endpoint, and
event stream all live inside Obsidian (shared code with the web prototype, in
[`../sheaf-server`](../sheaf-server)). There's no second process to start and
no `SHEAF_DATA_ROOT` to set: your vault is the data root. Install is two steps —
drop in the plugin, then copy-paste one command into your agent.

Thread-on-doc mode only — no drafts, no propose, no merge. This is the
"see how it feels" prototype the plan file describes.

## Setup

### 1. Install the plugin into your vault

```
pnpm install        # from the repo root (pnpm workspace)
pnpm --filter sheaf-obsidian build
mkdir -p <vault>/.obsidian/plugins/sheaf
cp manifest.json main.js <vault>/.obsidian/plugins/sheaf/
```

Or for dev with hot reload, `pnpm --filter sheaf-obsidian dev` (watches and
writes `main.js`); use a symlink instead of `cp`.

Enable the plugin from Settings → Community plugins. On enable it starts the
sheaf server on `http://localhost:31415` (change the port in the plugin's
settings; or turn the embedded server off there to point at one you run
yourself). Any markdown doc in your vault is a sheaf doc — dot-prefixed paths
(`.obsidian/`, etc.) are infra and ignored.

### 2. Connect your agent

Open the **Sheaf threads** panel (ribbon icon). While no agent is listening it
shows a copy button for the connect command — or run it yourself:

```
claude mcp add --transport http sheaf http://localhost:31415/api/mcp
claude
```

Then in the session:

```
> use the sheaf MCP and watch for events; action and resolve each thread as it appears, and keep handling new ones until I stop you
```

The agent calls sheaf's `ReadMe` tool on connect, which returns the full
operating guide (the loop, the tools to use, the one-liner `Monitor` command
that subscribes to live events). No skill install or AGENTS.md needed —
the MCP server tells the agent everything. Once it subscribes, the panel flips
to "agent connected".

## Use

1. Open a markdown file under your vault.
2. Select a passage you want the agent to work on.
3. Right-click → "Sheaf: Comment for agent" (or command palette →
   "Sheaf: Comment for agent").
4. Type the brief, hit Send.
5. Watch the right-panel threads view and your editor. Within seconds the
   agent should pick up the thread, edit the doc, and tick the thread off.

## Panel review (virtual comments)

Instead of one comment, ask the agent to review the whole doc as a panel of
reviewer roles:

1. Open a doc, then command palette → **"Sheaf: Request panel review"** (or
   right-click → *Sheaf: Request panel review*).
2. Pick which roles to run (the menu comes from **Settings → Sheaf → Review
   panel**, where you define/edit/enable roles like *Skeptic*, *On-call SRE*,
   *Security reviewer*, *New hire*).
3. The agent reads the doc and posts anchored feedback as simulated comments
   (author `review:<id>`), one per point. It does **not** edit the doc.
4. Triage each comment in the threads panel: **Address** asks the agent to make
   the change that comment calls for (scoped to its anchor); **Dismiss** drops
   it; a plain reply just discusses it. A review comment sits parked
   ("awaiting your review") until you act — the agent never processes its own
   review output.

## Status

Throwaway prototype. Set `isDesktopOnly: true`. No mobile support, no auth,
no draft UI, no inline anchor highlights yet (planned). The point is to
feel out the human+agent racing UX; expect rough edges and last-write-wins
on concurrent saves.

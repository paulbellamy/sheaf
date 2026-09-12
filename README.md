# sheaf

Comment on a doc, an agent edits it inline.

`sheaf` is a single CLI binary that talks to **one running daemon per vault**.
The daemon owns all state and the live event stream; every other command —
including the MCP server an agent connects to — is a thin client that speaks
loopback HTTP to it. You point an agent (Claude Code, Codex, …) at the vault,
comment on a passage in your editor, and the agent reacts to the comment, edits
the doc, and resolves the thread — while you watch the edit land live.

```
sheaf serve            # run the daemon for a vault (owns state + events)
sheaf mcp install       # wire sheaf into an agent's MCP config
sheaf thread add …      # post a comment; the connected agent wakes on it
sheaf events follow      # tail the live event stream as NDJSON
```

## Install & build

From the repo root (pnpm monorepo):

```sh
pnpm install                       # once
pnpm --filter sheaf-cli build      # bundles bin/sheaf.js (the `sheaf` binary)
```

`sheaf-cli` builds an esbuild bundle at `sheaf-cli/bin/sheaf.js` with a
`#!/usr/bin/env node` banner; its `package.json` exposes it as the `sheaf` bin.
Run it directly (`node sheaf-cli/bin/sheaf.js …`), `pnpm --filter sheaf-cli exec sheaf …`,
or `npm link` / `pnpm link` the package to put `sheaf` on your PATH. v0.1 is
POSIX-only (macOS/Linux); Windows is out of scope.

See **[docs/cli-usage.md](docs/cli-usage.md)** for a full walkthrough (serve →
install into an agent → post a thread → follow events).

## The daemon model

`StubBackend` keeps critical state in one process's memory (version counters,
the write-through op-log cache, the mutation lock chain, agent presence, the SSE
replay buffer). Two backends on one vault diverge and corrupt each other. So the
invariant is hard: **for a given vault there is exactly one live backend, inside
exactly one process — the daemon (`sheaf serve`).** Everything else is a client.

- **`sheaf serve`** binds loopback on an ephemeral port and serves the whole
  surface: UI REST (`/api/ui/*`), the SSE stream, MCP Streamable HTTP
  (`/api/mcp`), and `GET /api/health`. It registers itself in a discovery file
  under `$SHEAF_HOME` (default `~/.sheaf`) so clients can find it.
- **Clients** locate the daemon via that discovery file and speak loopback HTTP.
  Finding no daemon, every command except `sheaf mcp` exits `3` with
  `no sheaf daemon for <vault>; run \`sheaf serve\``. Only `sheaf mcp` may
  auto-spawn a daemon (it's the one client with no human at the keyboard).
- A daemon-less `sheaf mcp --no-daemon` (its own in-process backend) is a
  documented escape hatch, valid only when nothing else touches the vault.

### Wire protocol (not uniform)

REST covers only a subset, and REST mutations hard-code origin `ui`. So:

- **Reads** (`docs`, `read`, `grep`, `glob`, `thread list`, `thread show`) and
  **`--as agent` mutations** go over the **MCP tool surface** (`/api/mcp`,
  origin `agent`, the full tool set).
- **`--as ui` mutations** — the default for humans (`thread add/reply/resolve/
  reopen`) — go over **REST `/api/ui/*`**, because those stamp origin `ui` and
  thereby **wake the connected agent**. An agent-origin comment would not.
- **`events follow`** consumes the SSE stream, emitting one event per line.

## Command tree

```
sheaf --help | --version
sheaf serve   [--port N] [--host H] [--tools full|thread-only] [--allow-origin O]...
sheaf daemon  status | stop
sheaf mcp     [--doc PATH] [--tools full|thread-only] [--no-daemon]
sheaf mcp install [client...] [--name NAME] [--tools full|thread-only] [--dry-run]
sheaf docs
sheaf read    <path> [--ref REF]
sheaf grep    <pattern> [--path P] [--glob G] [-i] [-A n] [-B n] [--multiline] [--head-limit n] [--output-mode M] [--ref REF]
sheaf glob    <pattern> [--ref REF]
sheaf thread  list    [--path P] [--ref REF]
sheaf thread  show    <id>
sheaf thread  add     --path P [--range from:to | --doc] -m MSG [--as ui|agent] [--ref REF]
sheaf thread  reply   <id> -m MSG [--as ui|agent]
sheaf thread  resolve <id> [--as ui|agent]
sheaf thread  reopen  <id> [--as ui]
sheaf events  follow  [--role agent|ui] [--since ID] [--exit-on-disconnect]
```

| command | what it does |
|---------|--------------|
| `serve` | Run the daemon for a vault (owns state + events). One per vault. |
| `daemon status` / `daemon stop` | Report the daemon's address/pid, or SIGTERM it. |
| `mcp` | Run the stdio↔daemon MCP bridge (what agents connect to). |
| `mcp install` | Write an absolute stdio MCP entry into an agent's config. |
| `docs` | List the vault's documents. |
| `read` | Print a doc's markdown (`--ref` for a draft). |
| `grep` | Search doc contents (ripgrep-shaped: `-i`, `-A/-B`, output modes). |
| `glob` | List docs matching a glob (`**/*.md`). |
| `thread list` / `thread show` | List thread summaries / show one thread in full. |
| `thread add` | Start a thread anchored to a range (`--range from:to`) or the whole doc (`--doc`). |
| `thread reply` / `resolve` / `reopen` | Reply to, close, or re-open a thread. |
| `events follow` | Tail the live event stream as NDJSON. |

Global flags: `--vault/-C <dir>`, `--format text|json`, `--no-daemon`.
**Vault resolution** (highest wins): `--vault` › `$SHEAF_VAULT` › config
`defaultVault` › cwd.

### `--format json`

Text goes to stdout, diagnostics to stderr. `--format json` makes each command
emit exactly one JSON object on stdout (errors as `{ error, code }`). `events
follow` is always NDJSON regardless of `--format`. Exit codes: `0` ok, `1`
generic failure, `2` usage error, `3` no daemon.

## `sheaf mcp` and `sheaf mcp install`

`sheaf mcp` is the stdio MCP server an agent host launches: it relays JSON-RPC
between the agent (stdio) and the daemon (`/api/mcp`), so the agent gets the full
tool surface while the daemon owns the one backend. `sheaf mcp install <client>`
writes that invocation — with an **absolute** `node` + `bin/sheaf.js` path, since
GUI hosts have no PATH/cwd — into a client's config, upserting only the `sheaf`
entry and preserving everything else:

| client | target |
|--------|--------|
| `claude` | project-scope `<vault>/.mcp.json` |
| `claude-desktop` | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| `codex` | `~/.codex/config.toml` |

No client argument installs into every detected client; `--dry-run` prints the
diff and writes nothing.

## Deferred past v0.1

Agents still reach these through `sheaf mcp`; they're just not CLI verbs yet:
`write`/`edit`, `style *`, and the draft lifecycle (`fork`/`propose`/`merge`).

## Monorepo packages

`sheaf-cli` is the entrypoint; the rest are libraries it (and the legacy
embedding hosts) build on.

- [`sheaf-cli`](sheaf-cli) — **the `sheaf` binary.** Daemon, MCP bridge/installer,
  and the read/thread verbs.
- [`sheaf-server`](sheaf-server) — shared backend, MCP tool definitions, and the
  Fastify HTTP app. Pure library, no build step (consumed as TS source).
- [`obsidian-plugin`](obsidian-plugin) — Obsidian plugin. Historically embeds the
  server in-process (see the migration note below).
- [`prototype`](prototype) — Next.js web prototype (also embeds the server).

### Checks

```sh
pnpm --filter sheaf-cli build      # sheaf-cli's tests depend on the built bin
pnpm -r typecheck
pnpm -r test
```

## Migration note: embedding is deprecated

v0.1 has no legacy compatibility path — the daemon model replaces in-process
embedding of `buildSheafApp` / `buildServer`. Existing consumers keep working for
now, but should migrate to running or pointing at a `sheaf serve` daemon (and use
`sheaf mcp install` to wire agents) rather than standing up their own backend. The
concrete items:

- **Obsidian plugin — embedded server.** The plugin runs `buildSheafApp` in-process
  and violates the one-backend-per-vault invariant if a daemon is also running.
  It should spawn/point at `sheaf serve` instead of hosting its own app.
- **Obsidian plugin — agent connect strings.** These hard-code a direct
  `claude mcp add --transport http sheaf <url>/api/mcp` against the embedded
  server; they should instead run `sheaf mcp install claude` (or show that
  command):
  - `obsidian-plugin/src/views/threads-view.ts:776`
  - `obsidian-plugin/src/settings.ts:243`
  - `obsidian-plugin/README.md:43`
- **Next prototype — embedded MCP route.** `prototype/app/api/mcp/route.ts` imports
  `buildServer` from `sheaf-server` and hosts MCP itself. It should proxy to a
  `sheaf serve` daemon's `/api/mcp` rather than construct a second backend.

(These are recorded, not changed, in this step — the consumers migrate themselves.)

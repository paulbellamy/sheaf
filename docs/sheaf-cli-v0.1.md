# sheaf CLI v0.1 — plan

## Goal

Turn sheaf from "an MCP server you embed" into a **`sheaf` CLI binary** that,
among other things, **runs an MCP server** (`sheaf mcp`). Model the shape on the
Tuple CLL (`docs.tuple.app/cli/overview`): one binary, a subcommand tree,
readable text by default with `--format json`, a `mcp` subcommand that speaks
stdio, and `mcp install` to wire it into agent configs.

No legacy compatibility. Existing consumers (Obsidian plugin, Next prototype)
migrate on their own; nothing here preserves their in-process embedding.

## The one hard constraint: events are in-memory

`Backend.subscribe` + the SSE replay buffer live in a single backend instance's
memory. Docs/threads/drafts persist to disk (vault `.md` endmatter, `.drafts/`,
`.sheaf/`), so *state* crosses processes for free — but *live wake events*
(`thread_changed`, `doc_changed`, …) do not. An agent process cannot be woken by
a human's edit unless it shares the process that owns the event bus.

Therefore the architecture is **one running server + thin clients**, the Tuple
model:

- **`sheaf serve`** is the one process that owns the `Backend` and the event
  bus. It binds loopback HTTP and serves the existing surface (UI REST, SSE at
  `/api/ui/drafts/stream`, MCP Streamable-HTTP at `/api/mcp`). It is the vault's
  daemon.
- **Everything else is a client** of that daemon over loopback HTTP: the domain
  subcommands, `events follow`, and `sheaf mcp`. Single backend instance ⇒ one
  source of truth, one event bus, no cache-coherence problem.
- If no daemon is running for the target vault, a client **auto-spawns one**
  (detached) and waits for ready, unless `--no-daemon` is passed (then it errors
  with a clear message). This mirrors Tuple's "commands wait for the app."

## Vault, discovery, config

- **Vault resolution** (highest wins): `--vault/-C <dir>` › `SHEAF_VAULT` env ›
  config `defaultVault` › cwd. The vault is the backend data root
  (`SHEAF_DATA_ROOT`) and plugin root.
- **Daemon discovery**: on listen, `serve` writes
  `~/.sheaf/daemons/<vaultkey>.json` (mode 0600) =
  `{ pid, host, port, vault, startedAt, version }`; removes it on clean close.
  `vaultkey` = a stable hash of the absolute vault path. Clients read it, verify
  the pid is alive (and vault matches), else treat as stale and re-spawn.
- **Config**: `~/.sheaf/config.json` (zod-validated; mode 0600 on write). Keys:
  `defaultVault?`, `defaultPort?`, `mcp.install` prefs. JSON, not TOML, to avoid
  a new dep and match the `--format json` ethos. (TOML is the Tuple parallel if
  we later want it.)

## Package + build

- New workspace package **`sheaf-cli`** depending on `sheaf-server`
  (`workspace:*`). Keeps the server a pure library; the CLI is the binary.
- Build with **esbuild** (already the repo's bundler via the Obsidian plugin) →
  `bin/sheaf.js` with a `#!/usr/bin/env node` shebang. `package.json`
  `"bin": { "sheaf": "bin/sheaf.js" }`. Add `sheaf-cli` to `pnpm-workspace.yaml`.
- Tests: `vitest`, same as the rest of the repo.

## Command tree (v0.1)

```
sheaf --help | --version
sheaf serve   [--port N] [--host H] [--allow-origin O]...   # the daemon
sheaf mcp                                                    # stdio MCP for agents
sheaf mcp install [client...] [--name NAME] [--dry-run]      # wire into agent configs
sheaf docs                                                   # list docs
sheaf read   <path> [--ref REF]                              # print a doc
sheaf grep   <pattern> [--path P] [--glob G] [-i] ...        # search
sheaf glob   <pattern> [--ref REF]
sheaf thread list   [--path P] [--ref REF]
sheaf thread show   <id>
sheaf thread add    --path P [--range from:to | --doc] -m MSG [--as ui|agent]
sheaf thread reply  <id> -m MSG [--as ui|agent]
sheaf thread resolve <id>
sheaf thread reopen  <id>
sheaf events follow  [--role agent|ui] [--since ID]          # JSON-lines event stream
```

Global flags: `--vault/-C`, `--format text|json` (default `text`), `--no-daemon`.
Deferred to a later cut (not v0.1): `sheaf write/edit`, `sheaf style *`, draft
lifecycle (`fork/propose/merge`) as CLI verbs. They stay reachable via `sheaf
mcp` for agents; humans get the read + thread surface first.

## `sheaf mcp` — the bridge

`sheaf mcp` gives the agent a **stdio** MCP server (what `mcp install` points
Claude/Codex at) but must share the daemon's backend + events. Preferred
implementation: a **transport-layer proxy** — read the agent side with
`StdioServerTransport`, open a `StreamableHTTPClientTransport` to the daemon's
`/api/mcp`, and shuttle JSON-RPC messages both directions (`send`/`onmessage`).
No JSON-RPC re-interpretation, ~small. It auto-spawns the daemon if absent.

Fallback if the transport proxy is awkward with the SDK: implement an
`HttpBackend implements Backend` (calls the daemon) and run
`buildServer(httpBackend)` over stdio — reuses all tool code but requires the
daemon to expose every `Backend` method, so it's more surface. Prefer the proxy.

Liveness for the agent no longer uses a raw `curl` one-liner: the MCP `ReadMe`
tool is updated to tell the agent to subscribe via **`sheaf events follow
--role agent`** (which proxies the daemon SSE as JSON lines). The Monitor
wrapper stays; only the command inside it changes.

## `sheaf mcp install`

Writes an stdio MCP server entry (`command: "sheaf", args: ["mcp"]`, cwd/vault
env as needed) into detected agent configs, Tuple-style:

| client         | config path                                            |
|----------------|--------------------------------------------------------|
| claude         | `~/.claude.json`                                       |
| claude-desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| codex          | `~/.codex/config.toml`                                  |

`install` with no arg = every detected client. `--name` overrides the server
key (default `sheaf`). `--dry-run` prints the diff without writing. Idempotent:
re-running updates the existing entry in place. Back up / preserve unrelated
keys; never clobber the whole file.

## Steps (each: clean subagent implements → fable reviews → integrate)

1. **CLI skeleton + build + config + vault resolution.** `sheaf-cli` package,
   esbuild → `bin/sheaf.js`, subcommand dispatch, global flags, `--help`,
   `--version`, vault resolution, `~/.sheaf/config.json` load/save (0600). Stub
   subcommands that error "not implemented". Unit tests for arg parse, vault
   resolution precedence, config round-trip.
2. **`sheaf serve` + daemon discovery.** Wrap `buildSheafApp` as `serve`;
   write/remove the discovery file (0600); port-in-use handling; a
   `findDaemon(vault)` helper (read file, verify pid + vault). Tests: discovery
   write/read/stale-detection; `serve` answers `GET /api/ui/docs`.
3. **Client core + read commands.** Loopback HTTP client; auto-spawn daemon +
   wait-for-ready; `--no-daemon`. Implement `docs`, `read`, `grep`, `glob`,
   `thread list`, `thread show`. Text + `--format json`. Tests against a live
   daemon on a temp vault.
4. **Thread write commands + `events follow`.** `thread add|reply|resolve|
   reopen` (with `--as`), and `events follow` (SSE→JSON-lines, reconnect loop,
   `--role`, `--since`). Tests: mutate a thread via CLI, observe the event on a
   concurrent `follow`.
5. **`sheaf mcp` stdio bridge.** Transport proxy stdio↔daemon `/api/mcp`;
   auto-spawn daemon. Update the MCP `ReadMe` to use `sheaf events follow`.
   Tests: `initialize` + `tools/list` + a `ReadMe` call round-trip through the
   bridge to a live daemon.
6. **`sheaf mcp install` + docs.** Config writers for claude/claude-desktop/
   codex (idempotent, `--dry-run`, `--name`); rewrite root `README.md`, add a
   CLI usage section, update the `docs/` references, note consumer migration.
   Tests: install into temp config files (fresh + pre-existing).

## Risks / for fable to scrutinize

- The `sheaf mcp` bridge mechanism (transport proxy vs HttpBackend) — is the
  proxy actually clean against `@modelcontextprotocol/sdk` ≥1.29? Pin the exact
  transport classes.
- Auto-spawn semantics: detached lifetime, who kills the daemon, races when two
  clients spawn at once (discovery-file lock / atomic create).
- Does `StubBackend` cache anything that makes even single-daemon reads stale
  across its own writes? (Confirm during step 2.)
- Windows paths / `~/.sheaf` on non-POSIX — scope v0.1 to POSIX, say so.
- Is a 6-step cut the right granularity, or should read vs write split differ?

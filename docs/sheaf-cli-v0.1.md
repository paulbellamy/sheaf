# sheaf CLI v0.1 — plan

> Reviewed once by a clean Fable pass; verdict **revise**, all P1/P2 folded in
> below. v0.1 is **POSIX-only** (macOS/Linux); Windows is out of scope.

## Goal

Turn sheaf from "an MCP server you embed" into a **`sheaf` CLI binary** that,
among other things, **runs an MCP server** (`sheaf mcp`). Shape follows the
Tuple CLI: one binary, a subcommand tree, readable text by default with
`--format json`, a `mcp` subcommand over stdio, `mcp install` to wire it into
agent configs, and — the load-bearing part — **the CLI talks to one running
server** rather than standing up its own copy of the world.

No legacy compatibility. Obsidian plugin and Next prototype migrate themselves;
nothing here preserves their in-process embedding.

## The invariant: exactly one backend per vault

Not "state crosses processes for free." `StubBackend` keeps critical state in a
single instance's memory:

- `versionCounters` / `versionHistory` — **in-memory only** (`stub.ts:288-300`,
  comment says so). Two instances ⇒ diverging `vN` and broken merge-conflict
  detection.
- `.op_log.json` is **write-through cached** (`opLogCache`, `:263`,`:511-534`) —
  two writers clobber each other's idempotency log.
- Mutations serialize through a per-instance `lockChain` (`:264`,`:414`) — two
  instances ⇒ unserialized `.md`/endmatter writes, i.e. corruption.
- Agent presence + the SSE replay buffer + `subscribe` are per-instance.

So the invariant is hard: **for a given vault there is exactly one live
`StubBackend`, inside exactly one process.** That process is the daemon. Docs
and thread bodies happen to also live on disk, but that does not make a second
backend safe. Everything that isn't the daemon is a **client** of it over
loopback HTTP.

A daemon-less `sheaf mcp --no-daemon` (its own backend) is a documented escape
hatch, valid **only** when nothing else touches the vault (no Obsidian, no UI) —
in which case there are no human events to miss anyway. Not the default.

## Architecture: one daemon + thin clients

- **`sheaf serve`** = the daemon. Owns the one `StubBackend(vault, vault)`
  (constructed directly — **not** via `getBackend()`'s env/cwd factory). Binds
  loopback on an **ephemeral port** and serves the existing surface: UI REST
  (`/api/ui/*`), SSE (`/api/ui/drafts/stream`), MCP Streamable-HTTP
  (`/api/mcp`), plus a new `GET /api/health`.
- **Clients** (domain verbs, `events follow`, `sheaf mcp`) find the daemon via a
  discovery file and speak loopback HTTP. No client ever constructs a backend
  (except `mcp --no-daemon`).
- **Auto-spawn is restricted to `sheaf mcp`** — the only client with no human at
  the keyboard. Every other command, finding no daemon, exits with
  `no sheaf daemon for <vault>; run \`sheaf serve\`` (exit 3). This is the real
  Tuple behavior ("Tuple must be running") and collapses the spawn race to one
  code path.

### Wire protocol, per command (this is not uniform)

REST covers only a subset — there is **no** `grep`/`glob`/`thread show` REST
route, and REST mutations hard-code origin `ui`. So:

- **Reads** (`docs`, `read`, `grep`, `glob`, `thread list`, `thread show`) and
  **`--as agent` mutations** → the **MCP tool surface** via an SDK `Client` +
  `StreamableHTTPClientTransport` to `/api/mcp` (origin `agent`, tools cover
  everything). Do **not** add REST routes for these in v0.1.
- **`--as ui` mutations** (default for humans: `thread add/reply/resolve/
  reopen`) → **REST `/api/ui/*`**, because those stamp origin `ui` and thereby
  **wake the connected agent**. An agent-origin comment would not.
- **`events follow`** → the SSE stream.

Default `--as ui`. The CLI therefore carries both a tiny REST client and an MCP
client; they share the transport dep with the `sheaf mcp` bridge.

## Discovery, health, lifecycle

Discovery/registration lives in **`sheaf-server`** (new `sheaf-server/daemon`
subpath), not `sheaf-cli`, so any embedding host could register as *the* daemon
and CLI clients would find it instead of spawning a second backend.

- `registerDaemon(vault, host, port)` writes `$SHEAF_HOME/daemons/<key>.json`
  (mode 0600) = `{ pid, host, port, vault, startedAt, version }` and returns a
  disposer that removes it. `key` = hash of `realpath(vault)`.
- **`$SHEAF_HOME`** defaults to `~/.sheaf` (dir mode 0700), overridable — so
  tests never touch the real home. Config, daemons/, locks, logs all live under
  it.
- **Spawn lock**: before listening, `serve` claims
  `$SHEAF_HOME/daemons/<key>.lock` via `openSync(..., "wx")`. A loser exits 0;
  clients poll the discovery file (backoff, ~5s cap) rather than spawning again.
- **Health**: `GET /api/health` → `{ vault, pid, startedAt, version }`.
  Liveness = discovery file present **and** `/api/health`'s `vault ===
  realpath(target)` (not just `process.kill(pid,0)`, which pid-reuse defeats).
- **Lifecycle**: `sheaf daemon status|stop` (`stop` = SIGTERM the pid). `serve`
  installs SIGTERM/SIGINT handlers that remove the discovery file and
  `app.close()`. Idle-exit after 30 min with zero SSE clients and no MCP request
  (so auto-spawns don't become permanent orphans). Daemon logs to
  `$SHEAF_HOME/logs/<key>.log` via file fds; a spawned daemon **never inherits
  the parent's stdio** (the bridge's stdout is the MCP wire).

## Package + build

- New workspace package **`sheaf-cli`** (`"type":"module"`) depending on
  `sheaf-server` (`workspace:*`). Add it to `pnpm-workspace.yaml`. Server stays
  a pure library.
- **esbuild** bundle → `bin/sheaf.js`, `banner:{js:"#!/usr/bin/env node"}`,
  `platform:"node"`, `format:"esm"`, `target:"node20"`, first-party TS bundled,
  `node_modules` deps **external** (resolved at runtime from the install).
  `--version` injected via esbuild `define` from `package.json`. `package.json`
  `"bin": { "sheaf": "bin/sheaf.js" }`.
- **Reject** `node --strip-types`: CI is Node 20 (`.github/workflows/ci.yml`)
  and sources use extensionless imports.
- Arg parsing: **`node:util.parseArgs`** + hand-written help tables (zero deps).
- Tests: `vitest`. `sheaf-cli`'s `test` **depends on `build`** (auto-spawn and
  bridge tests exec the real `bin/sheaf.js`). Add a CI smoke step:
  `node bin/sheaf.js --version`.
- Codex install needs TOML → add **`smol-toml`** (round-trips) as a `sheaf-cli`
  dep. (Resolves the earlier "no TOML dep" contradiction.)

## Output contract

- Text → **stdout**; diagnostics/logs → **stderr**.
- `--format json` → exactly one JSON object per command on stdout.
- `events follow` → always **NDJSON** (one event per line), regardless of
  `--format`; pings dropped.
- Error JSON `{ error, code }` mirroring `errorResult`.
- Exit codes: `0` ok, `1` generic failure, `2` usage error, `3` no daemon.

## Command tree (v0.1)

```
sheaf --help | --version
sheaf serve   [--port N] [--host H] [--tools full|thread-only] [--allow-origin O]...
sheaf daemon  status | stop
sheaf mcp     [--doc PATH] [--tools full|thread-only] [--no-daemon]
sheaf mcp install [client...] [--name NAME] [--dry-run]
sheaf docs
sheaf read    <path> [--ref REF]
sheaf grep    <pattern> [--path P] [--glob G] [-i] [-A n] [-B n] ...
sheaf glob    <pattern> [--ref REF]
sheaf thread  list   [--path P] [--ref REF]
sheaf thread  show   <id>
sheaf thread  add    --path P [--range from:to | --doc] -m MSG [--as ui|agent]
sheaf thread  reply  <id> -m MSG [--as ui|agent]
sheaf thread  resolve <id>
sheaf thread  reopen  <id>
sheaf events  follow [--role agent|ui] [--since ID]
```

Global flags: `--vault/-C <dir>`, `--format text|json`, `--no-daemon`.
**Vault resolution** (highest wins): `--vault` › `SHEAF_VAULT` › config
`defaultVault` › cwd.

Deferred past v0.1 (agents still reach them via `sheaf mcp`): `write`/`edit`
verbs, `style *`, draft lifecycle (`fork/propose/merge`) as CLI verbs.

## `sheaf mcp` — the stdio bridge

Gives the agent a stdio MCP server (what `mcp install` points at) while the
daemon owns the backend. Implementation = **transport relay**: agent side
`StdioServerTransport` (`@modelcontextprotocol/sdk/server/stdio.js`), daemon
side `StreamableHTTPClientTransport`
(`@modelcontextprotocol/sdk/client/streamableHttp.js`); shuttle JSON-RPC both
ways. Works because the daemon is stateless (`listChanged:false`) and never
pushes server-initiated messages. Required details (verified against SDK
1.29.0):

- Make `/api/mcp` **GET return 405** — else the client's post-`initialized` auto
  GET-stream leaves a zombie `buildServer`+socket alive for the bridge's life
  (the client tolerates 405).
- On daemon death `send()` throws and nothing reaches stdout → the agent hangs.
  The relay **must** sniff in-flight request `id`s and synthesize a JSON-RPC
  `-32603` error for each. (So: not literally zero JSON-RPC awareness.)
- Exit the process on stdin `end` (`StdioServerTransport` has no such handler,
  so the bridge would outlive its host).
- Sniff the `initialize` result and call `setProtocolVersion` (no `Client`
  wrapper does it for us).
- All bridge logging to **stderr**; stdout is the wire.
- `--doc PATH` → `requestInit.headers["x-sheaf-doc"]` (ACP per-doc scope).
- Auto-spawn the daemon if absent (poll the lock/discovery, don't double-spawn);
  spawned daemon gets its own stdio, never the bridge's.
- Known limit to document: stateless proxying is complete only while the server
  never initiates (no elicitation/sampling/listChanged).

Alt (`fetch` POST per stdio message, `enableJsonResponse:true` guarantees JSON
bodies, no GET side effect, ~30 lines) is acceptable; the SDK-client relay and
raw-fetch relay are the two sanctioned options — the implementer pins one.
`HttpBackend implements Backend` is rejected (~30 methods, moves tool semantics
into the bridge).

## `sheaf mcp install`

Writes an stdio MCP entry with **absolute** invocation (GUI hosts have no PATH /
cwd): `command: process.execPath`, `args: [<abs bin/sheaf.js>, "mcp",
"--vault", <abs vault>]`.

| client         | target                                                             |
|----------------|--------------------------------------------------------------------|
| claude         | project-scope `<vault>/.mcp.json` (preferred; `~/.claude.json` gets rewritten by Claude Code on exit) |
| claude-desktop | `~/Library/Application Support/Claude/claude_desktop_config.json`  |
| codex          | `~/.codex/config.toml` (via `smol-toml`)                           |

No arg = every detected client. `--name` overrides the server key (default
`sheaf`). `--dry-run` prints the diff, writes nothing. Idempotent: update the
existing entry in place; preserve all unrelated keys; never rewrite the whole
file blind.

## Steps (each: clean subagent implements → Fable reviews → integrate)

1. **CLI skeleton + build + config + vault resolution.** `sheaf-cli` package,
   esbuild → `bin/sheaf.js`, `parseArgs` dispatch, global flags, `--help`,
   `--version`, vault resolution precedence, `$SHEAF_HOME` + `config.json`
   load/save (0600 / dir 0700). Stubbed subcommands. Output contract + exit
   codes. Unit tests: arg parse, vault precedence, config round-trip, `$SHEAF_
   HOME` isolation.
2. **`sheaf serve` + discovery + health + lifecycle.** Construct
   `new StubBackend(vault, vault)`, run `buildSheafApp` on an ephemeral port;
   add `GET /api/health` and make `/api/mcp` GET → 405 (both in `sheaf-server`).
   `sheaf-server/daemon`: `registerDaemon`/`findDaemon`/lock/`realpath` liveness.
   `serve` SIGTERM/SIGINT cleanup + idle-exit; `daemon status|stop`. Tests:
   discovery write/read/stale, lock contention (2nd `serve` loses), health, GET
   `/api/mcp` 405, serve answers `/api/ui/docs`.
3. **Client core + `events follow`.** REST client + MCP `Client`
   (`StreamableHTTPClientTransport`); daemon locate; **error-not-spawn** for
   non-`mcp` commands (`--no-daemon` errors clearly). `events follow` (SSE →
   NDJSON, reconnect loop, `--role`, `--since`). Tests against a live daemon on a
   temp vault; mutate via REST, observe event on a concurrent `follow`.
4. **`sheaf mcp` stdio bridge + ReadMe.** Transport relay per above; auto-spawn
   daemon (no stdio inheritance); GET-405 reliance, `-32603` synth, stdin-end
   exit, `setProtocolVersion`, `--doc`→header. Update the MCP **ReadMe**
   (`readme.ts`) to lead with `sheaf events follow --role agent`, keep the curl
   loop as fallback but built from the daemon's **actual** bound host:port (pass
   a `publicUrl` into `buildServer` instead of the hard-coded `localhost:31415`
   at `readme.ts:174`). **Update `app.test.ts:77-103`** (asserts the old
   one-liner). Tests: `initialize`+`tools/list`+`ReadMe` round-trip through the
   bridge to a live daemon; daemon-death yields `-32603`.
5. **`sheaf mcp install`.** Config writers for claude (project `.mcp.json`),
   claude-desktop (JSON), codex (`smol-toml`); absolute `execPath`+args;
   idempotent; `--dry-run`; `--name`. Tests: install into temp config files,
   fresh + pre-existing (preserve unrelated keys), dry-run writes nothing.
6. **Read/thread verbs + docs.** `docs`, `read`, `grep`, `glob`, `thread list/
   show` via MCP; `thread add/reply/resolve/reopen` via REST (`--as`). Rewrite
   root `README.md`; add a CLI usage doc; update `docs/` references; list
   consumer-migration items (Obsidian connect strings at
   `obsidian-plugin/src/views/threads-view.ts:776`, `settings.ts:243`,
   `obsidian-plugin/README.md:43`). Tests: each verb against a live daemon,
   text + `--format json`.

Order rationale: the agent-facing MVP (serve → client/events → mcp → install)
lands before the human read/thread verbs.

## Open items intentionally deferred to v0.2

- `fs.watch`-based daemon-less event synthesis (fragile vs Obsidian atomic
  writes).
- Persisting `versionCounters`/`versionHistory` (production backend concern).
- Windows support.
- `write`/`edit`/`style`/draft-lifecycle CLI verbs.

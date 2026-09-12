# sheaf CLI — usage

A full walkthrough of the `sheaf` binary: start the daemon, wire it into an
agent, post a thread the agent reacts to, and watch events stream. See the
[root README](../README.md) for the daemon model and the full command tree, and
[docs/sheaf-cli-v0.1.md](sheaf-cli-v0.1.md) for the design.

Throughout, `sheaf` means the built binary (`sheaf-cli/bin/sheaf.js`); build it
with `pnpm --filter sheaf-cli build`. Every command resolves its target vault
from `--vault/-C` › `$SHEAF_VAULT` › config `defaultVault` › cwd, so from inside
a vault you can drop `--vault`.

## 1. Run the daemon

One daemon owns each vault. Start it in a terminal (or background it):

```sh
sheaf serve --vault ~/notes
# → sheaf daemon listening at http://127.0.0.1:<ephemeral>
#   vault: /Users/you/notes
```

It binds loopback on an ephemeral port, registers itself under `$SHEAF_HOME`
(default `~/.sheaf`), and stays up until you stop it or it idles out. Check or
stop it from anywhere:

```sh
sheaf daemon status --vault ~/notes    # running — 127.0.0.1:52413 (pid 40122)
sheaf daemon stop   --vault ~/notes    # SIGTERM + wait for clean shutdown
```

Any client that can't find a daemon exits `3` (`no sheaf daemon for <vault>; run
\`sheaf serve\``) — it will not silently spin up a second backend.

## 2. Browse and read

These reads go over the MCP tool surface; text by default, `--format json` for
the raw structured payload.

```sh
sheaf docs                          # list every doc in the vault
sheaf read proposal.md              # print the doc's markdown
sheaf read proposal.md --ref draft_1c2f…   # read from a draft ref
sheaf glob 'notes/**/*.md'          # docs matching a glob
sheaf grep 'invariant' --output-mode content -i -A1   # ripgrep-shaped search
sheaf --format json grep 'invariant'                   # raw GrepResult
```

`grep` supports `--path`, `--glob`, `-i` (ignore case), `-A n`/`-B n` (context),
`--multiline`, `--head-limit n`, and `--output-mode content|files_with_matches|count`
(default `files_with_matches`).

## 3. Install sheaf into an agent

`sheaf mcp` is the stdio MCP server an agent connects to; it relays to the
daemon. `sheaf mcp install` writes the invocation into an agent's config with an
absolute `node` + `bin/sheaf.js` path (so GUI hosts with no PATH still launch it):

```sh
sheaf mcp install claude --vault ~/notes     # → <vault>/.mcp.json
sheaf mcp install                            # every detected client
sheaf mcp install codex --dry-run            # print the diff, write nothing
```

Then launch the agent (e.g. `claude`) from a context that reads that config. The
agent calls `ReadMe` on connect for its operating guide and subscribes to events
with `sheaf events follow --role agent`.

## 4. Post a thread the agent reacts to

Comment on a passage. The default `--as ui` routes through REST so the daemon
stamps origin `ui` and **wakes the connected agent** (an `--as agent` comment
would not):

```sh
# anchor to a character range [from:to)
sheaf thread add --path proposal.md --range 120:180 -m "tighten this sentence"
# → created thread thrd_9f3c…

# or comment on the whole doc
sheaf thread add --path proposal.md --doc -m "add a conclusion"
```

Exactly one of `--range` or `--doc` is required (else a usage error, exit `2`).
Watch the queue and drill in:

```sh
sheaf thread list                        # id, status, target paths, preview
sheaf thread list --path proposal.md     # filter to one doc
sheaf thread show thrd_9f3c…             # targets + anchors + every message
sheaf --format json thread show thrd_9f3c…
```

Reply, resolve, or re-open — again `--as ui` by default:

```sh
sheaf thread reply   thrd_9f3c… -m "actually, keep the second clause"
sheaf thread resolve thrd_9f3c…          # status → accepted
sheaf thread reopen  thrd_9f3c…          # status → open
```

`--as agent` reroutes `add`/`reply`/`resolve` through the MCP tools (origin
`agent`). Two combinations have no agent equivalent and error as usage: `thread
reopen --as agent` (there is no `ReopenThread` MCP tool) and `thread add --doc
--as agent` (the `AddThread` tool anchors to a char range only).

## 5. Follow events

Tail the live stream as NDJSON (one JSON event per line, pings dropped),
regardless of `--format`:

```sh
sheaf events follow                      # role ui (a passive human tail)
sheaf events follow --role agent         # flips the plugin's "agent connected"
sheaf events follow --since <id>         # resume from an SSE id
```

It runs until interrupted, reconnecting across daemon restarts; pass
`--exit-on-disconnect` for a bounded, script-friendly lifetime. Each line is a
`BackendEvent`, e.g.:

```
{"kind":"thread_changed","thread_id":"thrd_9f3c…","target_paths":["proposal.md"]}
{"kind":"doc_changed","path":"proposal.md"}
```

## `--format json` and exit codes

Text → stdout, diagnostics → stderr. `--format json` emits exactly one JSON
object per command on stdout; errors render as `{ error, code }`. Exit codes:
`0` ok, `1` generic failure, `2` usage error, `3` no daemon.

## Escape hatch: `--no-daemon`

`--no-daemon` is only valid for `sheaf mcp` (a lone in-process backend, safe only
when nothing else touches the vault). On any other command it's a misuse and
exits `3`. All the read/thread verbs require a running daemon.

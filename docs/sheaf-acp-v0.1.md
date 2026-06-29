# sheaf — acp integration design v0.1

*replace the hand-rolled mcp+sse+curl-loop agent channel with the agent client
protocol. obsidian becomes an acp client; the agent is a spawned subprocess.
threads stay the domain model; acp is the transport, streaming, permission, and
file-i/o layer.*

> scope: the obsidian plugin's agent integration only. storage model, md↔ycrdt
> sync, comment anchoring, and the web prototype's draft workflow are unchanged
> except where noted. this doc settles the architecture before any code lands.

---

## 1. thesis

the plugin already tries to be an acp client — it just predates the protocol
and reinvents the pieces by hand on top of mcp + sse. acp ([spec][acp]) is
purpose-built for editor↔agent integration, where mcp is built for exposing
tools *to* an agent. today sheaf uses mcp "backwards" (the editor hosts tools
the agent calls) and bolts a bespoke event/loop/permission protocol on top.
most of that bespoke layer is acp, badly.

| hand-rolled today | acp-native |
|---|---|
| user runs `claude mcp add … :31415`, then types a "watch for events…" prompt | `initialize` + plugin spawns the agent subprocess |
| agent learns the loop from the `ReadMe` mcp tool | capability negotiation + `session/new` |
| `Monitor({ command: "while true; curl -sN …/stream \| sed …" })` faking server-push into mcp | `session/update` notifications (native streaming) |
| `ReplyThread("on it")` as the "agent working" signal | `tool_call` status + `agent_message_chunk` |
| agent mirrors threads into `TodoWrite` so the user can watch | `plan` updates |
| agent writes `main` directly on disk, last-write-wins | `fs/write_text_file` serviced by the client → ydoc |
| `AttachDraftPayload` + `chooseVariant` + "Selected option N" reply | diff content blocks + `session/request_permission` options |
| `agent_presence` inferred from an sse `?role=agent` query param | the plugin owns the process; presence is trivial |
| no way to stop the agent from inside obsidian | `session/cancel` |

[acp]: https://agentclientprotocol.com

---

## 2. architecture

three layers, cleanly separated. acp does **not** replace the sheaf store; it
replaces the *agent channel*.

```
┌─────────────────────────── obsidian plugin (electron renderer) ───────────────────────────┐
│                                                                                            │
│  embedded sheaf-server (fastify, 127.0.0.1:31415)                                          │
│    • thread store + persistence (vault root = data root)                                   │
│    • /api/ui/*  — the plugin UI's data api + sse (role=ui only)                            │
│    • /api/mcp   — sheaf DOMAIN tools only (threads); no Read/Edit/Write (see §5)           │
│                                                                                            │
│  acp client                                                                                │
│    • spawns the adapter subprocess (claude-code-acp | codex-acp) over stdio                │
│    • initialize → session/new(cwd=vault, mcpServers=[sheaf /api/mcp?doc=<path> via http])  │
│    • services fs/read_text_file & fs/write_text_file → ydoc (client-write path)            │
│    • renders session/update (thoughts, plan, tool calls) in the threads panel              │
│    • answers session/request_permission with the keep/discard/propose gate                 │
│                                                                                            │
└────────────────────────────────────────────┬───────────────────────────────────────────-─┘
                                              │ acp / json-rpc / stdio
                                  ┌───────────▼────────────┐
                                  │  adapter subprocess     │
                                  │  (claude-code-acp …)    │──── mcp/http ──▶ sheaf /api/mcp?doc=<path>
                                  └─────────────────────────┘     (thread tools, doc-scoped)
```

the unlock: **acp carries mcp.** `session/new` takes an `mcpServers` list (stdio
or http transport) that the agent must connect to ([session-setup][setup]). so
the plugin hands the agent its own thread tools automatically — no user-typed
`claude mcp add`. acp handles lifecycle/streaming/permissions/fs; mcp-over-acp
handles sheaf's domain. they compose; it was never either/or. crucially the
registration is **per session**, so each doc's session gets the sheaf mcp
**scoped to that doc** (§3.1) — the agent only ever sees its own doc's threads.

[setup]: https://agentclientprotocol.com/protocol/session-setup

---

## 3. session model — one session per doc

the doc is the natural concurrency boundary.

- acp prompt turns are **serial within a session** (prompt → stream → stop
  reason → next). a per-doc session therefore works that doc's threads one at a
  time — exactly right, since two agent turns must never edit the same ydoc
  concurrently or the crdt/anchors go sideways. serial-within-a-doc is a feature.
- different docs are different sessions, so doc A and doc B run **concurrently**.
  per-doc buys "parallel across docs, serial within a doc" for free.

mechanics:

- **one process, many sessions.** per-doc ≠ a process per doc. the single
  adapter multiplexes N sessions over one stdio connection (each `session/new`
  → its own `sessionId`).
- **resume** via `session/load`, keyed by doc path. reopen the doc later → the
  agent remembers the prior discussion on it. the plugin persists a
  `docPath ↔ sessionId` map; `session/load` resends `cwd` + `mcpServers`.
- **no open tab required.** reads/writes are `fs/*` on absolute paths, so a
  doc's session can be serviced even when the doc isn't in a visible tab. v0:
  spawn a doc's session lazily on first thread activity for that doc.
- **how a thread becomes a turn.** a new/changed thread on doc X → the plugin
  issues `session/prompt` on X's session, carrying the brief + anchor as content
  blocks. the agent's `session/update`s render on the thread card; its `fs/write`
  flows through the ydoc; `request_permission` is the accept gate; on stop the
  thread is resolved.

### 3.1 the queue is doc-scoped, server-enforced

per-doc sessions only hold if the agent's **work queue** is also per-doc.
today it isn't: `ListThreads`'s `path` is optional and the `ReadMe` loop tells
the agent to call `ListThreads(ref:"main")` with no path — pulling **every
doc's** open threads (the whole-vault queue). that's correct for the current
one-global-agent model and wrong for per-doc sessions: doc X's session would
see, and could grab, doc Y's work.

fix: bind the doc scope into the **per-session mcp registration** so isolation
is a property of the wiring, not agent discipline. the http `mcpServers` entry
carries `url` + `headers` ([session-setup][setup]), so X's session registers the
sheaf mcp as `…/api/mcp?doc=<X>` (or an `X-Sheaf-Doc: <X>` header). the server
reads that scope and:

- defaults `ListThreads` `path` to the scope doc and ignores a wider request —
  the connection cannot enumerate other docs' threads.
- clamps `ReadThread` / `AddThread` / `ReplyThread` / `ResolveThread` /
  `AttachDraftPayload` to threads targeting the scope doc; a `thread_id` or
  target outside it is rejected.

one embedded server still serves every doc — the scope rides per request, so
each session's connection is independently clamped. the `ReadMe` loop loses its
"load the whole queue" step; "your queue" becomes "this doc's open threads."

**Implemented** server-side: `buildServer` takes `docScope`; the `/api/mcp`
route resolves the scope per request — `?doc=` (precedence) or the `X-Sheaf-Doc`
header — and passes it to `buildServer` per connection. Resolution fails
**closed**: a repeated/array param or a non-vault path is rejected
(`invalid_path`, 400), never silently widened to the whole vault. The thread
tools clamp accordingly (`out_of_scope`, 403, on violation). The ACP client that
sets `?doc` per session is the next phase; the `ReadMe` rewrite lands with it.

a **cross-cutting** thread (targets X *and* Y) surfaces in both sessions' queues
(any target matches the scope). that's correct, but it breaks serial-within-doc
across the two — folded into the deferred multi-target edge below.

rejected alternatives: per-*thread* (too granular — loses "make §4 match the
change you just made in §2" context, churns sessions); per-*workspace*
(over-serializes — one comment blocks every doc).

deferred edges (not plugin scope in v0):

- **cross-cutting threads** (multi-target) don't fit per-doc cleanly. the plugin
  only creates single-target threads today (`sheaf-client.ts` sends one target),
  so it's a non-issue now. later: route a multi-target thread to its primary
  target's session, or a workspace-level session.
- **multi-agent** = one session-set per connected agent. v0 connects one agent
  at a time, so it doesn't arise.

---

## 4. file i/o — client-write path

doc reads/writes come back as acp `fs/read_text_file` / `fs/write_text_file`,
which the **client** services ([spec][fs]):

- **writes route through the ydoc**, not a raw disk stomp. this is where the
  §4.2 md↔ycrdt reconciliation moves to — from a git-push-time fixup to the
  client write path. comment anchors survive because the edit lands as ydoc ops.
- **reads return the live doc**, including the user's unsaved buffer — the
  "human + agent racing on the same file" feel the prototype wants to test,
  instead of stale-on-disk.
- **last-write-wins goes away.** the client owns the write; it serializes the
  agent's edit against the editor's own state instead of clobbering it.

consequence: **sheaf's mcp server sheds its `Read`/`Edit`/`Write` tools.** those
become acp `fs/*` calls the client mediates. the adapter already routes the
agent's native file edits through acp fs (that's how zed shows + gates diffs), so
the sheaf mcp surface shrinks to threads-only and the `ReadMe` loop gets shorter.

[fs]: https://agentclientprotocol.com/protocol/file-system

---

## 5. tool surface changes

the embedded mcp server keeps only **domain** tools and gates the draft tools by
mode.

- **keep (thread-on-doc):** `ListThreads`, `ReadThread`, `ReplyThread`,
  `ResolveThread`, `AddThread`, `AttachDraftPayload`, `Glob`, `Grep`, `ReadMe`.
  the thread tools are **doc-scoped** on a scoped connection (§3.1) — `path` is
  implied by the session's scope, not supplied by the agent.
- **drop from the plugin's surface:** `Read`, `Edit`, `Write` → now acp `fs/*`
  (deferred — these stay registered until the acp fs path exists).
- **gate by surface, don't delete:** `Fork`, `Propose`, `Merge`, `DeclineDraft`,
  `DraftChanges`. The whole draft surface is omitted in `tools: "thread-only"`
  (the option `buildServer`/`buildSheafApp` take); `fork()` etc. stay in the
  backend for the web prototype. **Implemented.**

on `Fork` specifically: it is **load-bearing in `sheaf-server`, not dead code.**
the bare `Fork` mcp tool is unused by the plugin, but `backend.forkAndAttachThreads()`
is the Start-Draft primitive behind the entire draft/propose/merge workflow the
**web prototype** uses (`handlers.ts`, `DraftBanner`, `DocRail`, heavy coverage
in `tools.test.ts`). ripping `fork()` out of the backend would tear out drafts
and break the web prototype. decision: **gate tool registration by mode** — the
plugin's embedded server registers the thread-only set; `fork()` stays in the
backend for the web prototype.

---

## 6. permissions, progress, modes

- **permissions.** `session/request_permission` is the accept/decline gate the
  design doc wants ("the word on the button is **accept**"). map its options
  onto **keep / discard / propose**; auto-allow reads/greps, gate writes. this
  finally delivers the human-gated change the prototype punts on.
- **progress.** `session/update` streams `agent_thought_chunk`, `plan`, and
  per-`tool_call` status into the thread card / a side panel. the "agent working"
  indicator becomes real ("reading doc → editing §3 → resolving") instead of a
  heuristic on message authorship. the terminal the user is currently told to
  watch is no longer needed.
- **cancel.** `session/cancel` → a Stop button on the thread/panel.
- **modes.** `session/set_mode` models what is currently magic-string state:
  **panel review** becomes a *mode*, not a `[sheaf:panel-review]` brief prefix.
  add ask-mode (discuss, never edit) vs edit-mode cleanly.

---

## 7. agent registry — minimal config

no config *system* — a small typed registry. every acp agent reduces to the same
shape:

```ts
{ id, displayName, command, args, env?, installHint }
```

ship the entries below, surfaced as a settings dropdown, optionally auto-detecting
whether the binary is on PATH and showing `installHint` if not. Most adapters are
standalone packages run via `npx`; some agents speak ACP through a subcommand of
their own CLI, spawned directly:

- **claude code** — `npx @agentclientprotocol/claude-agent-acp` ([cc]).
- **codex** — `npx @agentclientprotocol/codex-acp` ([cx]).
- **omp (Oh My Pi)** — `omp acp`, a subcommand of the [`omp`][omp] CLI
  (`@oh-my-pi/pi-coding-agent`), spawned directly rather than via npx; effort is
  agent-controlled (no effort env).

auth is not the plugin's problem: each adapter reuses its cli's existing login
and exposes acp `authenticate` / `logout` if a session needs it, so the plugin
surfaces an auth prompt rather than managing keys. a "custom command" escape
hatch can come later for any other acp agent.

acp is agent-agnostic, so this also un-locks sheaf from claude code.

[cc]: https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp
[cx]: https://www.npmjs.com/package/@agentclientprotocol/codex-acp
[omp]: https://omp.sh/docs/acp

---

## 8. what stays / out of scope for v0

- **the embedded sheaf-server stays** — store + ui data api + threads-only mcp.
- **the ui sse stream stays** (`role=ui`); the `role=agent` channel and the
  curl-loop `Monitor` hack are removed.
- **drafts / fork / propose / merge** stay in `sheaf-server` for the web
  prototype; the plugin just doesn't expose them (§5).
- **terminals** (`terminal/*`) — free once we speak acp (lint / link-check /
  spell-check a doc), but not a v0 target.
- **remote agents** (acp over http/ws) — forward-looking: the cloud product
  could drive an agent and have the obsidian/web client speak the *same* acp
  transport, unifying the prototype and product agent-integration codepaths.
- **cross-cutting (multi-target) threads** and **multi-agent** sessions — §3.

---

## 9. open questions

- **session teardown.** when does a doc's session die — on doc close, on agent
  disconnect, idle timeout? lazy-spawn is settled; lifetime is not.
- **prompt shape.** how much of the anchor (`anchored_text`, context, `rel_pos`)
  goes into the `session/prompt` content blocks vs. left for the agent to fetch
  via `ReadThread`? leaning: enough to act without a round-trip, anchor detail
  via the tool.
- **panel review as a mode.** does `set_mode("review")` change the permission
  policy (no writes) and the prompt template, or is it just a label? probably
  both — review mode = writes-denied + a review prompt.
- **diff-options ux.** does presenting 2–4 takes use one `request_permission`
  with N options, or N tool-call diffs the user picks among? affects how the
  current `draft_options` card maps over.
- **resume fidelity.** `session/load` restores agent context, but the thread
  store is the source of truth — on resume, reconcile the agent's remembered
  state against the current open threads (the store wins).
- **dual driver.** posting a comment nudges the ACP agent *and* a manual-MCP
  watcher (if both are connected), so both could act on the same thread. v0 has
  no guard — assume one driver at a time; a "drive via" toggle (or suppressing
  the manual watcher when ACP is connected) is the real fix.
- **mcp transport capability.** we register the sheaf MCP as http without first
  checking the agent's `mcpCapabilities.http` from `initialize`. The shipped
  adapters support http; gate on the capability (and fall back to stdio) before
  relying on it with other agents.
- **symlink containment.** the absolute→vault path mapper is lexical; an in-vault
  symlink pointing outside isn't caught. A hardened build would `realpath` before
  comparing.
```

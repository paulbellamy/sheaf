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
│    • initialize → session/new(cwd=vault, mcpServers=[sheaf /api/mcp via http])             │
│    • services fs/read_text_file & fs/write_text_file → ydoc (client-write path)            │
│    • renders session/update (thoughts, plan, tool calls) in the threads panel              │
│    • answers session/request_permission with the keep/discard/propose gate                 │
│                                                                                            │
└────────────────────────────────────────────┬───────────────────────────────────────────-─┘
                                              │ acp / json-rpc / stdio
                                  ┌───────────▼────────────┐
                                  │  adapter subprocess     │
                                  │  (claude-code-acp …)    │──── mcp/http ──▶ sheaf /api/mcp
                                  └─────────────────────────┘     (thread tools)
```

the unlock: **acp carries mcp.** `session/new` takes an `mcpServers` list (stdio
or http transport) that the agent must connect to ([session-setup][setup]). so
the plugin hands the agent its own thread tools automatically — no user-typed
`claude mcp add`. acp handles lifecycle/streaming/permissions/fs; mcp-over-acp
handles sheaf's domain. they compose; it was never either/or.

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
- **drop from the plugin's surface:** `Read`, `Edit`, `Write` → now acp `fs/*`.
- **gate by mode, don't delete:** `Fork`, `Propose`, `Merge`, `DeclineDraft`.

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

ship two entries, surfaced as a settings dropdown, optionally auto-detecting
whether the binary is on PATH and showing `installHint` if not:

- **claude code** — [`@zed-industries/claude-code-acp`][cc] (wraps the claude
  code sdk). alt: [`@zed-industries/claude-agent-acp`][ca] (claude agent sdk).
- **codex** — [`@zed-industries/codex-acp`][cx] (also `@agentclientprotocol/codex-acp`).

auth is not the plugin's problem: each adapter reuses its cli's existing login
and exposes acp `authenticate` / `logout` if a session needs it, so the plugin
surfaces an auth prompt rather than managing keys. a "custom command" escape
hatch can come later for any other acp agent.

acp is agent-agnostic, so this also un-locks sheaf from claude code.

[cc]: https://www.npmjs.com/package/@zed-industries/claude-code-acp
[ca]: https://www.npmjs.com/package/@zed-industries/claude-agent-acp
[cx]: https://www.npmjs.com/package/@zed-industries/codex-acp

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
```

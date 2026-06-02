<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Reacting to /doc submissions

To react to thread submissions and other backend mutations while the agent is idle, use the `sheaf-event-watcher` skill (installed via the repo-root `.claude-plugin/`). It runs `scripts/watch-events.mjs` under `Monitor` and wakes the session on each event.

If the plugin is not installed, run the script directly:

```
Monitor({
  command: "node ../.claude-plugin/scripts/watch-events.mjs",
  description: "sheaf backend events",
  persistent: true,
})
```

Each notification is one `BackendEvent` JSON line (`thread_changed`, `doc_changed`, `draft_changed`, `draft_state`, `draft_created`, `draft_merged`, `agent_presence`). On `thread_changed`, call `ListThreads` / `ReadThread` via MCP. Stop with `TaskStop` when done.

# Drafts are agent-originated

Alice creates the draft itself via Start Draft (a draft ref is forked from main and her pending threads are persisted onto it). Every *edit inside* the draft is agent-originated — `Write` / `Edit` against the draft ref, or an α payload attached to a thread. Humans-in-draft write threads only; the agent executes.

That asymmetry is intentional:
- Agent-originated edits are the thing we want to review, so they deserve the heavier flow (draft + diff).
- Human-originated conversation is the thing we want to keep lightweight, so threads are UI-first.

The MCP tool surface covers the full draft lifecycle — `Fork`, `Write`, `Edit`, `AttachDraftPayload`, `Merge`, `DeclineDraft` — so agents never have to reach into the UI REST endpoints to close out their own drafts.

# Two modes: drafts vs thread-on-doc

There are two modes for landing changes. Pick per integration; don't mix them on a single doc.

**Draft mode (default for the web UI).** Threads live on drafts. Alice clicks Start Draft, pending threads get persisted onto the draft ref, the agent does α/β work against the draft, alice merges. See "Drafts are agent-originated" and "α vs β" below. In this mode, `AddThread` / `ReplyThread` / `ResolveThread` are called against the draft ref, not main.

**Thread-on-doc mode (Obsidian-plugin prototype).** No drafts. Threads anchor to the doc on main. For a single clear change the agent edits the doc directly via `Write` / `Edit` with `ref="main"` (or omitted), then `ResolveThread`. When a brief has more than one reasonable answer and the human should pick, the agent instead attaches inline options with `AttachDraftPayload` (`draft_options`, each a `{ new_md, name }`) and stops — presenting options doesn't touch the doc. The pick comes back as a new user reply (*Selected option N*); the agent then makes the real `Edit`/`Write` and resolves. The option `new_md` is a preview the human reads to choose, **not** applied verbatim. The event-watcher delivers `thread_changed` (a new comment) and `doc_changed` (the agent's edit landed). This mode exists so the Obsidian plugin can race human-and-agent edits on the same on-disk markdown without a review gate; the draft model (Fork/Propose/Merge) is unused.

When you see a `thread_changed` event, branch on the thread's `draft_id`:
- **`draft_id` set → draft mode.** Apply α or β against that draft ref.
- **`draft_id` absent → thread-on-doc mode.** `Read` the doc, then either edit directly (`Edit` / `Write` with `ref="main"`, then `ResolveThread`) or — when the human should choose between options — `AttachDraftPayload` with inline `draft_options` (each `{ new_md, name }`) and wait; the pick returns as a user reply, then you edit and resolve. No fork, no propose, no merge.

When reading a brief, pass the right ref: `ListThreads(path, ref=draft_id)` for draft mode, `ListThreads(path, ref="main")` (or omit `ref`) for thread-on-doc.

# α vs β

Two patterns for landing changes on a draft. Pick per-thread.

- **α — `AttachDraftPayload`.** For substantive prose changes. The redline (or multi-option leaf set) attaches to the existing thread, not the draft body. Alice accepts/declines per thread; on accept the payload's ops are applied to the draft ref. Use this whenever the human should review the prose before it lands.
- **β — `Edit` / `Write`.** For mechanical changes (typos, renames, redlines alice already drew, structural block moves). Apply directly to the draft ref, then `ReplyThread` describing what was done and `ResolveThread`. No payload, no per-thread accept gesture.

When in doubt, prefer α — it's the reviewable path.

# Multi-option exploration

When the human should choose between approaches, don't spawn parallel top-level drafts. Fork sub-drafts off the current draft and attach them as options to the relevant thread:

```
Fork(path, parent=draft_id, n=k, intent="...")
→ [draft_id_a, draft_id_b, ...]

AttachDraftPayload(
  thread_id=...,
  ref=draft_id,
  message="...",
  draft_options=[
    { name: "option a: ...", ref: "draft_id_a" },
    { name: "option b: ...", ref: "draft_id_b" },
  ],
)
```

Each leaf is a real sub-draft ref the agent can edit independently. Alice picks one; the others auto-decline and stay in git history.

That's the **draft-mode** form. In thread-on-doc mode there's no draft to fork: pass the options inline as `draft_options` with `new_md` (plus a `name`) instead of sub-draft `ref`s. The pick is **not** auto-applied to main — it comes back as a user reply, and you make the real edit then resolve (the inline `new_md` is just a preview).

# Broad-thread decomposition

When alice's thread is too broad to attach one payload (e.g. *"rework middle §3–§5"*), don't try to cram a giant α onto it. Instead:

1. Write standalone fine-grained threads at the precise anchors you intend to address (one for §3, one for §4 paragraph 2, one for §5 closing).
2. `ReplyThread` on the broad thread pointing at the new ones — *"split into 3 finer threads, see §3 / §4 / §5"*.
3. `ResolveThread` the broad one.

The new threads are not children of the original. They're flat top-level threads on the same draft. The audit trail is the reply pointing at them.

# Flat thread model

`parent_thread_id` does not exist. Threads on a draft are flat — every thread is first-class. Anything that feels like nesting is one of:

- `draft_options` on a single thread (multi-option exploration, or remix counter-proposals).
- A sibling thread at a finer anchor with a `ReplyThread` pointer from the broader one (decomposition).

If you reach for a parent/child link, you want one of the two patterns above instead.

# Plan reply optional

There is no global plan reply. Default: start work on unambiguous threads immediately — the first signal alice sees is α/β work landing in the margin. If a *specific* thread is ambiguous (e.g. *"tighten this"* with no target length, *"rework §4"* with no angle), `ReplyThread` on that one thread with a clarifying question and skip it for now. Proceed on the unambiguous siblings in parallel.

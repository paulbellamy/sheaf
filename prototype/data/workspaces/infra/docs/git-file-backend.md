# Git file backend for sheaf

**Status:** design · **Replaces:** `prototype/lib/mcp/backend/stub.ts`

## Why git

Sheaf docs are markdown that humans and agents co-edit. Content-addressed history, branching, merging, and replication are already solved — by git. This backend's job is to map sheaf's primitives (docs, drafts, threads) onto git objects, not invent a new storage engine.

The current prototype backs this interface with a filesystem stub that fakes commits with uuids and keeps all draft state in memory. This doc specifies the production implementation: same `Backend` surface, real git commits underneath, durable across restarts and across machines.

## Repository layout

All sheaf state lives in a single git repo, rooted at the working copy:

```
sheaf.yaml                                     # repo-level config (GC windows, per-ws overrides)
workspaces/<ws>/docs/<name>.md                 # authored markdown, on main
workspaces/<ws>/docs/<name>.ycrdt              # paired yjs state vector (json)
workspaces/<ws>/docs/<name>.threads/           # per-doc threads
  thrd_<id>.yaml
```

The md file is the source of truth for humans. The `.ycrdt` file is the source of truth for concurrent agent edits and is what case-2 sync (design §4.2) diffs against. It is stored as JSON so `git log -p` is legible — the size overhead vs. a compact binary encoding is acceptable at our doc sizes and gc/packing absorbs the rest. Md and ycrdt are always committed together — never one without the other — so `HEAD` is internally consistent.

Threads are anchored yaml files next to the doc. Anchoring uses `{rel_pos, content_hash, anchored_text, context_before, context_after}` (see `ThreadTarget` in `backend/index.ts`); the backend re-resolves anchors on read against the current md.

## Refs

- `main` — the published branch. Writes are rejected (`assertDraftRef`).
- `draft_<uuid>` — a git branch forked off main, one per draft. Branch name literal: `sheaf/drafts/<uuid>`.
- Draft metadata (author, seed_prompt, state, name, note) lives in `refs/notes/sheaf-drafts` attached to the branch tip, so it travels with the branch on push/pull.

## Operations

### Fork(path, n)

For each of n drafts:
1. Resolve main's tree.
2. Create branch `sheaf/drafts/<uuid>` at that commit.
3. Attach a note with `{base_path, seed_prompt, author, state: "open", created_at}`.

No file changes yet — the draft is just a named ref.

### Write/Edit(path, ref=draft_id, content)

1. Write md to the working tree under the draft branch.
2. Regenerate the paired `.ycrdt` via case-2 sync (diff md → yjs ops → verify render matches md).
3. Commit both files in one commit on the draft branch. Commit message: `write(<path>)` or `edit(<path>)`.
4. Emit `draft_changed`.

`op_id` idempotency maps to a git-notes lookup: if a commit with the same op_id exists on the branch, return its result without committing.

### Propose(draft_id)

Flip state in the draft note to `submitted`, set `submitted_at`, `note`, `name`. No git merge yet — reviewers see the branch in the /review UI.

### Merge(draft_id)

Squash-merge the draft branch into main. The squash commit message is a summary of the draft's arc — seed prompt, resolved threads, and final shape — so main's log carries the context without replaying agent ping-pong. Delete the branch; keep the note so history is traceable.

### declineDraft(draft_id)

Flip state to `declined`. Keep the branch for a retention window — configured in `sheaf.yaml` at repo root, overridable per workspace — so reviewers can resurrect or diff; GC after the window lapses.

### Threads

Thread writes (`addThread`, `replyThread`, `resolveThread`) commit yaml files to the same branch the thread targets (main for published threads, draft branch for draft-scoped conversation). A thread anchored on a draft doesn't follow the draft's md into main on merge unless its anchor still resolves.

## Why pair md + ycrdt in every commit

A commit that has only md loses concurrent-agent state. A commit with only ycrdt is unreadable by humans and by git diff. Pairing them makes HEAD a valid sheaf state for any consumer — the md works for `git log -p`, grep, and GitHub; the ycrdt works for agents joining mid-session.

Case-2 sync (design §4.2) is the adapter: it takes a human's markdown edit and derives the equivalent yjs operation list, rendering the result back to md to verify no drift. If verification fails, the write is rejected at the backend layer before a commit exists.

## Grep and glob

`grep` and `glob` over `ref=main` use `git grep <ref>` / `git ls-tree`. For a draft ref, they run on the draft branch's tree. This gives us the same sub-second performance `git grep` already has on large repos — no separate index.

## Deferred

- Multi-agent shared drafts (design §8): multiple agents writing to the same branch concurrently. Needs a serialization strategy on top of yjs — probably a short-lived lease per draft branch.
- Artifact-fs cold mount: streaming large binary attachments out of git without bloating the pack file. Likely git-lfs or a sidecar object store keyed by commit.
- Authn/authz: which identities can fork off which paths, which can merge.
- Remote sync: push/pull semantics when two sheaf instances share a repo, including draft-note reconciliation.


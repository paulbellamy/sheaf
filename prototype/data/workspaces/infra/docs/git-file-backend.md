# Git file backend for sheaf

## Why git

Sheaf docs are markdown that humans and agents co-edit. We already have a mature tool for content-addressed history, branching, merging, and replication: git. The backend's job is to adapt git's model to sheaf's primitives (docs, drafts, threads) without inventing a new storage engine.

The prototype uses a filesystem stub (`prototype/lib/mcp/backend/stub.ts`) that fakes commits with uuids. This doc describes the production git backend that replaces it behind the same `Backend` interface.

## Repository layout

All sheaf state lives in a single git repo, rooted at the working copy:

```
workspaces/<ws>/docs/<name>.md                 # authored markdown, on main
workspaces/<ws>/docs/<name>.ycrdt.jsonl        # paired yjs op log, one op per line
workspaces/<ws>/docs/<name>.threads/           # per-doc threads
  thrd_<id>.yaml
```

The md file is the source of truth for humans. The `.ycrdt.jsonl` file is the source of truth for concurrent agent edits and is what case-2 sync (design §4.2) diffs against: one yjs op per line, append-only within a commit, so `git log -p` on it stays legible even though the payload is opaque. Md and ycrdt are always committed together — never one without the other — so `HEAD` is internally consistent.

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
2. Regenerate the paired `.ycrdt.jsonl` via case-2 sync (diff md → yjs ops → append one line per op → verify render matches md).
3. Commit both files in one commit on the draft branch. Commit message: `write(<path>)` or `edit(<path>)`.
4. Emit `draft_changed`.

`op_id` idempotency maps to a git-notes lookup: if a commit with the same op_id exists on the branch, return its result without committing.

### Propose(draft_id)

Flip state in the draft note to `submitted`, set `submitted_at`, `note`, `name`. No git merge yet — reviewers see the branch in the /review UI.

### Merge(draft_id)

Squash-merge the draft branch into main — draft history is conversational and not interesting to main. The squash commit message is generated from the draft: first line is the draft's `name`, body is the `intent` plus a bulleted list of the branch commits (`write(<path>)` / `edit(<path>)` / thread ops) so `git log` on main still surfaces what happened inside the draft without carrying every agent ping-pong commit. Delete the branch; keep the draft note so history is traceable.

### declineDraft(draft_id)

Flip state to `declined`. Keep the branch for a retention window so reviewers can resurrect or diff; GC later.

### Threads

Thread writes (`addThread`, `replyThread`, `resolveThread`) commit yaml files to the same branch the thread targets (main for published threads, draft branch for draft-scoped conversation). A thread anchored on a draft doesn't follow the draft's md into main on merge unless its anchor still resolves.

## Why pair md + ycrdt in every commit

A commit that has only md loses concurrent-agent state. A commit with only ycrdt is unreadable by humans and by git diff. Pairing them makes HEAD a valid sheaf state for any consumer — the md works for `git log -p`, grep, and GitHub; the ycrdt works for agents joining mid-session. Jsonl keeps the ycrdt side append-friendly and line-diffable without paying pretty-json's size cost.

Case-2 sync (design §4.2) is the adapter: it takes a human's markdown edit and derives the equivalent yjs operation list, rendering the result back to md to verify no drift. If verification fails, the write is rejected at the backend layer before a commit exists.

## Grep and glob

`grep` and `glob` over `ref=main` use `git grep <ref>` / `git ls-tree`. For a draft ref, they run on the draft branch's tree. This gives us the same sub-second performance `git grep` already has on large repos — no separate index.

## Deferred

- Multi-agent shared drafts (design §8): multiple agents writing to the same branch concurrently. Needs a serialization strategy on top of yjs — probably a short-lived lease per draft branch.
- Artifact-fs cold mount: streaming large binary attachments out of git without bloating the pack file. Likely git-lfs or a sidecar object store keyed by commit.
- Authn/authz: which identities can fork off which paths, which can merge.
- Remote sync: push/pull semantics when two sheaf instances share a repo, including draft-note reconciliation.

## Unresolved

- GC policy for declined drafts. A week? A month? Configurable per-workspace?

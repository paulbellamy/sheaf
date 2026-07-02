# sheaf — ux doc v0.1

*companion to design-v0.1. the storage + sync substrate is settled there; this doc is the ux model that sits on top. thread-centric, manuscript-aesthetic, nelson-flavored. if the design doc is "crdts for merges, git for history," this one is "the page is the review, threads carry the drafts, transclusions make the graph visible."*

---

## 1. thesis

living specs spend 90% of their life in re-drafting and review, not in greenfield authoring. the ux should optimize for that. the dominant metaphor is **an editor working on a manuscript** — crossing things out, inserting replacements, scribbling in margins — not a word processor and not a pr queue.

knowledge work is also non-linear. a living spec is a node in a graph of other specs; today we serialize that graph by hand with links, and it rots. taking the nelson bit seriously — **transclusion, bi-directional visibility, parallel texts, trails** — lets the doc expose its own connections without forcing the user to context-switch to see them.

this produces a ux where:

- the manuscript is the primary surface. chrome is minimal. type is book-like.
- the manuscript visibly is its own review. proposed edits render in red pencil on the page, with the thread's conversation in the margin.
- the manuscript visibly is its own graph. transclusions, back-references, and connection density all appear on the page.
- the word "merge" never surfaces. "branch" never surfaces. the verbs are **propose**, **reply**, **accept**, **remix**, **pull in**, **weave**.

---

## 2. core abstractions

### manuscript
the doc, framed as paper. serif body, generous margins, paragraph numbers in the gutter. not a text area with a blinking cursor on a white field. the frame signals: this is something you edit deliberately, not something you dash off.

### thread
the atom. carries:
- one or more **anchors** (per §5 of design-v0.1)
- a **conversation** (ordered messages)
- an optional **draft** (see below)
- **state** — open, accepted, declined, archived

accepting a thread's draft resolves the thread. replying to a thread appends a message. a thread can live in multiple manuscripts' gutters at once (cross-cutting).

this collapses pr-body, pr-comments, and line-comments into a single object. a comment without a draft is a question; a draft without a comment is a silent proposal; most threads are both.

### draft
the proposed textual change carried by a thread. rendered **on the manuscript in place** as strikethrough (deletions) + marked insertions (new text in a distinguishable style — red pencil, handwritten, whatever the visual language settles on). not a separate diff pane.

a thread can carry sub-drafts — counter-proposals that fork the parent draft. review ui picks one branch when accepting.

### transclusion
a live reference from one manuscript to a passage in another. renders the source text inline at the quoting site, visibly edged. bi-directional: the source manuscript knows it's transcluded here.

states: **current** (source unchanged since pin), **drifted** (source edited since pin — flagged, re-pin action offered), **broken** (source deleted — flagged).

v0 pins to a specific commit of the source; drift detection is a read-time check. re-pinning is a thread.

### weave
a named set of threads that move together across manuscripts. the cross-cutting proposal (design-v0.1 §5's multi-target thread) promoted to a first-class object with its own review surface: all affected manuscripts scroll in parallel with their drafts rendered, accepted as a unit.

most edits are single threads. weaves are the heavier-weight gesture for "this rfc touches three docs."

### trail
a persistent, shareable breadcrumb of navigation through manuscripts, threads, and transclusions. nelson's docuverse trail. lets a user say "here is the 7-hop path i took through five docs to understand this decision" and share it.

---

## 3. aesthetic commitments

these aren't chrome choices; they are load-bearing for the ux thesis.

- **book-like typography.** serif body, ragged-right or justified, real line height, paragraph numbers. signals: manuscript, not dashboard.
- **red pencil for edits.** deletions strike through in situ; insertions appear inline in a distinguishable color/style. the visual vocabulary is copy-editing, not code-diff.
- **marginalia, not sidebar.** threads live in the gutter adjacent to their anchors, not in a right rail that scrolls independently. thread cards expand in place.
- **gutter density marks.** every paragraph's gutter shows a subtle indicator of how many threads / transclusions touch it. the manuscript reveals its own topology.
- **parallel texts for transclusions and reviews.** when following a trail or reviewing a weave, manuscripts sit side by side with visible connecting lines between linked passages.
- **zoom levels.** a manuscript with 200 open threads is illegible by default. readable levels: **clean** (prose only), **marginalia** (threads visible), **redline** (drafts rendered on the page), **full weave** (parallel manuscripts + connecting lines). one keystroke cycles.

---

## 4. what a session feels like

opening a manuscript: prose on the page, faint gutter marks showing thread density, one or two transcluded passages sitting inline with subtle edges. recent drafts leave a ghost underline on touched passages so you can see where activity is.

hovering a paragraph expands its gutter to one-line thread summaries. clicking one opens a card in the margin: conversation on top, draft (if any) rendered *on the manuscript itself* as strikethroughs + insertions. the page becomes a working copy with red pencil over it. the review is the page.

review mode is scrolling the manuscript with drafts auto-rendered inline; accept/decline/remix sit in the margin next to each thread. no separate review page.

starting a new manuscript: blank parchment with one prompt ("what are we figuring out?"). the first keystroke creates the manuscript and its first thread simultaneously — the first draft is already a reviewable proposal to yourself. you can pull in passages from existing manuscripts on day one via transclusion, so the new page is never alone on the table.

---

## 5. key workflows

### 5.1 propose an edit
select text → keyboard shortcut or gesture → selection becomes strikethrough on the page, empty margin card appears with cursor in it, optional replacement text can be inserted inline. save commits a thread-with-draft on the user's draft branch. the doc state on the page is now "manuscript + this proposed edit visible."

### 5.2 reply / counter-propose
click a thread in the gutter → conversation opens. **reply** appends a message. **draft another way** forks the draft, letting the responder edit the proposal in place. the thread card now shows a small tree of draft variants; accept picks a leaf.

### 5.3 transclude
select a passage → "pull into…" → pick target manuscript and position. a live reference appears at the target, rendering the source text in place, edged. mutating either end is visible at both. re-pinning on drift is a thread.

### 5.4 cross-cutting weave
while drafting in manuscript a, realize the change implies edits to b and c. "add to weave" → create threads on b and c joining the same weave. the weave has one review page where a/b/c scroll in parallel with their drafts rendered. one accept commits all three.

### 5.5 follow a trail
click a transclusion or a thread's cross-reference → opens the source in a parallel pane with a visible connecting line between the two passages. keep clicking; the trail builds. saveable, nameable, shareable as a reading order.

### 5.6 review session
open a manuscript (or a weave) in redline zoom level. scroll; drafts render inline as you reach them. accept/decline/remix per thread in the margin. when a weave is accepted, its constituent manuscripts commit as a unit.

---

## 6. mapping to the design substrate

this ux maps onto design-v0.1 with minimal violence:

- **thread-with-draft** — already supported. a thread's endmatter record gains a `draft` field holding the proposed new md for each target (rendered inline as a `{~~old~>new~~}` suggestion), plus anchor ranges for the strikethrough/insertion rendering. accepting a thread runs the case-2 sync algorithm (§4.2 of design-v0.1) on the draft md and closes the thread in one commit.
- **sub-drafts** — represented as a tree in the thread record, or as replies with `kind: draft`. determined at implementation time.
- **transclusion** — a new primitive. represented as an inline md extension (e.g. `![[path#anchor@commit]]`) rendered by the editor. the source manuscript's endmatter gains a back-reference so invariant 1.5 still holds. drift detection is a read-time hash check, same pattern as comment anchors (§5 of design-v0.1).
- **weave** — a new file type, e.g. `.sheaf/weaves/<id>.yml`, listing constituent thread ids. index maintenance mirrors thread-index.
- **trail** — per-user, stored in the user's workspace or ephemerally client-side. low-risk to ship.

v0 ships: manuscript + thread-with-draft + redline rendering + reply/counter-propose + single-manuscript review. v0 punts: transclusion (v1), weaves as first-class (v1 — v0 uses bare cross-cutting threads), trails (v1), full parallel-text view (v1).

---

## 7. open questions

- **gesture for "start a thread with a draft"** — selection + shortcut is obvious, but one-click-to-strikethrough feels more manuscripty. needs prototype.
- **density management at scale** — a doc with 500 historical threads. zoom levels help; filters (open only, mine, last 7d) likely required.
- **red-pencil visual language** — literal red? muted amber? handwritten font for insertions? affects feel more than any other single decision. prototype needs to try several.
- **transclusion drift ux** — flagging is the easy part; what does the stale passage look like while drifted? crossed out? ghosted? left alone with a gutter mark? needs testing.
- **multi-draft accept conflicts** — if two accepted threads on the same manuscript touch overlapping ranges, their case-2 reconciliations may fight. probably safe by crdt construction, but review-order ui needs thought.
- **mobile / narrow viewports** — gutters don't fit. fallback: margin cards become a bottom sheet, density marks stay inline. deserves its own pass.

---

## 8. relationship to design-v0.1

this doc does not change the storage model, the sync algorithm, the merge semantics, the mcp surface, or any invariant. it specifies the human-facing layer that those substrates exist to serve. where this ux requires new substrate (transclusion primitive, weave file type), those additions are noted in §6 and flagged for v1 unless otherwise specified.

nothing in this ux contradicts the design doc's v0 cuts; it refines which affordances ship in v0 and which wait.

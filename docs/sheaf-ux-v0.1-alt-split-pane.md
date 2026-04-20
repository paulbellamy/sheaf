# sheaf — ux doc v0.1 (alt: split-pane)

*alternate to sheaf-ux-v0.1.md. same substrate (design-v0.1), different center of gravity. this model unifies the doc-centric and diff-centric pitches: the screen is a **pane pair** — canonical on the left, working/proposed on the right — and that same geometry carries reading, editing, and review without swapping surfaces.*

---

## 1. thesis

a living spec spends its life oscillating between two states: **as-is** and **as-proposed**. every productive action is some transform between them — read (as-is only), edit (as-is → as-proposed), review (compare as-is vs. as-proposed), accept (as-proposed becomes as-is). the ux should make that geometry literal.

the split pane is the one metaphor that covers all of it:
- **read**: left pane has the doc. right pane sits empty or holds context.
- **edit**: right pane materializes; you type there. differences from left highlight in lockstep as you go. you are always seeing what-will-change alongside what-is.
- **review** (your draft or someone else's): left = canonical, right = proposal. scroll locked. accept/decline/remix sit in the gutter between.
- **compare**: pane sources are free. draft a vs. draft b. head vs. three commits ago. doc a vs. transcluded section of doc b.

the mental model is familiar (ides, git diff tools, google docs suggesting mode) so onboarding cost is low. the cost is paid in screen real estate, not in novelty.

---

## 2. core abstractions

### pane pair
the fundamental surface. two columns, scroll-locked by default, with a shared gutter between that holds threads, accept/decline controls, and difference markers. either pane can be pinned to any ref: main, a draft, a specific commit, a slice of another doc (transclusion-lite).

### canonical view (left)
by convention, the left pane shows the accepted/authoritative state for the doc at the chosen ref. book-like typography, uneditable in this surface. this is "the doc as it stands."

### working view (right)
the right pane is where change lives. modes:
- **empty** (pure reading) — right pane collapses or shows an outline / related docs
- **in-progress** — your current draft, editable, materializing as you type. differences from left highlighted per line
- **proposal** — a saved draft (yours or someone else's), editable-with-fork (edits become a sub-draft)
- **rendered diff** — a read-only review view showing the proposal against canonical

the right pane is where the draft branch lives. mutating it is mutating a draft; accepting it promotes that draft's state into the left pane.

### gutter
the strip between panes. carries:
- **hunk markers** — colored bars showing where left and right differ, per line
- **thread pins** — comment/conversation anchors on either side's lines
- **accept/decline** controls (per-hunk in review mode, global at the top)

threads render as expandable cards in the gutter adjacent to their anchor line. a thread anchored on a deleted line shows on the left side of the gutter; on a new line, on the right. cross-cutting threads use a color/icon to signal "also touches another doc."

### draft
unchanged from design-v0.1 §6: a branch. what's new is that the right pane *is* the visualization of a draft — opening a draft = loading it into the right pane.

### weave (cross-cutting)
a draft that touches multiple docs. ui realization: a **tab strip** above the pane pair, one tab per touched doc. each tab is its own pane pair. one "accept weave" commits all tabs' proposals together. scrolling can optionally sync across tabs for rfcs with corresponding sections.

### review queue
a lightweight inbox surface — list of open drafts (yours, mentions, watched docs, agent outputs). clicking an entry opens its pane pair. this is where the diff-centric stream lives, without taking over the home screen.

---

## 3. aesthetic commitments

- **two columns, one spine.** pane pair is the default. never a floating modal, never a drawer-over-page.
- **book-like typography in both panes.** serif body, paragraph numbers in the outer gutter. the left pane is "the canonical book"; the right pane is "the revised print." they should feel like the same object in two states, not two different apps.
- **color-coded diffs, subtle by default.** per-line sidebar marks (not background fills) indicate change kind. full-redline rendering is opt-in via a zoom level (see below).
- **scroll lock is the default, unlockable.** most of the time you want corresponding lines to align. sometimes (rearranging sections) you don't.
- **zoom levels.** **clean** (left only, read mode), **split** (default pane pair), **inline redline** (right pane overlays deletions+insertions on the left pane — single-column for narrow screens), **weave** (tabs visible, multiple pane pairs).
- **minimal chrome.** no top toolbar with 30 buttons. verbs live on the gutter and on selection.

---

## 4. what a session feels like

**reading.** open a doc → left pane shows it, full width-ish, right pane collapsed to a thin rail showing outline + recent drafts + related docs. no editing chrome distracts.

**starting to edit.** select text on the left or hit `e` → right pane materializes (animates in from the right), populated with the current doc state. cursor lands in the right pane at the corresponding position. type; differences light up in the gutter as you go. you can always see what the doc was while you change it.

**saving a draft.** cmd-enter (or similar) → name prompt → the right pane's state is committed as a named draft. the pane now reads as "proposal: <name>," with accept/decline/continue-editing controls in the top gutter.

**reviewing someone else's draft.** click it in the review queue → pane pair opens, left = current canonical, right = their proposal. scroll through, accept/decline per hunk in the gutter, reply on threads as you go. "accept all" commits the proposal.

**cross-cutting.** a proposal touches three docs → tab strip appears above the pane pair. click through each tab to review; per-doc accept/decline, or one "accept weave" at the top commits all three.

**agent output.** agent's `propose` lands as a named draft in the review queue. clicking opens the pane pair — left canonical, right agent proposal. same gesture vocabulary as a human draft. `fork(doc, 3)` produces three entries in the queue; reviewer clicks through, keeps zero/some/all.

**new project.** blank pane pair. left is empty parchment with the outline ("what are you figuring out?"). right is collapsed. first keystroke anywhere drops you into editing on the right; as content accrues, the left stays as a kind of running "accepted baseline" — every accepted draft pushes its content left. feels like iterative distillation.

---

## 5. key workflows

### 5.1 read
single pane, right collapsed. scroll, search, follow outline. no editing affordances visible.

### 5.2 edit
select + `e` or click-to-edit → right pane appears with current state, differences materialize as you type. save-as-draft commits.

### 5.3 propose
a saved draft is a proposal. shareable link → opens the pane pair for anyone with access. no separate "publish" step.

### 5.4 review
open a proposal from the queue → pane pair with canonical/proposal. per-hunk accept/decline in the gutter. global accept at top.

### 5.5 counter-propose
in a proposal pane pair, hit "fork this draft" → right pane becomes editable; your edits fork the draft. saving creates a sibling proposal. the review queue now shows the family.

### 5.6 compare arbitrary states
"compare…" menu lets you set either pane to any ref (branch, commit, another doc). useful for draft-vs-draft, before-vs-after-a-week-ago, doc-a-vs-related-doc-b.

### 5.7 cross-cutting weave
a draft that touches multiple docs → tab strip appears above the pane pair. review per tab or accept whole.

### 5.8 threads / comments
select text in either pane → "comment" → thread card appears in the gutter adjacent to that line. threads carry an optional draft (inline proposed edit for that anchor), visible by expanding the card. cross-cutting threads show a side icon; clicking jumps to the other affected doc in a new tab of the pane pair.

---

## 6. mapping to the design substrate

- **pane pair** is a rendering concept; left and right each resolve to a yjs doc at a ref. no change to storage.
- **draft = branch** — unchanged from design-v0.1 §6.
- **review queue** is a derived list (open drafts across watched docs/workspaces). similar cost to thread-index; probably per-user, cached, rebuildable.
- **weave tabs** are the ui realization of design-v0.1's cross-cutting (a draft branch touching multiple files). no schema change needed; the ui just groups touched files as tabs.
- **threads** unchanged (design-v0.1 §5). gutter is the rendering surface; sidecar storage is unchanged.
- **inline drafts on threads** (see ux-v0.1 thread-centric §2) optional here — this model doesn't require them, because proposals live in the right pane rather than inside threads. a simpler v0.

---

## 7. tradeoffs vs. thread-centric model

**this model wins on:**
- **familiarity.** ides, review tools, google docs suggesting mode — everyone has seen a split pane.
- **legibility at scale.** a proposal with 100 changed lines is readable in split view; the same proposal as red pencil on a single manuscript is dense.
- **smaller v0.** reuses existing drafts-as-branches; no new primitives (no transclusion, no weave file type, no trails).
- **review ergonomics.** side-by-side is the industry standard for a reason; hunk-level accept/decline is well understood.

**this model loses on:**
- **mobile / narrow viewports.** two panes demand width. fallback inline-redline is usable but loses the core metaphor.
- **the "manuscript" feel.** the thread-centric model makes editing feel like copy-editing a novel. split pane feels like using a tool.
- **non-linear navigation.** no transclusion, no trails — the nelson-flavored bits largely drop out, reappearing (if at all) as "compare" affordances.
- **connection visibility.** the doc doesn't expose its own graph topology; cross-doc relationships live in tabs and links, not inline.

**hybrid worth considering:** split pane as the chrome, with thread-centric rendering *inside* the right pane when editing a single doc (so small proposals feel like marginalia, but big ones get the two-column diff). zoom-levels could encode this — "inline redline" zoom collapses the pair, "split" shows it.

---

## 8. open questions

- **when does the right pane materialize?** on first keystroke? on explicit `e`? on selection? affects whether reading feels like reading or like "you're one click from editing."
- **scroll-lock heuristics.** pure line-for-line breaks when the proposal rearranges sections. hunk-based alignment might be better; needs prototyping.
- **narrow-viewport fallback.** inline redline is the obvious one, but does it feel like the same app or a second-class mobile version? should the primary model even try to be mobile-native, or is mobile a read-only surface?
- **cross-doc threads in the gutter.** when a thread anchors across tabs, where does it show? probably on each tab's gutter with a "also on…" marker. needs thought.
- **review queue spam.** agent-generated drafts could flood the queue. watch/mute/auto-group controls needed before first agent integrations ship.
- **"compare arbitrary states" discoverability.** power users will love it; nobody will find it without prompting. surface it via selection menu + keyboard, not a buried menu.

---

## 9. relationship to ux-v0.1 (thread-centric)

these two docs are alternatives, not complements. they disagree about where change *lives* visually:

- **thread-centric** puts drafts inside threads, renders them as red pencil on the manuscript. the page is the review.
- **split-pane** puts drafts in the right pane, renders them as side-by-side diff with threads in the gutter. the geometry is the review.

a v0 has to pick one spine. the hybrid sketched in §7 is plausible but harder to execute coherently than committing to either.

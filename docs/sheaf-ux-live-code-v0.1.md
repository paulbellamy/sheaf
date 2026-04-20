# sheaf — ux doc v0.1 (live code)

*companion to design-v0.1 and ux-v0.1. this doc extends the manuscript model to runnable code. thesis: the notebook, the spec, and the deployment target are the same manuscript. no separate notebook app, no separate deploy pipeline ui — one surface, one set of verbs (propose, reply, accept, remix, weave). code cells are blocks in a manuscript; outputs are figures on the page; deployment is accepting a manuscript state whose cells pass re-execution. presentation-agnostic — the model composes with both thread-centric and split-pane ux.*

---

## 1. thesis

three artifacts that today live in three different tools actually want to be one object:

- **the notebook** — exploratory, messy, stateful, cheap to iterate. jupyter.
- **the spec** — prose, versioned, reviewable, the canonical description of what the system does. a markdown file in a repo.
- **the deployed code** — pinned, reproducible, hashed, the thing that actually runs in prod. a release artifact.

keeping them separate is the source of most drift. the notebook diverges from the spec because it's easier to edit the notebook. the spec diverges from prod because nobody edits the spec after the code ships. the deploy diverges from both because hand-written yaml glues them.

sheaf's substrate — markdown + crdts + git + thread-with-draft review — already solves the hard parts of this. the only thing missing is a way to say "this block is code, and its output is part of the page." once that exists:

- prototyping a feature is drafting a manuscript with some runnable cells.
- speccing the feature is the prose around those cells.
- deploying the feature is accepting the manuscript state into main, after CI re-runs the sealed cells and confirms their outputs still match.
- reviewing the feature is reviewing a thread-with-draft, same as reviewing prose. a reviewer sees the new prose and the new cell outputs side-by-side, rendered on the page.

the notebook/spec/deployment distinction dissolves. there is just the manuscript, in various states of sealed-ness.

---

## 2. core abstractions

### cell
the runnable block. jupyter's term, kept verbatim — no gain in renaming what every scientist and ml engineer already knows. prose blocks and cells coexist in the same manuscript. a cell has:

- **language** — the kernel it runs against (python, ts, sql, r, shader, whatever)
- **source** — the code
- **inputs** — references to other cells, transclusions, or declared parameters (see §5.6)
- **output** — what it produced last time it ran (may be stale, may be sealed, may be empty)
- **determinism** — one of **pure**, **seeded**, or **impure**. default is pure:
  - **pure** — no clock, no rng, no network, no fs outside declared inputs. the runtime sandboxes the cell and blocks these. a pure cell is a function from (source, kernel, inputs) to output, full stop. seals verify by re-running and comparing the output hash byte-for-byte.
  - **seeded** — deterministic given an rng seed. the seed is a declared input; the sandbox still blocks clock/network/fs. seal semantics identical to pure — byte-for-byte output match — just with the seed in the input set.
  - **impure** — real side effects allowed: databases, http, filesystem, external apis. shippable (this is how real code does real work), but sealing uses a **contract** instead of an output hash (see seal below).

pure is default because the three tensions in the thesis (integration, repeatability, experimentation) all land cleanest when most cells are pure. impure exists because production code has to talk to the world.

syntax in the info string: `{cell: true, id: cell_7fa2, determinism: impure}`. omitted = pure.

cells render with clear visual separation from prose — monospace source, an output panel below. for pure/seeded cells, the output panel renders the output *as a figure* (plot, table, rendered component, image). for impure cells, the panel renders the **contract result** — a ✓/✗ badge with the contract description and a "last verified at commit X" note, not a captured figure. the manuscript reads like a book with figures for pure work and audit badges for impure work.

### kernel
the runtime environment bound to a manuscript. jupyter's term, kept. sheaf's twist: the kernel is **declared per manuscript in a sidecar** (`kernel.yml`) and **pinned per commit**. so "what python was this output produced with" is always answerable by checking out that commit.

a kernel declaration names: language version, dependency manifest (e.g. a lockfile), data source refs (urls + commit/hash pins where possible), environment variables (redacted), and resource constraints (memory, timeout, gpu).

kernels are shareable across manuscripts via ref — a weave of manuscripts can declare one kernel and bind all cells in all constituent manuscripts to it. this matters when a spec spans several docs (the common case for a real system).

### output
what a cell produces. jupyter's term, kept. an output has:

- **value** — the rendered thing (image bytes, html fragment, json, plain text)
- **mime type** — what renderer to use
- **metadata** — provenance (see seal)
- **state** — **live**, **sealed**, **drifted**, or **broken** (see below)

outputs are stored in a sidecar dir, `<doc>.outputs/`, one file per cell's last committed run. this mirrors the `<doc>.threads/` pattern. the `.md` rendering of the manuscript references output files by id; a viewer with no kernel can still display the manuscript with its last-committed figures.

### bench
new primitive — the concept jupyter is missing. the **bench** is an ephemeral sandbox where cells run. runs on the bench do not mutate canonical state. they produce **live outputs** that hang off the user's draft branch, not off main. closing the bench without promoting discards the runs.

bench state is per-user, per-draft, per-session. two users on the same draft do not share bench state — they share proposals, not experiments. this is the opposite of jupyter's "one notebook, one kernel, global state mutated by whoever ran the last cell," which is exactly the reproducibility problem sheaf exists to not have.

running a cell on the bench shows the result inline, but ghosted — visibly "live," visibly "not part of the page yet." promoting a result is an explicit gesture (see §5.2). unpromoted results live until the bench session ends.

### seal
new primitive, jupyter has no equivalent. a **seal** is a pin on an output that records:

- **hash of cell source** (including language)
- **hash of kernel declaration** (language version, deps, data refs, env, resource limits)
- **hash of resolved inputs** (the specific values the cell read from other cells, transclusions, and parameters)
- **verification target** — what the re-run must produce to verify. depends on the cell's determinism posture:
  - **pure / seeded** → **hash of produced output bytes**. CI re-runs and must produce a byte-identical output. this is the strongest guarantee and the default.
  - **impure** → a **contract**: one or more predicates the re-run output must satisfy. supported contract forms:
    - **schema** — json schema, type signature, row shape, response shape.
    - **predicate cell** — a second, pure cell that takes the impure cell's output and returns bool. the seal verifies iff the predicate is true. the predicate is itself sealed (it's pure), so the contract is auditable.
    - **execution success** — the weakest contract: cell ran without raising. combine with declared invariants (e.g. `response.status == 202`) for useful-but-lightweight seals.
- **timestamp + actor** (who sealed it, when)

a sealed output is **reproducible** in the sense appropriate to its posture: pure/seeded means byte-identical; impure means contract-satisfying. CI verifies on every accept. drift for pure/seeded = output hash mismatch. drift for impure = contract no longer holds (schema broken, predicate false, execution raised). either drift blocks the merge.

the author chooses the contract strength for impure cells. a db query might seal with "returns ≥1 row of shape `{id: string, …}`"; an email-send might seal with "executes without error and `response.status == 202`"; an llm call might seal with "output validates against this json schema." both are shippable; both are deploy-time gated. impure cells don't get a free pass — they seal against a different target.

unsealed outputs render differently on the page — a visible "draft" mark in the gutter, probably the same ghost-underline the thread-centric ux uses for live-draft passages. readers can tell at a glance which figures are provenance-guaranteed and which are "someone ran this once on their laptop."

### drift
the same pattern as transclusion drift. a sealed output is **drifted** if any of its hash inputs has changed since the seal — someone edited the cell, the kernel moved, the upstream data was re-pinned. drift is detected at read time (cheap hash comparison) and surfaced as a gutter mark + a thread offering **re-seal** as a resolution.

a drifted output does not vanish. it renders as it was at the seal, crossed through, with a "last verified at commit X, now stale" note. the prose stays readable; the figure stays legible; only the provenance indicator changes. this is the correct failure mode for a living spec — stale is visible, not invisible.

### verbs
**run** (execute a cell on the bench), **promote** (move a bench run onto a draft as a thread-with-draft), **seal** (pin a promoted output with hashes for reproducibility), **re-seal** (update a seal after intentional drift), **accept** (merge the draft into canonical — reusing design-v0.1 §4.2), **remix** (fork a draft and re-run).

notably: never "execute," never "deploy," never "commit." the verbs are the same ones the prose workflow already uses, with **run**, **seal**, **re-seal** added for code.

---

## 2.1 execution model

the single biggest thing sheaf takes from jupyter and the single biggest thing it rejects.

**takes**: cells, kernels, outputs, interactive feel, figure-rich manuscripts.

**rejects**: cells share mutable global state, can run in any order, and persist that state across sessions. this is jupyter's core failure mode — the reason a notebook that "works" on the author's laptop doesn't reproduce anywhere else. sheaf cannot inherit it.

sheaf's model: **cells are pure functions of their declared inputs and the kernel. there is no shared mutable kernel state across cells.** run a cell, you get an output that depends only on (source, kernel, inputs). run it again with the same inputs, you get the same output (byte-identical for pure/seeded; contract-satisfying for impure). no "oops, i ran cell 3 before cell 7 and now the df is different."

execution order is derived from the **input dag**: cell B reading cell A's output is an edge A→B. running B runs A first if A's output on the bench is stale. document order is for humans; execution order is for the runtime. the two can diverge and that's fine — the manuscript is a book, not a script.

exception, handled explicitly: shared resources that are expensive to construct (db pools, loaded models, warm caches). these live in **context cells** — a cell whose output is the handle, declared as an input to the cells that use it. the context cell runs once per bench session and its output is memoized. this preserves jupyter's "set up the notebook once, then iterate" ergonomics without reintroducing hidden global state. every dependency is still on the dag; every dependency is still explicit.

the bench enforces this model — it runs cells in isolated workers with explicit input injection, not in a long-lived repl. the sandbox strictness depends on determinism posture (see §2 cell).

---

## 3. aesthetic commitments

these are load-bearing — a dev tool aesthetic would collapse the thesis.

- **figures, not repls.** output renders as the thing it is (plot, table, component, image, value), not as scrollback. if the output is a react component, the page shows the rendered component. if it's a dataframe, a paginated table. if it's just a number, the number, typeset. code-repl output is the fallback for "we don't know how to render this," not the default.
- **cells feel like paragraphs with equipment.** a cell's source block sits on the page with the same gutter vocabulary as prose — paragraph numbers, density marks, thread pins. the code is part of the reading, not a sidebar to it.
- **sealed vs. live is visually unambiguous.** a sealed output has a subtle provenance mark (a wax-seal glyph, a thin underline in the seal color, whatever the visual language settles on). a live output has the existing draft ghost mark. readers can tell at a glance.
- **impure cells are audit badges, not figures.** where a pure/seeded cell renders its output as a figure, an impure cell renders a **contract badge** — a small ✓/✗ with the contract summary ("schema holds," "status 202," "predicate passed") and a "last verified at commit X" line. no captured figure bytes on the page. this is an honest visual: the reader knows immediately that this cell talks to the world and what the world is being asked to guarantee, not what the world happened to say one time on a tuesday.
- **kernel status is peripheral.** connection state, memory, gpu availability — all in a thin gutter strip, not a top-bar dashboard. the manuscript is the focus; the kernel is equipment.
- **bench feels disposable.** visibly a scratch space. the "promote" gesture has weight to it (an animation, a confirmation, a commit-level feel). running on the bench should feel costless; promoting should feel deliberate.
- **drift is loud but not panicked.** a drifted figure shows its original self, struck through, with a gutter mark and a one-click "re-seal" thread. no modal, no red banner.

---

## 4. what a session feels like

opening a manuscript with cells: prose on the page, figures inline where cells sit, paragraph numbers in the gutter. sealed figures look settled; one or two live figures have the ghost mark. a small gutter strip shows "python 3.12, pandas 2.2, connected." no scrollback, no kernel panel unless you ask for one.

editing a cell: click into the source, type. running it opens the bench — the figure below the cell gets a ghost overlay and updates. the canonical output (what's committed on the branch) doesn't change; what you see is your bench run. "promote" sits nearby, dim until you've changed something.

experimenting: forking sub-drafts is cheap. you try three versions of the same plot, each a sub-draft of one thread. the thread card in the margin shows a tree of three runs; you pick one to promote. the other two persist on the thread until you archive them, so "here's why we didn't do it the other way" is recoverable.

reviewing a draft with code changes: open the draft. manuscripts render with the proposed cell source (strikethrough/insertion, same visual language as prose edits). figures render as they *would* be after re-run — CI runs them on the review branch and attaches the proposed outputs. the reviewer sees the old figure and the new figure, inline, with the same accept/decline controls as a prose thread. accepting commits the new source + new seals in one commit.

deploying: accept a draft on a manuscript marked as production. CI re-runs every sealed cell against its declared kernel. if every seal verifies (produced output hash matches recorded seal), the accept goes through. if any drift, the accept is blocked and drift threads auto-open for each affected cell. rollback is accepting a prior state, same gesture.

---

## 5. key workflows

### 5.1 run a cell on the bench
click into a cell → hit run (shortcut or gutter button) → the bench spins up or reuses, executes against the manuscript's pinned kernel, shows the output inline with a ghost overlay. the output is tagged as a bench run on the user's current draft; it is not committed.

repeat runs overwrite the bench output for that cell. history of bench runs is not persisted across sessions by default (opt-in: keep last N runs).

### 5.2 promote a bench run to an output
in the cell's gutter, **promote** → creates (or attaches to) a thread anchored on the cell, with a draft whose payload is the new output (and, if the source changed on the bench, the new source too). the thread is the same object as any other thread-with-draft; reviewers reply, counter-propose, fork sub-drafts.

a manuscript's author promoting their own run on their own draft is the common case. it's still a thread, still explicit, still reviewable — and still discardable.

### 5.3 seal an output
on a promoted output, **seal** → computes hash(cell source, kernel decl, resolved inputs, output bytes), writes them into the thread yaml, marks the output as sealed. the output file in `<doc>.outputs/` gains a `seal: …` stanza.

seal can happen before or after accept. sealing before accept is the norm for "i'm confident in this"; sealing after accept is the workflow for "accept the proposal, then CI seals once it reproduces." either way, an unsealed output on main is flagged — most production-marked manuscripts require every cell to be sealed as an invariant (see §7, open question on policy).

### 5.4 drift detection + re-seal
on manuscript open, each sealed output is hash-checked. drift → gutter mark + auto-opened thread offering **re-seal** (accept the new output as the new seal) or **restore** (revert the inputs that changed). the user can also ignore; the figure stays drifted.

re-seal is a thread-with-draft whose draft is "new seal stanza." accepting it updates the output file and the thread yaml in one commit. same ceremony as any edit.

### 5.5 deploy a manuscript
production deploys = acceptances of a specific kind. a manuscript tagged `deploys-to: <target>` triggers a deploy on every accept into its canonical branch. the deploy worker:

1. re-runs every sealed cell against its declared kernel
2. confirms every seal still verifies
3. packages the manuscript state (source + outputs + kernel) as a release artifact
4. ships it to the target

any failure blocks the accept. rollback is accepting a prior manuscript state. the rollback gesture is not a special thing; it's just "accept commit X again."

cross-cutting deploys use **weaves** (design-v0.1 §5's cross-cutting proposal, promoted to a first-class object): several manuscripts accepted as a unit, deployed as a unit. useful for "this change touches the api spec, the client spec, and the migration spec."

### 5.6 design-thinking loop
the experimentation gesture we want to preserve from jupyter — "i'm going to tweak a parameter and re-run" — maps onto sub-drafts. a cell with declared **parameters** (a cell-level frontmatter) exposes them as affordances in the margin (sliders, inputs, pickers). changing a parameter reruns the cell on the bench. promoting a run captures the parameter value in the draft.

common pattern: a cell that renders a component preview, with parameters for props. the designer slides a prop, the component re-renders on the bench, they promote the chosen config as a sub-draft. the manuscript accumulates a small tree of design variants, each reviewable, each pickable. design reviews become thread reviews.

for dynamic docs — e.g., "here's a plot, tweak the parameters yourself to explore" — the manuscript can opt into **reader-runnable** cells. a reader opens the manuscript, the bench spins up a read-only session, they can run cells and tweak parameters locally. their runs never touch canonical state (they have no draft); they can screenshot or promote-to-own-draft if they want to preserve something.

---

## 6. mapping to design-v0.1 substrate

no storage-model violence. specifically:

- **cells as annotated fenced code blocks.** a regular markdown fenced code block with a recognized language, annotated via the info string with key-value metadata:

  ````
  ```python {cell: true, id: cell_7fa2, params: {n: 100}}
  import pandas as pd
  ```
  ````

  the info string is standard markdown — parsers that don't understand the extras ignore them and still syntax-highlight the code. the `cell: true` flag marks a block as runnable; absent, it's a plain illustrative code block. `id` is a stable identifier assigned on first run (survives renames, edits, cell reorderings — same pattern as thread ids). `params`, if present, declares the cell's parameters (see §5.6).

  the ycrdt holds the prose and cell sources uniformly; invariant 1 (consistency at rest) is unchanged — render(ycrdt) still equals the md file, because cells *are* md. a non-sheaf reader viewing the manuscript on github sees a normally-highlighted code block with a curly-brace annotation — slightly noisy, but readable and inert.

  **what the info string holds vs. what the sidecar holds.** the info string carries only the identity + authoring concerns — `cell: true`, `id`, `params`, optional `lang-version` override. everything that churns per-run (output refs, seal hashes, last-run timestamp) lives in the output sidecar file, not the info string. this keeps the manuscript's diff history quiet on re-seals: a re-run touches `<doc>.outputs/<id>.yml`, not the prose.
- **kernel declaration.** new file: `<doc>.kernel.yml` adjacent to `<doc>.md`. optional; absent means the manuscript has no cells or inherits from a weave-level kernel.
- **outputs sidecar.** new dir: `<doc>.outputs/` adjacent to `<doc>.md` and `<doc>.threads/`. one file per committed cell output, named by cell id. contains value (or a ref to a blob for large values), mime type, and — if sealed — the seal stanza.
- **seal as metadata on the output file.** the hashes live in the output file's frontmatter. the thread-with-draft that produced the seal is ordinary — its payload includes "update this output file." no new thread type.
- **cross-cutting cells** (a cell in manuscript a that renders a view of manuscript b's data) **use transclusion.** the cell's inputs reference transcluded passages, pinned to commits. drift detection composes: transclusion drift implies seal drift.
- **weaves carry cross-manuscript seals.** a weave accepted as a unit commits all affected manuscripts' output files in one commit; the CI re-run happens over the weave, not one manuscript at a time.
- **bench state is not stored in the repo.** bench runs live in an ephemeral per-user sandbox (worker-side), indexed by draft branch. discarded when the draft closes.
- **new invariant candidate (1.6): seal reproducibility.** for every sealed output on a committed branch, re-running (cell source, kernel decl, resolved inputs) produces the recorded output hash. CI enforces on accept into protected branches; warning (not failure) on non-protected.

no existing invariant is weakened. the md ↔ ycrdt sync algorithm (§4 of design-v0.1) is unchanged — cells are just md. the thread model is unchanged. the mcp surface gains three verbs (`run`, `seal`, `re-seal`) and one resource (`kernel`).

---

## 7. v0 / v1 cuts

v0 ships:
- cells as md extension with language + info-string annotations (`cell: true`, `id`, `determinism`)
- per-manuscript `kernel.yml`, manually declared
- bench runs (python + ts kernels), ephemeral, per-draft, input-dag driven
- **pure cells with sandbox enforcement** (no clock/rng/network/fs outside declared inputs)
- promote gesture (bench run → thread-with-draft)
- output sidecar files, unsealed by default
- manual seal gesture writing the seal stanza — output-hash seals for pure cells
- reader can see sealed vs. unsealed outputs on the page

v0 punts:
- **impure cells with contracts** (v1 — until then, impure cells exist but can't be sealed, so can't ship in production manuscripts)
- **seeded cells** (v1 — seed capture + sandbox that permits only declared rng)
- CI re-run on accept (v1 — until then, seals are assertions, not verified)
- drift detection (v1 — until then, seals can silently rot)
- context cells (v1 — v0 re-runs deps on every cell run, correct but slow)
- parameterized cells + sliders (v1)
- reader-runnable cells (v1)
- weave-level kernel sharing (v1)
- deploys-to-target integration (v1+)
- gpu / long-running / streaming cells (v1+)

**minimal v0 cut**: if impure contracts are unbaked by ship date, v0 can launch pure-only. authors can still write impure cells (they'll run on the bench) but they render as unsealed/unpublishable and production manuscripts reject them. this preserves the thesis (manuscript = spec = deploy target) without requiring the contract machinery to be ready on day one.

v0 is enough to validate the thesis: does a manuscript with runnable cells + a propose/accept review loop feel like the right object. the harder reproducibility + deploy machinery comes after the ux metaphor earns its keep.

---

## 8. open questions

- **policy: must production-marked manuscripts have 100% sealed cells?** arguments both ways. "yes" keeps prod honest; "no" allows gradual adoption and lets a cell be a comment-on-code (ran once, output is illustrative, don't pretend it's reproducible). leaning yes with an explicit `allow-unsealed: true` escape hatch per cell.
- **how long does bench state live?** per-session is minimal; per-draft is convenient but expensive. a draft left open for a week shouldn't pin a worker. probably: per-session with opt-in retention, plus a warm-start hint that re-runs recent cells automatically on reopen.
- **sandbox enforcement for pure/seeded cells.** the runtime has to actually block clock/rng/network/fs, not just ask politely. open design space: monkey-patch the stdlib (cheap, bypassable — `import ctypes` defeats it), run in a locked-down container (stricter, more expensive, per-cell overhead), or language-level (wasm sandboxes, deno permissions). probably tiered: cheap check in the editor, container-grade in CI.
- **contract design for impure cells.** schema is easy and composable. predicate-cells are maximally expressive but authoring a good predicate is work. "executes without error + asserted invariants" is the pragmatic default. what does the in-editor ux for authoring a contract look like — a sibling cell? a stanza in the info string? a dedicated pane?
- **who can seal whose output?** the author of the draft, obviously. a reviewer countersigning a seal for extra confidence — useful. an agent sealing — needs an audit trail but likely fine under the same thread model.
- **kernel updates as their own ceremony?** bumping a python minor version drifts every cell. that's correct but noisy. probably a **kernel-bump** is a weave across all a manuscript's cells, re-seals in bulk, reviewable as one unit. worth prototyping.
- **rendering unknown mime types?** pluggable renderers, but also a sane "code-repl scrollback" fallback so nothing breaks when a cell produces something weird.

---

## 9. relationship to existing ux docs

this doc is **orthogonal** to the thread-centric / split-pane choice. live code composes with either presentation:

- **thread-centric (ux-v0.1).** cells sit in the manuscript like illustrated paragraphs. bench runs appear as ghost overlays on the cell's output, same ghost-underline vocabulary used for live drafts. promote opens a thread card in the gutter. the page is still the review.
- **split-pane (ux-v0.1-alt).** left pane shows the canonical manuscript with sealed outputs. right pane *is* the bench — the working view for the current draft, with live outputs rendering as the user edits cells. "promote" commits the right pane's state into the draft. review mode scroll-locks canonical vs. proposed, with both figure versions visible.

the underlying substrate is identical across the two. the storage additions (§6) and the verbs (§2) don't depend on which ux ships first. either one can land cells in v0 without re-architecting.

this doc does not change the storage model, the sync algorithm, the merge semantics, or any existing invariant. it specifies what the substrate must support if the manuscript is to absorb the notebook. the invariants it adds (1.6, seal reproducibility) are additive and only bind on manuscripts that opt in by declaring a kernel.

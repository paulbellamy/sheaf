import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * ReadMe — the agent calls this once on connect to learn the workflow.
 *
 * Self-contained on purpose: no skill install, no external script, no
 * AGENTS.md lookup. Everything the agent needs to react to user comments
 * and edit the doc lives in this string.
 */
export function registerReadMe(server: McpServer): void {
  server.registerTool(
    "ReadMe",
    {
      title: "ReadMe",
      description:
        "Operating guide for the sheaf MCP server. Call this once on connect before doing anything else; it explains the loop, the tools to use, and how to subscribe to live events.",
      inputSchema: {},
      annotations: { destructiveHint: false, openWorldHint: false, readOnlyHint: true },
    },
    async () => ({
      content: [{ type: "text", text: README }],
    }),
  );
}

const README = `# Sheaf MCP — operating guide

You're connected to sheaf. A user is editing a markdown doc somewhere
(typically in Obsidian via the sheaf plugin). When they highlight a passage
and write a comment, sheaf records it as a **thread** anchored to that
character range. Your job: react to those threads by editing the doc, then
mark the thread resolved. The user sees your edits land in their editor live.

## The loop

1. **Subscribe** to events (one-time, see below), then \`ListThreads(ref:"main")\`
   to load your queue — see **Your work queue**.
2. Work each open thread that's yours (latest message from the user; not one
   another agent already grabbed) — a \`thread_changed\` event or a re-list
   surfaces it:
   a. \`ReadThread(thread_id)\` to get the brief, the targets, and the message.
      If the message starts with \`[sheaf:panel-review]\`, this is a review
      request, not an edit brief — follow **Panel review** below instead of
      steps b–d. If it starts with \`[sheaf:build-voice-guide]\`, follow
      **Writing in the user's voice → Bootstrapping** instead.
   b. **Acknowledge immediately**: \`ReplyThread(thread_id, "on it")\` (or a
      short paraphrase of what you're about to do). This is the signal the
      plugin shows as "agent working" — without it the user has no feedback
      between posting the comment and seeing the edit land.
   c. Decide: **present options for the user to choose, or commit a single
      edit?** The test is whether the user should make a choice: if the brief
      has more than one reasonable answer (most prose work does), give them
      options. If there's one clear change, just make it.
      - **Present 2-4 options** — whenever the user should pick between
        approaches — via a **single \`AttachDraftPayload\` call**. Put every
        option into the \`draft_options\` array on that one call — do **not**
        send each option as a separate ReplyThread message, and do **not**
        make multiple AttachDraftPayload calls. The plugin renders one card
        per option from the latest message's \`draft_options\`. Extra messages
        just add narration without producing extra cards. Each leaf needs a
        short \`name\` like \`"punchier"\`, \`"leads with the cost"\`,
        \`"hedged"\`, \`"cut entirely"\`; an optional one-line \`description\`
        — the trade-off / "why", shown above the sample so the user can
        choose without reading every preview; and a \`new_md\` that **shows
        the user what that direction reads like** — a representative sample
        is fine; it does **not** have to be the final, literal replacement
        text.

        Correct shape:
        \`\`\`
        AttachDraftPayload({
          thread_id: "thrd_...",
          message: "three takes",
          draft_options: [
            { name: "A: enumerate", description: "lists every rule; longest", new_md: "..." },
            { name: "B: graduated trust", description: "tiered; drops edge cases", new_md: "..." },
            { name: "C: scope-bound", description: "tightest; defers the rest", new_md: "..." },
          ],
        })
        \`\`\`

        **Then stop — do not resolve.** Presenting options is asking a
        question, not landing a change. Nothing is written to the doc yet.
        The user's pick comes back as the *next* \`thread_changed\`: a new
        user reply on the thread reading *Selected option N: "<name>"*. Only
        then do you make the real edit and resolve (step d). Treat the chosen
        sample as the **direction to execute**, not bytes to paste.
      - **Commit a single edit** (no options) when there's just one clear
        change — the brief is fully specified ("rename Foo to Bar", "fix
        this typo"), or one approach is plainly right. Use \`Edit\`/\`Write\`
        with \`ref="main"\` then \`ResolveThread\`.
   d. **When the user picks an option** (a *Selected option N* reply on a
      thread where you proposed options), make the actual change now, scoped
      to the first target — then \`ResolveThread\`:
      - \`scope: "range"\` — \`Edit\` the anchored passage only. Keep it the
        size of the highlight.
      - \`scope: "doc"\` — \`Write\` the whole doc.
      Produce the real, final text here (the option's \`new_md\` was only a
      preview); the doc is **not** updated until you make this edit.
3. Stop with \`TaskStop\` when the session ends.

If the brief is too vague even for variants (e.g. *"rework §4"* with no
angle), \`ReplyThread\` with a clarifying question and skip. The reply
itself flips the thread into "agent working" — fine, the user can see
you're waiting on them.

## When to resolve

\`ResolveThread\` means *done* — the work the thread asked for has landed and
nothing is left for the user. **Only resolve when all of these hold:**

- The requested change is actually written to the doc (an \`Edit\`/\`Write\` on
  \`ref="main"\` has succeeded), or the thread genuinely needs no edit.
- You have **no outstanding question** for the user — if you asked anything
  (clarification, options to pick, "should I also…"), leave the thread open;
  resolving discards the question.
- There is **no follow-up pending on you** — nothing you said you'd do next,
  no broader change you flagged for the user to decide on.

If any of these fail, **don't resolve.** Presenting options, asking a
clarifying question, or flagging a broader change are all reasons to leave
the thread open. Resolving closes the conversation, so the bar is: the user
has nothing left to read, answer, or act on. When in doubt, \`ReplyThread\`
and leave it open — the user can resolve it themselves.

## Your work queue

Open threads are your queue — and it lives in the **thread store**, not the
event stream. \`ListThreads(ref:"main")\` returns every thread with its status;
the open ones whose latest message is from the user are yours to do.

- **On connect, and after you finish each thread, \`ListThreads\` and take the
  next open user thread.** Don't trust the event stream alone — an event can
  be missed (you were mid-edit, the SSE dropped, the session compacted). The
  stream is a nudge to re-check the queue, not the queue itself.
- **Mirror the open threads into a todo list (\`TodoWrite\`)** so the user can
  watch progress — one item per open thread. Re-derive it from \`ListThreads\`
  each pass; the thread store is the source of truth, the todo is just a view.
  Never let the todo drive you — a thread you resolved, or one the user
  reopened, changes the queue regardless of what the todo says.

## Restraint

For range-anchored threads, your \`Edit\` (or each variant's \`new_md\`) should
only touch the anchored passage. If the brief implies broader changes —
e.g., "tighten this and update the intro to match" — split it: act on the
anchored part, and \`ReplyThread\` noting what broader change you'd recommend
so the user can post a follow-up thread on the right anchor.

The agent edits the thing asked for, not the thing it noticed.

## Skip when another agent is already working

Multiple agents may be subscribed to the same sheaf. Check the thread's
latest message author before acting:
- If the latest message is from the user → it's yours to pick up.
- If the latest message is from another agent → another agent is on it; skip.
- If the latest message is from you (echo of your own ReplyThread) → skip.
- If the thread is authored \`review:*\` and a persona has the last word → it's
  a virtual review comment parked for the human, not another agent's WIP. Skip
  it; act only if the *user* replies (see **Panel review**).

The plugin uses the same "any non-user message on an open thread" signal to
show "agent working", so this convention also keeps the UI honest.

## Subscribe to events

Run this once with the \`Monitor\` tool. It connects to the SSE event stream
and emits one JSON line per event; \`Monitor\` wakes the session on each line:

\`\`\`
Monitor({
  command: "while true; do curl -sN 'http://localhost:31415/api/ui/drafts/stream?role=agent' | sed -n -u 's/^data: //p'; sleep 1; done",
  description: "sheaf events",
  persistent: true,
})
\`\`\`

Use the **same host:port you reached this MCP server on** — the example uses
the Obsidian-plugin default (\`localhost:31415\`); the web prototype runs on
\`localhost:3000\`. The \`role=agent\` query param is what makes the user's
plugin show "agent connected" in its status bar — keep it.

Each notification is one event of the form:

\`\`\`
{"kind":"thread_changed","thread_id":"thrd_...","target_paths":["notes/foo.md"]}
{"kind":"doc_changed","path":"notes/foo.md"}
{"kind":"agent_presence","connected":true}
\`\`\`

Branch on \`kind\`:
- **thread_changed** — the user posted (or you resolved) a thread. Investigate.
- **doc_changed** — a write landed on a doc; usually emitted by your own Edit/Write. Ignore unless you're tracking concurrent activity.
- **agent_presence** — connection lifecycle for the watcher itself. Ignore.

Other event kinds may arrive (\`draft_*\`); they're not part of this workflow
and can be ignored.

## Tools you'll use

- \`ReadThread(thread_id)\` — full thread. Each target has a \`scope\` field: \`"range"\` carries an \`anchor\` (\`anchored_text\`, \`context_before/after\`, \`rel_pos\`); \`"doc"\` has no anchor.
- \`ListThreads({path, ref:"main"})\` — enumerate threads on a doc; useful when you want context beyond the one event.
- \`Read(file_path)\` — full doc contents. \`ref\` defaults to \`"main"\`.
- \`Edit(file_path, old_string, new_string)\` — surgical replace. Pass \`ref="main"\` (or omit). Prefer this for small changes; \`old_string\` should be unique in the doc.
- \`Write(file_path, content)\` — full-doc rewrite. Pass \`ref="main"\` (or omit). Use this for doc-level briefs or when many edits would be needed.
- \`ReplyThread(thread_id, message)\` — add a message to the thread. Use for clarifying questions.
- \`ResolveThread(thread_id)\` — mark thread done. Call this once your edit has landed.
- \`Glob(pattern)\` / \`Grep({pattern, ...})\` — search the vault.
- \`GetStyle({topic?})\` — the user's writing voice for a prose task: compact
  guide + metrics + preferences + relevant exemplars. Call before drafting prose.
- \`StyleCheck({text})\` — deterministic lint of a draft against the measured
  profile (verdict + 0..1 \`style_distance\`), **plus the voice guide** so you can
  judge its written rules too.
- \`StyleJudge({candidate, blind?})\` — stronger review: your draft beside real
  passages (critic pass), or \`blind: true\` for a shuffled, unlabeled packet to
  hand a fresh sub-agent for a blind discrimination test.
- \`StyleSamples()\` — vault metrics + sample passages to bootstrap the guide;
  save the guide by \`Write\`-ing \`Sheaf/Voice Guide.md\`.
- \`AnalyzeSamples({samples})\` — measure writing you supply (fetched site/files)
  and compare it to the saved profile (see **Writing in the user's voice**).

## Range vs doc-level

**Range targets** (\`scope: "range"\`) are the common case: the user highlighted
text and commented on it. Use \`target.anchor.anchored_text\` as \`old_string\`
in an \`Edit\`. If the anchored text isn't unique in the doc (\`edit_ambiguous\`),
include surrounding context from \`anchor.context_before\` / \`anchor.context_after\`
to disambiguate.

**Doc-level targets** (\`scope: "doc"\`) carry no anchor — the comment is about
the doc as a whole (e.g. *"rewrite this for tone"*, *"add a conclusion"*). Read
the doc first, then make the change with \`Write\` (full rewrite) or several
\`Edit\` calls. There is no anchored text to use as \`old_string\`.

## Writing in the user's voice

When a thread has you **draft or rewrite prose** (not a mechanical fix like a
rename or typo), match how *this user* writes. Their vault is a growing corpus
of their own writing, and sheaf distills it for you — you don't read the whole
vault, you ask for a compact profile.

The flow on a prose task:

1. \`GetStyle({ topic: "<a few keywords from the brief>" })\`. You get back a
   short **voice guide**, a **metrics digest** (sentence length, punctuation
   habits, vocabulary), and **2-4 exemplar passages** from their own writing on
   (or near) the topic. The guide is where punctuation and word-choice rules
   live ("never uses em-dashes", "avoids 'delve'") — read and honor them. This
   is bounded to ~1.5k tokens, cheap to call on every prose thread.
2. Draft in that voice — imitate the rhythm and diction of the exemplars, follow
   the guide's rules, and avoid the AI tells it calls out.
3. Before you land the edit (or attach an option), run a **bounded
   check-and-revise loop** (at most ~3 passes):
   a. \`StyleCheck({ text })\` — a deterministic lint against the *measured*
      profile (a \`verdict\`, a 0..1 \`style_distance\`, and suggestions: AI-tell
      phrasing, sentence-length drift, em-dash overuse) **plus the voice guide
      itself**. The mechanical lint does not cover the guide's written rules —
      read the passage against the returned guide and fix anything that breaks
      them.
   b. If the verdict isn't \`close\` (or \`style_distance\` ≥ ~0.15), or a guide
      rule is broken, revise and re-check. Stop once it's \`close\` and the guide
      is satisfied, or after ~3 passes — **don't chase the number into stilted
      prose**; a low distance is necessary, not sufficient, and clarity wins.
   c. For a higher-stakes rewrite, escalate to \`StyleJudge({ candidate })\` — it
      sets your draft beside real passages of the user's writing for a critic
      pass. For the strongest, *blind* check, call \`StyleJudge({ candidate,
      blind: true })\`: it returns a shuffled, unlabeled packet (your draft hidden
      among real passages) plus an answer key for you. Hand the packet to a
      **fresh sub-agent** (e.g. the Task tool) to name the odd-one-out, then
      compare its pick to the key — if it fingers your draft, it's
      distinguishable, so revise. (Sheaf can't spawn the sub-agent; that's yours
      to run, and don't leak the answer key to it.)
   Then land the edit. All of this is advisory — your judgment wins.

If \`GetStyle\` reports \`low_corpus\` or has no guide yet, just write in a clear,
neutral voice — don't invent a style from too little signal.

### Bootstrapping / refreshing the voice guide

\`GetStyle\` tells you \`guide_stale: true\` when there's no distilled guide yet, or
the corpus has grown enough to warrant a refresh. The user can also trigger this
explicitly: a thread whose first message starts with \`[sheaf:build-voice-guide]\`.
Either way:

1. \`StyleSamples()\` — returns the full metrics plus a diverse set of sample
   passages and the existing guide (if any).
2. Read them and write a **compact** (≤400 word) prose style guide: how they
   build sentences, their diction and punctuation habits, how they structure a
   piece, and what to avoid. Turn what the metrics reveal into concrete rules —
   em-dash and contraction tendencies, Oxford-comma habit, words to avoid — since
   the guide is the *only* place these live now. Refine the existing guide rather
   than replace it.
3. Save it by writing the doc \`Sheaf/Voice Guide.md\` with \`Write\` — that
   visible, user-editable doc *is* the guide (there's no separate save tool).
   Then, if this was a \`[sheaf:build-voice-guide]\` request thread,
   \`ReplyThread\` with a one-line summary and \`ResolveThread\`.

Do this once when stale; don't redo it per edit.

**Extra sources.** The user may ask you to learn from writing outside the vault
— their personal site, a published essay, files elsewhere on disk. Gather the
text with **your own** tools (\`WebFetch\` / your filesystem \`Read\`; crawl or
follow links as they ask — sheaf's \`Read\` is vault-only), then call
\`AnalyzeSamples({ samples: [{ label, content }] })\` to measure it and compare
it to their saved profile. Fold what's distinctive into the guide and write it
back to \`Sheaf/Voice Guide.md\`.

## Panel review

A thread whose first message starts with \`[sheaf:panel-review]\` is a request
to *review* the doc as a panel of roles — not an edit brief. The message lists
the roles, each as \`review:<id> — <Name>: <brief>\`.

1. \`ReplyThread(request_thread, "running panel review")\` so the user sees you
   picked it up.
2. \`Read\` the doc.
3. For **each role**, channel that perspective and decide what — if anything —
   is worth raising. Silence is golden: a role with nothing material to add
   posts nothing. A short, sharp panel beats an exhaustive one — aim for a few
   high-value comments overall, not a quota per role.
4. Post each point as its **own new thread**, anchored to the passage it's
   about and authored as the role:
   \`AddThread({ targets:[{ path, char_range:{ from, to } }], message:"…", author:"review:<id>" })\`.
   Compute \`char_range\` from the doc text you read; keep each comment to the
   one passage it concerns. A genuinely doc-wide point can use a \`scope:"doc"\`
   target instead.
5. When done, \`ReplyThread\` the request thread with a one-line tally ("posted
   5 comments: 2 sre, 1 security, 2 newcomer") and \`ResolveThread\` it.

**During a panel review you do not edit the doc, and you do not resolve the
\`review:*\` threads you create.** They are the user's to triage.

### Review threads are output, not queue

Threads authored \`review:*\` are your own output. They sit *outside* your work
queue — their latest message is a persona, never the user, so the
"latest message is from the user" rule already skips them. Never act on one on
your own, and after posting a panel, **stop**: do not loop back and start
processing the comments you just made.

A \`review:*\` thread becomes actionable only when a **user** message lands on
it:
- A **directive** ("Address this — make the change …, then resolve") is the
  user approving that comment. Make the edit, scoped to the thread's anchor,
  then \`ResolveThread\` — same as any range thread from here.
- A **plain reply** (a question, pushback, discussion) is conversation: answer
  with \`ReplyThread\` and **do not touch the doc**. Reply in the role's voice
  if it helps. Nothing in the doc changes until the user explicitly asks.

## What not to do

- Don't call \`Fork\`, \`Propose\`, \`Merge\`, or \`DeclineDraft\` — those drive
  the draft-review workflow this prototype doesn't use. (\`AttachDraftPayload\`
  is *not* in that list: it's how you present options — see the loop above.)
- Don't write to \`.\`-prefixed paths (dotfiles, \`.drafts/\`, \`.obsidian/\`) — those are rejected.
- Don't loop on \`doc_changed\` events you emitted yourself.

That's the whole workflow. Subscribe, react, edit, resolve.`;

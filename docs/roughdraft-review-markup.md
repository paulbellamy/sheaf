# how roughdraft handles comments, changes, and threads

*notes on [Lex-Inc/roughdraft](https://github.com/Lex-Inc/roughdraft), captured to guide
sheaf's move to the same markup style. roughdraft is a local-first markdown
reviewer: you open one `.md` file, comment on it, and suggest edits — and every
piece of that review state lives **inside the same markdown file**, never in a
sidecar database or a separate store. the format is specified as "Roughdraft
Flavored Markdown" (RFM); the reference parser is `packages/rfm`.*

---

## 1. the one idea

> review state is markdown. comments, suggested changes, and threaded replies
> are all expressed as [CriticMarkup](http://criticmarkup.com/) spans inline in
> the prose, plus a YAML **endmatter** block at the end of the file. open the
> `.md` in VS Code, Vim, Obsidian, or roughdraft — the review travels with the
> file.

There is no `comments.json`, no `.threads/` directory, no project DB. The
markdown file is the normative storage format. A JSON "review index" exists
(`roughdraft-flavored-markdown.schema.json`) but it is a *derived* read model
for APIs and tests, not a store.

---

## 2. the inline markers (CriticMarkup)

RFM uses the five standard CriticMarkup markers:

```markdown
{>>a comment<<}
{++inserted text++}
{--deleted text--}
{~~old text~>new text~~}
{==highlighted text==}
```

- `{>>…<<}` — a **comment** (a note, a question — feedback, not a change).
- `{++…++}` / `{--…--}` / `{~~old~>new~~}` — **suggestions**: a pending insertion,
  deletion, or substitution. These are the proposed *changes*; an implementation
  MUST NOT silently collapse them into prose on read or write.
- `{==…==}` — a **highlight**, used as the visible **anchor** a comment attaches to.

Markers inside inline code spans (`` `…` ``) and fenced code blocks are literal
example text and MUST NOT be parsed as review markup.

### anchored vs. standalone

A **comment on a span** is a highlight immediately followed by one or more comment
blocks — the highlighted run is the anchor:

```markdown
Please revisit {==this sentence==}{>>Needs a source.<<}{#c1}.
```

A comment with **no preceding highlight** applies to the surrounding paragraph or
to the document as a whole:

```markdown
Add a concrete launch example here.{>>This should come from the customer story.<<}{#c1}
```

A trailing comment block right after a suggestion attaches discussion to that
suggestion.

---

## 3. identity & metadata: `{#id}` + YAML endmatter

Every comment and suggestion gets a compact, document-local **id reference**
written immediately after its marker:

```ebnf
reference = "{#" id "}"          ; id = letter then [letters digits _ -]
```

The structured metadata behind that id lives in a YAML **endmatter** block —
everything after the file's *final* `---` divider:

```markdown
Please revisit {==this sentence==}{>>Needs a source.<<}{#c1}.

---
comments:
  c1:
    by: user
    at: "2026-04-28T12:00:00.000Z"
```

Endmatter holds two maps, `comments:` and `suggestions:`, each keyed by id.
Known attributes:

| attr       | applies to            | meaning                                                |
|------------|-----------------------|--------------------------------------------------------|
| `id`       | comments, suggestions | stable document-local id (`c1`, `c2`, … / `s1`, `s2`, …)|
| `by`       | comments, suggestions | author label; `AI` marks an agent author               |
| `at`       | comments, suggestions | ISO-8601 timestamp                                     |
| `re`       | comments              | parent id — this is how threading is expressed         |
| `status`   | comments, suggestions | review state; roughdraft writes `resolved`             |
| `resolved` | comments, suggestions | optional one-line resolution summary                   |

Design split: **root comment bodies and suggestion text stay inline** (so the
anchor stays portable and human-legible in any editor), while **replies live
entirely in endmatter** — a reply carries its `body:` in YAML because its `re:`
field already pins it to a parent. Unknown attributes/keys MUST be preserved on
round-trip.

For compatibility, readers also accept an older inline attribute block
(`{by="user" at="…"}`) and a legacy `{@id:c1; by:AI; …@}` form, but writers emit
the compact `{#id}` + endmatter shape.

---

## 4. threads

Threading is just the `re:` pointer — a comment whose `re` names a parent id is a
reply to it. There is no nesting in the markup; a flat set of `comments:` entries
chained by `re:` *is* the thread:

```markdown
Review {==this sentence==}{>>Needs a source.<<}{#c1}.

---
comments:
  c1:
    by: user
    at: "2026-04-28T12:00:00.000Z"
  c2:
    body: I can add one from the intro.
    by: AI
    at: "2026-04-28T12:05:00.000Z"
    re: c1
```

Rules: a reply whose `re` points at a missing id is treated as a top-level
comment; a comment MUST NOT be its own parent. Resolving an item is recorded by
setting `status: resolved` (with an optional `resolved:` summary) on its entry —
not by deleting the markup.

---

## 5. the reference parser (`packages/rfm`)

`packages/rfm/src/index.ts` is a hand-rolled scanner (no markdown AST) that:

- **validates** a document (`validateRoughdraftMarkdown`) — unclosed markers,
  missing `id`/`by`/`at`, bad `at` timestamps, duplicate ids, self-replies,
  dangling `re` targets, and missing endmatter entries all surface as
  located diagnostics (severity + code + line/column).
- **extracts a review index** (`extractRoughdraftReviewIndex`) — walks the body
  outside code spans/fences, pairs `{==…==}` highlights with following
  `{>>…<<}` comments, reads `{++/--/~~}` as typed suggestions, hydrates each
  `{#id}` against the endmatter, and emits a flat `items[]` list of
  `comment | reply | suggestion` with offsets/line/column.
- **mutates by re-serializing endmatter** — `appendRoughdraftDocumentComment`,
  `appendRoughdraftReply`, and `markRoughdraftResolved` parse, edit the
  `comments:`/`suggestions:` maps (or the inline metadata), and re-emit. Ids are
  minted as `c{n}` / `s{n}`. Reply/comment text containing a raw CriticMarkup
  close delimiter (`<<}`, `++}`, …) is rejected rather than emitted ambiguously.

The endmatter is detected as the *last* `\n---\n` in the file whose YAML parses to
an object containing `comments:`/`suggestions:`, so an RFM endmatter is
distinguishable from ordinary `---` rules or YAML *frontmatter*.

---

## 6. what sheaf adopts from this

Sheaf previously stored each doc's threads as a directory of per-thread YAML
sidecar files (`<doc>.threads/thrd_*.yaml`). The migration this doc accompanies
moves sheaf to RFM's markup style: **review state lives inline in the doc's
markdown** — CriticMarkup spans for the anchored comment / proposed change, plus
a YAML endmatter block that authoritatively stores the thread record. Sheaf's
thread model is richer than RFM's flat comments/suggestions (an ordered message
log, attached draft *options*, draft-scoped threads, multi-doc targets, a wider
status enum), so it keeps those fields in the endmatter — which RFM explicitly
allows ("implementations MUST preserve unknown valid attributes or YAML keys") —
while using RFM's exact inline markers and `{#id}` + `comments:`/`suggestions:`
endmatter shape so a sheaf doc reads as Roughdraft Flavored Markdown in any
editor. See `docs/sheaf-design-v0.1.md` §5 for the resulting on-disk model.

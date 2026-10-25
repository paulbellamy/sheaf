import { z } from "zod";

/**
 * Zod schemas for on-disk state. Applied on every read so corrupt YAML/JSON
 * surfaces as a structured `invalid_path`-style error instead of crashing
 * downstream when a field is the wrong shape.
 *
 * The filesystem backend caps the whole file at read time (`MAX_FILE_BYTES`),
 * so the per-field length limits below are DoS backstops, not the primary
 * bound. They are sized *above* anything the write path can produce from an
 * in-bounds file: a record that fails validation is dropped on read and then
 * deleted on the next write, so an over-tight cap is silent data loss (e.g.
 * commenting on a >10k-char selection once stored an `anchored_text` the read
 * schema rejected).
 */

/** Upper bound for a single free-text / content field. As large as the largest
 *  file the backend will read, since that file cap already dominates; the
 *  intent is only to reject a pathologically huge single value, never to clip
 *  legitimate content (clipping would drop the whole record on the next write). */
const MAX_FIELD_CHARS = 16 * 1024 * 1024;

/**
 * Stored thread target. Discriminated by `scope`:
 *   - `range` carries an anchor (rel_pos + anchored_text).
 *   - `doc`   carries no anchor — the comment is about the whole doc.
 *
 * A target record without a `scope` (one written before the discriminator
 * existed) is migrated in `threadOnDiskSchema` below: a target with an
 * `anchor` and no `scope` is treated as `scope=range`.
 */
const threadAnchorSchema = z.discriminatedUnion("scope", [
  z.object({
    scope: z.literal("doc"),
    path: z.string().min(1).max(512),
  }),
  z.object({
    scope: z.literal("range"),
    path: z.string().min(1).max(512),
    anchor: z.object({
      rel_pos: z.string().max(1024),
      content_hash: z.string().max(128),
      // A range comment stores the whole selection verbatim, so this must admit
      // any in-bounds selection — not a small fixed cap that a large selection
      // would blow, dropping the thread.
      anchored_text: z.string().max(MAX_FIELD_CHARS),
      context_before: z.string().max(1024),
      context_after: z.string().max(1024),
    }),
  }),
]);

const threadDraftBodySchema = z.object({
  // A draft replacement can be as large as a whole doc.
  new_md: z.string().max(MAX_FIELD_CHARS),
  name: z.string().max(512).optional(),
  description: z.string().max(16_384).optional(),
});

const threadMessageSchema = z.object({
  author: z.string().max(64),
  ts: z.number().int(),
  body: z.string().max(MAX_FIELD_CHARS),
  draft: threadDraftBodySchema.optional(),
  // Multi-option α payload (Phase F). Bounded list so a malformed message
  // can't blow the on-disk schema budget.
  draft_options: z.array(threadDraftBodySchema).min(1).max(64).optional(),
});

/**
 * One stored thread record — a value in a doc's review endmatter. The `id` is
 * carried in the value too, so this schema validates an entry directly.
 */
export const threadOnDiskSchema = z.preprocess(
  (val) => {
    // Migration: records written before the scope discriminator default
    // to `scope=range` when an anchor is present, `scope=doc` otherwise.
    if (val && typeof val === "object" && val !== null) {
      const v = val as { targets?: unknown };
      if (Array.isArray(v.targets)) {
        v.targets = v.targets.map((t: unknown) => {
          if (t && typeof t === "object") {
            const tt = t as { scope?: string; anchor?: unknown };
            if (!tt.scope) {
              tt.scope = tt.anchor ? "range" : "doc";
            }
          }
          return t;
        });
      }
    }
    return val;
  },
  z.object({
    id: z.string().regex(/^thrd_[A-Za-z0-9]{6,64}(?:-[A-Za-z0-9]{1,64}){0,8}$/),
    created: z.number().int(),
    status: z.enum(["open", "accepted", "declined", "archived"]),
    targets: z.array(threadAnchorSchema).min(1).max(64),
    // A long-lived thread accretes replies; the file cap is the real bound, so
    // keep this generous rather than dropping a busy thread wholesale.
    messages: z.array(threadMessageSchema).min(1).max(100_000),
  }),
);

/** One op-log entry: when the write carrying that `op_id` was applied (unix ms). */
export type OpLogEntry = { applied_at: number };

const opLogEntrySchema = z.object({ applied_at: z.number() });

/**
 * Parse a JSON-decoded `.op_log.json`: the set of write `op_id`s already
 * applied, as `op_id → { applied_at }`. Returns `null` when the top level isn't
 * a plain object (a corrupt log).
 *
 * Only key presence is load-bearing — a present key means "applied; a repeat
 * is a no-op" — so the parse is lenient per entry rather than all-or-nothing
 * (failing the whole log would forget every applied op and let each retry
 * re-apply its write):
 * - A value in any shape but `{ applied_at: number }` (e.g. the earlier
 *   `{ version_token }` record) still counts as applied, normalized to
 *   `applied_at: 0` ("unknown").
 * - An invalid key (empty — no write records one) is skipped and counted in
 *   `skipped`, not fatal. Length isn't capped here; the tool input schema
 *   already bounds `op_id`.
 *
 * Keys are walked by hand, not through `z.record`: zod's record parse drops a
 * `__proto__` key, which would forget an applied `__proto__` op on reload.
 * `JSON.parse` makes `__proto__` an own property and `Object.entries` returns
 * it, so every key survives.
 */
export function parseOpLog(
  json: unknown,
): { entries: Map<string, OpLogEntry>; skipped: number } | null {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return null;
  }
  const entries = new Map<string, OpLogEntry>();
  let skipped = 0;
  for (const [key, value] of Object.entries(json)) {
    if (key === "") {
      skipped += 1;
      continue;
    }
    const entry = opLogEntrySchema.safeParse(value);
    entries.set(key, entry.success ? entry.data : { applied_at: 0 });
  }
  return { entries, skipped };
}

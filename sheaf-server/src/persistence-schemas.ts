import { z } from "zod";

/**
 * Zod schemas for on-disk state. Applied on every read so corrupt YAML/JSON
 * surfaces as a structured `invalid_path`-style error instead of crashing
 * downstream when a field is the wrong shape.
 *
 * Also enforces a maximum byte count before `yaml.parse` / `JSON.parse` runs,
 * so a billion-laughs YAML anchor or a 1GB oplog can't DoS the server.
 */

export const MAX_DISK_BYTES = 4 * 1024 * 1024; // 4MB

export const draftMetaSchema = z.object({
  draft_id: z.string().regex(/^draft_[A-Za-z0-9]{6,64}(?:-[A-Za-z0-9]{1,64}){0,8}$/),
  base_path: z.string().min(1).max(512),
  intent: z.string().max(2048).optional(),
  author: z.string().max(64),
  state: z.enum(["open", "submitted", "accepted", "declined"]),
  created_at: z.number().int(),
  submitted_at: z.number().int().optional(),
  name: z.string().max(256).optional(),
  display_name: z.string().max(264).optional(),
  touches: z.array(z.string().min(1).max(512)).max(64).optional(),
  base_version: z.number().int().nonnegative().optional(),
  parent_draft_id: z
    .string()
    .regex(/^draft_[A-Za-z0-9]{6,64}(?:-[A-Za-z0-9]{1,64}){0,8}$/)
    .optional(),
  // seed_prompt / note kept for backward compatibility with on-disk files
  // written before the intent rename.
  seed_prompt: z.string().max(2048).optional(),
  note: z.string().max(2048).optional(),
});

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
      anchored_text: z.string().max(10_000),
      context_before: z.string().max(256),
      context_after: z.string().max(256),
    }),
  }),
]);

const threadDraftBodySchema = z.object({
  new_md: z.string().max(1_000_000),
  name: z.string().max(256).optional(),
  description: z.string().max(1_000).optional(),
});

const threadMessageSchema = z.object({
  author: z.string().max(64),
  ts: z.number().int(),
  body: z.string().max(10_000),
  draft: threadDraftBodySchema.optional(),
  // Multi-option α payload (Phase F). Bounded list so a malformed message
  // can't blow the on-disk schema budget.
  draft_options: z.array(threadDraftBodySchema).min(1).max(8).optional(),
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
    draft_id: z.string().optional(),
    targets: z.array(threadAnchorSchema).min(1).max(16),
    messages: z.array(threadMessageSchema).min(1).max(1000),
  }),
);

/**
 * Op log is a map of op_id to WriteResult. Shape is open-ended (backend may
 * evolve WriteResult), so we only assert the outer container.
 */
export const opLogSchema = z.record(
  z.string().max(128),
  z.object({
    version_token: z.string().max(128),
  }),
);

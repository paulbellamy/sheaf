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

export type DraftMetaOnDisk = z.infer<typeof draftMetaSchema>;

export const threadAnchorSchema = z.object({
  path: z.string().min(1).max(512),
  anchor: z.object({
    rel_pos: z.string().max(1024),
    content_hash: z.string().max(128),
    anchored_text: z.string().max(10_000),
    context_before: z.string().max(256),
    context_after: z.string().max(256),
  }),
});

const threadDraftBodySchema = z.object({
  new_md: z.string().max(1_000_000),
  name: z.string().max(256).optional(),
});

export const threadMessageSchema = z.object({
  author: z.string().max(64),
  ts: z.number().int(),
  body: z.string().max(10_000),
  draft: threadDraftBodySchema.optional(),
  // Multi-option α payload (Phase F). Bounded list so a malformed message
  // can't blow the on-disk schema budget.
  draft_options: z.array(threadDraftBodySchema).min(1).max(8).optional(),
});

export const threadOnDiskSchema = z.object({
  id: z.string().regex(/^thrd_[A-Za-z0-9]{6,64}(?:-[A-Za-z0-9]{1,64}){0,8}$/),
  created: z.number().int(),
  status: z.enum(["open", "accepted", "declined", "archived"]),
  draft_id: z.string().optional(),
  targets: z.array(threadAnchorSchema).min(1).max(16),
  messages: z.array(threadMessageSchema).min(1).max(1000),
});

export type ThreadOnDisk = z.infer<typeof threadOnDiskSchema>;

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

export type OpLogOnDisk = z.infer<typeof opLogSchema>;

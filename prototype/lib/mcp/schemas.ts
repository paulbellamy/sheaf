import { z } from "zod";

/**
 * Shared zod shapes for MCP tool inputs. These are re-used across tool files
 * to keep argument names/descriptions consistent.
 */

export const pathArg = z
  .string()
  .min(1)
  .describe(
    "Repo-root-relative doc path, e.g. 'workspaces/infra/docs/proposal.md'.",
  );

export const refArg = z
  .string()
  .min(1)
  .describe(
    "Ref to read from: 'main' or a draft id like 'draft_<uuid>' returned by Fork.",
  );

export const refOptionalArg = refArg
  .optional()
  .describe(
    "Optional ref. Defaults to 'main'. Pass a draft_<uuid> from Fork to see draft state.",
  );

export const draftIdArg = z
  .string()
  .regex(/^draft_[A-Za-z0-9-]+$/)
  .describe("Draft id returned by Fork, e.g. 'draft_<uuid>'.");

export const threadIdArg = z
  .string()
  .regex(/^thrd_[A-Za-z0-9-]+$/)
  .describe("Thread id, e.g. 'thrd_<uuid>'.");

export const opIdArg = z
  .string()
  .optional()
  .describe(
    "Client-supplied idempotency key. Retrying a write with the same op_id returns the original result without re-applying.",
  );

export const authorArg = z
  .string()
  .optional()
  .describe(
    "Optional author handle for attribution (e.g. 'claude-code', 'refactor-bot'). Falls back to 'agent' if omitted.",
  );

export const charRangeSchema = z.object({
  from: z.number().int().min(0),
  to: z.number().int().min(0),
});

export const anchorSchema = z.object({
  path: pathArg,
  char_range: charRangeSchema,
});

export const threadDraftSchema = z
  .object({
    new_md: z
      .string()
      .describe("Proposed replacement markdown for this thread's anchor."),
  })
  .describe("Optional attached draft (counter-proposal / edit suggestion).");

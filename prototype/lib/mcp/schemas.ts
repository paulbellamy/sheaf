import { z } from "zod";

/**
 * Shared zod shapes for MCP tool inputs. These are re-used across tool files
 * to keep argument names/descriptions consistent.
 *
 * Size caps are applied at the schema boundary so we reject pathological
 * inputs (1GB writes, unbounded author strings) before the server hashes or
 * serializes them. See todo #013 for rationale.
 */

/** Hard caps used across schemas. Values chosen to fit the prototype's
 *  narrow use-cases; bump only when a concrete need appears. */
export const LIMITS = {
  path: 512,
  ref: 128,
  author: 64,
  opId: 128,
  message: 10_000,
  intent: 2_048,
  name: 256,
  /** Document markdown — we're storing small specs, not documents. */
  content: 1_000_000,
  /** Grep pattern — ReDoS-prone inputs get longer timeouts but the input
   *  itself is still bounded. */
  grepPattern: 1_024,
  glob: 256,
} as const;

export const pathArg = z
  .string()
  .min(1)
  .max(LIMITS.path)
  .describe(
    "Repo-root-relative doc path, e.g. 'workspaces/infra/docs/proposal.md'.",
  );

export const refArg = z
  .string()
  .min(1)
  .max(LIMITS.ref)
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
  .regex(/^draft_[A-Za-z0-9]{6,64}(?:-[A-Za-z0-9]{1,64}){0,8}$/)
  .describe("Draft id returned by Fork, e.g. 'draft_<uuid>'.");

export const threadIdArg = z
  .string()
  .regex(/^thrd_[A-Za-z0-9]{6,64}(?:-[A-Za-z0-9]{1,64}){0,8}$/)
  .describe("Thread id, e.g. 'thrd_<uuid>'.");

export const opIdArg = z
  .string()
  .max(LIMITS.opId)
  .optional()
  .describe(
    "Client-supplied idempotency key. Retrying a write with the same op_id returns the original result without re-applying.",
  );

/** Author handle — restricted charset blocks attribution forgery with
 *  markdown/control characters that would otherwise render weirdly in the
 *  review UI. */
export const authorArg = z
  .string()
  .regex(/^[a-zA-Z0-9._@:\- ]{1,64}$/)
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
      .max(LIMITS.content)
      .describe("Proposed replacement markdown for this thread's anchor."),
  })
  .describe("Optional attached draft (counter-proposal / edit suggestion).");

/** Shared bounded-content schema for Write/Edit tool payloads. */
export const contentArg = z
  .string()
  .max(LIMITS.content)
  .describe("Document markdown (bounded).");

export const messageArg = z
  .string()
  .min(1)
  .max(LIMITS.message)
  .describe("Thread message body (bounded).");

export const intentArg = z
  .string()
  .max(LIMITS.intent)
  .optional()
  .describe("Natural-language intent string (bounded).");

export const nameArg = z
  .string()
  .max(LIMITS.name)
  .optional()
  .describe("Draft name / label (bounded).");

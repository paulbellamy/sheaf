import { z } from "zod";

import type { Backend, ThreadDraftBody, ThreadMessage } from "./backend/index";
import { assertThreadId } from "./paths";

/**
 * UI route logic, framework-agnostic. Each handler takes the backend plus the
 * already-extracted inputs (path/query/body) and returns an `{status, json}`
 * result, or throws a `SheafError` for the adapter to map. The Next route
 * files and the Fastify routes are thin wrappers over these — one source of
 * truth for `/api/ui/*` behaviour and response shapes.
 */
export type HandlerResult = { status: number; json: unknown };

function invalidBody(error: z.ZodError): HandlerResult {
  return {
    status: 400,
    json: {
      error: "invalid body",
      details: error.issues.map((i) => ({ path: i.path, message: i.message })),
    },
  };
}

/* ------------------------------------------------------------------ docs -- */

/** Group label for the doc list: the doc's top-level folder, or "(root)". */
function folderOf(p: string): string {
  return p.includes("/") ? p.slice(0, p.indexOf("/")) : "(root)";
}

export async function listDocsAndDrafts(backend: Backend): Promise<HandlerResult> {
  // TODO(phase 2): with the draft surfaces gone, `drafts` is always empty here.
  // Drop the `.drafts/` scan + the `drafts` response key (and rename this
  // handler) when the draft/ref data model is excised.
  const allDocs = await backend.listDocs();
  const docs = allDocs
    .map((d) => ({
      path: d.path,
      title: d.title,
      workspace: folderOf(d.path),
      updated_at: d.updated_at,
    }))
    .sort((a, b) => b.updated_at - a.updated_at);

  const allDrafts = await backend.listDrafts();
  const active = allDrafts.filter(
    (d) => d.state === "open" || d.state === "submitted",
  );
  const drafts = (
    await Promise.all(
      active.map(async (d) => {
        const changes = await backend.draftChanges(d.draft_id);
        const changedPaths = changes.map((c) => c.path);
        const primaryPath = changedPaths.includes(d.base_path)
          ? d.base_path
          : (changedPaths[0] ?? d.base_path);
        return {
          draft_id: d.draft_id,
          base_path: d.base_path,
          primary_path: primaryPath,
          changed_paths: changedPaths,
          name: d.name,
          state: d.state,
          author: d.author,
          workspace: folderOf(primaryPath),
          created_at: d.created_at,
        };
      }),
    )
  ).sort((a, b) => b.created_at - a.created_at);

  return { status: 200, json: { docs, drafts } };
}

/* -------------------------------------------------------------- doc read -- */

export async function readDoc(
  backend: Backend,
  opts: { path: string; ref: string },
): Promise<HandlerResult> {
  const { md, version_counter } = await backend.readDoc(opts.path, opts.ref);
  return {
    status: 200,
    json: { path: opts.path, ref: opts.ref, md, version_counter },
  };
}

/* --------------------------------------------------------------- threads -- */

const charRangeSchema = z.object({
  from: z.number().int().min(0),
  to: z.number().int().min(0),
});

const wideTargetSchema = z.union([
  z.object({
    path: z.string().min(1).max(512),
    scope: z.literal("doc"),
  }),
  z.object({
    path: z.string().min(1).max(512),
    scope: z.literal("range").optional(),
    char_range: charRangeSchema,
  }),
]);

const narrowTargetSchema = z.union([
  z.object({ scope: z.literal("doc") }),
  z.object({
    scope: z.literal("range").optional(),
    char_range: charRangeSchema,
  }),
]);

const addThreadBodySchema = z.union([
  z.object({
    targets: z.array(wideTargetSchema).min(1).max(16),
    message: z.string().min(1).max(10_000),
    draft: z.object({ new_md: z.string().max(1_000_000) }).optional(),
  }),
  z.object({
    path: z.string().min(1).max(512),
    targets: z.array(narrowTargetSchema).min(1).max(16),
    message: z.string().min(1).max(10_000),
    draft: z.object({ new_md: z.string().max(1_000_000) }).optional(),
  }),
]);

export async function listThreadsForDoc(
  backend: Backend,
  opts: { path?: string; ref: string },
): Promise<HandlerResult> {
  const summaries = await backend.listThreads({ path: opts.path, ref: opts.ref });
  const threads = await Promise.all(
    summaries.map((s) => backend.readThread(s.id)),
  );
  return {
    status: 200,
    json: { path: opts.path, ref: opts.ref, threads },
  };
}

export async function addThread(
  backend: Backend,
  opts: { ref: string; body: unknown },
): Promise<HandlerResult> {
  const parsed = addThreadBodySchema.safeParse(opts.body);
  if (!parsed.success) return invalidBody(parsed.error);
  const body = parsed.data;
  // Normalize: wide form keeps per-target paths; narrow form repeats `path`.
  const targets =
    "path" in body
      ? body.targets.map((t) =>
          t.scope === "doc"
            ? ({ path: body.path, scope: "doc" as const })
            : ({
                path: body.path,
                scope: "range" as const,
                char_range: t.char_range,
              }),
        )
      : body.targets.map((t) =>
          t.scope === "doc"
            ? ({ path: t.path, scope: "doc" as const })
            : ({
                path: t.path,
                scope: "range" as const,
                char_range: t.char_range,
              }),
        );
  const id = await backend.addThread({
    ref: opts.ref,
    author: "user",
    message: body.message,
    draft: body.draft,
    targets,
  });
  return { status: 201, json: { thread_id: id } };
}

const replyBodySchema = z.object({
  message: z.string().min(1).max(10_000),
  draft: z.object({ new_md: z.string().max(1_000_000) }).optional(),
});

export async function replyThread(
  backend: Backend,
  opts: { id: string; body: unknown },
): Promise<HandlerResult> {
  assertThreadId(opts.id);
  const parsed = replyBodySchema.safeParse(opts.body);
  if (!parsed.success) return invalidBody(parsed.error);
  await backend.replyThread(opts.id, parsed.data.message, {
    author: "user",
    draft: parsed.data.draft,
  });
  return { status: 200, json: { ok: true } };
}

/**
 * Walk the thread message log newest-first and pick the latest message that
 * carries `draft_options` or a single `draft`. Returns the leaf to apply, or
 * null if the thread has no payload to apply.
 */
function pickLeaf(
  messages: ThreadMessage[],
  optionIndex: number | undefined,
): ThreadDraftBody | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.draft_options && m.draft_options.length > 0) {
      const idx = optionIndex ?? 0;
      return m.draft_options[idx] ?? m.draft_options[0];
    }
    if (m.draft) return m.draft;
  }
  return null;
}

const optionIndexSchema = z.coerce.number().int().min(0).max(7).optional();

/**
 * Optionally apply a chosen leaf before resolving — but only for draft-mode
 * threads (those with a `draft_id`). Thread-on-doc threads never auto-apply:
 * the pick is routed back to the agent, which makes the real edit.
 */
export async function resolveThread(
  backend: Backend,
  opts: { id: string; optionIndex?: string | null; skipApply: boolean },
): Promise<HandlerResult> {
  assertThreadId(opts.id);
  const optionParsed = optionIndexSchema.safeParse(opts.optionIndex ?? undefined);
  if (!optionParsed.success) {
    return { status: 400, json: { error: "invalid option_index" } };
  }
  const optionIndex = optionParsed.data;

  const thread = await backend.readThread(opts.id);
  const applyRef = thread.draft_id;
  const leaf =
    opts.skipApply || !applyRef ? null : pickLeaf(thread.messages, optionIndex);
  if (leaf && applyRef && thread.targets.length > 0) {
    for (const target of thread.targets) {
      try {
        if (target.scope === "range") {
          const oldString = target.anchor.anchored_text;
          if (oldString.length === 0) continue;
          await backend.editDoc(target.path, applyRef, oldString, leaf.new_md, false);
        } else {
          await backend.writeDoc(target.path, applyRef, leaf.new_md);
        }
      } catch {
        // Anchored text drifted, or the write conflicted. Fall through to
        // resolve so the thread doesn't get stuck on a stale anchor.
      }
    }
  }
  await backend.resolveThread(opts.id);
  return { status: 200, json: { ok: true } };
}

export async function reopenThread(
  backend: Backend,
  opts: { id: string },
): Promise<HandlerResult> {
  assertThreadId(opts.id);
  await backend.reopenThread(opts.id);
  return { status: 200, json: { ok: true } };
}

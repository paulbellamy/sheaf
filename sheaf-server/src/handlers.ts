import { z } from "zod";

import type { Backend } from "./backend/index";
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

export async function listDocs(backend: Backend): Promise<HandlerResult> {
  const allDocs = await backend.listDocs();
  const docs = allDocs
    .map((d) => ({
      path: d.path,
      title: d.title,
      workspace: folderOf(d.path),
      updated_at: d.updated_at,
    }))
    .sort((a, b) => b.updated_at - a.updated_at);

  return { status: 200, json: { docs } };
}

/* -------------------------------------------------------------- doc read -- */

export async function readDoc(
  backend: Backend,
  opts: { path: string },
): Promise<HandlerResult> {
  const { md } = await backend.readDoc(opts.path);
  return {
    status: 200,
    json: { path: opts.path, md },
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
  opts: { path?: string },
): Promise<HandlerResult> {
  const summaries = await backend.listThreads({ path: opts.path });
  const threads = await Promise.all(
    summaries.map((s) => backend.readThread(s.id)),
  );
  return {
    status: 200,
    json: { path: opts.path, threads },
  };
}

export async function addThread(
  backend: Backend,
  opts: { body: unknown },
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
 * Resolve a thread. In the thread-on-doc workflow a resolve never auto-writes
 * a leaf to the doc: an option's `new_md` is a preview routed back to the agent
 * (which makes the real edit), so resolve just flips the thread's status.
 */
export async function resolveThread(
  backend: Backend,
  opts: { id: string },
): Promise<HandlerResult> {
  assertThreadId(opts.id);
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

import { z } from "zod";

import type { Backend, ThreadDraftBody, ThreadMessage } from "./backend/index";
import { assertDraftId, assertThreadId } from "./paths";
import { loadOrRefreshProfile } from "./style/corpus";
import {
  VOICE_GUIDE_PATH,
  VOICE_GUIDE_PLACEHOLDER,
  buildVoiceGuideRequestMessage,
} from "./style/profile";
import { styleConfigSchema } from "./style/schemas";

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

export async function docVersions(
  backend: Backend,
  opts: { path: string },
): Promise<HandlerResult> {
  const [{ version_counter }, history] = await Promise.all([
    backend.readDoc(opts.path),
    backend.listVersionHistory(opts.path),
  ]);
  const byVersion = new Map<number, { draft_id: string; accepted_at: number }>();
  for (const e of history) {
    byVersion.set(e.version, { draft_id: e.draft_id, accepted_at: e.accepted_at });
  }
  const versions: {
    version: number;
    draft_id?: string;
    accepted_at?: number;
  }[] = [];
  const top = Math.max(version_counter, 1);
  for (let v = 1; v <= top; v++) {
    const entry = byVersion.get(v);
    versions.push(
      entry
        ? { version: v, draft_id: entry.draft_id, accepted_at: entry.accepted_at }
        : { version: v },
    );
  }
  return { status: 200, json: { path: opts.path, versions } };
}

const renameBodySchema = z.object({
  from: z.string().min(1).max(512),
  to: z.string().min(1).max(512),
});

/**
 * Reconcile sheaf's review state after the vault renamed `from` → `to` —
 * either a single doc or a whole folder (the backend remaps every descendant).
 * The Obsidian plugin fires this on `vault.on("rename")` so the target paths
 * stored in each doc's endmatter, version history, and drafts follow the move
 * instead of orphaning on the old path. The byte move is the vault's job (a
 * doc's threads travel inline with it); this only fixes sheaf's metadata.
 */
export async function renameDoc(
  backend: Backend,
  opts: { body: unknown },
): Promise<HandlerResult> {
  const parsed = renameBodySchema.safeParse(opts.body);
  if (!parsed.success) return invalidBody(parsed.error);
  const moved = await backend.renameDoc(parsed.data.from, parsed.data.to);
  return { status: 200, json: { ok: true, moved_threads: moved } };
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

const draftBodySchema = z.object({
  new_md: z.string().max(1_000_000),
  name: z.string().min(1).max(256).optional(),
  description: z.string().max(1_000).optional(),
});

const draftOptionSchema = z.object({
  name: z.string().min(1).max(256),
  new_md: z.string().max(1_000_000),
  description: z.string().max(1_000).optional(),
});

const attachPayloadBodySchema = z.object({
  message: z.string().min(1).max(10_000).optional(),
  draft: draftBodySchema.optional(),
  draft_options: z.array(draftOptionSchema).min(2).max(8).optional(),
  author: z
    .string()
    .regex(/^[a-zA-Z0-9._@:\- ]{1,64}$/)
    .optional(),
});

export async function attachPayload(
  backend: Backend,
  opts: { id: string; body: unknown },
): Promise<HandlerResult> {
  assertThreadId(opts.id);
  const parsed = attachPayloadBodySchema.safeParse(opts.body);
  if (!parsed.success) return invalidBody(parsed.error);
  const body = parsed.data;
  const hasDraft = body.draft !== undefined;
  const hasOptions =
    body.draft_options !== undefined && body.draft_options.length > 0;
  if (!hasDraft && !hasOptions) {
    return {
      status: 400,
      json: { error: "must provide `draft` or `draft_options`" },
    };
  }
  if (hasDraft && hasOptions) {
    return {
      status: 400,
      json: {
        error:
          "must provide either `draft` (1 leaf) or `draft_options` (>1); not both",
      },
    };
  }
  await backend.attachDraftPayload(opts.id, {
    message: body.message,
    draft: body.draft,
    draft_options: body.draft_options,
    author: body.author ?? "user",
  });
  return { status: 201, json: { ok: true } };
}

/* ---------------------------------------------------------------- drafts -- */

export async function listDrafts(backend: Backend): Promise<HandlerResult> {
  const drafts = await backend.listDrafts();
  return { status: 200, json: { drafts } };
}

const createDraftTargetSchema = z.object({
  path: z.string().min(1).max(512),
  char_range: charRangeSchema,
});

const initialThreadSchema = z.object({
  targets: z.array(createDraftTargetSchema).min(1).max(16),
  message: z.string().min(1).max(10_000),
  draft: z.object({ new_md: z.string().max(1_000_000) }).optional(),
});

const createDraftBodySchema = z.object({
  base_path: z.string().min(1).max(512),
  base_ref: z.literal("main"),
  base_version: z.number().int().nonnegative(),
  name: z.string().min(1).max(256),
  initial_threads: z.array(initialThreadSchema).max(64),
});

export async function createDraft(
  backend: Backend,
  opts: { body: unknown },
): Promise<HandlerResult> {
  const parsed = createDraftBodySchema.safeParse(opts.body);
  if (!parsed.success) return invalidBody(parsed.error);
  const body = parsed.data;
  const result = await backend.forkAndAttachThreads({
    base_path: body.base_path,
    base_version: body.base_version,
    name: body.name,
    author: "user",
    initial_threads: body.initial_threads.map((t) => ({
      targets: t.targets,
      message: t.message,
      draft: t.draft,
    })),
  });
  return { status: 201, json: result };
}

export async function getDraft(
  backend: Backend,
  opts: { id: string },
): Promise<HandlerResult> {
  assertDraftId(opts.id);
  const drafts = await backend.listDrafts();
  const meta = drafts.find((d) => d.draft_id === opts.id);
  if (!meta) return { status: 404, json: { error: "not found" } };
  const [changes, threads] = await Promise.all([
    backend.draftChanges(opts.id),
    backend.listThreads({ ref: opts.id }),
  ]);
  const open_count = threads.filter((t) => t.status === "open").length;
  return {
    status: 200,
    json: {
      draft_id: meta.draft_id,
      display_name: meta.display_name ?? meta.name ?? meta.draft_id,
      base_version: meta.base_version,
      touches: meta.touches,
      open_count,
      state: meta.state,
      versions_behind: meta.versions_behind,
      meta,
      changes,
    },
  };
}

export async function acceptDraft(
  backend: Backend,
  opts: { id: string },
): Promise<HandlerResult> {
  assertDraftId(opts.id);
  // The banner-driven accept skips the agent-only Propose step. Move through
  // `submitted` here so `merge()`'s gating accepts the call.
  const drafts = await backend.listDrafts();
  const meta = drafts.find((d) => d.draft_id === opts.id);
  if (meta && meta.state === "open") {
    await backend.propose(opts.id);
  }
  const result = await backend.merge(opts.id);
  return { status: 200, json: { ok: true, ...result } };
}

export async function declineDraft(
  backend: Backend,
  opts: { id: string },
): Promise<HandlerResult> {
  assertDraftId(opts.id);
  await backend.declineDraft(opts.id);
  return { status: 200, json: { ok: true } };
}

/* ------------------------------------------------------------- style/voice -- */

export async function getStyleConfig(backend: Backend): Promise<HandlerResult> {
  const config = await backend.readStyleConfig();
  return { status: 200, json: { config } };
}

export async function putStyleConfig(
  backend: Backend,
  opts: { body: unknown },
): Promise<HandlerResult> {
  const parsed = styleConfigSchema.safeParse(opts.body);
  if (!parsed.success) return invalidBody(parsed.error);
  await backend.writeStyleConfig(parsed.data);
  return { status: 200, json: { ok: true, config: parsed.data } };
}

/**
 * Kick off a voice-guide build: recompute the deterministic metrics now (so the
 * UI can report "analyzed N notes" immediately), ensure the visible guide doc
 * exists, and post a `[sheaf:build-voice-guide]` request thread for the
 * connected agent to pick up. The agent does the distillation; if none is
 * connected the thread simply waits, and the metrics are cached regardless.
 */
export async function buildStyleGuide(backend: Backend): Promise<HandlerResult> {
  const config = await backend.readStyleConfig();
  const load = await loadOrRefreshProfile(backend, config);

  try {
    await backend.readDoc(VOICE_GUIDE_PATH, "main");
  } catch {
    await backend.writeDoc(
      VOICE_GUIDE_PATH,
      "main",
      VOICE_GUIDE_PLACEHOLDER,
      undefined,
      "ui",
    );
  }

  const threadId = await backend.addThread({
    ref: "main",
    author: "user",
    message: buildVoiceGuideRequestMessage(),
    targets: [{ path: VOICE_GUIDE_PATH, scope: "doc" }],
    origin: "ui",
  });

  return {
    status: 200,
    json: {
      thread_id: threadId,
      doc_count: load.profile.fingerprint.doc_count,
      word_count: load.profile.metrics.word_count,
      low_corpus: load.low_corpus,
    },
  };
}

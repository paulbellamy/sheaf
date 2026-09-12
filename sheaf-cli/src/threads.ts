/**
 * The thread verbs: `sheaf thread list|show|add|reply|resolve|reopen`.
 *
 * The **wire split** (docs/sheaf-cli-v0.1.md "Wire protocol") lives here:
 *   - **Reads** (`list`, `show`) go over the MCP tool surface — origin is
 *     irrelevant and there's no `thread show` REST route.
 *   - **Mutations** (`add`, `reply`, `resolve`, `reopen`) default to `--as ui`,
 *     which routes through the REST `/api/ui/*` surface so the daemon stamps
 *     origin `ui` and **wakes the connected agent**. `--as agent` instead calls
 *     the MCP tool (origin `agent`), which does *not* wake the agent watcher.
 *
 * Two mutation paths have no agent equivalent and say so with a usage error
 * rather than a confusing schema/transport failure:
 *   - `reopen --as agent` — there is no `ReopenThread` MCP tool (reopen exists
 *     only as REST + a backend method).
 *   - `add --doc --as agent` — the `AddThread` tool's `targets` are range
 *     anchors (`{ path, char_range }`); a doc-scope target isn't expressible
 *     through it. `--as ui` handles doc-level threads.
 */
import type {
  Thread,
  ThreadMessage,
  ThreadSummary,
} from "sheaf-server/types";

import { connectDaemon, requireDaemonAllowed } from "./client";
import type { RunContext } from "./commands";
import { intFlag, parseAs, requireThreadId, strFlag } from "./flags";
import { EXIT, usageError, type ExitCode } from "./io";
import { callTool } from "./tool-call";

/* ------------------------------------------------------------------ reads -- */

/**
 * `sheaf thread list [--path P] [--ref REF]` → the `ListThreads` tool. Prints a
 * compact line per thread (id, status, target paths, message count, last-
 * message preview) or the raw `{ threads }` payload (`--format json`).
 */
export async function threadListCommand(ctx: RunContext): Promise<ExitCode> {
  requireDaemonAllowed(ctx.globals, "sheaf thread list");

  const path = strFlag(ctx.values, "path");
  const ref = strFlag(ctx.values, "ref");

  const client = await connectDaemon(ctx.vault, ctx.io.env);
  try {
    const mcp = await client.mcp();
    const result = await callTool(mcp, "ListThreads", {
      ...(path !== undefined ? { path } : {}),
      ...(ref !== undefined ? { ref } : {}),
    });
    const threads =
      (result.structuredContent as { threads?: ThreadSummary[] } | undefined)
        ?.threads ?? [];

    if (ctx.out.format === "json") {
      ctx.out.json({ threads });
      return EXIT.OK;
    }
    if (threads.length === 0) {
      ctx.out.text("(no threads)");
      return EXIT.OK;
    }
    for (const t of threads) {
      ctx.out.text(
        `${t.id}  ${t.status.padEnd(8)}  ${t.target_paths.join(", ")}  (${t.message_count} msg) — ${t.last_message_preview}`,
      );
    }
    return EXIT.OK;
  } finally {
    await client.close();
  }
}

/**
 * `sheaf thread show <id>` → the `ReadThread` tool. Prints the thread's
 * targets+anchors and each message (author/ts/body, plus any attached draft or
 * draft options), or the raw `Thread` object (`--format json`).
 */
export async function threadShowCommand(ctx: RunContext): Promise<ExitCode> {
  requireDaemonAllowed(ctx.globals, "sheaf thread show");

  const id = ctx.positionals[0];
  if (id === undefined) throw usageError("sheaf thread show requires a <id>");
  requireThreadId(id);

  const client = await connectDaemon(ctx.vault, ctx.io.env);
  try {
    const mcp = await client.mcp();
    const result = await callTool(mcp, "ReadThread", { thread_id: id });
    const thread = result.structuredContent as Thread;

    if (ctx.out.format === "json") {
      ctx.out.json(thread);
      return EXIT.OK;
    }
    renderThread(ctx, thread);
    return EXIT.OK;
  } finally {
    await client.close();
  }
}

/** Human-readable rendering of a full {@link Thread}. */
function renderThread(ctx: RunContext, thread: Thread): void {
  ctx.out.text(`${thread.id}  [${thread.status}]  ${iso(thread.created)}`);
  ctx.out.text("targets:");
  for (const t of thread.targets) {
    if (t.scope === "doc") {
      ctx.out.text(`  ${t.path}  (doc-level)`);
    } else {
      ctx.out.text(`  ${t.path}  "${truncate(t.anchor.anchored_text, 60)}"`);
    }
  }
  ctx.out.text("messages:");
  for (const m of thread.messages) {
    ctx.out.text(`  [${iso(m.ts)}] ${m.author}: ${m.body}`);
    renderDrafts(ctx, m);
  }
}

/** Show a message's attached draft / draft options as indented preview lines. */
function renderDrafts(ctx: RunContext, m: ThreadMessage): void {
  if (m.draft) {
    ctx.out.text(`    draft: ${truncate(m.draft.new_md, 80)}`);
  }
  for (const opt of m.draft_options ?? []) {
    const label = opt.name ?? "option";
    ctx.out.text(`    option ${label}: ${truncate(opt.new_md, 80)}`);
  }
}

/* -------------------------------------------------------------- mutations -- */

/** One target built from `--range`/`--doc`, as the REST/MCP payloads expect. */
type ThreadTargetInput =
  | { path: string; scope: "doc" }
  | { path: string; char_range: { from: number; to: number } };

/** Parse `--range FROM:TO` into a char range; a malformed value is a usage error. */
function parseRange(spec: string): { from: number; to: number } {
  const m = /^(\d+):(\d+)$/.exec(spec);
  if (!m) {
    throw usageError(
      `--range must be FROM:TO with non-negative integers (got '${spec}')`,
    );
  }
  return { from: Number(m[1]), to: Number(m[2]) };
}

/**
 * `sheaf thread add --path P (--range FROM:TO | --doc) -m MSG [--as ui|agent]
 * [--ref REF]`. Builds exactly one target and creates the thread: `--as ui`
 * (default) via `POST /api/ui/threads` (author `user`, origin `ui`, wakes the
 * agent); `--as agent` via the `AddThread` tool (origin `agent`). Prints the
 * new thread id.
 */
export async function threadAddCommand(ctx: RunContext): Promise<ExitCode> {
  requireDaemonAllowed(ctx.globals, "sheaf thread add");

  const path = strFlag(ctx.values, "path");
  if (path === undefined) throw usageError("sheaf thread add requires --path P");
  const message = strFlag(ctx.values, "message");
  if (message === undefined) {
    throw usageError("sheaf thread add requires -m/--message MSG");
  }
  const range = strFlag(ctx.values, "range");
  const doc = ctx.values.doc === true;
  // Exactly one of --range / --doc. `(range set) === doc` is true iff both are
  // set or both are unset — either way an error.
  if ((range !== undefined) === doc) {
    throw usageError(
      "sheaf thread add requires exactly one of --range FROM:TO or --doc",
    );
  }
  const as = parseAs(ctx.values.as);
  const ref = strFlag(ctx.values, "ref");

  // Validate the unsupported agent+doc combo before touching the daemon, so it
  // surfaces as a usage error (exit 2) even when no daemon is running.
  if (as === "agent" && doc) {
    throw usageError(
      "sheaf thread add --doc is only supported with --as ui; the agent AddThread tool anchors to a char range",
    );
  }

  const target: ThreadTargetInput = doc
    ? { path, scope: "doc" }
    : { path, char_range: parseRange(range as string) };

  const client = await connectDaemon(ctx.vault, ctx.io.env);
  try {
    let threadId: string;
    if (as === "ui") {
      const body = await client.rest<{ thread_id: string }>(
        "POST",
        "/api/ui/threads",
        {
          query: ref !== undefined ? { ref } : undefined,
          body: { targets: [target], message },
        },
      );
      threadId = body.thread_id;
    } else {
      const mcp = await client.mcp();
      const result = await callTool(mcp, "AddThread", {
        targets: [target],
        message,
        ...(ref !== undefined ? { ref } : {}),
      });
      threadId = (result.structuredContent as { thread_id: string }).thread_id;
    }

    if (ctx.out.format === "json") ctx.out.json({ thread_id: threadId });
    else ctx.out.text(`created thread ${threadId}`);
    return EXIT.OK;
  } finally {
    await client.close();
  }
}

/**
 * `sheaf thread reply <id> -m MSG [--as ui|agent]`. `--as ui` →
 * `POST /api/ui/threads/:id/reply`; `--as agent` → the `ReplyThread` tool.
 */
export async function threadReplyCommand(ctx: RunContext): Promise<ExitCode> {
  requireDaemonAllowed(ctx.globals, "sheaf thread reply");

  const id = ctx.positionals[0];
  if (id === undefined) throw usageError("sheaf thread reply requires a <id>");
  requireThreadId(id);
  const message = strFlag(ctx.values, "message");
  if (message === undefined) {
    throw usageError("sheaf thread reply requires -m/--message MSG");
  }
  const as = parseAs(ctx.values.as);

  const client = await connectDaemon(ctx.vault, ctx.io.env);
  try {
    if (as === "ui") {
      await client.rest("POST", `/api/ui/threads/${encodeURIComponent(id)}/reply`, {
        body: { message },
      });
    } else {
      const mcp = await client.mcp();
      await callTool(mcp, "ReplyThread", { thread_id: id, message });
    }

    if (ctx.out.format === "json") ctx.out.json({ thread_id: id, ok: true });
    else ctx.out.text(`replied to ${id}`);
    return EXIT.OK;
  } finally {
    await client.close();
  }
}

/**
 * `sheaf thread resolve <id> [--as ui|agent] [--no-apply] [--option N]`.
 *
 * `--as ui` → `POST /api/ui/threads/:id/resolve`; `--as agent` → the
 * `ResolveThread` tool. On the `ui` path a resolve **applies an attached draft
 * leaf into the doc by default** (the plugin's "resolve & take"): `--no-apply`
 * (`?apply=false`) resolves without taking, and `--option N` (`?option_index=N`)
 * picks which option leaf to apply. Both are `ui`-only — the `agent` tool just
 * flips status — but `--option` is still parsed on both paths so a malformed
 * value is a clean usage error.
 */
export async function threadResolveCommand(ctx: RunContext): Promise<ExitCode> {
  requireDaemonAllowed(ctx.globals, "sheaf thread resolve");

  const id = ctx.positionals[0];
  if (id === undefined) throw usageError("sheaf thread resolve requires a <id>");
  requireThreadId(id);
  const as = parseAs(ctx.values.as);
  const noApply = ctx.values["no-apply"] === true;
  const option = intFlag(ctx.values, "option", "--option", 0);

  const client = await connectDaemon(ctx.vault, ctx.io.env);
  try {
    if (as === "ui") {
      await client.rest(
        "POST",
        `/api/ui/threads/${encodeURIComponent(id)}/resolve`,
        {
          query: {
            apply: noApply ? "false" : undefined,
            option_index: option,
          },
        },
      );
    } else {
      const mcp = await client.mcp();
      await callTool(mcp, "ResolveThread", { thread_id: id });
    }

    if (ctx.out.format === "json") ctx.out.json({ thread_id: id, ok: true });
    else ctx.out.text(`resolved ${id}`);
    return EXIT.OK;
  } finally {
    await client.close();
  }
}

/**
 * `sheaf thread reopen <id> [--as ui]`. Only the `ui` path exists: reopen is a
 * REST route (`POST /api/ui/threads/:id/reopen`) + a backend method with no
 * `ReopenThread` MCP tool, so `--as agent` is a usage error.
 */
export async function threadReopenCommand(ctx: RunContext): Promise<ExitCode> {
  requireDaemonAllowed(ctx.globals, "sheaf thread reopen");

  const id = ctx.positionals[0];
  if (id === undefined) throw usageError("sheaf thread reopen requires a <id>");
  requireThreadId(id);
  const as = parseAs(ctx.values.as);
  if (as === "agent") {
    throw usageError(
      "sheaf thread reopen is only supported with --as ui; there is no agent-facing ReopenThread MCP tool",
    );
  }

  const client = await connectDaemon(ctx.vault, ctx.io.env);
  try {
    await client.rest(
      "POST",
      `/api/ui/threads/${encodeURIComponent(id)}/reopen`,
    );

    if (ctx.out.format === "json") ctx.out.json({ thread_id: id, ok: true });
    else ctx.out.text(`reopened ${id}`);
    return EXIT.OK;
  } finally {
    await client.close();
  }
}

/* ---------------------------------------------------------------- helpers -- */

/** ISO-8601 rendering of a unix-ms timestamp (matches the server's thread text). */
function iso(ts: number): string {
  return new Date(ts).toISOString();
}

/** Truncate to `max` chars with an ellipsis, collapsing embedded newlines. */
function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

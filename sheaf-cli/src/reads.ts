/**
 * The document-read verbs: `sheaf read`, `sheaf grep`, `sheaf glob`.
 *
 * All three go over the **MCP tool surface** rather than REST: there is no
 * REST route for `grep`/`glob`, and origin is irrelevant for a read, so the
 * plan (docs/sheaf-cli-v0.1.md "Wire protocol") routes every read through
 * `client.mcp().callTool(...)`. Each verb:
 *   - guards `--no-daemon` (reads need the daemon; `requireDaemonAllowed`),
 *   - `connectDaemon` → `mcp()` → `callTool`,
 *   - renders the tool's result human-readably by default, or emits the raw
 *     structured payload under `--format json`,
 *   - always `close()`s the client in a `finally` so the MCP socket can't keep
 *     the process alive.
 *
 * This mirrors {@link docsCommand}'s shape (the REST exemplar) on the MCP side.
 */
import type { DocSummary, GrepResult } from "sheaf-server/types";

import { connectDaemon, requireDaemonAllowed } from "./client";
import type { RunContext } from "./commands";
import { intFlag, strFlag } from "./flags";
import { EXIT, usageError, type ExitCode } from "./io";
import { callTool, firstText } from "./tool-call";

/**
 * `sheaf read <path> [--ref REF]` → the `Read` tool.
 *
 * Text mode prints the doc's markdown (the tool's first text block — the body,
 * without the `ref/version` footer the tool appends for agents). JSON mode
 * emits the full tool result (`content` blocks + any metadata), since `Read`
 * carries no `structuredContent` of its own.
 */
export async function readCommand(ctx: RunContext): Promise<ExitCode> {
  requireDaemonAllowed(ctx.globals, "sheaf read");

  const path = ctx.positionals[0];
  if (path === undefined) throw usageError("sheaf read requires a <path>");
  const ref = strFlag(ctx.values, "ref");

  const client = await connectDaemon(ctx.vault, ctx.io.env);
  try {
    const mcp = await client.mcp();
    const result = await callTool(mcp, "Read", {
      file_path: path,
      ...(ref !== undefined ? { ref } : {}),
    });

    if (ctx.out.format === "json") {
      ctx.out.json(result);
      return EXIT.OK;
    }
    const md = firstText(result);
    if (md !== undefined) ctx.out.text(md);
    return EXIT.OK;
  } finally {
    await client.close();
  }
}

/** The three ripgrep-shaped output modes the `Grep` tool understands. */
type GrepOutputMode = "content" | "files_with_matches" | "count";

/** Validate `--output-mode`; anything else is a usage error (exit 2). */
function parseOutputMode(value: unknown): GrepOutputMode | undefined {
  if (value === undefined) return undefined;
  if (
    value === "content" ||
    value === "files_with_matches" ||
    value === "count"
  ) {
    return value;
  }
  throw usageError(
    `--output-mode must be 'content', 'files_with_matches', or 'count' (got '${String(value)}')`,
  );
}

/**
 * `sheaf grep <pattern> [--path][--glob][-i][-A n][-B n][--multiline]
 * [--head-limit n][--output-mode][--ref]` → the `Grep` tool.
 *
 * The tool returns a discriminated `GrepResult` as `structuredContent`; JSON
 * mode emits it raw. Text mode renders per output mode: `path:line: text` (with
 * context lines) for `content`, one path per line for `files_with_matches`, and
 * `path:count` for `count`.
 */
export async function grepCommand(ctx: RunContext): Promise<ExitCode> {
  requireDaemonAllowed(ctx.globals, "sheaf grep");

  const pattern = ctx.positionals[0];
  if (pattern === undefined) throw usageError("sheaf grep requires a <pattern>");

  const outputMode = parseOutputMode(ctx.values["output-mode"]);
  const after = intFlag(ctx.values, "after-context", "-A");
  const before = intFlag(ctx.values, "before-context", "-B");
  const headLimit = intFlag(ctx.values, "head-limit", "--head-limit");
  const path = strFlag(ctx.values, "path");
  const glob = strFlag(ctx.values, "glob");
  const ref = strFlag(ctx.values, "ref");

  // The Grep tool's input keys mirror ripgrep's flags (`-i`/`-A`/`-B`), which is
  // why they're passed under those exact names rather than the backend's
  // `case_insensitive`/`before_context`/`after_context`.
  const args: Record<string, unknown> = { pattern };
  if (path !== undefined) args.path = path;
  if (glob !== undefined) args.glob = glob;
  if (ctx.values["ignore-case"] === true) args["-i"] = true;
  if (after !== undefined) args["-A"] = after;
  if (before !== undefined) args["-B"] = before;
  if (ctx.values.multiline === true) args.multiline = true;
  if (headLimit !== undefined) args.head_limit = headLimit;
  if (outputMode !== undefined) args.output_mode = outputMode;
  if (ref !== undefined) args.ref = ref;

  const client = await connectDaemon(ctx.vault, ctx.io.env);
  try {
    const mcp = await client.mcp();
    const result = await callTool(mcp, "Grep", args);
    const grep = result.structuredContent as GrepResult;

    if (ctx.out.format === "json") {
      ctx.out.json(grep);
      return EXIT.OK;
    }
    renderGrep(ctx, grep);
    return EXIT.OK;
  } finally {
    await client.close();
  }
}

/** Human-readable rendering of a {@link GrepResult}, per output mode. */
function renderGrep(ctx: RunContext, grep: GrepResult): void {
  if (grep.mode === "files_with_matches") {
    if (grep.paths.length === 0) return void ctx.out.text("(no matches)");
    for (const p of grep.paths) ctx.out.text(p);
    return;
  }
  if (grep.mode === "count") {
    if (grep.counts.length === 0) return void ctx.out.text("(no matches)");
    for (const c of grep.counts) ctx.out.text(`${c.path}:${c.count}`);
    return;
  }
  // content mode
  if (grep.matches.length === 0) return void ctx.out.text("(no matches)");
  for (const m of grep.matches) {
    for (const line of m.before ?? []) ctx.out.text(`  ${line}`);
    ctx.out.text(`${m.path}:${m.line}: ${m.text}`);
    for (const line of m.after ?? []) ctx.out.text(`  ${line}`);
  }
}

/**
 * `sheaf glob <pattern> [--ref REF]` → the `Glob` tool. Prints one matching doc
 * path per line (text) or the raw `{ matches }` payload (`--format json`).
 */
export async function globCommand(ctx: RunContext): Promise<ExitCode> {
  requireDaemonAllowed(ctx.globals, "sheaf glob");

  const pattern = ctx.positionals[0];
  if (pattern === undefined) throw usageError("sheaf glob requires a <pattern>");
  const ref = strFlag(ctx.values, "ref");

  const client = await connectDaemon(ctx.vault, ctx.io.env);
  try {
    const mcp = await client.mcp();
    const result = await callTool(mcp, "Glob", {
      pattern,
      ...(ref !== undefined ? { ref } : {}),
    });
    const matches =
      (result.structuredContent as { matches?: DocSummary[] } | undefined)
        ?.matches ?? [];

    if (ctx.out.format === "json") {
      ctx.out.json({ matches });
      return EXIT.OK;
    }
    if (matches.length === 0) {
      ctx.out.text("(no matches)");
      return EXIT.OK;
    }
    for (const d of matches) ctx.out.text(d.path);
    return EXIT.OK;
  } finally {
    await client.close();
  }
}

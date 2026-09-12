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
 * without the `ref/version` footer the tool appends for agents). JSON mode emits
 * a clean domain object `{ path, ref, md, version_counter, version_token,
 * origin }`, parsed out of the tool's body + footer blocks, so consumers get
 * one flat object like the other verbs rather than the raw `content` array.
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

    // The Read tool emits two text blocks: [0] the doc body, [1] a
    // `--\nref: … v: … version_token: … origin: …` footer.
    const blocks = (result.content ?? []).filter(
      (b): b is { type: "text"; text: string } =>
        b.type === "text" && typeof b.text === "string",
    );
    const md = blocks[0]?.text ?? firstText(result) ?? "";

    if (ctx.out.format === "json") {
      ctx.out.json(parseReadResult(path, ref, md, blocks[1]?.text));
      return EXIT.OK;
    }
    ctx.out.text(md);
    return EXIT.OK;
  } finally {
    await client.close();
  }
}

/** The Read tool's footer, e.g. `--\nref: main  v: 1  version_token: v-ab  origin: main`. */
const READ_FOOTER_RE =
  /ref:\s*(\S+)\s+v:\s*(\d+)\s+version_token:\s*(\S+)\s+origin:\s*(\S+)/;

/**
 * Fold the Read tool's body + footer blocks into a flat domain object. The
 * footer is deterministic (see `sheaf-server/src/tools/read.ts`); if it ever
 * fails to parse, the doc `md` and requested `ref` still come through.
 */
function parseReadResult(
  path: string,
  requestedRef: string | undefined,
  md: string,
  footer: string | undefined,
): Record<string, unknown> {
  const m = footer ? READ_FOOTER_RE.exec(footer) : null;
  return {
    path,
    ref: m?.[1] ?? requestedRef ?? "main",
    md,
    ...(m ? { version_counter: Number(m[2]) } : {}),
    ...(m ? { version_token: m[3] } : {}),
    ...(m ? { origin: m[4] } : {}),
  };
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
  const headLimit = intFlag(ctx.values, "head-limit", "--head-limit", 1);
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
  renderGrepContent(ctx, grep.matches);
}

/**
 * Render content-mode matches like ripgrep: dedupe overlapping context windows
 * (adjacent matches with `-A`/`-B` otherwise reprint the shared lines), keep a
 * line as a match line where it is one, and emit a `--` separator between
 * non-contiguous groups (and between files).
 */
function renderGrepContent(
  ctx: RunContext,
  matches: { path: string; line: number; text: string; before?: string[]; after?: string[] }[],
): void {
  // Group by path in first-seen order; matches within a doc are already ordered.
  const byPath = new Map<string, typeof matches>();
  for (const m of matches) {
    const group = byPath.get(m.path);
    if (group) group.push(m);
    else byPath.set(m.path, [m]);
  }

  let firstGroup = true;
  for (const [path, group] of byPath) {
    // Merge every match's window into one line-number → {text, isMatch} map;
    // a match line always wins over a context line for the same number.
    const lines = new Map<number, { text: string; isMatch: boolean }>();
    for (const m of group) {
      const before = m.before ?? [];
      const after = m.after ?? [];
      for (let i = 0; i < before.length; i++) {
        const ln = m.line - before.length + i;
        if (!lines.has(ln)) lines.set(ln, { text: before[i], isMatch: false });
      }
      lines.set(m.line, { text: m.text, isMatch: true });
      for (let i = 0; i < after.length; i++) {
        const ln = m.line + 1 + i;
        if (!lines.has(ln)) lines.set(ln, { text: after[i], isMatch: false });
      }
    }

    const nums = [...lines.keys()].sort((a, b) => a - b);
    let prev: number | undefined;
    for (const n of nums) {
      // Separator before a new file, or across a gap within a file.
      if (prev === undefined) {
        if (!firstGroup) ctx.out.text("--");
      } else if (n > prev + 1) {
        ctx.out.text("--");
      }
      const entry = lines.get(n) as { text: string; isMatch: boolean };
      ctx.out.text(entry.isMatch ? `${path}:${n}: ${entry.text}` : `  ${entry.text}`);
      prev = n;
    }
    firstGroup = false;
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

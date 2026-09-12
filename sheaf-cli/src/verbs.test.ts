/**
 * Step-6 read + thread verbs, driven in-process against a real daemon.
 *
 * Hermetic: a throwaway `$SHEAF_HOME` + vault (seeded with two `.md` docs) per
 * test, a live daemon via {@link startServer}, always torn down in `afterEach`.
 * Commands run through the real {@link run} dispatcher with a capturing {@link Io}
 * (so the `--no-daemon` guard, vault resolution, and `--format` handling are all
 * exercised), asserting both text and `--format json` output.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Io } from "./io";
import { run } from "./run";
import { startServer, type ServeHandle } from "./serve";

const trash: string[] = [];
const handles: ServeHandle[] = [];

interface Scratch {
  env: NodeJS.ProcessEnv;
  vault: string;
}

const NOTE_MD =
  "# Title\n\nThe quick brown fox jumps over the lazy dog.\nAnother line mentions fox again.\n";

/** Temp `$SHEAF_HOME` + realpath'd vault with two docs, auto-cleaned. */
function scratch(): Scratch {
  const home = mkdtempSync(join(tmpdir(), "sheaf-home-"));
  const vault = realpathSync(mkdtempSync(join(tmpdir(), "sheaf-vault-")));
  writeFileSync(join(vault, "note.md"), NOTE_MD);
  writeFileSync(join(vault, "other.md"), "# Other\n\nnothing to see here\n");
  trash.push(home, vault);
  return { env: { SHEAF_HOME: home }, vault };
}

/** Start a daemon for the scratch vault and register it for teardown. */
async function serve(s: Scratch): Promise<ServeHandle> {
  const handle = await startServer({ vault: s.vault, version: "test", env: s.env });
  handles.push(handle);
  return handle;
}

/** Run one CLI invocation in-process, capturing stdout/stderr and the exit code. */
async function cli(
  s: Scratch,
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (c) => out.push(c),
    err: (c) => err.push(c),
    env: s.env,
    cwd: "/tmp",
  };
  const code = await run(["--vault", s.vault, ...args], io);
  return { code, stdout: out.join(""), stderr: err.join("") };
}

/** Parse the single JSON object a `--format json` command prints on stdout. */
function json<T = unknown>(stdout: string): T {
  return JSON.parse(stdout.trim()) as T;
}

afterEach(async () => {
  for (const h of handles.splice(0)) await h.close().catch(() => {});
  for (const d of trash.splice(0)) rmSync(d, { recursive: true, force: true });
});

/* -------------------------------------------------------------- read verbs -- */

describe("sheaf read", () => {
  it("prints the doc markdown as text and the full tool result as JSON", async () => {
    const s = scratch();
    await serve(s);

    const text = await cli(s, "read", "note.md");
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("The quick brown fox jumps over the lazy dog.");

    const j = await cli(s, "--format", "json", "read", "note.md");
    expect(j.code).toBe(0);
    const body = json<{ content: { type: string; text?: string }[] }>(j.stdout);
    expect(Array.isArray(body.content)).toBe(true);
    expect(body.content[0].text).toContain("The quick brown fox");
  });

  it("errors (exit 1) with the server code for a missing doc", async () => {
    const s = scratch();
    await serve(s);
    const r = await cli(s, "--format", "json", "read", "missing.md");
    expect(r.code).toBe(1);
    expect(json<{ code: string }>(r.stdout).code).toBe("doc_not_found");
  });
});

describe("sheaf grep", () => {
  it("renders content matches as path:line: text and raw JSON", async () => {
    const s = scratch();
    await serve(s);

    const text = await cli(s, "grep", "fox", "--output-mode", "content");
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("note.md:3: The quick brown fox");
    expect(text.stdout).toContain("note.md:4: Another line mentions fox");

    const j = await cli(s, "--format", "json", "grep", "fox", "--output-mode", "content");
    const body = json<{ mode: string; matches: { path: string; line: number }[] }>(j.stdout);
    expect(body.mode).toBe("content");
    expect(body.matches).toHaveLength(2);
    expect(body.matches[0]).toMatchObject({ path: "note.md", line: 3 });
  });

  it("files_with_matches (default) lists paths; count reports per-doc counts", async () => {
    const s = scratch();
    await serve(s);

    const files = await cli(s, "grep", "fox");
    expect(files.stdout.trim()).toBe("note.md");

    const count = await cli(s, "grep", "fox", "--output-mode", "count");
    expect(count.stdout.trim()).toBe("note.md:2");

    const none = await cli(s, "grep", "zzzznotfound");
    expect(none.stdout.trim()).toBe("(no matches)");
  });
});

describe("sheaf glob", () => {
  it("prints matching paths as text and { matches } as JSON", async () => {
    const s = scratch();
    await serve(s);

    const text = await cli(s, "glob", "**/*.md");
    expect(text.code).toBe(0);
    expect(text.stdout.split("\n").filter(Boolean).sort()).toEqual([
      "note.md",
      "other.md",
    ]);

    const j = await cli(s, "--format", "json", "glob", "**/*.md");
    const body = json<{ matches: { path: string }[] }>(j.stdout);
    expect(body.matches.map((m) => m.path).sort()).toEqual(["note.md", "other.md"]);
  });
});

/* ---------------------------------------------------------- thread reads -- */

describe("sheaf thread list / show", () => {
  it("lists and shows a seeded thread in both text and JSON", async () => {
    const s = scratch();
    await serve(s);

    const add = await cli(
      s,
      "--format",
      "json",
      "thread",
      "add",
      "--path",
      "note.md",
      "--range",
      "0:5",
      "-m",
      "tighten this",
    );
    const id = json<{ thread_id: string }>(add.stdout).thread_id;
    expect(id).toMatch(/^thrd_/);

    const listText = await cli(s, "thread", "list");
    expect(listText.code).toBe(0);
    expect(listText.stdout).toContain(id);
    expect(listText.stdout).toContain("open");
    expect(listText.stdout).toContain("tighten this");

    const listJson = await cli(s, "--format", "json", "thread", "list");
    const threads = json<{ threads: { id: string; status: string }[] }>(
      listJson.stdout,
    ).threads;
    expect(threads.map((t) => t.id)).toContain(id);

    const showText = await cli(s, "thread", "show", id);
    expect(showText.stdout).toContain(id);
    expect(showText.stdout).toContain("targets:");
    expect(showText.stdout).toContain("user: tighten this");

    const showJson = await cli(s, "--format", "json", "thread", "show", id);
    const thread = json<{
      id: string;
      status: string;
      messages: { author: string; body: string }[];
    }>(showJson.stdout);
    expect(thread.id).toBe(id);
    expect(thread.messages[0]).toMatchObject({ author: "user", body: "tighten this" });
  });
});

/* ------------------------------------------------------ thread mutations -- */

describe("sheaf thread add", () => {
  it("--range (ui) creates a range thread authored by the user", async () => {
    const s = scratch();
    await serve(s);

    const add = await cli(s, "thread", "add", "--path", "note.md", "--range", "0:5", "-m", "hi");
    expect(add.code).toBe(0);
    expect(add.stdout).toMatch(/created thread thrd_/);

    const list = await cli(s, "--format", "json", "thread", "list");
    const threads = json<{ threads: { id: string; target_paths: string[] }[] }>(
      list.stdout,
    ).threads;
    expect(threads).toHaveLength(1);
    const id = threads[0].id;
    expect(threads[0].target_paths).toEqual(["note.md"]);

    const show = await cli(s, "--format", "json", "thread", "show", id);
    const thread = json<{
      targets: { scope: string }[];
      messages: { author: string }[];
    }>(show.stdout);
    expect(thread.targets[0].scope).toBe("range");
    expect(thread.messages[0].author).toBe("user"); // ui origin
  });

  it("--doc (ui) creates a doc-level thread", async () => {
    const s = scratch();
    await serve(s);

    const add = await cli(s, "--format", "json", "thread", "add", "--path", "other.md", "--doc", "-m", "whole doc");
    const id = json<{ thread_id: string }>(add.stdout).thread_id;

    const show = await cli(s, "--format", "json", "thread", "show", id);
    const thread = json<{ targets: { scope: string; path: string }[] }>(show.stdout);
    expect(thread.targets[0]).toMatchObject({ scope: "doc", path: "other.md" });
  });

  it("--as agent (MCP) creates a thread authored by the agent", async () => {
    const s = scratch();
    await serve(s);

    const add = await cli(
      s,
      "--format",
      "json",
      "thread",
      "add",
      "--path",
      "note.md",
      "--range",
      "0:5",
      "-m",
      "agent note",
      "--as",
      "agent",
    );
    const id = json<{ thread_id: string }>(add.stdout).thread_id;

    const show = await cli(s, "--format", "json", "thread", "show", id);
    const thread = json<{ messages: { author: string }[] }>(show.stdout);
    expect(thread.messages[0].author).toBe("agent"); // agent origin
  });

  it("requires exactly one of --range / --doc (usage error, exit 2)", async () => {
    const s = scratch();
    await serve(s);

    const neither = await cli(s, "thread", "add", "--path", "note.md", "-m", "hi");
    expect(neither.code).toBe(2);
    expect(neither.stderr).toContain("exactly one of --range");

    const both = await cli(s, "thread", "add", "--path", "note.md", "--range", "0:5", "--doc", "-m", "hi");
    expect(both.code).toBe(2);
    expect(both.stderr).toContain("exactly one of --range");
  });
});

describe("sheaf thread reply / resolve / reopen", () => {
  it("reply (ui) appends a message; --as agent replies over MCP", async () => {
    const s = scratch();
    await serve(s);

    const add = await cli(s, "--format", "json", "thread", "add", "--path", "note.md", "--range", "0:5", "-m", "first");
    const id = json<{ thread_id: string }>(add.stdout).thread_id;

    const replyUi = await cli(s, "thread", "reply", id, "-m", "a ui reply");
    expect(replyUi.code).toBe(0);
    expect(replyUi.stdout).toContain(`replied to ${id}`);

    const replyAgent = await cli(s, "thread", "reply", id, "-m", "an agent reply", "--as", "agent");
    expect(replyAgent.code).toBe(0);

    const show = await cli(s, "--format", "json", "thread", "show", id);
    const thread = json<{ messages: { author: string; body: string }[] }>(show.stdout);
    expect(thread.messages.map((m) => m.body)).toEqual([
      "first",
      "a ui reply",
      "an agent reply",
    ]);
    expect(thread.messages[1].author).toBe("user"); // ui reply
    expect(thread.messages[2].author).toBe("agent"); // agent reply
  });

  it("resolve flips status to accepted; reopen flips it back to open", async () => {
    const s = scratch();
    await serve(s);

    const add = await cli(s, "--format", "json", "thread", "add", "--path", "note.md", "--range", "0:5", "-m", "hi");
    const id = json<{ thread_id: string }>(add.stdout).thread_id;

    const resolve = await cli(s, "--format", "json", "thread", "resolve", id);
    expect(resolve.code).toBe(0);
    expect(json<{ thread_id: string; ok: boolean }>(resolve.stdout)).toEqual({
      thread_id: id,
      ok: true,
    });
    expect(await statusOf(s, id)).toBe("accepted");

    const reopen = await cli(s, "thread", "reopen", id);
    expect(reopen.code).toBe(0);
    expect(reopen.stdout).toContain(`reopened ${id}`);
    expect(await statusOf(s, id)).toBe("open");
  });

  it("reopen --as agent is a usage error (no agent-facing tool)", async () => {
    const s = scratch();
    await serve(s);
    const r = await cli(s, "thread", "reopen", "thrd_abcdef", "--as", "agent");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("only supported with --as ui");
  });

  /** Read a thread's current status via `thread show --format json`. */
  async function statusOf(s: Scratch, id: string): Promise<string> {
    const show = await cli(s, "--format", "json", "thread", "show", id);
    return json<{ status: string }>(show.stdout).status;
  }
});

/* --------------------------------------------------- needsDaemon guard -- */

describe("--no-daemon enforcement", () => {
  it("a read verb with --no-daemon exits 3 (needsDaemon)", async () => {
    const s = scratch();
    // No daemon started: the dispatcher's needsDaemon guard rejects --no-daemon
    // before any connection attempt.
    const r = await cli(s, "read", "note.md", "--no-daemon");
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("only valid for `sheaf mcp`");
  });
});

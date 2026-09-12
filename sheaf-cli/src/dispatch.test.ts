import { describe, expect, it } from "vitest";

import { run } from "./run";
import { VERSION } from "./version";
import type { Io } from "./io";

/**
 * Build a capturing {@link Io} plus accessors for what was written. `env`
 * carries a bogus `SHEAF_HOME` so that, even though step-1 stubs never touch it,
 * an accidental write would land in a nonexistent temp path, never the real
 * home. Extra env (e.g. `SHEAF_DEBUG`) can be merged in.
 */
function makeIo(env: NodeJS.ProcessEnv = {}): {
  io: Io;
  stdout: () => string;
  stderr: () => string;
} {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (c) => out.push(c),
    err: (c) => err.push(c),
    env: { SHEAF_HOME: "/nonexistent/sheaf-home", ...env },
    cwd: "/tmp",
  };
  return { io, stdout: () => out.join(""), stderr: () => err.join("") };
}

describe("global flags", () => {
  it("--version prints the injected version to stdout, exit 0", async () => {
    const { io, stdout, stderr } = makeIo();
    expect(await run(["--version"], io)).toBe(0);
    expect(stdout().trim()).toBe(VERSION);
    expect(stderr()).toBe("");
  });

  it("-V is an alias for --version", async () => {
    const { io, stdout } = makeIo();
    expect(await run(["-V"], io)).toBe(0);
    expect(stdout().trim()).toBe(VERSION);
  });

  it("--version --format json emits one JSON object", async () => {
    const { io, stdout } = makeIo();
    expect(await run(["--version", "--format", "json"], io)).toBe(0);
    expect(JSON.parse(stdout())).toEqual({ version: VERSION });
  });

  it("--help prints the root usage table to stdout, exit 0", async () => {
    const { io, stdout } = makeIo();
    expect(await run(["--help"], io)).toBe(0);
    expect(stdout()).toContain("Usage: sheaf");
    expect(stdout()).toContain("Commands:");
    expect(stdout()).toContain("Global flags:");
  });

  it("bare invocation prints root help, exit 0", async () => {
    const { io, stdout } = makeIo();
    expect(await run([], io)).toBe(0);
    expect(stdout()).toContain("Usage: sheaf");
  });

  it("rejects an invalid --format with a usage error (exit 2)", async () => {
    const { io, stderr } = makeIo();
    expect(await run(["--format", "yaml", "docs"], io)).toBe(2);
    expect(stderr()).toContain("--format must be");
  });

  it("a dangling --vault is a usage error (exit 2)", async () => {
    const { io } = makeIo();
    expect(await run(["read", "--vault"], io)).toBe(2);
  });

  it("an unknown flag on a command is a usage error (exit 2)", async () => {
    const { io } = makeIo();
    expect(await run(["read", "notes.md", "--bogus"], io)).toBe(2);
  });
});

describe("per-command help", () => {
  it("`thread --help` lists the thread subcommands", async () => {
    const { io, stdout } = makeIo();
    expect(await run(["thread", "--help"], io)).toBe(0);
    const text = stdout();
    expect(text).toContain("sheaf thread");
    expect(text).toContain("Subcommands:");
    expect(text).toContain("show");
    expect(text).toContain("reply");
  });

  it("`thread show --help` prints the leaf usage", async () => {
    const { io, stdout } = makeIo();
    expect(await run(["thread", "show", "--help"], io)).toBe(0);
    expect(stdout()).toContain("sheaf thread show <id>");
  });
});

describe("dispatch to stubs", () => {
  // `docs` (step 6) and `events follow` (step 3) are wired now, so they're
  // deliberately absent here — they're covered by their own live-daemon tests.
  it.each([
    [["mcp"], 4],
    [["mcp", "install"], 5],
    [["read", "notes.md"], 6],
    [["grep", "foo"], 6],
    [["glob", "**/*.md"], 6],
    [["thread", "list"], 6],
    [["thread", "show", "thrd_x"], 6],
  ])("`%s` stubs with its step number, exit 1", async (argv, step) => {
    const { io, stdout, stderr } = makeIo();
    expect(await run(argv as string[], io)).toBe(1);
    expect(stderr().trim()).toBe(`not implemented (step ${step})`);
    expect(stdout()).toBe("");
  });

  it("emits stub errors as JSON under --format json", async () => {
    const { io, stdout, stderr } = makeIo();
    expect(await run(["read", "notes.md", "--format", "json"], io)).toBe(1);
    expect(JSON.parse(stdout())).toEqual({
      error: "not implemented (step 6)",
      code: "not_implemented",
    });
    expect(stderr()).toBe("");
  });
});

describe("--no-daemon enforcement (dispatcher, not per-handler)", () => {
  it("rejects --no-daemon on a daemon-client command with exit 3", async () => {
    const { io, stderr } = makeIo();
    expect(await run(["docs", "--no-daemon"], io)).toBe(3);
    expect(stderr()).toContain("only valid for `sheaf mcp`");
  });

  it("rejects --no-daemon on `events follow` with exit 3", async () => {
    const { io, stderr } = makeIo();
    expect(await run(["events", "follow", "--no-daemon"], io)).toBe(3);
    expect(stderr()).toContain("requires a running daemon");
  });
});

describe("per-command flags parse (proven via SHEAF_DEBUG)", () => {
  it("read <path> --ref REF", async () => {
    const { io, stderr } = makeIo({ SHEAF_DEBUG: "1" });
    expect(await run(["read", "notes.md", "--ref", "v3"], io)).toBe(1);
    const debug = stderr();
    expect(debug).toContain("command=read");
    expect(debug).toContain('"ref":"v3"');
    expect(debug).toContain('["notes.md"]');
  });

  it("thread add --path P -m MSG --as agent", async () => {
    const { io, stderr } = makeIo({ SHEAF_DEBUG: "1" });
    expect(
      await run(
        ["thread", "add", "--path", "a.md", "-m", "hi", "--as", "agent"],
        io,
      ),
    ).toBe(1);
    const debug = stderr();
    expect(debug).toContain("command=thread add");
    expect(debug).toContain('"path":"a.md"');
    expect(debug).toContain('"message":"hi"');
    expect(debug).toContain('"as":"agent"');
  });

  it("mcp --doc PATH is the bridge (not a stray subcommand)", async () => {
    const { io, stderr } = makeIo({ SHEAF_DEBUG: "1" });
    expect(await run(["mcp", "--doc", "notes.md"], io)).toBe(1);
    const debug = stderr();
    expect(debug).toContain("command=mcp");
    expect(debug).toContain('"doc":"notes.md"');
    // No leftover positional was mistaken for a subcommand.
    expect(debug).toContain("positionals=[]");
  });
});

describe("usage errors (exit 2)", () => {
  it("unknown top-level command", async () => {
    const { io, stderr } = makeIo();
    expect(await run(["frobnicate"], io)).toBe(2);
    expect(stderr()).toContain("unknown command: frobnicate");
  });

  it("unknown nested subcommand", async () => {
    const { io, stderr } = makeIo();
    expect(await run(["thread", "bogus"], io)).toBe(2);
    expect(stderr()).toContain("unknown subcommand: thread bogus");
  });

  it("group invoked with no subcommand", async () => {
    const { io, stderr } = makeIo();
    expect(await run(["thread"], io)).toBe(2);
    expect(stderr()).toContain("`thread` requires a subcommand");
  });

  it("`daemon` with no subcommand is a usage error", async () => {
    const { io, stderr } = makeIo();
    expect(await run(["daemon"], io)).toBe(2);
    expect(stderr()).toContain("`daemon` requires a subcommand");
  });

  it("`daemon` with a bad subcommand is a usage error", async () => {
    const { io, stderr } = makeIo();
    expect(await run(["daemon", "bogus"], io)).toBe(2);
    expect(stderr()).toContain("unknown subcommand: daemon bogus");
  });

  it("runnable group with a stray positional is a bad subcommand, not the bridge", async () => {
    const { io, stderr } = makeIo();
    expect(await run(["mcp", "bogus"], io)).toBe(2);
    expect(stderr()).toContain("unknown subcommand: mcp bogus");
  });

  it("renders usage errors as JSON under --format json", async () => {
    const { io, stdout } = makeIo();
    expect(await run(["frobnicate", "--format", "json"], io)).toBe(2);
    expect(JSON.parse(stdout())).toEqual({
      error: "unknown command: frobnicate",
      code: "usage",
    });
  });
});

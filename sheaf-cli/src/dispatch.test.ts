import { describe, expect, it } from "vitest";

import { run } from "./run";
import { VERSION } from "./version";
import type { Io } from "./io";

/**
 * Build a capturing {@link Io} plus accessors for what was written. `env`
 * carries a bogus `SHEAF_HOME` so that, even though step-1 stubs never touch
 * it, an accidental write would land in a nonexistent temp path, never the real
 * home.
 */
function makeIo(): {
  io: Io;
  stdout: () => string;
  stderr: () => string;
} {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (c) => out.push(c),
    err: (c) => err.push(c),
    env: { SHEAF_HOME: "/nonexistent/sheaf-home" },
    cwd: "/tmp",
  };
  return { io, stdout: () => out.join(""), stderr: () => err.join("") };
}

describe("global flags", () => {
  it("--version prints the injected version to stdout, exit 0", async () => {
    const { io, stdout, stderr } = makeIo();
    const code = await run(["--version"], io);
    expect(code).toBe(0);
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
    const code = await run(["--help"], io);
    expect(code).toBe(0);
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
    const code = await run(["--format", "yaml", "docs"], io);
    expect(code).toBe(2);
    expect(stderr()).toContain("--format must be");
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
  it.each([
    [["serve"], 2],
    [["daemon", "status"], 2],
    [["daemon", "stop"], 2],
    [["mcp"], 4],
    [["mcp", "install"], 5],
    [["docs"], 6],
    [["read", "notes.md"], 6],
    [["grep", "foo"], 6],
    [["glob", "**/*.md"], 6],
    [["thread", "list"], 6],
    [["thread", "show", "thrd_x"], 6],
    [["events", "follow"], 3],
  ])("`%s` stubs with its step number, exit 1", async (argv, step) => {
    const { io, stdout, stderr } = makeIo();
    const code = await run(argv as string[], io);
    expect(code).toBe(1);
    expect(stderr().trim()).toBe(`not implemented (step ${step})`);
    expect(stdout()).toBe("");
  });

  it("emits stub errors as JSON under --format json", async () => {
    const { io, stdout, stderr } = makeIo();
    const code = await run(["docs", "--format", "json"], io);
    expect(code).toBe(1);
    expect(JSON.parse(stdout())).toEqual({
      error: "not implemented (step 6)",
      code: "not_implemented",
    });
    // Diagnostics channel stays empty; the one JSON object is on stdout.
    expect(stderr()).toBe("");
  });
});

describe("usage errors (exit 2)", () => {
  it("unknown top-level command", async () => {
    const { io, stderr } = makeIo();
    const code = await run(["frobnicate"], io);
    expect(code).toBe(2);
    expect(stderr()).toContain("unknown command: frobnicate");
  });

  it("unknown nested subcommand", async () => {
    const { io, stderr } = makeIo();
    const code = await run(["thread", "bogus"], io);
    expect(code).toBe(2);
    expect(stderr()).toContain("unknown subcommand: thread bogus");
  });

  it("group invoked with no subcommand", async () => {
    const { io, stderr } = makeIo();
    const code = await run(["thread"], io);
    expect(code).toBe(2);
    expect(stderr()).toContain("`thread` requires a subcommand");
  });

  it("renders usage errors as JSON under --format json", async () => {
    const { io, stdout } = makeIo();
    const code = await run(["frobnicate", "--format", "json"], io);
    expect(code).toBe(2);
    expect(JSON.parse(stdout())).toEqual({
      error: "unknown command: frobnicate",
      code: "usage",
    });
  });
});

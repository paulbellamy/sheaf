import { describe, expect, it } from "vitest";

import { parseCommand } from "./args";
import { REGISTRY } from "./commands";
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

describe("dispatch to wired verbs", () => {
  // After step 6 every command has a handler (no stubs remain). The read/thread
  // read verbs are daemon clients, so with no reachable daemon (a nonexistent
  // $SHEAF_HOME + a /tmp cwd vault) they resolve to the no-daemon error (exit 3)
  // rather than a step-1 stub. Their behavior against a live daemon is covered
  // in verbs.test.ts.
  it.each([
    [["read", "notes.md"]],
    [["grep", "foo"]],
    [["glob", "**/*.md"]],
    [["thread", "list"]],
    [["thread", "show", "thrd_abcdef"]],
  ])("`%s` is wired and needs a daemon (exit 3 when none)", async (argv) => {
    const { io, stdout, stderr } = makeIo();
    expect(await run(argv as string[], io)).toBe(3);
    expect(stderr()).toContain("no sheaf daemon");
    expect(stdout()).toBe("");
  });

  it("`mcp install` is wired (an unknown client is a usage error, exit 2)", async () => {
    // Proves the step-5 handler runs — an unknown client name fails in
    // selectClients (exit 2) before any home/fs access, so this stays hermetic.
    const { io, stderr } = makeIo();
    expect(await run(["mcp", "install", "bogus"], io)).toBe(2);
    expect(stderr()).toContain("unknown client");
  });

  it("renders the no-daemon error as JSON under --format json", async () => {
    const { io, stdout, stderr } = makeIo();
    expect(await run(["read", "notes.md", "--format", "json"], io)).toBe(3);
    expect(JSON.parse(stdout())).toMatchObject({ code: "no_daemon" });
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

describe("per-command flags parse", () => {
  // The step-6 verbs now have real handlers, so their flags are asserted at the
  // parse layer (running them would require a live daemon — see verbs.test.ts).
  it("read <path> --ref REF", () => {
    const { values, positionals } = parseCommand(
      ["read", "notes.md", "--ref", "v3"],
      REGISTRY.read.options,
    );
    expect(values.ref).toBe("v3");
    expect(positionals).toEqual(["read", "notes.md"]);
  });

  it("grep <pattern> with the ripgrep-shaped flags", () => {
    const { values } = parseCommand(
      ["grep", "foo", "-i", "-A", "2", "-B", "1", "--output-mode", "content"],
      REGISTRY.grep.options,
    );
    expect(values["ignore-case"]).toBe(true);
    expect(values["after-context"]).toBe("2");
    expect(values["before-context"]).toBe("1");
    expect(values["output-mode"]).toBe("content");
  });

  it("thread add --path P -m MSG --range A:B --as agent", () => {
    const { values } = parseCommand(
      ["thread", "add", "--path", "a.md", "-m", "hi", "--range", "0:5", "--as", "agent"],
      REGISTRY.thread.subcommands!.add.options,
    );
    expect(values.path).toBe("a.md");
    expect(values.message).toBe("hi");
    expect(values.range).toBe("0:5");
    expect(values.as).toBe("agent");
  });

  it("mcp --doc PATH parses as the runnable bridge, not a stray subcommand", () => {
    // `mcp` is a runnable group whose `run` starts the (blocking) stdio bridge,
    // so we assert at the parse layer rather than executing the handler: with
    // `--doc` as a flag on the group, `notes.md` is its value — not a leftover
    // positional that would be mistaken for a `mcp <subcommand>`.
    expect(REGISTRY.mcp.runnable).toBe(true);
    expect(typeof REGISTRY.mcp.run).toBe("function");
    const { values, positionals } = parseCommand(
      ["mcp", "--doc", "notes.md"],
      REGISTRY.mcp.options,
    );
    expect(values.doc).toBe("notes.md");
    // Only the command word itself remains a positional — nothing stray.
    expect(positionals).toEqual(["mcp"]);
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

/**
 * Hermetic tests for `sheaf mcp install`.
 *
 * Every client path resolver reads `HOME` (and `PATH`) from the injected env, so
 * these tests point them at throwaway temp dirs — a run never touches the real
 * `~/.codex`, `~/.claude.json`, or `~/Library/Application Support/Claude`. We
 * drive the command through {@link mcpInstallCommand} with a fabricated
 * {@link RunContext} (capturing Io), then read the written files back off disk
 * and parse them — asserting on *data*, not incidental formatting.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parse as parseToml } from "smol-toml";

import type { RunContext } from "./commands";
import { CliError, EXIT, Output, type ExitCode, type Io } from "./io";
import { sheafBinPath } from "./mcp";
import {
  CLIENTS,
  applyPlan,
  buildSheafEntry,
  mcpInstallCommand,
  type McpEntry,
  type Plan,
} from "./mcp-install";

const trash: string[] = [];

afterEach(() => {
  for (const d of trash) rmSync(d, { recursive: true, force: true });
  trash.length = 0;
});

/** A throwaway temp dir, torn down after each test. */
function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  trash.push(d);
  return d;
}

interface Captured {
  stdout: string;
  stderr: string;
}

interface CtxOpts {
  vault: string;
  home: string;
  clients?: string[];
  name?: string;
  tools?: string;
  dryRun?: boolean;
  format?: "text" | "json";
  /** PATH the resolvers see; default "" (⇒ no `claude` on PATH). */
  path?: string;
}

/** Build a RunContext + an output-capture buffer for the installer. */
function makeCtx(opts: CtxOpts): { ctx: RunContext; cap: Captured } {
  const cap: Captured = { stdout: "", stderr: "" };
  const env: NodeJS.ProcessEnv = { HOME: opts.home, PATH: opts.path ?? "" };
  const io: Io = {
    out: (c) => (cap.stdout += c),
    err: (c) => (cap.stderr += c),
    env,
    cwd: opts.vault,
  };
  const format = opts.format ?? "text";
  const values: Record<string, unknown> = { format };
  if (opts.name !== undefined) values.name = opts.name;
  if (opts.tools !== undefined) values.tools = opts.tools;
  if (opts.dryRun) values["dry-run"] = true;
  const ctx: RunContext = {
    globals: { format, noDaemon: false, help: false, version: false },
    out: new Output(io, format),
    io,
    vault: opts.vault,
    values,
    positionals: opts.clients ?? [],
    argv: [],
  };
  return { ctx, cap };
}

/** Run the installer and return the exit code (throws propagate). */
function install(opts: CtxOpts): { code: ExitCode; cap: Captured } {
  const { ctx, cap } = makeCtx(opts);
  const code = mcpInstallCommand(ctx);
  return { code, cap };
}

/** Capture the CliError a thrown call produces (fails the test if none is thrown). */
function caught(fn: () => unknown): CliError {
  try {
    fn();
  } catch (e) {
    if (e instanceof CliError) return e;
    throw e;
  }
  throw new Error("expected a CliError to be thrown");
}

/** The macOS Claude Desktop config dir under a fake home. */
function desktopDir(home: string): string {
  return join(home, "Library", "Application Support", "Claude");
}

/** Read + parse a JSON config file. */
function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Read + parse a TOML config file. */
function readToml(path: string): Record<string, unknown> {
  return parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Fresh install — each client, correct shape
// ---------------------------------------------------------------------------

describe("fresh install creates exactly our entry", () => {
  it("claude → <vault>/.mcp.json with mcpServers.sheaf", () => {
    const vault = tmp("sheaf-vault-");
    const home = tmp("sheaf-home-");
    const { code } = install({ vault, home, clients: ["claude"] });
    expect(code).toBe(EXIT.OK);

    const cfg = readJson(join(vault, ".mcp.json"));
    expect(Object.keys(cfg)).toEqual(["mcpServers"]);
    const servers = cfg.mcpServers as Record<string, McpEntry>;
    expect(Object.keys(servers)).toEqual(["sheaf"]);
    expect(servers.sheaf).toEqual(buildSheafEntry(vault));
  });

  it("claude-desktop → JSON under ~/Library/Application Support/Claude", () => {
    const vault = tmp("sheaf-vault-");
    const home = tmp("sheaf-home-");
    mkdirSync(desktopDir(home), { recursive: true }); // simulate macOS presence
    const { code } = install({ vault, home, clients: ["claude-desktop"] });
    expect(code).toBe(EXIT.OK);

    const cfg = readJson(join(desktopDir(home), "claude_desktop_config.json"));
    const servers = cfg.mcpServers as Record<string, McpEntry>;
    expect(Object.keys(servers)).toEqual(["sheaf"]);
    expect(servers.sheaf).toEqual(buildSheafEntry(vault));
  });

  it("codex → ~/.codex/config.toml with [mcp_servers.sheaf]", () => {
    const vault = tmp("sheaf-vault-");
    const home = tmp("sheaf-home-");
    const { code } = install({ vault, home, clients: ["codex"] });
    expect(code).toBe(EXIT.OK);

    const cfg = readToml(join(home, ".codex", "config.toml"));
    const servers = cfg.mcp_servers as Record<string, McpEntry>;
    expect(Object.keys(servers)).toEqual(["sheaf"]);
    expect(servers.sheaf).toEqual(buildSheafEntry(vault));
  });
});

// ---------------------------------------------------------------------------
// Preserve foreign servers / keys
// ---------------------------------------------------------------------------

describe("upsert preserves unrelated keys", () => {
  it("claude JSON: other servers + top-level keys survive", () => {
    const vault = tmp("sheaf-vault-");
    const home = tmp("sheaf-home-");
    const path = join(vault, ".mcp.json");
    writeFileSync(
      path,
      JSON.stringify({
        someTopKey: { nested: [1, 2, 3] },
        mcpServers: {
          other: { command: "otherbin", args: ["--x"], env: { A: "1" } },
        },
      }),
    );

    install({ vault, home, clients: ["claude"] });

    const cfg = readJson(path);
    expect(cfg.someTopKey).toEqual({ nested: [1, 2, 3] });
    const servers = cfg.mcpServers as Record<string, unknown>;
    // Foreign server preserved byte-for-key.
    expect(servers.other).toEqual({
      command: "otherbin",
      args: ["--x"],
      env: { A: "1" },
    });
    expect(servers.sheaf).toEqual(buildSheafEntry(vault));
  });

  it("codex TOML round-trip: existing [mcp_servers.other] + top-level key survive", () => {
    const vault = tmp("sheaf-vault-");
    const home = tmp("sheaf-home-");
    mkdirSync(join(home, ".codex"), { recursive: true });
    const path = join(home, ".codex", "config.toml");
    writeFileSync(
      path,
      [
        'model = "gpt-5"',
        'approval_policy = "on-request"',
        "",
        "[mcp_servers.other]",
        'command = "otherbin"',
        'args = ["--flag"]',
        "",
      ].join("\n"),
    );

    install({ vault, home, clients: ["codex"] });

    const cfg = readToml(path);
    expect(cfg.model).toBe("gpt-5");
    expect(cfg.approval_policy).toBe("on-request");
    const servers = cfg.mcp_servers as Record<string, unknown>;
    expect(servers.other).toEqual({ command: "otherbin", args: ["--flag"] });
    expect(servers.sheaf).toEqual(buildSheafEntry(vault));
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("idempotent re-run", () => {
  it("codex: second install updates in place, byte-identical, action=update", () => {
    const vault = tmp("sheaf-vault-");
    const home = tmp("sheaf-home-");
    const path = join(home, ".codex", "config.toml");

    const first = install({ vault, home, clients: ["codex"], format: "json" });
    expect(JSON.parse(first.cap.stdout).changes[0].action).toBe("install");
    const afterFirst = readFileSync(path, "utf8");

    const second = install({ vault, home, clients: ["codex"], format: "json" });
    expect(JSON.parse(second.cap.stdout).changes[0].action).toBe("update");
    const afterSecond = readFileSync(path, "utf8");

    expect(afterSecond).toBe(afterFirst); // no duplicate, no drift
    const servers = readToml(path).mcp_servers as Record<string, unknown>;
    expect(Object.keys(servers)).toEqual(["sheaf"]);
  });

  it("claude: second install does not duplicate the entry", () => {
    const vault = tmp("sheaf-vault-");
    const home = tmp("sheaf-home-");
    install({ vault, home, clients: ["claude"] });
    install({ vault, home, clients: ["claude"] });
    const servers = readJson(join(vault, ".mcp.json")).mcpServers as Record<
      string,
      unknown
    >;
    expect(Object.keys(servers)).toEqual(["sheaf"]);
  });
});

// ---------------------------------------------------------------------------
// --name
// ---------------------------------------------------------------------------

describe("--name overrides the server key", () => {
  it("codex: keyed under `custom`, not `sheaf`", () => {
    const vault = tmp("sheaf-vault-");
    const home = tmp("sheaf-home-");
    install({ vault, home, clients: ["codex"], name: "custom" });
    const servers = readToml(join(home, ".codex", "config.toml"))
      .mcp_servers as Record<string, unknown>;
    expect(Object.keys(servers)).toEqual(["custom"]);
    expect(servers.custom).toEqual(buildSheafEntry(vault));
  });

  it("claude: a blank --name is a usage error (exit 2)", () => {
    const vault = tmp("sheaf-vault-");
    const home = tmp("sheaf-home-");
    const { ctx } = makeCtx({ vault, home, clients: ["claude"], name: "  " });
    const e = caught(() => mcpInstallCommand(ctx));
    expect(e.exitCode).toBe(EXIT.USAGE);
  });
});

// ---------------------------------------------------------------------------
// --dry-run
// ---------------------------------------------------------------------------

describe("--dry-run writes nothing", () => {
  it("existing file is left byte-identical and a diff is printed", () => {
    const vault = tmp("sheaf-vault-");
    const home = tmp("sheaf-home-");
    mkdirSync(join(home, ".codex"), { recursive: true });
    const path = join(home, ".codex", "config.toml");
    const original = 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n';
    writeFileSync(path, original);

    const { code, cap } = install({
      vault,
      home,
      clients: ["codex"],
      dryRun: true,
    });
    expect(code).toBe(EXIT.OK);
    expect(readFileSync(path, "utf8")).toBe(original); // untouched on disk
    // A readable diff naming the entry and the abs bin invocation.
    expect(cap.stdout).toContain("codex");
    expect(cap.stdout).toContain("sheaf");
    expect(cap.stdout).toContain(sheafBinPath());
  });

  it("fresh target: prints `would create` and does not create the file", () => {
    const vault = tmp("sheaf-vault-");
    const home = tmp("sheaf-home-");
    const { cap } = install({ vault, home, clients: ["codex"], dryRun: true });
    expect(cap.stdout).toContain("would create");
    expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false);
  });

  it("--format json emits one planned-changes object, writes nothing", () => {
    const vault = tmp("sheaf-vault-");
    const home = tmp("sheaf-home-");
    const { cap } = install({
      vault,
      home,
      clients: ["codex"],
      dryRun: true,
      format: "json",
    });
    const obj = JSON.parse(cap.stdout);
    expect(obj.dryRun).toBe(true);
    expect(obj.changes).toHaveLength(1);
    expect(obj.changes[0]).toMatchObject({
      client: "codex",
      action: "install",
      fileExists: false,
      name: "sheaf",
    });
    expect(obj.changes[0].new).toEqual(buildSheafEntry(vault));
    expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Invocation shape
// ---------------------------------------------------------------------------

describe("written invocation is absolute", () => {
  it("command === process.execPath; args start with abs bin, then mcp --vault <vault>", () => {
    const vault = tmp("sheaf-vault-");
    const home = tmp("sheaf-home-");
    install({ vault, home, clients: ["codex"] });
    const entry = (readToml(join(home, ".codex", "config.toml"))
      .mcp_servers as Record<string, McpEntry>).sheaf;

    expect(entry.command).toBe(process.execPath);
    expect(entry.args[0]).toBe(sheafBinPath());
    expect(entry.args.slice(1, 4)).toEqual(["mcp", "--vault", vault]);
  });

  it("--tools is appended to args", () => {
    const vault = tmp("sheaf-vault-");
    const home = tmp("sheaf-home-");
    install({ vault, home, clients: ["codex"], tools: "thread-only" });
    const entry = (readToml(join(home, ".codex", "config.toml"))
      .mcp_servers as Record<string, McpEntry>).sheaf;
    expect(entry.args.slice(-2)).toEqual(["--tools", "thread-only"]);
  });

  it("an invalid --tools value is a usage error (exit 2)", () => {
    const vault = tmp("sheaf-vault-");
    const home = tmp("sheaf-home-");
    const { ctx } = makeCtx({ vault, home, clients: ["codex"], tools: "bogus" });
    expect(caught(() => mcpInstallCommand(ctx)).exitCode).toBe(EXIT.USAGE);
  });
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

describe("client selection", () => {
  it("explicit unknown client → usage error (exit 2)", () => {
    const vault = tmp("sheaf-vault-");
    const home = tmp("sheaf-home-");
    const { ctx } = makeCtx({ vault, home, clients: ["bogus"] });
    const e = caught(() => mcpInstallCommand(ctx));
    expect(e.exitCode).toBe(EXIT.USAGE);
    expect(e.message).toContain("unknown client");
  });

  it("explicit claude-desktop with no config dir → CliError exit 1, writes nothing", () => {
    const vault = tmp("sheaf-vault-");
    const home = tmp("sheaf-home-"); // no Library/Application Support/Claude
    const { ctx } = makeCtx({ vault, home, clients: ["claude-desktop"] });
    const e = caught(() => mcpInstallCommand(ctx));
    expect(e.exitCode).toBe(EXIT.GENERIC);
    expect(e.code).toBe("client_unavailable");
    expect(existsSync(join(desktopDir(home), "claude_desktop_config.json"))).toBe(
      false,
    );
  });

  it("bare install with only ~/.codex present installs codex only", () => {
    const vault = tmp("sheaf-vault-");
    const home = tmp("sheaf-home-");
    mkdirSync(join(home, ".codex"), { recursive: true });
    // PATH is "" and there is no ~/.claude.json / ~/.claude, so claude is not
    // detected; no macOS dir, so claude-desktop is not detected.
    const { code, cap } = install({ vault, home });
    expect(code).toBe(EXIT.OK);
    expect(cap.stdout).toContain("codex:");
    expect(existsSync(join(home, ".codex", "config.toml"))).toBe(true);
    expect(existsSync(join(vault, ".mcp.json"))).toBe(false); // claude untouched
  });

  it("bare install detects claude via ~/.claude.json", () => {
    const vault = tmp("sheaf-vault-");
    const home = tmp("sheaf-home-");
    writeFileSync(join(home, ".claude.json"), "{}");
    const { code } = install({ vault, home });
    expect(code).toBe(EXIT.OK);
    expect(existsSync(join(vault, ".mcp.json"))).toBe(true);
    // codex not present → not installed.
    expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false);
  });

  it("bare install with nothing detected → exit 0, nothing written", () => {
    const vault = tmp("sheaf-vault-");
    const home = tmp("sheaf-home-");
    const { code, cap } = install({ vault, home });
    expect(code).toBe(EXIT.OK);
    expect(cap.stderr).toContain("no MCP clients detected");
    expect(existsSync(join(vault, ".mcp.json"))).toBe(false);
  });

  it("nothing detected under --format json → empty changes, exit 0", () => {
    const vault = tmp("sheaf-vault-");
    const home = tmp("sheaf-home-");
    const { code, cap } = install({ vault, home, format: "json" });
    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(cap.stdout).changes).toEqual([]);
  });

  it("multiple explicit clients are all applied", () => {
    const vault = tmp("sheaf-vault-");
    const home = tmp("sheaf-home-");
    install({ vault, home, clients: ["claude", "codex"] });
    expect(existsSync(join(vault, ".mcp.json"))).toBe(true);
    expect(existsSync(join(home, ".codex", "config.toml"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Non-destructive: file mode preserved on update
// ---------------------------------------------------------------------------

describe("non-destructive write", () => {
  it("preserves an existing file's mode across an update", () => {
    const vault = tmp("sheaf-vault-");
    const home = tmp("sheaf-home-");
    const path = join(vault, ".mcp.json");
    // Seed 0o600 (NOT the umask default 0o644, so the assertion is meaningful:
    // it would fail if preservation were broken and we fell back to the default).
    writeFileSync(path, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
    chmodSync(path, 0o600); // writeFileSync's mode is umask-masked; force it
    install({ vault, home, clients: ["claude"] });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("creates ~/.codex with mode 0700 (it also holds auth.json)", () => {
    const vault = tmp("sheaf-vault-");
    const home = tmp("sheaf-home-"); // no ~/.codex yet
    install({ vault, home, clients: ["codex"] });
    expect(statSync(join(home, ".codex")).mode & 0o777).toBe(0o700);
  });
});

// ---------------------------------------------------------------------------
// Symlinked config (P1) — follow the link, keep the real file, stay a symlink
// ---------------------------------------------------------------------------

describe("symlinked config", () => {
  it("updates the real target and leaves the symlink a symlink", () => {
    const vault = tmp("sheaf-vault-");
    const home = tmp("sheaf-home-");
    const dotfiles = tmp("sheaf-dotfiles-");
    const realFile = join(dotfiles, "codex.toml");
    writeFileSync(realFile, 'model = "gpt-5"\n');

    mkdirSync(join(home, ".codex"), { recursive: true });
    const link = join(home, ".codex", "config.toml");
    symlinkSync(realFile, link);

    install({ vault, home, clients: ["codex"] });

    // The link is still a symlink (not clobbered into a plain file)...
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(realFile);
    // ...and the REAL file got our entry while keeping its own content.
    const cfg = readToml(realFile);
    expect(cfg.model).toBe("gpt-5");
    expect((cfg.mcp_servers as Record<string, McpEntry>).sheaf).toEqual(
      buildSheafEntry(vault),
    );
  });

  it("a dangling symlink is a clear error, not an overwrite", () => {
    const vault = tmp("sheaf-vault-");
    const home = tmp("sheaf-home-");
    mkdirSync(join(home, ".codex"), { recursive: true });
    const link = join(home, ".codex", "config.toml");
    symlinkSync(join(home, "does-not-exist.toml"), link);

    const { ctx } = makeCtx({ vault, home, clients: ["codex"] });
    const e = caught(() => mcpInstallCommand(ctx));
    expect(e.code).toBe("config_dangling_symlink");
    expect(lstatSync(link).isSymbolicLink()).toBe(true); // still a (dangling) link
  });
});

// ---------------------------------------------------------------------------
// Merge: user-added keys on OUR entry survive an update (P2.4)
// ---------------------------------------------------------------------------

describe("update merges over user-added keys on our entry", () => {
  it("codex: startup_timeout_sec + nested env survive; command/args are ours", () => {
    const vault = tmp("sheaf-vault-");
    const home = tmp("sheaf-home-");
    mkdirSync(join(home, ".codex"), { recursive: true });
    const path = join(home, ".codex", "config.toml");
    writeFileSync(
      path,
      [
        "[mcp_servers.sheaf]",
        'command = "oldnode"',
        'args = ["old"]',
        "startup_timeout_sec = 30",
        "",
        "[mcp_servers.sheaf.env]",
        'FOO = "bar"',
        "",
      ].join("\n"),
    );

    install({ vault, home, clients: ["codex"] });

    const sheaf = (readToml(path).mcp_servers as Record<string, Record<string, unknown>>)
      .sheaf;
    expect(sheaf.command).toBe(process.execPath); // ours
    expect(sheaf.args).toEqual(buildSheafEntry(vault).args); // ours
    expect(sheaf.startup_timeout_sec).toBe(30); // user key preserved
    expect(sheaf.env).toEqual({ FOO: "bar" }); // user nested table preserved
  });

  it("claude JSON: a user-added env on our entry survives", () => {
    const vault = tmp("sheaf-vault-");
    const home = tmp("sheaf-home-");
    const path = join(vault, ".mcp.json");
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: { sheaf: { command: "old", args: ["old"], env: { A: "1" } } },
      }),
    );

    install({ vault, home, clients: ["claude"] });

    const sheaf = (readJson(path).mcpServers as Record<string, Record<string, unknown>>)
      .sheaf;
    expect(sheaf.command).toBe(process.execPath);
    expect(sheaf.args).toEqual(buildSheafEntry(vault).args);
    expect(sheaf.env).toEqual({ A: "1" });
  });
});

// ---------------------------------------------------------------------------
// TOML comment/formatting preservation (P2.2)
// ---------------------------------------------------------------------------

describe("codex TOML comment handling", () => {
  it("first install APPENDS a table and preserves comments (no reformat warning)", () => {
    const vault = tmp("sheaf-vault-");
    const home = tmp("sheaf-home-");
    mkdirSync(join(home, ".codex"), { recursive: true });
    const path = join(home, ".codex", "config.toml");
    writeFileSync(path, '# my codex config\nmodel = "gpt-5" # inline note\n');

    const { cap } = install({ vault, home, clients: ["codex"] });

    const after = readFileSync(path, "utf8");
    expect(after).toContain("# my codex config");
    expect(after).toContain("# inline note");
    expect((readToml(path).mcp_servers as Record<string, McpEntry>).sheaf).toEqual(
      buildSheafEntry(vault),
    );
    expect(cap.stderr).not.toContain("not preserved");
  });

  it("updating an existing entry reserializes (drops comments) and warns", () => {
    const vault = tmp("sheaf-vault-");
    const home = tmp("sheaf-home-");
    mkdirSync(join(home, ".codex"), { recursive: true });
    const path = join(home, ".codex", "config.toml");
    writeFileSync(
      path,
      '# keep me?\n[mcp_servers.sheaf]\ncommand = "old"\nargs = []\n',
    );

    const { cap } = install({ vault, home, clients: ["codex"], format: "json" });

    expect(readFileSync(path, "utf8")).not.toContain("# keep me?");
    expect(cap.stderr).toContain("not preserved"); // warned on stderr
    expect(JSON.parse(cap.stdout).changes[0].reformat).toBe(true);
  });

  it("a reserialize warning appears in dry-run output too, file untouched", () => {
    const vault = tmp("sheaf-vault-");
    const home = tmp("sheaf-home-");
    mkdirSync(join(home, ".codex"), { recursive: true });
    const path = join(home, ".codex", "config.toml");
    const original = '# keep me?\n[mcp_servers.sheaf]\ncommand = "old"\nargs = []\n';
    writeFileSync(path, original);

    const { cap } = install({ vault, home, clients: ["codex"], dryRun: true });
    expect(cap.stdout).toContain("not preserved");
    expect(readFileSync(path, "utf8")).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// Malformed configs → clear error, exit 1, ORIGINAL left byte-intact
// ---------------------------------------------------------------------------

describe("malformed existing config is refused non-destructively", () => {
  it("malformed JSON → config_parse, exit 1, file byte-intact", () => {
    const vault = tmp("sheaf-vault-");
    const home = tmp("sheaf-home-");
    const path = join(vault, ".mcp.json");
    const bad = "{ this is : not json";
    writeFileSync(path, bad);

    const { ctx } = makeCtx({ vault, home, clients: ["claude"] });
    const e = caught(() => mcpInstallCommand(ctx));
    expect(e.exitCode).toBe(EXIT.GENERIC);
    expect(e.code).toBe("config_parse");
    expect(readFileSync(path, "utf8")).toBe(bad);
  });

  it("malformed TOML → config_parse, exit 1, file byte-intact", () => {
    const vault = tmp("sheaf-vault-");
    const home = tmp("sheaf-home-");
    mkdirSync(join(home, ".codex"), { recursive: true });
    const path = join(home, ".codex", "config.toml");
    const bad = "model = = =\n[unclosed\n";
    writeFileSync(path, bad);

    const { ctx } = makeCtx({ vault, home, clients: ["codex"] });
    const e = caught(() => mcpInstallCommand(ctx));
    expect(e.exitCode).toBe(EXIT.GENERIC);
    expect(e.code).toBe("config_parse");
    expect(readFileSync(path, "utf8")).toBe(bad);
  });

  it("mcpServers: null → config_invalid, exit 1", () => {
    const vault = tmp("sheaf-vault-");
    const home = tmp("sheaf-home-");
    const path = join(vault, ".mcp.json");
    writeFileSync(path, JSON.stringify({ mcpServers: null }));
    const { ctx } = makeCtx({ vault, home, clients: ["claude"] });
    const e = caught(() => mcpInstallCommand(ctx));
    expect(e.exitCode).toBe(EXIT.GENERIC);
    expect(e.code).toBe("config_invalid");
  });

  it("mcpServers: [array] → config_invalid, exit 1", () => {
    const vault = tmp("sheaf-vault-");
    const home = tmp("sheaf-home-");
    const path = join(vault, ".mcp.json");
    writeFileSync(path, JSON.stringify({ mcpServers: [1, 2] }));
    const { ctx } = makeCtx({ vault, home, clients: ["claude"] });
    expect(caught(() => mcpInstallCommand(ctx)).code).toBe("config_invalid");
  });

  it("a whitespace-only / empty config is treated as empty, not an error", () => {
    const vault = tmp("sheaf-vault-");
    const home = tmp("sheaf-home-");
    const path = join(vault, ".mcp.json");
    writeFileSync(path, "   \n\t\n");
    const { code } = install({ vault, home, clients: ["claude"] });
    expect(code).toBe(EXIT.OK);
    expect((readJson(path).mcpServers as Record<string, McpEntry>).sheaf).toEqual(
      buildSheafEntry(vault),
    );
  });
});

// ---------------------------------------------------------------------------
// Multi-client: all plans computed before any write (P2.3)
// ---------------------------------------------------------------------------

describe("multi-client run is all-or-nothing", () => {
  it("a malformed target aborts before ANY client is written", () => {
    const vault = tmp("sheaf-vault-");
    const home = tmp("sheaf-home-");
    // codex is listed FIRST and is valid; claude is malformed. Since every plan
    // is computed before any write, codex must NOT be written when claude fails.
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(vault, ".mcp.json"), "{ broken");

    const { ctx } = makeCtx({ vault, home, clients: ["codex", "claude"] });
    const e = caught(() => mcpInstallCommand(ctx));
    expect(e.code).toBe("config_parse");
    expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false); // not written
    expect(readFileSync(join(vault, ".mcp.json"), "utf8")).toBe("{ broken"); // intact
  });
});

// ---------------------------------------------------------------------------
// Atomic write leaves no tmp orphan on failure (P3.7)
// ---------------------------------------------------------------------------

describe("applyPlan cleans up its tmp file on failure", () => {
  it("removes the .tmp sibling when the rename fails", () => {
    const base = tmp("sheaf-apply-");
    // Target is a NON-EMPTY directory, so rename(tmp, target) fails after the
    // tmp has been created+written — exercising the finally cleanup branch.
    const target = join(base, "adir");
    mkdirSync(target);
    writeFileSync(join(target, "keep"), "x");

    const plan: Plan = {
      client: CLIENTS.codex,
      path: target,
      requested: target,
      fileExists: false,
      action: "install",
      oldEntry: null,
      newEntry: { command: "x", args: [] },
      contents: "x = 1\n",
      mode: undefined,
      reformat: false,
    };

    expect(() => applyPlan(plan)).toThrow();
    const orphans = readdirSync(base).filter(
      (f) => f.includes(".sheaf-") || f.endsWith(".tmp"),
    );
    expect(orphans).toEqual([]);
  });
});

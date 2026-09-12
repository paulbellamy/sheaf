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
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parse as parseToml } from "smol-toml";

import type { RunContext } from "./commands";
import { CliError, EXIT, Output, type ExitCode, type Io } from "./io";
import { sheafBinPath } from "./mcp";
import { buildSheafEntry, mcpInstallCommand, type McpEntry } from "./mcp-install";

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
    writeFileSync(path, JSON.stringify({ mcpServers: {} }), { mode: 0o644 });
    install({ vault, home, clients: ["claude"] });
    expect(statSync(path).mode & 0o777).toBe(0o644);
  });
});

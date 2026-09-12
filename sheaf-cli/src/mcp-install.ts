/**
 * `sheaf mcp install [client...] [--name NAME] [--dry-run] [--tools full|thread-only]`
 * — wire sheaf's stdio MCP bridge into an agent host's configuration.
 *
 * The installer writes ONE MCP server entry, with an **absolute** invocation,
 * into each selected client's config file (docs/sheaf-cli-v0.1.md "`sheaf mcp
 * install`"). GUI hosts (Claude Desktop, Codex) launch their MCP servers with
 * no inherited PATH and no useful cwd, so a bare `sheaf` / relative path would
 * not resolve — the entry is therefore:
 *
 *     command: process.execPath              (the node that is running us)
 *     args:    [<abs bin/sheaf.js>, "mcp", "--vault", <abs vault>, ...--tools?]
 *
 * `<abs bin/sheaf.js>` comes from {@link sheafBinPath} (shared with the bridge's
 * auto-spawn), and `<abs vault>` is `ctx.vault` (already realpath'd). We do NOT
 * write `--doc`: that is a per-session scope the agent passes at connect time,
 * not an install-time property.
 *
 * ## Clients (docs table)
 *
 *   | id             | target                                                          | format |
 *   |----------------|-----------------------------------------------------------------|--------|
 *   | claude         | `<vault>/.mcp.json` (project scope)                             | json   |
 *   | claude-desktop | `~/Library/Application Support/Claude/claude_desktop_config.json`| json   |
 *   | codex          | `~/.codex/config.toml`                                           | toml   |
 *
 *   - **claude** uses the *project*-scoped `<vault>/.mcp.json` rather than
 *     `~/.claude.json`, because Claude Code rewrites the latter on exit (it
 *     would clobber a hand-written entry). A vault always has a project dir, so
 *     claude is always installable; for a *bare* `install` (no client arg) it is
 *     auto-selected only when Claude Code looks present (the `claude` CLI is on
 *     PATH, or `~/.claude.json` / `~/.claude/` exists).
 *   - **claude-desktop** is macOS-only. Its parent dir existing is both the
 *     detection signal (bare install) and the installability check: naming it
 *     explicitly on a machine without that dir is a clear error (exit 1), never
 *     a fabricated mac path on Linux.
 *   - **codex** is always installable (we create `~/.codex/` as needed); it is
 *     auto-selected for a bare install only when `~/.codex/` already exists.
 *
 * ## Selection
 *
 *   - **No client arg** → every *detected* client (reported). None detected is
 *     not an error: we say so and exit 0 (mirroring `daemon stop` with no daemon
 *     — "nothing to do" is a valid outcome), pointing the user at an explicit
 *     client name.
 *   - **Explicit client args** → exactly those. An unknown name is a usage error
 *     (exit 2); a named-but-impossible target (claude-desktop off-mac) is a
 *     CliError (exit 1). Availability of every named client is checked *before*
 *     any file is written, so we never leave a half-applied set.
 *
 * ## Idempotent + non-destructive
 *
 * We load the existing config (if any), UPSERT only our `<name>` entry, and
 * preserve every other server, table, and top-level key. The file is never
 * rewritten blind: JSON is `JSON.parse`→`JSON.stringify` (2-space, all data
 * kept, key order preserved) and TOML round-trips through `smol-toml`
 * (`parse`→`stringify`, all tables/keys kept). Writes are atomic (tmp sibling +
 * `rename`), parent dirs are created as needed, and an existing file's mode is
 * preserved. Re-running with the same inputs reproduces byte-identical output.
 *
 * Known limitation: reserialization keeps all *data* but not incidental
 * formatting — JSON whitespace is normalized to 2-space, and TOML comments are
 * dropped (smol-toml does not model them). This matches how the hosts
 * themselves rewrite these files.
 *
 * ## `--dry-run`
 *
 * Computes the change and prints it — a per-client old→new diff, or "would
 * create <path>" — writing NOTHING. Under `--format json` it emits a single
 * object describing the planned changes.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { ToolSurface } from "sheaf-server";

import type { RunContext } from "./commands";
import { CliError, EXIT, usageError, type ExitCode, type Output } from "./io";
import { parseTools, sheafBinPath } from "./mcp";

/** The stdio MCP server entry we write into a client config. */
export interface McpEntry {
  command: string;
  args: string[];
}

/**
 * Build the canonical sheaf invocation for a vault. Exported so tests assert
 * the written entry against the *same* derivation (rather than hard-coding an
 * absolute path that differs between the bundled binary and the vitest source
 * load — see {@link sheafBinPath}).
 */
export function buildSheafEntry(
  vault: string,
  tools?: ToolSurface,
): McpEntry {
  const args = [sheafBinPath(), "mcp", "--vault", vault];
  if (tools) args.push("--tools", tools);
  return { command: process.execPath, args };
}

// ---------------------------------------------------------------------------
// Client definitions
// ---------------------------------------------------------------------------

/** Config file serialization dialect. */
type ConfigFormat = "json" | "toml";

/** The context a client resolver needs, all injectable for hermetic tests. */
interface ResolveCtx {
  /** Environment — source of `HOME` (never the real `~` in tests) and `PATH`. */
  env: NodeJS.ProcessEnv;
  /** The resolved, realpath'd target vault (for claude's project scope). */
  vault: string;
}

interface ClientDef {
  /** CLI id (the arg the user types) and the label shown in output. */
  id: string;
  /** JSON `mcpServers` vs TOML `mcp_servers`. */
  format: ConfigFormat;
  /** Absolute path to this client's config file. */
  targetPath(rc: ResolveCtx): string;
  /**
   * Whether this client is auto-selected for a bare `install` (no client arg).
   * A heuristic "the host looks present here"; naming the client explicitly
   * bypasses it (subject to {@link unavailable}).
   */
  detect(rc: ResolveCtx): boolean;
  /**
   * A human-readable reason if this client's target is *impossible* here, else
   * undefined. Only claude-desktop has one (its mac-only dir); claude and codex
   * are always installable (their parent dirs are created as needed).
   */
  unavailable(rc: ResolveCtx): string | undefined;
}

/** Resolve `~` from the (injectable) env, so tests never touch the real home. */
function userHome(env: NodeJS.ProcessEnv): string {
  const h = env.HOME;
  if (h && h.length > 0) return h;
  return homedir();
}

/** Directory holding `claude_desktop_config.json` on macOS. */
function claudeDesktopDir(env: NodeJS.ProcessEnv): string {
  return join(userHome(env), "Library", "Application Support", "Claude");
}

/** True if an executable named `name` exists on any `PATH` entry. */
function isOnPath(name: string, env: NodeJS.ProcessEnv): boolean {
  const raw = env.PATH;
  if (!raw) return false;
  for (const dir of raw.split(":")) {
    if (dir.length === 0) continue;
    if (existsSync(join(dir, name))) return true;
  }
  return false;
}

/** The three v0.1 clients, keyed by id. Insertion order = bare-install order. */
export const CLIENTS: Record<string, ClientDef> = {
  claude: {
    id: "claude",
    format: "json",
    targetPath: (rc) => join(rc.vault, ".mcp.json"),
    detect: (rc) =>
      isOnPath("claude", rc.env) ||
      existsSync(join(userHome(rc.env), ".claude.json")) ||
      existsSync(join(userHome(rc.env), ".claude")),
    // A vault always has a project dir, so claude's target is always writable.
    unavailable: () => undefined,
  },

  "claude-desktop": {
    id: "claude-desktop",
    format: "json",
    targetPath: (rc) => join(claudeDesktopDir(rc.env), "claude_desktop_config.json"),
    // Detected iff the config dir exists (effectively: macOS + Claude Desktop).
    detect: (rc) => existsSync(claudeDesktopDir(rc.env)),
    unavailable: (rc) =>
      existsSync(claudeDesktopDir(rc.env))
        ? undefined
        : `Claude Desktop config dir not found at ${claudeDesktopDir(rc.env)} ` +
          `(it lives under ~/Library/Application Support/Claude, macOS only)`,
  },

  codex: {
    id: "codex",
    format: "toml",
    targetPath: (rc) => join(userHome(rc.env), ".codex", "config.toml"),
    // Detected iff `~/.codex/` exists; explicit install creates it if absent.
    detect: (rc) => existsSync(join(userHome(rc.env), ".codex")),
    unavailable: () => undefined,
  },
};

/** Sorted list of valid client ids, for error messages. */
const CLIENT_IDS = Object.keys(CLIENTS);

// ---------------------------------------------------------------------------
// Config codecs (per format)
// ---------------------------------------------------------------------------

/** A parsed config as a mutable root object plus the key holding the server map. */
interface Codec {
  /** JSON `"mcpServers"` vs TOML `"mcp_servers"`. */
  serversKey: string;
  /** Parse file text into a root object; throws a CliError if it is not a table. */
  parse(text: string, path: string): Record<string, unknown>;
  /** Serialize a root object back to file text with exactly one trailing newline. */
  serialize(root: Record<string, unknown>): string;
}

const CODECS: Record<ConfigFormat, Codec> = {
  json: {
    serversKey: "mcpServers",
    parse(text, path) {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        throw new CliError(
          `existing config is not valid JSON: ${path}`,
          "config_parse",
          EXIT.GENERIC,
        );
      }
      return asTable(value, path);
    },
    serialize(root) {
      return `${JSON.stringify(root, null, 2)}\n`;
    },
  },

  toml: {
    serversKey: "mcp_servers",
    parse(text, path) {
      let value: unknown;
      try {
        value = parseToml(text);
      } catch (e) {
        throw new CliError(
          `existing config is not valid TOML: ${path} (${
            e instanceof Error ? e.message : String(e)
          })`,
          "config_parse",
          EXIT.GENERIC,
        );
      }
      return asTable(value, path);
    },
    serialize(root) {
      const s = stringifyToml(root);
      return s.endsWith("\n") ? s : `${s}\n`;
    },
  },
};

/** Narrow a parsed value to a plain object (config root / server map), or error. */
function asTable(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError(
      `existing config at ${path} is not a table/object`,
      "config_invalid",
      EXIT.GENERIC,
    );
  }
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Planning + applying
// ---------------------------------------------------------------------------

type Action = "install" | "update";

/** The computed change for one client — everything both dry-run and apply need. */
interface Plan {
  client: ClientDef;
  path: string;
  /** True if the config file already exists on disk. */
  fileExists: boolean;
  /** True if OUR `<name>` entry already existed (⇒ update, else install). */
  action: Action;
  /** The pre-existing value at our key (raw), for the diff; null if none. */
  oldEntry: unknown;
  /** The entry we upsert. */
  newEntry: McpEntry;
  /** The full serialized file contents to write. */
  contents: string;
  /** Mode to reapply after write (existing file's mode), or undefined if new. */
  mode: number | undefined;
}

/**
 * Read the config (if any), upsert our `<name>` entry under the format's server
 * key, and compute the serialized result — WITHOUT touching disk. Preserves
 * every other key/server/table. The caller decides whether to write (apply) or
 * just render (dry-run).
 */
function planInstall(
  client: ClientDef,
  rc: ResolveCtx,
  name: string,
  entry: McpEntry,
): Plan {
  const path = client.targetPath(rc);
  const codec = CODECS[client.format];
  const fileExists = existsSync(path);

  let root: Record<string, unknown> = {};
  let mode: number | undefined;
  if (fileExists) {
    root = codec.parse(readFileSync(path, "utf8"), path);
    try {
      mode = statSync(path).mode & 0o777;
    } catch {
      mode = undefined;
    }
  }

  // The server map may be absent (fresh/other-only config) — create it — or
  // present, in which case it must itself be a table we merge into.
  const existingServers = root[codec.serversKey];
  const servers =
    existingServers === undefined
      ? {}
      : asTable(existingServers, path);

  const oldEntry = servers[name] ?? null;
  const action: Action = servers[name] === undefined ? "install" : "update";

  servers[name] = entry;
  root[codec.serversKey] = servers;

  return {
    client,
    path,
    fileExists,
    action,
    oldEntry,
    newEntry: entry,
    contents: codec.serialize(root),
    mode,
  };
}

/**
 * Write `plan.contents` to `plan.path` atomically: create parent dirs, write a
 * sibling tmp file (reapplying the original mode when updating so we never
 * loosen or tighten the user's permissions), then `rename` over the target. The
 * rename is atomic on POSIX, so a crash mid-write can never truncate the config.
 */
function applyPlan(plan: Plan): void {
  mkdirSync(dirname(plan.path), { recursive: true });
  const tmp = `${plan.path}.sheaf.tmp`;
  writeFileSync(tmp, plan.contents);
  if (plan.mode !== undefined) {
    try {
      chmodSync(tmp, plan.mode);
    } catch {
      /* best effort — a failed chmod must not abandon the write */
    }
  }
  renameSync(tmp, plan.path);
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** Resolve the requested client ids to definitions; validate + fail fast. */
function selectClients(
  requested: string[],
  rc: ResolveCtx,
  out: Output,
): ClientDef[] {
  if (requested.length === 0) {
    // Bare install: every detected client (dedup not needed — CLIENTS is a set).
    const detected = CLIENT_IDS.filter((id) => CLIENTS[id].detect(rc)).map(
      (id) => CLIENTS[id],
    );
    if (detected.length === 0) return [];
    out.diagnostic(
      `detected client(s): ${detected.map((c) => c.id).join(", ")}`,
    );
    return detected;
  }

  // Explicit clients: validate names, dedupe (preserving order), then check that
  // each named target is possible BEFORE anything is written.
  const seen = new Set<string>();
  const chosen: ClientDef[] = [];
  for (const id of requested) {
    const def = CLIENTS[id];
    if (!def) {
      throw usageError(
        `unknown client '${id}'; valid clients: ${CLIENT_IDS.join(", ")}`,
      );
    }
    if (seen.has(id)) continue;
    seen.add(id);
    chosen.push(def);
  }
  for (const def of chosen) {
    const reason = def.unavailable(rc);
    if (reason) {
      throw new CliError(
        `cannot install for '${def.id}': ${reason}`,
        "client_unavailable",
        EXIT.GENERIC,
      );
    }
  }
  return chosen;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Compact one-line JSON for an entry (used in both text and json diffs). */
function entryJson(entry: unknown): string {
  return JSON.stringify(entry);
}

/** Print the per-client dry-run diff to stdout (text mode). */
function renderDryRunText(out: Output, name: string, plans: Plan[]): void {
  for (const plan of plans) {
    if (!plan.fileExists) {
      out.text(`${plan.client.id} — would create ${plan.path}`);
      out.text(`  + ${name}: ${entryJson(plan.newEntry)}`);
    } else {
      out.text(
        `${plan.client.id} — would ${plan.action} \`${name}\` in ${plan.path}`,
      );
      out.text(
        `  - ${name}: ${plan.oldEntry === null ? "(none)" : entryJson(plan.oldEntry)}`,
      );
      out.text(`  + ${name}: ${entryJson(plan.newEntry)}`);
    }
  }
}

/** Print the per-client apply result to stdout (text mode). */
function renderApplyText(out: Output, name: string, plans: Plan[]): void {
  for (const plan of plans) {
    const verb = plan.action === "install" ? "installed" : "updated";
    out.text(`${plan.client.id}: ${verb} \`${name}\` -> ${plan.path}`);
  }
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

/**
 * `run` handler for `sheaf mcp install`. Does NOT talk to a daemon and never
 * spawns or connects — it only reads/writes local config files. Returns the
 * process exit code.
 */
export function mcpInstallCommand(ctx: RunContext): ExitCode {
  const { out, io, vault } = ctx;
  const rc: ResolveCtx = { env: io.env, vault };

  const name = resolveName(ctx.values.name);
  const tools = parseTools(ctx.values.tools);
  const dryRun = ctx.values["dry-run"] === true;
  const entry = buildSheafEntry(vault, tools);

  const clients = selectClients(ctx.positionals, rc, out);
  if (clients.length === 0) {
    // Bare install, nothing detected: not an error (see module doc). Point the
    // user at an explicit client name.
    if (out.format === "json") {
      out.json({ dryRun, changes: [], note: "no MCP clients detected" });
    } else {
      out.diagnostic(
        `no MCP clients detected (looked for ${CLIENT_IDS.join(", ")}); ` +
          `name one explicitly, e.g. \`sheaf mcp install codex\``,
      );
    }
    return EXIT.OK;
  }

  const plans = clients.map((client) => planInstall(client, rc, name, entry));

  if (dryRun) {
    if (out.format === "json") {
      out.json({
        dryRun: true,
        changes: plans.map((p) => ({
          client: p.client.id,
          path: p.path,
          action: p.action,
          fileExists: p.fileExists,
          name,
          old: p.oldEntry,
          new: p.newEntry,
        })),
      });
    } else {
      renderDryRunText(out, name, plans);
    }
    return EXIT.OK;
  }

  for (const plan of plans) {
    applyPlan(plan);
  }

  if (out.format === "json") {
    out.json({
      changes: plans.map((p) => ({
        client: p.client.id,
        path: p.path,
        action: p.action,
        name,
      })),
    });
  } else {
    renderApplyText(out, name, plans);
  }
  return EXIT.OK;
}

/** Validate `--name`; default `sheaf`. A blank name is a usage error (exit 2). */
function resolveName(value: unknown): string {
  if (value === undefined) return "sheaf";
  if (typeof value !== "string" || value.trim().length === 0) {
    throw usageError("--name must be a non-empty server key");
  }
  return value;
}

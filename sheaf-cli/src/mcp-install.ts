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
 * `command: process.execPath` PINS the specific node binary running the install
 * (an absolute path is mandatory for GUI hosts). Under a node version manager
 * (nvm/volta/asdf), switching the default node later moves `execPath`, so the
 * pinned path may become stale — re-run `sheaf mcp install` after such a switch.
 * The `mcp install --help` text says so.
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
 *   - **codex** is always installable (we create `~/.codex/` as needed, mode
 *     0700 — it also holds `auth.json`); it is auto-selected for a bare install
 *     only when `~/.codex/` already exists.
 *
 * ## Selection
 *
 *   - **No client arg** → every *detected* client (reported). None detected is
 *     not an error: we say so and exit 0 (mirroring `daemon stop` with no daemon
 *     — "nothing to do" is a valid outcome), pointing the user at an explicit
 *     client name.
 *   - **Explicit client args** → exactly those. An unknown name is a usage error
 *     (exit 2); a named-but-impossible target (claude-desktop off-mac) is a
 *     CliError (exit 1). Availability of every named client is checked, AND every
 *     plan is computed (each config parsed), BEFORE any file is written — so a
 *     malformed config for one client aborts the whole run with nothing written,
 *     never a half-applied set.
 *
 * ## Idempotent + non-destructive
 *
 * We load the existing config (if any), UPSERT our `<name>` entry — merging over
 * any user-added keys on *our* entry (we own only `command`+`args`; a
 * user-added `env`, `type`, `startup_timeout_sec`, … survives) — and preserve
 * every other server, table, and top-level key. The file is never rewritten
 * blind. Writes are atomic and symlink-preserving (see {@link resolveTarget} /
 * {@link applyPlan}). Re-running with the same inputs reproduces byte-identical
 * output.
 *
 * ### How the new entry is merged in, per format
 *
 *   - **JSON** (`.mcp.json`, `claude_desktop_config.json`): `JSON.parse` →
 *     upsert under `mcpServers` → `JSON.stringify` (2-space). Standard JSON has
 *     no comments, and the hosts themselves rewrite these files, so reformatting
 *     whitespace is expected and loses no data.
 *   - **TOML** (`~/.codex/config.toml`): the Codex CLI edits this file with
 *     `toml_edit`, which PRESERVES comments and formatting; a naive
 *     parse→stringify (smol-toml) would NOT. So on a **first install** (our
 *     `[mcp_servers.<name>]` table is absent — the common case) we do NOT
 *     reserialize: we parse the original text only to VALIDATE it, then
 *     TEXTUALLY APPEND a fresh `[mcp_servers.<name>]` block at EOF. A new table
 *     at end-of-file is well-scoped TOML, so every existing comment, inline
 *     table, and bit of formatting is preserved verbatim. Only on an **update**
 *     (our table already exists) do we fall back to a full smol-toml
 *     reserialization, and we then WARN (stderr + dry-run output) that comments
 *     and formatting in the rewritten file were not preserved.
 *
 * ## `--dry-run`
 *
 * Computes the change and prints it — a per-client old→new diff, or "would
 * create <path>" — writing NOTHING. Under `--format json` it emits a single
 * object describing the planned changes.
 *
 * ## Concurrency
 *
 * The read→compute→write sequence is NOT locked. If an agent host rewrites the
 * same config in the window between our read and our rename, that host's change
 * is lost. This is acceptable for a human-run, one-shot installer (the user is
 * not simultaneously reconfiguring the same file by hand); a daemon-grade writer
 * would need a lock.
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

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
export function buildSheafEntry(vault: string, tools?: ToolSurface): McpEntry {
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
  /** Absolute path to this client's config file (before symlink resolution). */
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
    targetPath: (rc) =>
      join(claudeDesktopDir(rc.env), "claude_desktop_config.json"),
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

/** List of valid client ids, for error messages and bare-install order. */
const CLIENT_IDS = Object.keys(CLIENTS);

// ---------------------------------------------------------------------------
// Parsing + merging
// ---------------------------------------------------------------------------

/** JSON `"mcpServers"` vs TOML `"mcp_servers"`. */
const SERVERS_KEY: Record<ConfigFormat, string> = {
  json: "mcpServers",
  toml: "mcp_servers",
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

/**
 * Parse existing config text into a root object. A missing / empty / whitespace-
 * only file is an empty config `{}` (not a parse error). Malformed content
 * throws a {@link CliError} with a `config_parse` code so the original file is
 * left untouched.
 */
function parseConfig(
  format: ConfigFormat,
  text: string,
  path: string,
): Record<string, unknown> {
  if (text.trim().length === 0) return {};
  let value: unknown;
  if (format === "json") {
    try {
      value = JSON.parse(text);
    } catch {
      throw new CliError(
        `existing config is not valid JSON: ${path}`,
        "config_parse",
        EXIT.GENERIC,
      );
    }
  } else {
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
  }
  return asTable(value, path);
}

/**
 * Merge our canonical invocation over any pre-existing value at our key. We own
 * ONLY `command` and `args`; a user who added `env`, `type: "stdio"`,
 * `startup_timeout_sec`, … onto our entry keeps them. A non-object pre-existing
 * value (someone set `sheaf = "x"`) is simply replaced.
 */
function mergeEntry(existing: unknown, entry: McpEntry): Record<string, unknown> {
  if (existing !== null && typeof existing === "object" && !Array.isArray(existing)) {
    return { ...(existing as Record<string, unknown>), command: entry.command, args: entry.args };
  }
  return { command: entry.command, args: entry.args };
}

type Action = "install" | "update";

/** The serialized result of merging our entry into one config. */
interface Computed {
  contents: string;
  action: Action;
  oldEntry: unknown;
  newEntry: Record<string, unknown>;
  /** True when we reserialized (⇒ TOML comments/formatting were not preserved). */
  reformat: boolean;
}

/** Compute the new JSON file contents (always a full reserialize; no comments to keep). */
function computeJson(
  root: Record<string, unknown>,
  name: string,
  entry: McpEntry,
  path: string,
): Computed {
  const existingServers = root[SERVERS_KEY.json];
  const servers =
    existingServers === undefined ? {} : asTable(existingServers, path);
  const existing = servers[name];
  const merged = mergeEntry(existing, entry);
  servers[name] = merged;
  root[SERVERS_KEY.json] = servers;
  return {
    contents: `${JSON.stringify(root, null, 2)}\n`,
    action: existing === undefined ? "install" : "update",
    oldEntry: existing ?? null,
    newEntry: merged,
    reformat: false,
  };
}

/** Render just a `[mcp_servers.<name>]` table (ends with a newline). */
function tomlBlock(name: string, entry: Record<string, unknown>): string {
  return stringifyToml({ [SERVERS_KEY.toml]: { [name]: entry } });
}

/**
 * Confirm a textually-appended TOML file round-trips: it parses, and our entry
 * reads back identical to what we appended. If not (e.g. `mcp_servers` was an
 * inline table, so `[mcp_servers.x]` is illegal), the caller reserializes.
 */
function appendRoundTrips(
  text: string,
  name: string,
  merged: Record<string, unknown>,
): boolean {
  try {
    const parsed = parseToml(text) as Record<string, unknown>;
    const servers = parsed[SERVERS_KEY.toml];
    if (servers === null || typeof servers !== "object" || Array.isArray(servers)) {
      return false;
    }
    const got = (servers as Record<string, unknown>)[name];
    return JSON.stringify(got) === JSON.stringify(merged);
  } catch {
    return false;
  }
}

/**
 * Compute the new TOML file contents. On a first install (our table absent) we
 * TEXTUALLY APPEND to preserve comments/formatting; on an update, or if the
 * append would not round-trip, we reserialize (and flag it).
 */
function computeToml(
  originalText: string,
  root: Record<string, unknown>,
  name: string,
  entry: McpEntry,
  path: string,
): Computed {
  const existingServers = root[SERVERS_KEY.toml];
  const servers =
    existingServers === undefined ? {} : asTable(existingServers, path);
  const existing = servers[name];
  const merged = mergeEntry(existing, entry);

  if (existing === undefined) {
    // Append a fresh table at EOF — foreign comments/formatting untouched.
    const block = tomlBlock(name, merged);
    const trimmed = originalText.replace(/\s+$/, "");
    const contents = trimmed.length ? `${trimmed}\n\n${block}` : block;
    if (appendRoundTrips(contents, name, merged)) {
      return {
        contents,
        action: "install",
        oldEntry: null,
        newEntry: merged,
        reformat: false,
      };
    }
    // Fall through to a reserialize (rare: `mcp_servers` was an inline table).
  }

  servers[name] = merged;
  root[SERVERS_KEY.toml] = servers;
  const s = stringifyToml(root);
  return {
    contents: s.endsWith("\n") ? s : `${s}\n`,
    action: existing === undefined ? "install" : "update",
    oldEntry: existing ?? null,
    newEntry: merged,
    reformat: true,
  };
}

// ---------------------------------------------------------------------------
// Target resolution (symlink-safe)
// ---------------------------------------------------------------------------

/** Where we actually read + write for a client, after following any symlink. */
interface ResolvedTarget {
  /** The canonical file to read + write (a symlink's real target, if any). */
  path: string;
  /** The path the client definition asked for (may be a symlink). */
  requested: string;
  /** True if the (resolved) file already exists. */
  exists: boolean;
}

/**
 * Resolve where to operate. A dotfile-managed config is commonly a SYMLINK
 * (`~/.codex/config.toml -> ~/dotfiles/codex.toml`); writing tmp+rename over the
 * symlink path itself would detach it into a plain file and leave the real file
 * stale. So we follow the link and operate on its real target (the symlink stays
 * a symlink pointing at the now-updated file). A DANGLING symlink is a hard
 * error rather than a silent plain-file replacement. `realpathSync` also
 * canonicalizes parent-directory symlinks, keeping the tmp+rename on one device.
 */
function resolveTarget(requested: string): ResolvedTarget {
  let link;
  try {
    link = lstatSync(requested);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: requested, requested, exists: false };
    }
    throw e; // permissions etc. — surface it
  }
  if (link.isSymbolicLink()) {
    let real: string;
    try {
      real = realpathSync(requested);
    } catch {
      throw new CliError(
        `config path is a dangling symlink: ${requested}; refusing to overwrite it`,
        "config_dangling_symlink",
        EXIT.GENERIC,
      );
    }
    return { path: real, requested, exists: true };
  }
  // A regular file: canonicalize (parent symlinks) so the atomic rename is same-dir.
  return { path: realpathSync(requested), requested, exists: true };
}

// ---------------------------------------------------------------------------
// Planning + applying
// ---------------------------------------------------------------------------

/** The computed change for one client — everything both dry-run and apply need. */
export interface Plan {
  client: ClientDef;
  /** The canonical file we read + write (symlink-resolved). */
  path: string;
  /** What the client asked for (differs from `path` when a symlink was followed). */
  requested: string;
  /** True if the config file already exists on disk. */
  fileExists: boolean;
  /** True if OUR `<name>` entry already existed (⇒ update, else install). */
  action: Action;
  /** The pre-existing value at our key (raw), for the diff; null if none. */
  oldEntry: unknown;
  /** The entry we upsert (merged over any user-added keys on our entry). */
  newEntry: Record<string, unknown>;
  /** The full serialized file contents to write. */
  contents: string;
  /** Mode to reapply after write (existing file's mode), or undefined if new. */
  mode: number | undefined;
  /** True when a TOML reserialize dropped comments/formatting (warn about it). */
  reformat: boolean;
}

/**
 * Read the config (if any), upsert our `<name>` entry, and compute the
 * serialized result — WITHOUT touching disk. Preserves every other key/server/
 * table (and any user-added keys on our own entry). The caller decides whether
 * to write (apply) or just render (dry-run).
 */
function planInstall(
  client: ClientDef,
  rc: ResolveCtx,
  name: string,
  entry: McpEntry,
): Plan {
  const { path, requested, exists } = resolveTarget(client.targetPath(rc));

  const original = exists ? readFileSync(path, "utf8") : "";
  let mode: number | undefined;
  if (exists) {
    try {
      mode = statSync(path).mode & 0o777;
    } catch {
      mode = undefined;
    }
  }

  const root = parseConfig(client.format, original, path);
  const computed =
    client.format === "json"
      ? computeJson(root, name, entry, path)
      : computeToml(original, root, name, entry, path);

  return {
    client,
    path,
    requested,
    fileExists: exists,
    action: computed.action,
    oldEntry: computed.oldEntry,
    newEntry: computed.newEntry,
    contents: computed.contents,
    mode,
    reformat: computed.reformat,
  };
}

/**
 * Create `dir` and any missing parents, chmod'ing every level WE create to 0700
 * (mkdir's mode is masked by umask). `~/.codex` also holds `auth.json`, so a
 * world-readable dir would leak; existing dirs are left as the user set them.
 */
function ensureDir(dir: string): void {
  const created: string[] = [];
  let cur = dir;
  while (!existsSync(cur)) {
    created.push(cur);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  mkdirSync(dir, { recursive: true });
  for (const d of created) {
    try {
      chmodSync(d, 0o700);
    } catch {
      /* best effort */
    }
  }
}

/**
 * Write `plan.contents` to `plan.path` atomically and durably:
 *   - create parent dirs (0700 for any we make);
 *   - write a UNIQUE sibling tmp (pid + random, so concurrent installs can't
 *     clobber each other's tmp), reapplying the original mode on an update (new
 *     files get 0600 — these can hold host secrets) so we neither loosen nor
 *     tighten the user's permissions;
 *   - `fsync` the tmp before `rename` (power-loss safety);
 *   - `rename` over the target (atomic on POSIX);
 *   - always remove the tmp on failure (no orphan left behind).
 */
export function applyPlan(plan: Plan): void {
  const dir = dirname(plan.path);
  ensureDir(dir);
  const tmp = join(
    dir,
    `.${basename(plan.path)}.sheaf-${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
  );
  const fileMode = plan.mode ?? 0o600;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", fileMode);
    writeSync(fd, plan.contents);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // Defend against a umask that stripped bits at create time.
    chmodSync(tmp, fileMode);
    renameSync(tmp, plan.path);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    if (existsSync(tmp)) {
      try {
        rmSync(tmp);
      } catch {
        /* best effort — a stray tmp is better than masking the real error */
      }
    }
  }
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
    // Bare install: every detected client.
    const detected = CLIENT_IDS.filter((id) => CLIENTS[id].detect(rc)).map(
      (id) => CLIENTS[id],
    );
    if (detected.length === 0) return [];
    out.diagnostic(`detected client(s): ${detected.map((c) => c.id).join(", ")}`);
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

/** " (via symlink <requested>)" when the write target was reached through a link. */
function viaSuffix(plan: Plan): string {
  return plan.path === plan.requested ? "" : ` (via symlink ${plan.requested})`;
}

/** The stderr/diagnostic warning for a TOML reserialize that dropped formatting. */
function reformatWarning(plan: Plan): string {
  return (
    `${plan.client.id}: updating an existing entry rewrites ${plan.path} via ` +
    `reserialization — TOML comments and formatting are not preserved`
  );
}

/** Print the per-client dry-run diff to stdout (text mode). */
function renderDryRunText(out: Output, name: string, plans: Plan[]): void {
  for (const plan of plans) {
    if (!plan.fileExists) {
      out.text(`${plan.client.id} — would create ${plan.path}${viaSuffix(plan)}`);
      out.text(`  + ${name}: ${entryJson(plan.newEntry)}`);
    } else {
      out.text(
        `${plan.client.id} — would ${plan.action} \`${name}\` in ${plan.path}${viaSuffix(plan)}`,
      );
      out.text(
        `  - ${name}: ${plan.oldEntry === null ? "(none)" : entryJson(plan.oldEntry)}`,
      );
      out.text(`  + ${name}: ${entryJson(plan.newEntry)}`);
    }
    if (plan.reformat) out.text(`  ! ${reformatWarning(plan)}`);
  }
}

/** Print the per-client apply result to stdout (text mode). */
function renderApplyText(out: Output, name: string, plans: Plan[]): void {
  for (const plan of plans) {
    const verb = plan.action === "install" ? "installed" : "updated";
    out.text(`${plan.client.id}: ${verb} \`${name}\` -> ${plan.path}${viaSuffix(plan)}`);
  }
}

/** The JSON change record shared by dry-run and apply output. */
function changeRecord(plan: Plan, name: string, includePlan: boolean) {
  const base = {
    client: plan.client.id,
    path: plan.path,
    requested: plan.requested,
    action: plan.action,
    name,
    reformat: plan.reformat,
  };
  return includePlan
    ? { ...base, fileExists: plan.fileExists, old: plan.oldEntry, new: plan.newEntry }
    : base;
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

  // Compute EVERY plan (parsing each config) before writing ANYTHING, so a
  // malformed config for one client aborts with nothing written.
  const plans = clients.map((client) => planInstall(client, rc, name, entry));

  if (dryRun) {
    if (out.format === "json") {
      out.json({ dryRun: true, changes: plans.map((p) => changeRecord(p, name, true)) });
    } else {
      renderDryRunText(out, name, plans);
    }
    return EXIT.OK;
  }

  for (const plan of plans) {
    applyPlan(plan);
  }

  // Warn on stderr — regardless of --format — for any client whose existing
  // entry forced a TOML reserialize (comments/formatting were not preserved).
  for (const plan of plans) {
    if (plan.reformat) out.diagnostic(reformatWarning(plan));
  }

  if (out.format === "json") {
    out.json({ dryRun: false, changes: plans.map((p) => changeRecord(p, name, false)) });
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

/**
 * `sheaf events follow` — tail the daemon's live event stream as NDJSON.
 *
 * This is the client side of the SSE stream that `sheaf-server/src/events.ts`
 * produces. It exists distinct from that server module: the server *formats*
 * SSE frames onto a connection; this *consumes* them, unwraps each `data:`
 * payload, and prints one BackendEvent JSON object per line to stdout.
 *
 * `--role` defaults to `ui`: a human tailing events should NOT flip the plugin's
 * "agent connected" indicator. The MCP ReadMe's agent watcher (which replaces
 * the old curl+sed loop) passes `--role agent` explicitly — that's the role that
 * signals presence.
 *
 * The load-bearing behaviors (docs/sheaf-cli-v0.1.md "Output contract"):
 *   - Output is ALWAYS NDJSON — one valid JSON object per line — regardless of
 *     `--format`. Each payload is re-parsed and re-serialized so a multi-line or
 *     empty `data:` frame can never break the one-event-per-line contract; SSE
 *     `:` comment lines (the connect primer and `: ping` keep-alives) are dropped.
 *   - It runs until interrupted, reconnecting across daemon restarts. On each
 *     (re)connect it re-locates the daemon, because a restart lands on a fresh
 *     ephemeral port; it resends the last-seen SSE `id:` (seeded by `--since`)
 *     as `Last-Event-ID` so the daemon replays what was missed — or emits a
 *     `stream_reset` when it can't prove continuity (a different backend
 *     instance, or the id aged out of the replay buffer).
 *   - Diagnostics (connect / reconnect notices) go to stderr only; stdout stays
 *     pure NDJSON.
 *   - No daemon on the *initial* connect ⇒ `noDaemonError` (exit 3); it never
 *     auto-spawns. A daemon that goes away *later* is treated as a transient
 *     outage and retried forever (a follow is a long-lived watcher) — unless
 *     `--exit-on-disconnect` is set, which exits instead (0 on a clean daemon
 *     shutdown, non-zero on an error) for scripts that want a bounded lifetime.
 *
 * The reconnect loop is factored into {@link followEvents}, which takes an
 * explicit `AbortSignal` and output callbacks, so it is unit-testable without a
 * real SIGINT or the process's stdout. {@link eventsFollowCommand} wires SIGINT
 * to that signal and the process streams to the callbacks.
 */
import { daemonBaseUrl, findDaemon } from "sheaf-server/daemon";

import type { RunContext } from "./commands";
import { requireDaemonAllowed } from "./client";
import { CliError, EXIT, noDaemonError, usageError, type ExitCode } from "./io";

/** Base reconnect backoff, doubled per consecutive failure up to the cap. */
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30_000;

/** The two subscriber roles the SSE stream understands. */
export type FollowRole = "agent" | "ui";

/** Inputs for the reconnecting follow loop. */
export interface FollowOptions {
  /** Realpath'd vault whose daemon to follow. */
  vault: string;
  /** Environment for daemon discovery (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Subscriber role (drives `?role=`; agent flips plugin presence). */
  role: FollowRole;
  /** Initial resume position (`--since`), sent as `Last-Event-ID` on connect. */
  since?: string;
  /** Aborting this stops the loop and returns cleanly. */
  signal: AbortSignal;
  /** Sink for each event: one compact, re-serialized JSON string (no newline). */
  onData: (jsonLine: string) => void;
  /** Sink for diagnostics (connect/reconnect notices, dropped payloads). Optional. */
  onDiagnostic?: (line: string) => void;
  /**
   * Called with the SSE resume cursor each time it advances (the `id:` of the
   * last event delivered). Lets a caller checkpoint the position; the tests use
   * it to drive an in-epoch resume.
   */
  onResumeId?: (id: string) => void;
  /**
   * Exit instead of retrying when the daemon goes away after the initial
   * connect: a clean end-of-stream returns normally (exit 0), an error throws a
   * {@link CliError} (non-zero). Default `false` → retry forever.
   */
  exitOnDisconnect?: boolean;
  /** Override the base backoff (ms) — tests use a small value. */
  backoffBaseMs?: number;
  /** Override the backoff cap (ms). */
  backoffCapMs?: number;
}

/**
 * Follow the daemon's event stream until `opts.signal` aborts. Resolves (does
 * not reject) on abort. Throws {@link noDaemonError} only when NO daemon is
 * reachable on the very first locate — a daemon disappearing mid-follow is a
 * transient outage that the loop rides out.
 */
export async function followEvents(opts: FollowOptions): Promise<void> {
  const env = opts.env ?? process.env;
  const base = opts.backoffBaseMs ?? BACKOFF_BASE_MS;
  const cap = opts.backoffCapMs ?? BACKOFF_CAP_MS;
  const diag = opts.onDiagnostic ?? (() => {});

  // Enforce the one-valid-JSON-object-per-line contract at the single point of
  // emission: skip empty payloads, and drop (with a diagnostic) anything that
  // isn't parseable JSON, so a multi-line/empty `data:` frame can't leak a
  // malformed or blank line onto stdout.
  const emit = (payload: string): void => {
    if (payload.trim() === "") return; // empty data frame — silently skip
    const line = ndjsonLine(payload);
    if (line === null) {
      diag(`dropping unparseable event payload`);
      return;
    }
    opts.onData(line);
  };

  // Resume cursor: the SSE `id:` of the last event we printed. Seeded by
  // `--since`; updated as events with ids arrive; resent on every reconnect.
  let lastId = opts.since;
  const noteId = (id: string): void => {
    lastId = id;
    opts.onResumeId?.(id);
  };
  let firstLocate = true;
  let failures = 0; // consecutive failures without a successful connect

  while (!opts.signal.aborted) {
    const info = await findDaemon(opts.vault, env);
    if (!info) {
      if (firstLocate) throw noDaemonError(opts.vault);
      if (opts.exitOnDisconnect) throw disconnectedError(opts.vault);
      diag(`daemon unreachable; retrying`);
      await abortableDelay(backoffFor(failures, base, cap), opts.signal);
      failures += 1;
      continue;
    }
    firstLocate = false;

    const url = daemonBaseUrl(info);
    let established = false;
    try {
      diag(
        `following ${url}/api/ui/drafts/stream?role=${opts.role}` +
          (lastId !== undefined ? ` (since ${lastId})` : ""),
      );
      await streamOnce({
        base: url,
        role: opts.role,
        lastId,
        signal: opts.signal,
        onConnected: () => {
          established = true;
        },
        onId: noteId,
        onData: emit,
      });
      // A clean end-of-stream: the daemon closed the connection (shutdown /
      // restart).
      if (opts.signal.aborted) break;
      if (opts.exitOnDisconnect) {
        diag(`daemon disconnected; exiting`);
        return; // clean shutdown → exit 0
      }
      diag(`stream ended; reconnecting`);
    } catch (e) {
      if (opts.signal.aborted) break;
      if (opts.exitOnDisconnect) throw disconnectedError(opts.vault, e);
      diag(`stream error; reconnecting: ${errMessage(e)}`);
    }

    if (opts.signal.aborted) break;
    // Compute the delay from the CURRENT failure count, THEN advance it, so the
    // first retry is always ~base whether it was a locate or a stream failure (a
    // stream that connected before dropping resets the count → fast reconnect).
    const delayMs = backoffFor(established ? 0 : failures, base, cap);
    failures = established ? 0 : failures + 1;
    await abortableDelay(delayMs, opts.signal);
  }
}

/**
 * Open one SSE connection and pump frames until the body ends, the signal
 * aborts, or an error is thrown. Calls `onConnected` once the response is
 * accepted (a 200 with a body), `onId` for each SSE `id:`, and `onData` with
 * each `data:` payload as a single compact line.
 */
async function streamOnce(opts: {
  base: string;
  role: FollowRole;
  lastId: string | undefined;
  signal: AbortSignal;
  onConnected: () => void;
  onId: (id: string) => void;
  onData: (jsonLine: string) => void;
}): Promise<void> {
  const url = new URL(`${opts.base}/api/ui/drafts/stream`);
  url.searchParams.set("role", opts.role);

  const headers: Record<string, string> = { accept: "text/event-stream" };
  // Resume position: the standard SSE reconnect header. The server also accepts
  // `?since=`, but the header is the canonical form and what it reads first.
  if (opts.lastId !== undefined) headers["last-event-id"] = opts.lastId;

  const res = await fetch(url, { headers, signal: opts.signal });
  if (!res.ok || !res.body) {
    // Drain the body so the socket is freed before we retry.
    try {
      await res.text();
    } catch {
      /* ignore */
    }
    throw new Error(`stream request failed: HTTP ${res.status}`);
  }
  opts.onConnected();

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseFrameParser(opts.onId, opts.onData);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return; // clean EOF → caller reconnects
      parser.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already released */
    }
  }
}

/**
 * Incremental SSE frame parser. Fed decoded text chunks (of any size — a frame,
 * an `id:`, even a single byte may span calls); dispatches `onId` for each SSE
 * `id:` and `onData` for each complete `data:` frame. Exported so the
 * chunk-splitting / CRLF handling can be tested without a live socket.
 *
 * Line endings: it normalizes CRLF and lone CR to LF (the spec permits CRLF, and
 * a proxy may rewrite ours), holding back a trailing lone `\r` between chunks so
 * a `\r\n` split across a chunk boundary is never miscounted as two terminators.
 */
export class SseFrameParser {
  /** LF-normalized text not yet consumed as a complete frame. */
  private buffer = "";
  /** A trailing `\r` from the previous chunk, possibly the start of a `\r\n`. */
  private pendingCr = false;

  constructor(
    private readonly onId: (id: string) => void,
    private readonly onData: (payload: string) => void,
  ) {}

  /** Feed the next decoded text chunk, dispatching any newly-complete frames. */
  push(text: string): void {
    let chunk = (this.pendingCr ? "\r" : "") + text;
    this.pendingCr = chunk.endsWith("\r");
    if (this.pendingCr) chunk = chunk.slice(0, -1);
    this.buffer += chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    let sep: number;
    while ((sep = this.buffer.indexOf("\n\n")) !== -1) {
      this.parseFrame(this.buffer.slice(0, sep));
      this.buffer = this.buffer.slice(sep + 2);
    }
  }

  /**
   * Parse one frame. Comment lines (`:` — the `: connected` primer and `: ping`
   * keep-alives) are dropped; `id:` updates the resume cursor; `data:` lines are
   * collected and, per the SSE spec, joined with `\n` (our events are single-
   * line JSON, so this is normally one line) and handed to `onData`.
   */
  private parseFrame(frame: string): void {
    const dataParts: string[] = [];
    for (const line of frame.split("\n")) {
      if (line === "" || line.startsWith(":")) continue; // blank or comment
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1); // SSE strips one lead space
      if (field === "id") this.onId(value);
      else if (field === "data") dataParts.push(value);
    }
    if (dataParts.length > 0) this.onData(dataParts.join("\n"));
  }
}

/**
 * Enforce the NDJSON contract on one joined `data:` payload: re-parse and
 * re-serialize to a single compact line. Returns `null` to drop the payload —
 * empty (a bare `data:` frame) or not valid JSON (a multi-object or malformed
 * frame) — so a blank or malformed line can never reach stdout. Exported for
 * direct testing.
 */
export function ndjsonLine(payload: string): string | null {
  if (payload.trim() === "") return null;
  try {
    return JSON.stringify(JSON.parse(payload));
  } catch {
    return null;
  }
}

/** Exponential backoff for the Nth consecutive failure, capped. */
function backoffFor(failures: number, base: number, cap: number): number {
  return Math.min(cap, base * 2 ** failures);
}

/** A delay that resolves early (rather than throwing) when `signal` aborts. */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Best-effort message for a wrapped fetch/stream error. */
function errMessage(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return cause.message;
    return e.message;
  }
  return String(e);
}

/**
 * Validate `--role`; anything but the two roles is a usage error (exit 2).
 * Defaults to `ui`: a human tailing must not flip the plugin's "agent connected"
 * indicator. The agent watcher passes `--role agent` explicitly.
 */
function parseRole(value: unknown): FollowRole {
  if (value === undefined) return "ui";
  if (value === "agent" || value === "ui") return value;
  throw usageError(
    `--role must be 'agent' or 'ui' (got '${String(value)}')`,
  );
}

/** The "daemon went away after connecting" error used by `--exit-on-disconnect`. */
function disconnectedError(vault: string, e?: unknown): CliError {
  const detail = e === undefined ? "" : `: ${errMessage(e)}`;
  return new CliError(
    `sheaf daemon for ${vault} disconnected${detail}`,
    "daemon_disconnected",
    EXIT.GENERIC,
  );
}

/**
 * `run` handler for `sheaf events follow`. Wires SIGINT → an abort that stops
 * the loop and returns 0 (a clean, expected exit for a foreground tail), and
 * streams events to stdout as NDJSON with diagnostics on stderr.
 */
export async function eventsFollowCommand(ctx: RunContext): Promise<ExitCode> {
  requireDaemonAllowed(ctx.globals, "sheaf events follow");

  const role = parseRole(ctx.values.role);
  const since =
    typeof ctx.values.since === "string" ? ctx.values.since : undefined;
  const exitOnDisconnect = ctx.values["exit-on-disconnect"] === true;

  const controller = new AbortController();
  // First Ctrl-C aborts the loop for a clean exit 0; a second (while we're mid
  // reconnect/backoff) forces the conventional 130, so an impatient user can
  // always get out.
  let sigints = 0;
  const onSigint = (): void => {
    sigints += 1;
    if (sigints >= 2) process.exit(130);
    controller.abort();
  };
  process.on("SIGINT", onSigint);
  // Track the latest SSE resume cursor so we can hand it back on exit — stdout
  // stays pure NDJSON (which carries no ids), so the cursor for `--since` goes
  // to stderr, where a script can capture it separately.
  let lastResumeId: string | undefined;
  try {
    await followEvents({
      vault: ctx.vault,
      env: ctx.io.env,
      role,
      since,
      exitOnDisconnect,
      signal: controller.signal,
      // Always NDJSON on stdout, regardless of --format.
      onData: (line) => ctx.io.out(`${line}\n`),
      onDiagnostic: (line) => ctx.io.err(`${line}\n`),
      onResumeId: (id) => {
        lastResumeId = id;
      },
    });
  } finally {
    process.removeListener("SIGINT", onSigint);
    if (lastResumeId !== undefined) {
      ctx.io.err(`resume cursor: ${lastResumeId}\n`);
    }
  }
  return EXIT.OK;
}

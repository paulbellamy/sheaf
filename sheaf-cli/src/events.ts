/**
 * `sheaf events follow` — tail the daemon's live event stream as NDJSON.
 *
 * This is the client side of the SSE stream that `sheaf-server/src/events.ts`
 * produces. It exists distinct from that server module: the server *formats*
 * SSE frames onto a connection; this *consumes* them, unwraps each `data:`
 * payload, and prints one BackendEvent JSON object per line to stdout. The ReadMe
 * points agents at `sheaf events follow --role agent` as the first-class
 * replacement for the curl+sed watch loop (the `role=agent` param is what flips
 * the plugin's "agent connected" status), so `--role` defaults to `agent`.
 *
 * The load-bearing behaviors (docs/sheaf-cli-v0.1.md "Output contract"):
 *   - Output is ALWAYS NDJSON — one event per line — regardless of `--format`.
 *     Pings and the connect primer (SSE `:` comment lines) are dropped.
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
 *     outage and retried (a follow is a long-lived watcher).
 *
 * The reconnect loop is factored into {@link followEvents}, which takes an
 * explicit `AbortSignal` and output callbacks, so it is unit-testable without a
 * real SIGINT or the process's stdout. {@link eventsFollowCommand} wires SIGINT
 * to that signal and the process streams to the callbacks.
 */
import { daemonBaseUrl, findDaemon } from "sheaf-server/daemon";

import type { RunContext } from "./commands";
import { requireDaemonAllowed } from "./client";
import { EXIT, noDaemonError, usageError, type ExitCode } from "./io";

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
  /** Sink for each event: one compact JSON string (no trailing newline). */
  onData: (jsonLine: string) => void;
  /** Sink for diagnostics (connect/reconnect notices). Optional. */
  onDiagnostic?: (line: string) => void;
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

  // Resume cursor: the SSE `id:` of the last event we printed. Seeded by
  // `--since`; updated as events with ids arrive; resent on every reconnect.
  let lastId = opts.since;
  let firstLocate = true;
  let failures = 0; // consecutive failures without a successful connect

  while (!opts.signal.aborted) {
    const info = await findDaemon(opts.vault, env);
    if (!info) {
      if (firstLocate) throw noDaemonError(opts.vault);
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
        onId: (id) => {
          lastId = id;
        },
        onData: opts.onData,
      });
      // A clean end-of-stream: the daemon closed the connection (shutdown /
      // restart). Reconnect promptly.
      if (opts.signal.aborted) break;
      diag(`stream ended; reconnecting`);
    } catch (e) {
      if (opts.signal.aborted) break;
      diag(`stream error; reconnecting: ${errMessage(e)}`);
    }

    if (opts.signal.aborted) break;
    // A stream that connected before dropping resets the backoff (fast
    // reconnect after a restart); one that never connected backs off.
    failures = established ? 0 : failures + 1;
    await abortableDelay(backoffFor(established ? 0 : failures, base, cap), opts.signal);
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
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return; // clean EOF → caller reconnects
      buffer += decoder.decode(value, { stream: true });
      buffer = drainFrames(buffer, opts.onId, opts.onData);
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
 * Split off every complete SSE frame (`…\n\n`) from `buffer`, dispatch it, and
 * return the incomplete trailing remainder for the next chunk.
 */
function drainFrames(
  buffer: string,
  onId: (id: string) => void,
  onData: (jsonLine: string) => void,
): string {
  let sep: number;
  while ((sep = buffer.indexOf("\n\n")) !== -1) {
    parseFrame(buffer.slice(0, sep), onId, onData);
    buffer = buffer.slice(sep + 2);
  }
  return buffer;
}

/**
 * Parse one SSE frame. Comment lines (`:` — the `: connected` primer and
 * `: ping` keep-alives) are dropped; `id:` updates the resume cursor; `data:`
 * lines are collected and, per the SSE spec, joined with `\n` (our events are
 * single-line JSON, so this is normally one line) and handed to `onData`.
 */
function parseFrame(
  frame: string,
  onId: (id: string) => void,
  onData: (jsonLine: string) => void,
): void {
  const dataParts: string[] = [];
  for (const raw of frame.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === "" || line.startsWith(":")) continue; // blank or comment
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1); // SSE strips one lead space
    if (field === "id") onId(value);
    else if (field === "data") dataParts.push(value);
  }
  if (dataParts.length > 0) onData(dataParts.join("\n"));
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

/** Validate `--role`; anything but the two roles is a usage error (exit 2). */
function parseRole(value: unknown): FollowRole {
  if (value === undefined) return "agent"; // ReadMe's agent-watcher default
  if (value === "agent" || value === "ui") return value;
  throw usageError(
    `--role must be 'agent' or 'ui' (got '${String(value)}')`,
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

  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.on("SIGINT", onSigint);
  try {
    await followEvents({
      vault: ctx.vault,
      env: ctx.io.env,
      role,
      since,
      signal: controller.signal,
      // Always NDJSON on stdout, regardless of --format.
      onData: (line) => ctx.io.out(`${line}\n`),
      onDiagnostic: (line) => ctx.io.err(`${line}\n`),
    });
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
  return EXIT.OK;
}

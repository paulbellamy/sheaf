import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { connectDaemon } from "./client";
import type { RunContext } from "./commands";
import {
  eventsFollowCommand,
  followEvents,
  ndjsonLine,
  SseFrameParser,
} from "./events";
import { EXIT, Output, type Io } from "./io";
import { startServer, type ServeHandle } from "./serve";

const delay = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Poll `pred` until it holds or the deadline passes (then throw). */
async function waitFor(
  pred: () => boolean,
  ms = 5000,
  what = "condition",
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred() && Date.now() < deadline) await delay(25);
  if (!pred()) throw new Error(`timed out waiting for ${what}`);
}

/** True if any NDJSON line in `lines` decodes to an event of `kind`. */
function hasKind(lines: string[], kind: string): boolean {
  return lines.some((l) => {
    try {
      return (JSON.parse(l) as { kind?: string }).kind === kind;
    } catch {
      return false;
    }
  });
}

const trash: string[] = [];
const handles: ServeHandle[] = [];

function scratch(): { env: NodeJS.ProcessEnv; vault: string } {
  const home = mkdtempSync(join(tmpdir(), "sheaf-home-"));
  const vault = realpathSync(mkdtempSync(join(tmpdir(), "sheaf-vault-")));
  writeFileSync(join(vault, "note.md"), "# Note\n\nhello world");
  trash.push(home, vault);
  return { env: { SHEAF_HOME: home }, vault };
}

afterEach(async () => {
  for (const h of handles.splice(0)) await h.close().catch(() => {});
  for (const d of trash.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A POST /api/ui/threads body that adds a doc-scoped thread on note.md. */
const THREAD_BODY = {
  path: "note.md",
  targets: [{ scope: "doc" as const }],
  message: "a comment from the ui",
};

describe("followEvents", () => {
  it("emits a thread_changed NDJSON line when a thread is posted over REST", async () => {
    const { env, vault } = scratch();
    const handle = await startServer({ vault, version: "test", env });
    handles.push(handle);

    const lines: string[] = [];
    const diags: string[] = [];
    const controller = new AbortController();
    const followed = followEvents({
      vault,
      env,
      role: "agent",
      signal: controller.signal,
      onData: (l) => lines.push(l),
      onDiagnostic: (l) => diags.push(l),
      backoffBaseMs: 100,
      backoffCapMs: 500,
    });

    try {
      // Wait until the follow has actually connected before mutating.
      await waitFor(
        () => diags.some((d) => d.startsWith("following")),
        5000,
        "follow to connect",
      );

      // Mutate via REST (origin ui) — this is what wakes the agent stream.
      const client = await connectDaemon(vault, env);
      try {
        const res = await client.rest<{ thread_id: string }>(
          "POST",
          "/api/ui/threads",
          { body: THREAD_BODY },
        );
        expect(res.thread_id).toMatch(/^thrd_/);
      } finally {
        await client.close();
      }

      await waitFor(
        () => hasKind(lines, "thread_changed"),
        5000,
        "a thread_changed line",
      );
    } finally {
      controller.abort();
      await followed;
    }

    // Output is pure NDJSON: every stdout line parses as a JSON object.
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  }, 15_000);

  it("reconnects across a daemon restart and emits a fresh stream_reset", async () => {
    const { env, vault } = scratch();
    const first = await startServer({ vault, version: "one", env });
    handles.push(first);

    const lines: string[] = [];
    const diags: string[] = [];
    const controller = new AbortController();
    const followed = followEvents({
      vault,
      env,
      role: "agent",
      signal: controller.signal,
      onData: (l) => lines.push(l),
      onDiagnostic: (l) => diags.push(l),
      backoffBaseMs: 100,
      backoffCapMs: 500,
    });

    try {
      await waitFor(
        () => diags.some((d) => d.startsWith("following")),
        5000,
        "follow to connect",
      );

      // Post a thread so the follow has advanced its resume id (Last-Event-ID)
      // before the restart — the reconnect then genuinely can't be honored.
      const c1 = await connectDaemon(vault, env);
      try {
        await c1.rest("POST", "/api/ui/threads", { body: THREAD_BODY });
      } finally {
        await c1.close();
      }
      await waitFor(() => hasKind(lines, "thread_changed"), 5000, "thread_changed");

      const marker = lines.length;

      // Restart the daemon: clean close (ends the SSE stream) then a fresh
      // instance on a new ephemeral port.
      await first.close();
      const second = await startServer({ vault, version: "two", env });
      handles.push(second);

      // The reconnect lands on a different backend instance, which can't prove
      // continuity with the old resume id → one stream_reset, after the marker.
      await waitFor(
        () => hasKind(lines.slice(marker), "stream_reset"),
        12_000,
        "a post-restart stream_reset",
      );
    } finally {
      controller.abort();
      await followed;
    }
  }, 25_000);

  it("resumes in-epoch from a valid id without a stream_reset", async () => {
    const { env, vault } = scratch();
    const handle = await startServer({ vault, version: "test", env });
    handles.push(handle);

    // Phase 1: connect and capture a real resume id from a thread_changed.
    let capturedId: string | undefined;
    const linesA: string[] = [];
    const diagsA: string[] = [];
    const ctrlA = new AbortController();
    const followA = followEvents({
      vault,
      env,
      role: "ui",
      signal: ctrlA.signal,
      onData: (l) => linesA.push(l),
      onDiagnostic: (l) => diagsA.push(l),
      onResumeId: (id) => {
        capturedId = id;
      },
      backoffBaseMs: 100,
      backoffCapMs: 500,
    });
    try {
      await waitFor(
        () => diagsA.some((d) => d.startsWith("following")),
        5000,
        "connect A",
      );
      const c = await connectDaemon(vault, env);
      try {
        await c.rest("POST", "/api/ui/threads", { body: THREAD_BODY });
      } finally {
        await c.close();
      }
      await waitFor(
        () => hasKind(linesA, "thread_changed") && capturedId !== undefined,
        5000,
        "a resume id",
      );
    } finally {
      ctrlA.abort();
      await followA;
    }
    expect(capturedId).toBeDefined();

    // Phase 2: resume from that id against the SAME daemon (same epoch, id still
    // in the replay buffer) → continuity is honored, so NO stream_reset.
    const linesB: string[] = [];
    const diagsB: string[] = [];
    const ctrlB = new AbortController();
    const followB = followEvents({
      vault,
      env,
      role: "ui",
      since: capturedId,
      signal: ctrlB.signal,
      onData: (l) => linesB.push(l),
      onDiagnostic: (l) => diagsB.push(l),
      backoffBaseMs: 100,
      backoffCapMs: 500,
    });
    try {
      await waitFor(
        () => diagsB.some((d) => d.startsWith("following")),
        5000,
        "connect B",
      );
      const c = await connectDaemon(vault, env);
      try {
        await c.rest("POST", "/api/ui/threads", { body: THREAD_BODY });
      } finally {
        await c.close();
      }
      await waitFor(
        () => hasKind(linesB, "thread_changed"),
        5000,
        "thread_changed on the resumed stream",
      );
    } finally {
      ctrlB.abort();
      await followB;
    }
    // The load-bearing assertion: a valid in-epoch resume does not reset.
    expect(hasKind(linesB, "stream_reset")).toBe(false);
  }, 20_000);

  it("throws a no-daemon CliError (exit 3) on the initial connect with no daemon", async () => {
    const { env, vault } = scratch();
    const controller = new AbortController();
    await expect(
      followEvents({
        vault,
        env,
        role: "agent",
        signal: controller.signal,
        onData: () => {},
      }),
    ).rejects.toMatchObject({ code: "no_daemon", exitCode: EXIT.NO_DAEMON });
  });

  it("--exit-on-disconnect stops (does not retry forever) when the daemon shuts down", async () => {
    const { env, vault } = scratch();
    const handle = await startServer({ vault, version: "test", env });
    handles.push(handle);

    const diags: string[] = [];
    const controller = new AbortController(); // deliberately never aborted
    const followed = followEvents({
      vault,
      env,
      role: "ui",
      exitOnDisconnect: true,
      signal: controller.signal,
      onData: () => {},
      onDiagnostic: (l) => diags.push(l),
      backoffBaseMs: 100,
      backoffCapMs: 500,
    });

    await waitFor(
      () => diags.some((d) => d.startsWith("following")),
      5000,
      "connect",
    );
    await handle.close(); // clean shutdown ends the SSE stream

    // The load-bearing behavior: it TERMINATES rather than looping forever. A
    // clean EOF resolves (exit 0); if the socket errored it rejects with the
    // daemon_disconnected code (non-zero) — both are acceptable, a hang is not.
    const outcome = await Promise.race([
      followed.then(
        () => ({ kind: "resolved" as const }),
        (e: unknown) => ({ kind: "rejected" as const, e }),
      ),
      delay(6000).then(() => ({ kind: "timeout" as const })),
    ]);
    expect(outcome.kind).not.toBe("timeout");
    if (outcome.kind === "rejected") {
      expect((outcome.e as { code?: string }).code).toBe("daemon_disconnected");
    }
  }, 15_000);
});

describe("SseFrameParser", () => {
  it("parses CRLF frames, tracks id, and drops comment lines", () => {
    const ids: string[] = [];
    const data: string[] = [];
    const p = new SseFrameParser(
      (id) => ids.push(id),
      (d) => data.push(d),
    );
    // A CRLF stream with a comment primer, an id, and two data frames.
    p.push(": connected\r\n\r\n");
    p.push('id: 7\r\ndata: {"kind":"thread_changed"}\r\n\r\n');
    p.push(': ping\r\n\r\ndata: {"kind":"doc_changed"}\r\n\r\n');
    expect(ids).toEqual(["7"]);
    expect(data).toEqual([
      '{"kind":"thread_changed"}',
      '{"kind":"doc_changed"}',
    ]);
  });

  it("reassembles a CRLF terminator split across chunk boundaries", () => {
    const data: string[] = [];
    const p = new SseFrameParser(
      () => {},
      (d) => data.push(d),
    );
    // The "\r\n\r\n" frame terminator is dribbled one byte at a time.
    p.push('data: {"k":1}');
    for (const c of "\r\n\r\n") p.push(c);
    expect(data).toEqual(['{"k":1}']);
  });
});

describe("ndjsonLine", () => {
  it("compacts valid JSON (including multi-line) to a single line", () => {
    expect(ndjsonLine('{"a":1}')).toBe('{"a":1}');
    expect(ndjsonLine('{\n  "a": 1\n}')).toBe('{"a":1}');
  });

  it("drops empty and unparseable payloads", () => {
    expect(ndjsonLine("")).toBeNull();
    expect(ndjsonLine("   ")).toBeNull();
    expect(ndjsonLine("not json")).toBeNull();
    // Two objects in one payload is not one event → dropped.
    expect(ndjsonLine('{"a":1}\n{"b":2}')).toBeNull();
  });
});

describe("eventsFollowCommand --no-daemon guard", () => {
  it("rejects --no-daemon with exit 3 before any daemon work", async () => {
    const { env, vault } = scratch();
    const io: Io = { out: () => {}, err: () => {}, env, cwd: vault };
    const ctx: RunContext = {
      globals: { vault, format: "text", noDaemon: true, help: false, version: false },
      out: new Output(io, "text"),
      io,
      vault,
      values: {},
      positionals: [],
      argv: [],
    };
    await expect(eventsFollowCommand(ctx)).rejects.toMatchObject({
      code: "no_daemon",
      exitCode: EXIT.NO_DAEMON,
    });
  });
});

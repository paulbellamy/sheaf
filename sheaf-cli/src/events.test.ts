import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { connectDaemon } from "./client";
import type { RunContext } from "./commands";
import { eventsFollowCommand, followEvents } from "./events";
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

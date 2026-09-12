/**
 * `sheaf daemon status` and `sheaf daemon stop`.
 *
 * Both are thin clients: they read the discovery record and (for `status`) hit
 * `/api/health` via `isDaemonAlive`. `stop` SIGTERMs the recorded pid and waits
 * briefly for the daemon's own cleanup to remove the discovery file — the
 * proof it actually went down. Neither needs the full step-3 client core.
 */
import { existsSync } from "node:fs";

import {
  daemonFile,
  isDaemonAlive,
  readDaemon,
} from "sheaf-server/daemon";

import type { RunContext } from "./commands";
import { loadConfig } from "./config";
import { EXIT, type ExitCode } from "./io";
import { resolveVault } from "./vault";

/** Resolve the target vault the same way every command does. */
function targetVault(ctx: RunContext): string {
  const config = loadConfig(ctx.io.env);
  return resolveVault({
    flag: ctx.globals.vault,
    env: ctx.io.env,
    config,
    cwd: ctx.io.cwd,
  });
}

/** Sleep `ms` without blocking the event loop. */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** `sheaf daemon status`: report running/stopped plus the daemon's address. */
export async function daemonStatusCommand(ctx: RunContext): Promise<ExitCode> {
  const { out, io } = ctx;
  const vault = targetVault(ctx);
  const info = readDaemon(vault, io.env);
  const running = info ? await isDaemonAlive(vault, io.env) : false;

  if (out.format === "json") {
    out.json({
      running,
      vault,
      ...(info
        ? {
            host: info.host,
            port: info.port,
            pid: info.pid,
            startedAt: info.startedAt,
            version: info.version,
          }
        : {}),
    });
    return EXIT.OK;
  }

  if (running && info) {
    out.text(`running — ${info.host}:${info.port} (pid ${info.pid})`);
    out.text(`vault: ${vault}`);
  } else if (info) {
    // A record survives but health failed: a crashed daemon left it behind.
    out.text(`stopped — stale discovery record for ${vault}`);
  } else {
    out.text(`stopped — no daemon for ${vault}`);
  }
  return EXIT.OK;
}

/**
 * `sheaf daemon stop`: SIGTERM the recorded pid and wait for the discovery file
 * to disappear (the daemon removes it on clean shutdown). Reports stopped when
 * it does; says so and exits 0 when nothing was running.
 */
export async function daemonStopCommand(ctx: RunContext): Promise<ExitCode> {
  const { out, io } = ctx;
  const vault = targetVault(ctx);
  const info = readDaemon(vault, io.env);
  const running = info ? await isDaemonAlive(vault, io.env) : false;

  if (!info || !running) {
    if (out.format === "json") {
      out.json({ stopped: false, running: false, vault });
    } else {
      out.text(`no running daemon for ${vault}`);
    }
    return EXIT.OK;
  }

  try {
    process.kill(info.pid, "SIGTERM");
  } catch (e) {
    // ESRCH: the pid died between the liveness check and the signal — that is
    // exactly the outcome we wanted, so treat it as stopped.
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
  }

  // Poll for the discovery file to vanish — the daemon removes it on shutdown.
  const file = daemonFile(vault, io.env);
  const deadline = Date.now() + 5000;
  while (existsSync(file) && Date.now() < deadline) {
    await delay(50);
  }
  const stopped = !existsSync(file);

  if (out.format === "json") {
    out.json({ stopped, running: !stopped, vault, pid: info.pid });
  } else if (stopped) {
    out.text(`daemon stopped (pid ${info.pid})`);
  } else {
    out.diagnostic(
      `sent SIGTERM to pid ${info.pid}, but the daemon is still running after 5s`,
    );
  }
  return stopped ? EXIT.OK : EXIT.GENERIC;
}

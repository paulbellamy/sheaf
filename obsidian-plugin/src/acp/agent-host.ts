import { spawn } from "node:child_process";

import { AcpConnection, type AcpCallbacks, type AcpConnectionOptions } from "./connection";
import { DocStore } from "./doc-store";
import { JsonRpcPeer } from "./jsonrpc";
import type { AcpAgentSpec } from "./registry";
import { resolveCommand, spawnEnv } from "./spawn-env";

/**
 * Spawn an ACP adapter subprocess and bring up an {@link AcpConnection} over its
 * stdio. ACP frames messages as newline-delimited JSON, so we write each
 * outgoing message to the child's stdin and split its stdout on "\n". The
 * desktop-only plugin runs in Electron's Node renderer, so child_process is
 * available; node builtins stay external in the bundle.
 *
 * Runtime glue — exercised only inside Obsidian, so it's typecheck-covered, not
 * unit-tested (the protocol/connection logic it wires is tested separately).
 */

export interface SpawnedAgent {
  connection: AcpConnection;
  /** Kill the subprocess and reject any in-flight calls. Idempotent. */
  dispose(): void;
}

export interface SpawnAgentOptions extends AcpConnectionOptions {
  /** Called when the subprocess exits (so the plugin can update presence). */
  onExit?: (code: number | null) => void;
}

export function spawnAcpAgent(
  spec: AcpAgentSpec,
  docs: DocStore,
  callbacks: AcpCallbacks,
  opts: SpawnAgentOptions,
): SpawnedAgent {
  // Resolve the command on a recovered PATH (Electron's inherited PATH is
  // minimal, so a bare `npx` would ENOENT). On Windows a resolved `.cmd` must be
  // run via the shell (Node refuses to spawn .cmd/.bat directly).
  const command = resolveCommand(spec.command);
  const child = spawn(command, spec.args, {
    cwd: opts.cwd,
    env: spawnEnv(spec.env),
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  const peer = new JsonRpcPeer((line) => {
    // Best-effort: drop writes once the pipe is gone (the child died), and let
    // the 'error' listener below catch any async EPIPE so it can't crash the
    // renderer.
    if (child.stdin.writable) child.stdin.write(line);
  });

  child.stdin.on("error", (err) => {
    console.error(`[acp:${spec.id}] stdin error`, err);
    peer.close(`agent ${spec.id} stdin error: ${String(err)}`);
  });

  // Split stdout into newline-delimited JSON messages.
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      peer.receive(line);
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    console.error(`[acp:${spec.id}] ${chunk.trimEnd()}`);
  });

  child.on("exit", (code) => {
    peer.close(`agent ${spec.id} exited (code ${code ?? "null"})`);
    opts.onExit?.(code);
  });
  child.on("error", (err) => {
    console.error(`[acp:${spec.id}] spawn error`, err);
    peer.close(`agent ${spec.id} failed to spawn: ${String(err)}`);
  });

  const connection = new AcpConnection(peer, docs, callbacks, opts);

  return {
    connection,
    dispose() {
      peer.close("disposed");
      child.kill();
    },
  };
}

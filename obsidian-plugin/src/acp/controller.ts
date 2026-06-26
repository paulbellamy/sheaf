import { App } from "obsidian";

import { DocStore } from "./doc-store";
import { spawnAcpAgent, type SpawnedAgent } from "./agent-host";
import { getAcpAgent, type AcpEffort } from "./registry";
import { makeToVaultPath, obsidianVaultFs } from "./vault-fs";
import { requestAcpPermission } from "../views/acp-permission-modal";
import {
  textBlock,
  type McpServerConfig,
  type SessionNotification,
} from "./protocol";

/**
 * Orchestrates the plugin's ACP client: spawns the chosen adapter, brings up the
 * connection, and feeds each posted thread to the agent as a prompt on that
 * doc's session. The agent gets sheaf's thread tools via the embedded MCP server
 * (scoped per doc through `?doc=`) handed over `session/new`, and edits the doc
 * through the client-write path (fs/write → ydoc). Permission requests surface
 * as a modal; session updates surface as status.
 *
 * Runtime glue — typecheck-covered; the pieces it composes are unit-tested.
 */
export interface AcpControllerDeps {
  app: App;
  onStatus(text: string): void;
  /** Fired on every connect/disconnect/exit so the UI can reflect ACP presence. */
  onConnectionChange?(connected: boolean): void;
}

export class AcpController {
  private agent: SpawnedAgent | null = null;
  // Bumped on every connect/disconnect so a *previous* agent's late exit can't
  // clear the live one (a killed child's "exit" fires after the new one is up).
  private generation = 0;

  constructor(private readonly deps: AcpControllerDeps) {}

  get connected(): boolean {
    return this.agent !== null;
  }

  /** Spawn `agentId` rooted at `vaultRoot`, scoping the sheaf MCP at `serverUrl`. */
  async connect(
    agentId: string,
    vaultRoot: string,
    serverUrl: string,
    effort: AcpEffort = "default",
  ): Promise<void> {
    const spec = getAcpAgent(agentId);
    if (!spec) throw new Error(`unknown ACP agent: ${agentId}`);
    this.disconnect();
    const myGen = this.generation;
    const effortEnv = spec.effortEnv?.(effort) ?? {};

    const docs = new DocStore(obsidianVaultFs(this.deps.app.vault.adapter));
    const base = serverUrl.replace(/\/$/, "");

    this.agent = spawnAcpAgent(
      spec,
      docs,
      {
        onPermission: (req) => requestAcpPermission(this.deps.app, req),
        onUpdate: (n) => this.deps.onStatus(summarizeUpdate(n)),
      },
      {
        cwd: vaultRoot,
        toVaultPath: makeToVaultPath(vaultRoot),
        mcpServersFor: (docPath): McpServerConfig[] => [
          {
            type: "http",
            name: "sheaf",
            url: `${base}/api/mcp?doc=${encodeURIComponent(docPath)}`,
            // `headers` is required by the ACP schema (array of {name,value}).
            // Also carry the doc scope as a header so it survives any client
            // that strips the query string.
            headers: [{ name: "X-Sheaf-Doc", value: docPath }],
          },
        ],
        env: effortEnv,
        onExit: (code) => {
          if (this.generation !== myGen) return; // a superseded agent — ignore
          this.agent = null;
          this.deps.onStatus(`ACP agent exited (${code ?? "?"})`);
          this.deps.onConnectionChange?.(false);
        },
      },
    );

    try {
      await this.agent.connection.initialize();
    } catch (e) {
      // Spawn/initialize failed (e.g. the adapter isn't installed → ENOENT).
      // Tear down so `connected` doesn't lie, and surface the install hint.
      this.disconnect();
      const detail = e instanceof Error ? e.message : String(e);
      throw new Error(
        `${spec.displayName} didn't start (${detail}). Install it with: ${spec.installHint}`,
      );
    }
    this.deps.onStatus(`ACP agent connected (${spec.displayName})`);
    this.deps.onConnectionChange?.(true);
  }

  /** Kill the subprocess and drop the connection. Idempotent. */
  disconnect(): void {
    const wasConnected = this.agent !== null;
    this.agent?.dispose();
    this.agent = null;
    this.generation++; // invalidate the old agent's pending exit handler
    if (wasConnected) this.deps.onConnectionChange?.(false);
  }

  /**
   * Nudge the agent to handle a freshly posted thread on `docPath`. The agent
   * reads/acts via the scoped sheaf MCP; we just point it at the new work. No-op
   * when no agent is connected (the manual-MCP flow still works on its own).
   */
  async promptForThread(docPath: string, brief: string): Promise<void> {
    const agent = this.agent;
    if (!agent) return;
    try {
      await agent.connection.prompt(docPath, [
        textBlock(
          `A new sheaf comment thread was posted on "${docPath}":\n\n${brief}\n\n` +
            "Use the sheaf MCP tools to read the open thread(s) on this doc and " +
            "act on each per the sheaf operating guide — edit the doc with your " +
            "file tools, then resolve.",
        ),
      ]);
    } catch (e) {
      // Don't let a prompt/session-creation failure vanish (callers fire this
      // with `void`); surface it on the status channel.
      const detail = e instanceof Error ? e.message : String(e);
      console.error("sheaf: ACP prompt failed", e);
      this.deps.onStatus(`ACP prompt failed: ${detail}`);
    }
  }
}

function summarizeUpdate(n: SessionNotification): string {
  const u = n.update;
  switch (u.sessionUpdate) {
    case "tool_call":
      return `agent: ${u.title ?? "running a tool"}`;
    case "plan":
      return `agent plan: ${u.entries.length} step${u.entries.length === 1 ? "" : "s"}`;
    case "current_mode_update":
      return `agent mode: ${u.currentModeId}`;
    default:
      return "agent working…";
  }
}

import { App } from "obsidian";

import { DocStore } from "./doc-store";
import { spawnAcpAgent, type SpawnedAgent } from "./agent-host";
import { getAcpAgent } from "./registry";
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
}

export class AcpController {
  private agent: SpawnedAgent | null = null;

  constructor(private readonly deps: AcpControllerDeps) {}

  get connected(): boolean {
    return this.agent !== null;
  }

  /** Spawn `agentId` rooted at `vaultRoot`, scoping the sheaf MCP at `serverUrl`. */
  async connect(
    agentId: string,
    vaultRoot: string,
    serverUrl: string,
  ): Promise<void> {
    const spec = getAcpAgent(agentId);
    if (!spec) throw new Error(`unknown ACP agent: ${agentId}`);
    this.disconnect();

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
          },
        ],
        onExit: (code) => {
          this.agent = null;
          this.deps.onStatus(`ACP agent exited (${code ?? "?"})`);
        },
      },
    );

    await this.agent.connection.initialize();
    this.deps.onStatus(`ACP agent connected (${spec.displayName})`);
  }

  /** Kill the subprocess and drop the connection. Idempotent. */
  disconnect(): void {
    this.agent?.dispose();
    this.agent = null;
  }

  /**
   * Nudge the agent to handle a freshly posted thread on `docPath`. The agent
   * reads/acts via the scoped sheaf MCP; we just point it at the new work. No-op
   * when no agent is connected (the manual-MCP flow still works on its own).
   */
  async promptForThread(docPath: string, brief: string): Promise<void> {
    const agent = this.agent;
    if (!agent) return;
    await agent.connection.prompt(docPath, [
      textBlock(
        `A new sheaf comment thread was posted on "${docPath}":\n\n${brief}\n\n` +
          "Use the sheaf MCP tools to read the open thread(s) on this doc and act " +
          "on each per the sheaf operating guide — edit the doc with your file " +
          "tools, then resolve.",
      ),
    ]);
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

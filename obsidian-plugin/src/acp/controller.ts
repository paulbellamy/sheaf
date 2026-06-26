import { App, Notice } from "obsidian";

import { ActivityStore } from "./activity-store";
import { DocStore } from "./doc-store";
import { spawnAcpAgent, type SpawnedAgent } from "./agent-host";
import { DEFAULT_ACP_EFFORT, getAcpAgent, type AcpEffort } from "./registry";
import { makeToVaultPath, obsidianVaultFs } from "./vault-fs";
import { requestAcpPermission } from "../views/acp-permission-modal";
import {
  textBlock,
  type ContentBlock,
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
  /** Per-doc activity the harness UI renders. Persists across connects. */
  readonly activity = new ActivityStore();

  constructor(private readonly deps: AcpControllerDeps) {}

  get connected(): boolean {
    return this.agent !== null;
  }

  /** Spawn `agentId` rooted at `vaultRoot`, scoping the sheaf MCP at `serverUrl`. */
  async connect(
    agentId: string,
    vaultRoot: string,
    serverUrl: string,
    effort: AcpEffort = DEFAULT_ACP_EFFORT,
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
        onPermission: async (req, docPath) => {
          const permId = docPath
            ? this.activity.recordPermission(
                docPath,
                req.toolCall.title ?? "Permission requested",
                req.options,
              )
            : -1;
          const result = await requestAcpPermission(this.deps.app, req);
          if (docPath) {
            const outcome =
              result.outcome.outcome === "selected"
                ? result.outcome.optionId
                : "cancelled";
            this.activity.resolvePermission(docPath, permId, outcome);
          }
          return result;
        },
        onUpdate: (n, docPath) => {
          if (docPath) this.activity.ingest(docPath, n.update);
          this.deps.onStatus(summarizeUpdate(n));
          const u = n.update;
          if (u.sessionUpdate === "tool_call_update" && u.status === "failed") {
            new Notice(
              `Sheaf: agent tool failed${u.title ? ` — ${u.title}` : ""}`,
              6000,
            );
          }
        },
        onFileOp: (op, path, docPath) => {
          if (docPath) this.activity.fileOp(docPath, op, path);
        },
        onSessionModes: (docPath, current, available) =>
          this.activity.setAvailableModes(docPath, available, current),
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
          this.activity.agentExited(`agent exited (code ${code ?? "?"})`);
          this.deps.onStatus(`ACP agent exited (${code ?? "?"})`);
          new Notice(`Sheaf: ACP agent exited (code ${code ?? "?"})`, 8000);
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
    await this.runPrompt(docPath, [
      textBlock(
        `A new sheaf comment thread was posted on "${docPath}":\n\n${brief}\n\n` +
          "Use the sheaf MCP tools to read the open thread(s) on this doc and " +
          "act on each per the sheaf operating guide — edit the doc with your " +
          "file tools, then resolve.",
      ),
    ]);
  }

  /** Send a free-form follow-up into the doc's live session (user interjection). */
  async interject(docPath: string, text: string): Promise<void> {
    await this.runPrompt(docPath, [textBlock(text)]);
  }

  /** Cancel the in-flight turn for a doc (best-effort; resolves as cancelled). */
  cancel(docPath: string): void {
    void this.agent?.connection.cancel(docPath);
  }

  /** Switch the agent's mode for a doc (e.g. edit ↔ review). */
  setMode(docPath: string, modeId: string): void {
    void this.agent?.connection.setMode(docPath, modeId).then(
      () => this.activity.setMode(docPath, modeId),
      (e) => this.deps.onStatus(`set mode failed: ${String(e)}`),
    );
  }

  /** Run a prompt turn on a doc's session, tracking it in the activity store. */
  private async runPrompt(docPath: string, blocks: ContentBlock[]): Promise<void> {
    const agent = this.agent;
    if (!agent) return;
    this.activity.turnStarted(docPath);
    try {
      const res = await agent.connection.prompt(docPath, blocks);
      this.activity.turnEnded(docPath, res.stopReason);
      if (res.stopReason !== "end_turn") {
        new Notice(`Sheaf: agent stopped — ${res.stopReason}`, 6000);
      }
    } catch (e) {
      // Don't let a prompt/session-creation failure vanish (callers fire this
      // with `void`); surface it. (A crash also marks the doc dead via onExit,
      // which wins over this abort in the snapshot.)
      this.activity.turnAborted(docPath);
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

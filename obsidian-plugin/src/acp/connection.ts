import { JsonRpcPeer } from "./jsonrpc";
import {
  ACP_METHOD,
  ACP_PROTOCOL_VERSION,
  type ContentBlock,
  type InitializeParams,
  type InitializeResult,
  type McpServerConfig,
  type NewSessionParams,
  type NewSessionResult,
  type PromptParams,
  type PromptResult,
  type ReadTextFileParams,
  type ReadTextFileResult,
  type RequestPermissionParams,
  type RequestPermissionResult,
  type SessionNotification,
  type WriteTextFileParams,
} from "./protocol";
import { DocStore } from "./doc-store";
import { SessionManager } from "./session-manager";

/**
 * The ACP client: drives the agent (initialize / session.new / prompt) and
 * serves the agent's calls back (fs/read, fs/write, request_permission) +
 * streams session/update. It owns the per-doc session map and routes the
 * agent's fs writes through the DocStore (the client-write path).
 *
 * Collaborators are injected (peer, doc store, callbacks, path mapper) so the
 * integration is unit-tested against a fake agent peer with no subprocess. The
 * subprocess spawn + Obsidian wiring live in the glue, which constructs the
 * peer over the child process's stdio and passes it here.
 */

export interface AcpCallbacks {
  /** Resolve a permission request to a chosen option (or cancel). */
  onPermission(
    req: RequestPermissionParams,
    docPath: string | undefined,
  ): Promise<RequestPermissionResult>;
  /** A streamed session update (message/thought chunk, plan, tool call). */
  onUpdate(notif: SessionNotification, docPath: string | undefined): void;
}

export interface AcpConnectionOptions {
  /** Working directory for sessions (the vault root, absolute). */
  cwd: string;
  /** Build the per-session MCP server list for a doc (sheaf MCP scoped via ?doc=). */
  mcpServersFor(docPath: string): McpServerConfig[];
  /**
   * Map an absolute ACP path (the protocol mandates absolute paths) to a
   * vault-relative sheaf path, or null if it falls outside the vault.
   */
  toVaultPath(absPath: string): string | null;
}

export class AcpConnection {
  readonly sessions: SessionManager;

  constructor(
    private readonly peer: JsonRpcPeer,
    private readonly docs: DocStore,
    private readonly cb: AcpCallbacks,
    private readonly opts: AcpConnectionOptions,
  ) {
    this.sessions = new SessionManager((docPath) => this.createSession(docPath));

    peer.onRequest(ACP_METHOD.readTextFile, (p) =>
      this.onReadTextFile(p as ReadTextFileParams),
    );
    peer.onRequest(ACP_METHOD.writeTextFile, (p) =>
      this.onWriteTextFile(p as WriteTextFileParams),
    );
    peer.onRequest(ACP_METHOD.requestPermission, (p) =>
      this.onRequestPermission(p as RequestPermissionParams),
    );
    peer.onNotification(ACP_METHOD.sessionUpdate, (p) =>
      this.onSessionUpdate(p as SessionNotification),
    );
  }

  /** Handshake: negotiate version and advertise our fs capability. */
  async initialize(): Promise<InitializeResult> {
    const params: InitializeParams = {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
    };
    return this.peer.request<InitializeResult>(ACP_METHOD.initialize, params);
  }

  /** Send a prompt on the doc's session, creating the session on first use. */
  async prompt(docPath: string, blocks: ContentBlock[]): Promise<PromptResult> {
    const sessionId = await this.sessions.sessionFor(docPath);
    const params: PromptParams = { sessionId, prompt: blocks };
    return this.peer.request<PromptResult>(ACP_METHOD.prompt, params);
  }

  /** Cancel the in-flight turn for a doc, if it has a session. */
  async cancel(docPath: string): Promise<void> {
    if (!this.sessions.has(docPath)) return;
    const sessionId = await this.sessions.sessionFor(docPath);
    this.peer.notify(ACP_METHOD.cancel, { sessionId });
  }

  private async createSession(docPath: string): Promise<string> {
    const params: NewSessionParams = {
      cwd: this.opts.cwd,
      mcpServers: this.opts.mcpServersFor(docPath),
    };
    const res = await this.peer.request<NewSessionResult>(
      ACP_METHOD.newSession,
      params,
    );
    return res.sessionId;
  }

  /* ----------------------------------------------- agent → client ---- */

  private async onReadTextFile(
    p: ReadTextFileParams,
  ): Promise<ReadTextFileResult> {
    const rel = this.requireVaultPath(p.path);
    return { content: await this.docs.read(rel) };
  }

  private async onWriteTextFile(p: WriteTextFileParams): Promise<null> {
    const rel = this.requireVaultPath(p.path);
    await this.docs.write(rel, p.content);
    return null;
  }

  private onRequestPermission(
    p: RequestPermissionParams,
  ): Promise<RequestPermissionResult> {
    return this.cb.onPermission(p, this.sessions.docForSession(p.sessionId));
  }

  private onSessionUpdate(n: SessionNotification): void {
    this.cb.onUpdate(n, this.sessions.docForSession(n.sessionId));
  }

  private requireVaultPath(absPath: string): string {
    const rel = this.opts.toVaultPath(absPath);
    if (rel === null) {
      throw new Error(`path is outside the vault: ${absPath}`);
    }
    return rel;
  }
}

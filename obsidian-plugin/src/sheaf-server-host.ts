import { buildSheafApp } from "sheaf-server/app";
import { StubBackend } from "sheaf-server";

type App = ReturnType<typeof buildSheafApp>;

/**
 * Runs the sheaf backend + MCP + UI API inside the Obsidian plugin process.
 *
 * The plugin is desktop-only, so it runs in Electron's Node-enabled renderer
 * where a Fastify server can bind a localhost socket. The agent (a separate
 * `claude` process) connects to it over HTTP exactly as it would to a
 * standalone server — so there's still a listening port, but the user no
 * longer runs a second process or wires up `SHEAF_DATA_ROOT`: the vault root
 * is the data root, passed straight to the backend.
 */
export class SheafServerHost {
  private app: App | null = null;
  private startedAt: { root: string; port: number } | null = null;

  get running(): boolean {
    return this.app !== null;
  }

  /** Where the server is currently listening, or null if stopped. */
  get current(): { root: string; port: number } | null {
    return this.startedAt;
  }

  /**
   * Start (or restart) the embedded server on `127.0.0.1:<port>`, serving the
   * vault at `root`. Throws if the port can't be bound (e.g. already in use);
   * callers surface that to the user.
   */
  async start(
    root: string,
    port: number,
    allowedOrigins?: string[],
  ): Promise<void> {
    await this.stop();
    // pluginRoot = root (not the default parent dir) so the backend's
    // read-only `.claude-plugin/` serving can never reach above the vault.
    const backend = new StubBackend(root, root);
    // thread-only: the plugin runs in thread-on-doc mode and never drives the
    // draft workflow, so the embedded server omits the draft tools (Fork /
    // Propose / Merge / DeclineDraft / DraftChanges).
    const app = buildSheafApp(backend, {
      tools: "thread-only",
      ...(allowedOrigins ? { allowedOrigins } : {}),
    });
    await app.listen({ port, host: "127.0.0.1" });
    this.app = app;
    this.startedAt = { root, port };
  }

  async stop(): Promise<void> {
    if (!this.app) return;
    const app = this.app;
    this.app = null;
    this.startedAt = null;
    try {
      await app.close();
    } catch {
      // already closing / never fully started — nothing to do
    }
  }
}

import {
  Editor,
  FileSystemAdapter,
  MarkdownView,
  Notice,
  Plugin,
  TAbstractFile,
  TFile,
  TFolder,
} from "obsidian";

import { SheafApiError, SheafClient } from "./sheaf-client";
import { SheafEventStream, type BackendEvent } from "./sheaf-events";
import { SheafServerHost } from "./sheaf-server-host";
import {
  DEFAULT_SETTINGS,
  type SheafSettings,
  SheafSettingTab,
} from "./settings";
import { CommentModal } from "./views/comment-modal";
import { ReviewModal } from "./views/review-modal";
import { ThreadsView, VIEW_TYPE_SHEAF_THREADS } from "./views/threads-view";
import { buildPanelRequestMessage } from "./review";
import { flashField, mountFlashStyles } from "./editor/flash";
import { AcpController } from "./acp/controller";

export default class SheafPlugin extends Plugin {
  settings: SheafSettings = DEFAULT_SETTINGS;
  client!: SheafClient;
  agentConnected = false;
  private events!: SheafEventStream;
  private statusBar: HTMLElement | null = null;
  private host = new SheafServerHost();
  private acp!: AcpController;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.client = new SheafClient(this.settings.serverUrl);
    this.events = new SheafEventStream(
      this.settings.serverUrl,
      (e) => this.dispatchEvent(e),
    );
    this.acp = new AcpController({
      app: this.app,
      onStatus: (t) => this.flashStatus(t),
    });

    this.registerView(
      VIEW_TYPE_SHEAF_THREADS,
      (leaf) => new ThreadsView(leaf, this),
    );

    // Backs the transient highlight when a thread card is clicked (flash.ts).
    // updateOptions() flushes the field into any editor already open when the
    // plugin loads — registerEditorExtension alone only reaches editors opened
    // afterward. mountFlashStyles injects the CSS (no separate styles.css).
    this.registerEditorExtension(flashField);
    this.app.workspace.updateOptions();
    this.register(mountFlashStyles());

    this.addRibbonIcon("message-square", "Sheaf threads", () => {
      void this.activateThreadsView();
    });

    this.addCommand({
      id: "sheaf-open-threads-panel",
      name: "Open threads panel",
      callback: () => void this.activateThreadsView(),
    });

    this.addCommand({
      id: "sheaf-comment-for-agent",
      name: "Comment for agent",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "M" }],
      editorCallback: (editor, view) => {
        if (view instanceof MarkdownView) {
          this.openCommentModal(editor, view);
        }
      },
    });

    this.addCommand({
      id: "sheaf-request-review",
      name: "Request panel review",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) return false;
        if (!checking) {
          this.openReviewModalForPath(this.vaultPathToSheafPath(view.file.path));
        }
        return true;
      },
    });

    this.addCommand({
      id: "sheaf-acp-connect",
      name: "Connect ACP agent",
      callback: () => void this.connectAcpAgent(),
    });

    this.addCommand({
      id: "sheaf-acp-disconnect",
      name: "Disconnect ACP agent",
      callback: () => {
        this.acp.disconnect();
        new Notice("Sheaf: ACP agent disconnected");
      },
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        if (!(view instanceof MarkdownView)) return;
        const hasSelection = editor.getSelection().length > 0;
        menu.addItem((item) => {
          item
            .setTitle(
              hasSelection
                ? "Sheaf: Comment for agent"
                : "Sheaf: Comment on doc",
            )
            .setIcon("message-square")
            .onClick(() => this.openCommentModal(editor, view));
        });
        menu.addItem((item) => {
          item
            .setTitle("Sheaf: Request panel review")
            .setIcon("users")
            .onClick(() => {
              if (view.file) {
                this.openReviewModalForPath(
                  this.vaultPathToSheafPath(view.file.path),
                );
              }
            });
        });
      }),
    );

    // A vault rename moves the `.md` but leaves sheaf's sidecars (threads,
    // version history, drafts) pinned to the old path. Reconcile them on the
    // server — which also wakes the connected agent — and follow the rename in
    // the open threads panel so it doesn't go blank on the now-stale path.
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        void this.onFileRenamed(file, oldPath);
      }),
    );

    this.statusBar = this.addStatusBarItem();
    this.updateStatusBar();

    this.addSettingTab(new SheafSettingTab(this.app, this));

    // Start the embedded server (if enabled) before opening the event stream
    // so the first SSE connect lands on a live server.
    await this.startServerIfEnabled();

    this.events.start();

    // First-time enable / fresh install: the layout restore won't have a
    // sheaf-threads leaf, so we add one to the right sidebar. If the user
    // closes it and reopens the app, Obsidian's layout restore takes over
    // (leaf is gone, plugin recreates it — mildly opinionated, prototype).
    this.app.workspace.onLayoutReady(() => {
      void this.ensureThreadsViewMounted();
    });
  }

  async onunload(): Promise<void> {
    this.events?.stop();
    this.acp?.disconnect();
    await this.host.stop();
  }

  /**
   * Spawn the configured ACP agent as a subprocess and bring up the connection.
   * Replaces the manual `claude mcp add` + terminal flow: the plugin hands the
   * agent the sheaf MCP (scoped per doc) over session/new, services its file
   * I/O through the ydoc, and gates writes via a permission modal.
   */
  private async connectAcpAgent(): Promise<void> {
    const root = this.vaultRoot();
    if (!root) {
      new Notice("Sheaf: ACP needs a local-filesystem vault.");
      return;
    }
    try {
      new Notice("Sheaf: starting ACP agent…");
      await this.acp.connect(
        this.settings.acpAgentId,
        root,
        this.settings.serverUrl,
      );
      new Notice("Sheaf: ACP agent connected.");
    } catch (err) {
      console.error("sheaf: ACP connect failed", err);
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Sheaf: ACP connect failed — ${msg}`, 8000);
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData(),
    );
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async onConnectionChanged(): Promise<void> {
    // Re-point (or stop) the embedded server first, then the client/stream.
    await this.startServerIfEnabled();
    this.client.setBaseUrl(this.settings.serverUrl);
    this.events.setBaseUrl(this.settings.serverUrl);
    this.updateStatusBar();
  }

  /** Absolute path of the vault on disk, or null on a non-filesystem vault. */
  vaultRoot(): string | null {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
  }

  /** Port the embedded server binds — parsed from the configured server URL. */
  serverPort(): number {
    try {
      const p = new URL(this.settings.serverUrl).port;
      return p ? Number(p) : 31415;
    } catch {
      return 31415;
    }
  }

  /**
   * Start (or stop) the in-Obsidian server to match the `runServer` setting.
   * Best-effort: a bind failure (port in use, etc.) surfaces a notice but
   * doesn't block the plugin — the user may be pointing at an external server.
   */
  private async startServerIfEnabled(): Promise<void> {
    if (!this.settings.runServer) {
      await this.host.stop();
      return;
    }
    const root = this.vaultRoot();
    if (!root) {
      new Notice(
        "Sheaf: can't run the embedded server on this vault (no local filesystem).",
        8000,
      );
      return;
    }
    const port = this.serverPort();
    // Allow the plugin's own renderer origin to read the SSE stream
    // cross-origin (its `fetch` carries exactly this Origin); every other
    // origin is refused, so a web page can't read vault contents.
    const origins = window.location?.origin
      ? [window.location.origin]
      : undefined;
    try {
      await this.host.start(root, port, origins);
    } catch (err) {
      console.error("sheaf: embedded server failed to start", err);
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(
        `Sheaf: embedded server couldn't start on port ${port} — ${msg}`,
        8000,
      );
    }
  }

  /** Re-render the threads panel from current settings. */
  refreshThreadsView(): void {
    this.getThreadsView()?.rerender();
  }

  /**
   * Obsidian vault path → sheaf path. The plugin assumes the vault root is
   * the sheaf data root, so `file.path` (vault-relative) is already the sheaf
   * path. Any markdown doc in the vault is supported — sheaf rejects only
   * dot-prefixed paths (its own infra), which Obsidian doesn't surface anyway.
   */
  vaultPathToSheafPath(vaultPath: string): string {
    return vaultPath;
  }

  /**
   * Handle a vault rename. Markdown files carry thread state directly; folders
   * carry it for every doc under them (Obsidian fires one event for the folder,
   * not per descendant), so both are forwarded as a single `from → to` the
   * server expands. Non-markdown files have no sheaf state and are skipped.
   * Pushes the change to the server (best effort — it may be down or external)
   * and tells the threads panel to re-anchor if it was showing an affected doc.
   */
  private async onFileRenamed(
    file: TAbstractFile,
    oldPath: string,
  ): Promise<void> {
    const isFolder = file instanceof TFolder;
    const isMarkdown = file instanceof TFile && file.extension === "md";
    if (!isFolder && !isMarkdown) return;
    const from = this.vaultPathToSheafPath(oldPath);
    const to = this.vaultPathToSheafPath(file.path);
    if (from === to) return;
    try {
      await this.client.renameDoc(from, to);
      // Re-anchor the panel only once the server has actually moved the
      // threads — otherwise refetching the new path returns nothing and the
      // panel goes blank. On failure leave it on the old path (whose threads
      // are still intact server-side); a later file switch recovers.
      this.getThreadsView()?.onDocRenamed(from, to);
    } catch (err) {
      console.warn("sheaf: could not sync rename to server", err);
    }
  }

  private async activateThreadsView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_SHEAF_THREADS);
    if (existing.length > 0) {
      workspace.revealLeaf(existing[0]);
      return;
    }
    const right = workspace.getRightLeaf(false);
    if (!right) return;
    await right.setViewState({
      type: VIEW_TYPE_SHEAF_THREADS,
      active: true,
    });
    workspace.revealLeaf(right);
  }

  /**
   * Auto-mount on plugin load: add a sheaf-threads leaf to the right sidebar
   * if there isn't one already. Doesn't steal focus from the user's current
   * leaf — `active: false` keeps whatever they were looking at in front.
   */
  private async ensureThreadsViewMounted(): Promise<void> {
    const { workspace } = this.app;
    if (workspace.getLeavesOfType(VIEW_TYPE_SHEAF_THREADS).length > 0) return;
    const right = workspace.getRightLeaf(false);
    if (!right) return;
    await right.setViewState({
      type: VIEW_TYPE_SHEAF_THREADS,
      active: false,
    });
  }

  private openCommentModal(editor: Editor, view: MarkdownView): void {
    const file = view.file;
    if (!file) {
      new Notice("Open a markdown file first");
      return;
    }
    const docPath = this.vaultPathToSheafPath(file.path);
    const selection = editor.getSelection();
    // No selection → doc-level comment. With a selection → anchored range.
    const charRange = selection.length > 0 ? this.computeCharRange(editor) : null;
    this.composeComment(docPath, charRange, selection);
  }

  /**
   * "New thread" from the threads panel. The panel isn't an editor, so we look
   * up the open editor for `docPath` and anchor to its live selection if there
   * is one; otherwise it's a doc-level comment.
   */
  commentFromPanel(docPath: string): void {
    const editor = this.editorForPath(docPath);
    const selection = editor ? editor.getSelection() : "";
    const charRange =
      editor && selection.length > 0 ? this.computeCharRange(editor) : null;
    this.composeComment(docPath, charRange, selection);
  }

  /**
   * Open the comment composer and post the result as a thread on `docPath`.
   * Shared by the editor-menu path and the panel "New thread" button.
   */
  private composeComment(
    docPath: string,
    charRange: { from: number; to: number } | null,
    selection: string,
  ): void {
    new CommentModal(this.app, selection, async (message) => {
      try {
        await this.client.addThread(docPath, charRange, message);
      } catch (err) {
        console.error("sheaf: addThread failed", err);
        const msg =
          err instanceof SheafApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        // Re-throw so the modal keeps the typed comment and shows the error
        // inline instead of closing and discarding it.
        throw new Error(msg);
      }
      new Notice(
        charRange === null
          ? "Doc-level comment posted; agent will pick it up"
          : "Comment posted; agent will pick it up",
      );
      // If an ACP agent is connected, point it at the new thread directly
      // (no-op otherwise — the manual-MCP watch flow still applies).
      void this.acp.promptForThread(docPath, message);
    }).open();
  }

  /**
   * Ask the connected agent to run a panel review of `docPath`. Posts a single
   * doc-level request thread carrying the selected roles; the agent channels
   * each and posts anchored `review:<id>` comments back for triage. No
   * selection needed — the panel reads the whole doc.
   */
  openReviewModalForPath(docPath: string): void {
    if (!this.agentConnected && !this.acp.connected) {
      new Notice(
        "No agent connected — run “Sheaf: Connect ACP agent” or start a Claude Code session first",
      );
      return;
    }

    new ReviewModal(this.app, this.settings.personas, async (selected) => {
      const message = buildPanelRequestMessage(selected);
      try {
        await this.client.addThread(docPath, null, message);
      } catch (err) {
        const msg =
          err instanceof SheafApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        throw new Error(msg);
      }
      new Notice(
        `Panel review requested (${selected.length} role${selected.length === 1 ? "" : "s"}); comments will appear as the agent posts them`,
      );
      void this.acp.promptForThread(docPath, message);
    }).open();
  }

  /** The editor of an open markdown view whose file maps to `docPath`, if any. */
  private editorForPath(docPath: string): Editor | null {
    let found: Editor | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      const v = leaf.view;
      if (
        v instanceof MarkdownView &&
        v.file &&
        this.vaultPathToSheafPath(v.file.path) === docPath
      ) {
        found = v.editor;
      }
    });
    return found;
  }

  private computeCharRange(
    editor: Editor,
  ): { from: number; to: number } | null {
    const fromOff = editor.posToOffset(editor.getCursor("from"));
    const toOff = editor.posToOffset(editor.getCursor("to"));
    if (Number.isNaN(fromOff) || Number.isNaN(toOff)) return null;
    if (toOff < fromOff) return { from: toOff, to: fromOff };
    return { from: fromOff, to: toOff };
  }

  private dispatchEvent(event: BackendEvent): void {
    const view = this.getThreadsView();

    switch (event.kind) {
      case "thread_changed":
        if (view) {
          void view.onThreadChanged(event.thread_id, event.target_paths);
        }
        this.updateStatusBar();
        break;
      case "doc_changed":
        this.flashStatus(`edit landed: ${basename(event.path)}`);
        break;
      case "agent_presence":
        this.agentConnected = event.connected;
        view?.setAgentPresence(event.connected);
        this.updateStatusBar(event.connected);
        break;
      default:
        // draft_* events: prototype doesn't show drafts in UX. Ignore.
        break;
    }
  }

  private getThreadsView(): ThreadsView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_SHEAF_THREADS);
    const view = leaves[0]?.view;
    return view instanceof ThreadsView ? view : null;
  }

  private updateStatusBar(agentConnected?: boolean): void {
    if (!this.statusBar) return;
    const url = this.settings.serverUrl;
    if (agentConnected === undefined) {
      this.statusBar.setText(`sheaf: ${url}`);
      return;
    }
    this.statusBar.setText(
      agentConnected ? `sheaf: agent connected` : `sheaf: no agent`,
    );
  }

  private flashStatus(text: string): void {
    if (!this.statusBar) return;
    const prev = this.statusBar.getText();
    this.statusBar.setText(`sheaf: ${text}`);
    setTimeout(() => this.statusBar?.setText(prev), 2000);
  }
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

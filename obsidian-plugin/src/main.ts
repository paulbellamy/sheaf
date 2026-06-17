import { Editor, FileSystemAdapter, MarkdownView, Notice, Plugin } from "obsidian";

import { SheafApiError, SheafClient } from "./sheaf-client";
import { SheafEventStream, type BackendEvent } from "./sheaf-events";
import { SheafServerHost } from "./sheaf-server-host";
import {
  DEFAULT_SETTINGS,
  mergeStyle,
  type SheafSettings,
  SheafSettingTab,
} from "./settings";
import { CommentModal } from "./views/comment-modal";
import { ReviewModal } from "./views/review-modal";
import { ThreadsView, VIEW_TYPE_SHEAF_THREADS } from "./views/threads-view";
import { buildPanelRequestMessage } from "./review";

export default class SheafPlugin extends Plugin {
  settings: SheafSettings = DEFAULT_SETTINGS;
  client!: SheafClient;
  agentConnected = false;
  private events!: SheafEventStream;
  private statusBar: HTMLElement | null = null;
  private host = new SheafServerHost();
  private settingTab: SheafSettingTab | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.client = new SheafClient(this.settings.serverUrl);
    this.events = new SheafEventStream(
      this.settings.serverUrl,
      (e) => this.dispatchEvent(e),
    );

    this.registerView(
      VIEW_TYPE_SHEAF_THREADS,
      (leaf) => new ThreadsView(leaf, this),
    );

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

    this.statusBar = this.addStatusBarItem();
    this.updateStatusBar();

    this.settingTab = new SheafSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    // Start the embedded server (if enabled) before opening the event stream
    // so the first SSE connect lands on a live server.
    await this.startServerIfEnabled();

    // Mirror the user's voice settings into the vault so the agent honors them.
    await this.pushStyleConfig();

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
    await this.host.stop();
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<SheafSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
    // Reconcile the style block against current defaults (fresh object so the
    // settings UI never mutates the shared default in place).
    this.settings.style = mergeStyle(loaded?.style);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /**
   * Persist the style settings and mirror them to the server's
   * `.sheaf/config.json` (the agent's source of truth). Best-effort push: the
   * server may be down or external.
   */
  async saveAndPushStyle(): Promise<void> {
    await this.saveSettings();
    await this.pushStyleConfig();
  }

  private async pushStyleConfig(): Promise<void> {
    try {
      await this.client.putStyleConfig(this.settings.style);
    } catch (err) {
      console.warn("sheaf: could not push style config to server", err);
    }
  }

  /**
   * Generate / refresh the voice guide: the server computes metrics now and
   * posts a build request the connected agent picks up to write the guide.
   */
  async buildVoiceGuide(): Promise<void> {
    try {
      await this.pushStyleConfig();
      const res = await this.client.buildStyleGuide();
      const docs = `${res.doc_count} note${res.doc_count === 1 ? "" : "s"}`;
      if (res.word_count === 0 || res.low_corpus) {
        new Notice(
          `Analyzed ${docs} — not much writing to learn from yet. Write more, then regenerate.`,
          8000,
        );
      } else if (!this.agentConnected) {
        new Notice(
          `Analyzed ${docs} (~${res.word_count} words). Connect a Claude agent and it will write your voice guide.`,
          8000,
        );
      } else {
        new Notice(
          `Analyzing ${docs} (~${res.word_count} words); the agent is writing your voice guide now.`,
          6000,
        );
      }
    } catch (err) {
      const msg =
        err instanceof SheafApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      new Notice(`Sheaf: couldn't build voice guide — ${msg}`, 8000);
    }
  }

  async onConnectionChanged(): Promise<void> {
    // Re-point (or stop) the embedded server first, then the client/stream.
    await this.startServerIfEnabled();
    this.client.setBaseUrl(this.settings.serverUrl);
    this.events.setBaseUrl(this.settings.serverUrl);
    await this.pushStyleConfig();
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
    }).open();
  }

  /**
   * Ask the connected agent to run a panel review of `docPath`. Posts a single
   * doc-level request thread carrying the selected roles; the agent channels
   * each and posts anchored `review:<id>` comments back for triage. No
   * selection needed — the panel reads the whole doc.
   */
  openReviewModalForPath(docPath: string): void {
    if (!this.agentConnected) {
      new Notice("No agent connected — start a Claude Code session first");
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
        this.settingTab?.onAgentPresenceChanged();
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

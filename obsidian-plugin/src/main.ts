import {
  Editor,
  FileSystemAdapter,
  MarkdownView,
  Menu,
  Notice,
  Plugin,
  TAbstractFile,
  TFile,
  TFolder,
} from "obsidian";

import { cleanOffset, stripReviewMarkup } from "sheaf-server/types";

import { locateSelection } from "./editor/anchor-text";

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
import { ActivityView, VIEW_TYPE_SHEAF_ACTIVITY } from "./views/activity-view";
import { buildPanelRequestMessage } from "./review";
import { flashField, flashRange, mountFlashStyles } from "./editor/flash";
import {
  reviewMarkupExtension,
  mountReviewMarkupStyles,
  setResolvedThreadIds,
} from "./editor/review-markup";
import { decorateReadingReviewMarkup } from "./editor/reading-markup";
import type { EditorView } from "@codemirror/view";
import { AcpController } from "./acp/controller";
import type { ActivityStore } from "./acp/activity-store";
import {
  ACP_EFFORTS,
  DEFAULT_ACP_AGENT_ID,
  DEFAULT_ACP_EFFORT,
  listAcpAgents,
  resolveAcpAgent,
  type AcpAgentSpec,
} from "./acp/registry";

export default class SheafPlugin extends Plugin {
  settings: SheafSettings = DEFAULT_SETTINGS;
  client!: SheafClient;
  agentConnected = false;
  private events!: SheafEventStream;
  private statusBar: HTMLElement | null = null;
  private host = new SheafServerHost();
  private acp!: AcpController;
  private settingTab: SheafSettingTab | null = null;

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
      onConnectionChange: () => this.refreshAgentPresence(),
    });

    this.registerView(
      VIEW_TYPE_SHEAF_THREADS,
      (leaf) => new ThreadsView(leaf, this),
    );
    this.registerView(
      VIEW_TYPE_SHEAF_ACTIVITY,
      (leaf) => new ActivityView(leaf, this),
    );

    // CM6 editor extensions:
    //  - flashField backs the transient highlight when a thread card is clicked
    //    (flash.ts).
    //  - reviewMarkupExtension hides/prettifies the inline RFM review markup in
    //    Live Preview (review-markup.ts).
    // updateOptions() flushes them into any editor already open when the plugin
    // loads — registerEditorExtension alone only reaches editors opened
    // afterward. The mount* helpers inject the CSS (no separate styles.css).
    this.registerEditorExtension(flashField);
    this.registerEditorExtension(reviewMarkupExtension);
    this.app.workspace.updateOptions();
    this.register(mountFlashStyles());
    this.register(mountReviewMarkupStyles());

    // Reading mode has no CodeMirror editor, so the CM6 extension above never
    // runs there — decorate the rendered HTML with the same review markup via a
    // post-processor (reading-markup.ts). Shares the `.sheaf-rfm-*` styles the
    // mount above injects, so both modes read identically. `ctx` lets it skip
    // the rendered review endmatter, mirroring the CM6 path's body-only scan.
    this.registerMarkdownPostProcessor((el, ctx) =>
      decorateReadingReviewMarkup(el, ctx),
    );

    this.addRibbonIcon("message-square", "Sheaf threads", () => {
      void this.activateThreadsView();
    });

    this.addRibbonIcon("activity", "Sheaf activity", () => {
      void this.activateActivityView();
    });

    this.addCommand({
      id: "sheaf-open-threads-panel",
      name: "Open threads panel",
      callback: () => void this.activateThreadsView(),
    });

    this.addCommand({
      id: "sheaf-open-activity",
      name: "Open activity view",
      callback: () => void this.activateActivityView(),
    });

    // checkCallback (not editorCallback) so the command — and its hotkey — are
    // available in reading mode too, where there is no CodeMirror editor. The
    // handler branches on the view's mode to capture the selection either way.
    this.addCommand({
      id: "sheaf-comment-for-agent",
      name: "Comment for agent",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "M" }],
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) return false;
        if (!checking) void this.commentFromActiveView(view);
        return true;
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
      callback: () => void this.connectAcp(),
    });

    this.addCommand({
      id: "sheaf-acp-disconnect",
      name: "Disconnect ACP agent",
      callback: () => {
        this.disconnectAcp();
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

    // Reading mode has no CodeMirror editor, so `editor-menu` never fires there.
    // Take over the context menu for a text selection inside a reading view to
    // offer the same "Comment for agent" action (plus Copy, so the native
    // affordance isn't lost).
    this.registerDomEvent(document, "contextmenu", (evt) => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view?.file || view.getMode() !== "preview") return;
      // Only take over right-clicks that land inside this reading view — a live
      // selection can outlive the click, so right-clicking the panel, ribbon, or
      // a modal input must not suppress the native menu or pop ours.
      if (!view.containerEl.contains(evt.target as Node)) return;
      const sel = view.containerEl.ownerDocument.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
      const text = sel.toString();
      if (!text.trim()) return;
      // Only when the selection actually lives in this reading view.
      if (!view.containerEl.contains(sel.getRangeAt(0).commonAncestorContainer)) {
        return;
      }
      evt.preventDefault();
      const menu = new Menu();
      menu.addItem((item) =>
        item
          .setTitle("Sheaf: Comment for agent")
          .setIcon("message-square")
          .onClick(() => void this.composeReadingComment(view)),
      );
      menu.addItem((item) =>
        item
          .setTitle("Copy")
          .setIcon("copy")
          .onClick(() => void navigator.clipboard.writeText(text)),
      );
      menu.showAtMouseEvent(evt);
    });

    // A vault rename moves the `.md` (threads travel inline with it), but the
    // target paths recorded in its endmatter, the version history, and the
    // hidden draft overrides stay pinned to the old path. Reconcile them on the
    // server — which also wakes the connected agent — and follow the rename in
    // the open threads panel so it doesn't go blank on the now-stale path.
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        void this.onFileRenamed(file, oldPath);
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
    this.acp?.disconnect();
    await this.host.stop();
  }

  /**
   * Spawn the configured ACP agent as a subprocess and bring up the connection.
   * Replaces the manual `claude mcp add` + terminal flow: the plugin hands the
   * agent the sheaf MCP (scoped per doc) over session/new, services its file
   * I/O through the ydoc, and gates writes via a permission modal.
   */
  async connectAcp(): Promise<void> {
    const root = this.vaultRoot();
    if (!root) {
      new Notice("Sheaf: ACP needs a local-filesystem vault.");
      return;
    }
    const spec = resolveAcpAgent(
      this.settings.acpAgentId,
      this.settings.customAcpAgents,
    );
    if (!spec) {
      new Notice(`Sheaf: unknown ACP agent "${this.settings.acpAgentId}".`);
      return;
    }
    try {
      new Notice("Sheaf: starting ACP agent…");
      await this.acp.connect(
        spec,
        root,
        this.settings.serverUrl,
        this.settings.acpEffort,
      );
      new Notice("Sheaf: ACP agent connected.");
    } catch (err) {
      console.error("sheaf: ACP connect failed", err);
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Sheaf: ACP connect failed — ${msg}`, 8000);
    }
  }

  /** Stop the ACP agent the plugin started. */
  disconnectAcp(): void {
    this.acp.disconnect();
    // Wipe the activity timeline — it described what the now-gone agent was
    // doing, so the activity view shouldn't keep showing it.
    this.acp.activity.clear();
    new Notice("Sheaf: ACP agent disconnected");
  }

  /** True when the plugin has a live ACP agent (distinct from a manual MCP one). */
  acpConnected(): boolean {
    return this.acp?.connected === true;
  }

  /** Built-in + user-defined ACP agents (for the pickers). */
  acpAgents(): AcpAgentSpec[] {
    return listAcpAgents(this.settings.customAcpAgents);
  }

  /** The per-doc activity model the threads panel renders. */
  acpActivity(): ActivityStore {
    return this.acp.activity;
  }

  /** Cancel the agent's in-flight turn on `docPath`. */
  cancelAgentTurn(docPath: string): void {
    this.acp.cancel(docPath);
  }

  /** Switch the agent's mode for `docPath`. */
  setAcpMode(docPath: string, modeId: string): void {
    this.acp.setMode(docPath, modeId);
  }

  /** Send a free-form follow-up into the doc's live agent session. */
  interjectAcp(docPath: string, text: string): Promise<void> {
    return this.acp.interject(docPath, text);
  }

  /** Follow-along: briefly highlight `line` (1-based) of `docPath`'s open editor. */
  flashDocLine(docPath: string, line: number): void {
    const editor = this.editorForPath(docPath);
    if (!editor) return;
    const lineIdx = line - 1; // ACP line numbers are 1-based
    if (lineIdx < 0 || lineIdx >= editor.lineCount()) return;
    const from = editor.posToOffset({ line: lineIdx, ch: 0 });
    const to = editor.posToOffset({
      line: lineIdx,
      ch: editor.getLine(lineIdx).length,
    });
    const cm = (editor as unknown as { cm?: EditorView }).cm;
    if (cm) flashRange(cm, from, to);
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<SheafSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
    // Reconcile the style block against current defaults (fresh object so the
    // settings UI never mutates the shared default in place).
    this.settings.style = mergeStyle(loaded?.style);
    // Migrate an out-of-range stored effort (e.g. the old "default") to a valid
    // mode so the dropdown and the spawn env both stay well-formed.
    if (!ACP_EFFORTS.includes(this.settings.acpEffort)) {
      this.settings.acpEffort = DEFAULT_ACP_EFFORT;
    }
    if (!Array.isArray(this.settings.customAcpAgents)) {
      this.settings.customAcpAgents = [];
    }
    // A selected agent that no longer resolves (deleted custom) → reset.
    if (
      !resolveAcpAgent(this.settings.acpAgentId, this.settings.customAcpAgents)
    ) {
      this.settings.acpAgentId = DEFAULT_ACP_AGENT_ID;
    }
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

  private async activateActivityView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_SHEAF_ACTIVITY);
    if (existing.length > 0) {
      workspace.revealLeaf(existing[0]);
      return;
    }
    const right = workspace.getRightLeaf(false);
    if (!right) return;
    await right.setViewState({
      type: VIEW_TYPE_SHEAF_ACTIVITY,
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

  /** Route a comment request to the capture path for the view's current mode. */
  private async commentFromActiveView(view: MarkdownView): Promise<void> {
    if (view.getMode() === "preview") {
      await this.composeReadingComment(view);
    } else {
      this.openCommentModal(view.editor, view);
    }
  }

  /**
   * Comment flow for reading (preview) mode. There's no CodeMirror editor, so we
   * read the DOM selection and pin it to the doc by locating the selected text
   * in the clean prose (offsets are already in the clean-prose space the server
   * anchors against). Falls back to a doc-level comment when the selection can't
   * be pinned — it spans blocks/formatting, or the text can't be found.
   */
  private async composeReadingComment(view: MarkdownView): Promise<void> {
    const file = view.file;
    if (!file) {
      new Notice("Open a markdown file first");
      return;
    }
    const docPath = this.vaultPathToSheafPath(file.path);
    const picked = readingSelection(view);
    if (!picked) {
      // No selection → doc-level comment, same as the editor path.
      this.composeComment(docPath, null, "");
      return;
    }
    const clean = stripReviewMarkup(await this.app.vault.cachedRead(file));
    const range = locateSelection(clean, picked.text, picked.before);
    if (!range) {
      new Notice(
        "Couldn't pin the highlight to the text — posting a doc-level comment instead.",
        6000,
      );
      this.composeComment(docPath, null, picked.text);
      return;
    }
    this.composeComment(docPath, range, picked.text);
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

  /**
   * Tell every open editor for `docPath` which of its threads are
   * resolved/dismissed, so their inline anchor highlights drop (the markup
   * itself stays in the file — resolving doesn't rewrite the doc). Called by the
   * threads panel whenever it (re)loads a doc's threads.
   */
  setResolvedHighlights(docPath: string, resolvedIds: ReadonlySet<string>): void {
    this.app.workspace.iterateAllLeaves((leaf) => {
      const v = leaf.view;
      if (
        !(v instanceof MarkdownView) ||
        !v.file ||
        this.vaultPathToSheafPath(v.file.path) !== docPath
      ) {
        return;
      }
      const cm = (v.editor as unknown as { cm?: EditorView }).cm;
      cm?.dispatch({ effects: setResolvedThreadIds.of(resolvedIds) });
    });
  }

  private computeCharRange(
    editor: Editor,
  ): { from: number; to: number } | null {
    const fromOff = editor.posToOffset(editor.getCursor("from"));
    const toOff = editor.posToOffset(editor.getCursor("to"));
    if (Number.isNaN(fromOff) || Number.isNaN(toOff)) return null;
    const lo = Math.min(fromOff, toOff);
    const hi = Math.max(fromOff, toOff);
    // The editor buffer carries inline review markup, but the server anchors
    // against the clean prose `readDoc` returns — map the offsets into
    // clean-prose space (a no-op until the note has its first thread).
    const buf = editor.getValue();
    return { from: cleanOffset(buf, lo), to: cleanOffset(buf, hi) };
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
        // Combined presence (manual MCP OR a spawned ACP agent).
        this.refreshAgentPresence();
        this.settingTab?.onAgentPresenceChanged();
        break;
      default:
        // draft_* events: prototype doesn't show drafts in UX. Ignore.
        break;
    }
  }

  /**
   * Reflect agent presence from *either* signal — a manual MCP agent (SSE
   * `agent_presence`) or a spawned ACP agent — in the status bar and the
   * threads panel. The two are independent, so an SSE "no agent" must not hide
   * a live ACP connection (and vice versa).
   */
  private refreshAgentPresence(): void {
    const present = this.isAgentPresent();
    this.getThreadsView()?.setAgentPresence(present);
    this.updateStatusBar(present);
  }

  /** Agent present via *either* signal — a manual MCP agent or a spawned ACP one. */
  isAgentPresent(): boolean {
    return this.agentConnected || this.acp?.connected === true;
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

/**
 * The current text selection inside a reading view, plus the text preceding it
 * within the same block (used to disambiguate a phrase that repeats). Null when
 * there's no usable selection in this view.
 */
function readingSelection(
  view: MarkdownView,
): { text: string; before: string } | null {
  const sel = view.containerEl.ownerDocument.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const text = sel.toString();
  if (!text.trim()) return null;
  const range = sel.getRangeAt(0);
  if (!view.containerEl.contains(range.commonAncestorContainer)) return null;
  return { text, before: precedingBlockText(range) };
}

/** Rendered text from the start of the selection's block up to the selection. */
function precedingBlockText(range: Range): string {
  const start =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as HTMLElement)
      : range.startContainer.parentElement;
  const block = start?.closest(
    "p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, dd, dt, pre",
  );
  if (!block) return "";
  const pre = range.cloneRange();
  pre.selectNodeContents(block);
  try {
    pre.setEnd(range.startContainer, range.startOffset);
  } catch {
    return "";
  }
  return pre.toString();
}

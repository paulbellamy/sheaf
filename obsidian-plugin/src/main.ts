import { Editor, MarkdownView, Notice, Plugin, TFile } from "obsidian";

import { SheafClient } from "./sheaf-client";
import { SheafEventStream, type BackendEvent } from "./sheaf-events";
import {
  DEFAULT_SETTINGS,
  type SheafSettings,
  SheafSettingTab,
} from "./settings";
import { CommentModal } from "./views/comment-modal";
import { ThreadsView, VIEW_TYPE_SHEAF_THREADS } from "./views/threads-view";

export default class SheafPlugin extends Plugin {
  settings: SheafSettings = DEFAULT_SETTINGS;
  client!: SheafClient;
  private events!: SheafEventStream;
  private statusBar: HTMLElement | null = null;

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
      editorCallback: (editor, view) => {
        if (view instanceof MarkdownView) {
          this.openCommentModal(editor, view);
        }
      },
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        if (!(view instanceof MarkdownView)) return;
        if (editor.getSelection().length === 0) return;
        menu.addItem((item) => {
          item
            .setTitle("Sheaf: Comment for agent")
            .setIcon("message-square")
            .onClick(() => this.openCommentModal(editor, view));
        });
      }),
    );

    this.statusBar = this.addStatusBarItem();
    this.updateStatusBar();

    this.addSettingTab(new SheafSettingTab(this.app, this));

    this.events.start();
  }

  async onunload(): Promise<void> {
    this.events?.stop();
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

  onConnectionChanged(): void {
    this.client.setBaseUrl(this.settings.serverUrl);
    this.events.setBaseUrl(this.settings.serverUrl);
    this.updateStatusBar();
  }

  /**
   * Convert an Obsidian vault path ("notes/proposal.md") into the sheaf-relative
   * path the backend expects ("workspaces/<ws>/docs/notes/proposal.md").
   *
   * For the prototype, the vault is mapped to a single workspace; nested folders
   * carry over verbatim.
   */
  vaultPathToSheafPath(vaultPath: string): string {
    return `workspaces/${this.settings.workspaceName}/docs/${vaultPath}`;
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

  private openCommentModal(editor: Editor, view: MarkdownView): void {
    const file = view.file;
    if (!file) {
      new Notice("Open a markdown file first");
      return;
    }
    const selection = editor.getSelection();
    if (selection.length === 0) {
      new Notice("Select some text first");
      return;
    }
    const charRange = this.computeCharRange(editor, file);
    if (!charRange) {
      new Notice("Couldn't resolve selection range");
      return;
    }
    const docPath = this.vaultPathToSheafPath(file.path);

    new CommentModal(this.app, selection, async (message) => {
      try {
        await this.client.addThread(docPath, charRange, message);
        new Notice("Comment posted; agent will pick it up");
      } catch (err) {
        console.error("sheaf: addThread failed", err);
        new Notice("Failed to post comment; see console");
      }
    }).open();
  }

  private computeCharRange(
    editor: Editor,
    _file: TFile,
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

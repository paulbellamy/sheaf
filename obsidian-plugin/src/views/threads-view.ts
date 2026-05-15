import { ItemView, WorkspaceLeaf, TFile, Notice } from "obsidian";
import type SheafPlugin from "../main";
import type { Thread } from "../sheaf-client";

export const VIEW_TYPE_SHEAF_THREADS = "sheaf-threads";

export class ThreadsView extends ItemView {
  private currentDocPath: string | null = null;
  private threads: Thread[] = [];
  private agentConnected = false;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: SheafPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_SHEAF_THREADS;
  }

  getDisplayText(): string {
    return "Sheaf threads";
  }

  getIcon(): string {
    return "message-square";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("sheaf-threads-view");
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        void this.onFileOpen(file);
      }),
    );
    const active = this.app.workspace.getActiveFile();
    if (active) void this.onFileOpen(active);
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  setAgentPresence(connected: boolean): void {
    this.agentConnected = connected;
    this.render();
  }

  async refreshCurrent(): Promise<void> {
    if (!this.currentDocPath) return;
    try {
      this.threads = await this.plugin.client.listThreads(this.currentDocPath);
      this.render();
    } catch (err) {
      console.error("sheaf: list threads failed", err);
    }
  }

  async onThreadChanged(threadId: string, targetPaths: string[]): Promise<void> {
    if (!this.currentDocPath) return;
    if (!targetPaths.includes(this.currentDocPath)) return;
    await this.refreshCurrent();
  }

  private async onFileOpen(file: TFile | null): Promise<void> {
    this.currentDocPath = file ? this.plugin.vaultPathToSheafPath(file.path) : null;
    this.threads = [];
    this.render();
    if (this.currentDocPath) {
      await this.refreshCurrent();
    }
  }

  private render(): void {
    const el = this.contentEl;
    el.empty();

    const header = el.createDiv({ cls: "sheaf-threads-header" });
    header.style.padding = "0.5em";
    header.style.borderBottom = "1px solid var(--background-modifier-border)";

    const presence = header.createDiv();
    presence.setText(
      this.agentConnected
        ? "● agent connected"
        : "○ no agent listening",
    );
    presence.style.fontSize = "0.85em";
    presence.style.opacity = this.agentConnected ? "1" : "0.6";
    presence.style.color = this.agentConnected
      ? "var(--text-success)"
      : "var(--text-muted)";

    if (!this.currentDocPath) {
      const empty = el.createDiv({ cls: "sheaf-empty" });
      empty.setText("Open a doc under workspaces/.");
      empty.style.padding = "1em";
      empty.style.opacity = "0.6";
      return;
    }

    const docLabel = header.createDiv();
    docLabel.setText(this.currentDocPath);
    docLabel.style.fontSize = "0.75em";
    docLabel.style.opacity = "0.5";
    docLabel.style.marginTop = "0.25em";

    if (this.threads.length === 0) {
      const empty = el.createDiv({ cls: "sheaf-empty" });
      empty.setText("No threads. Select text and run \"Sheaf: Comment for agent\".");
      empty.style.padding = "1em";
      empty.style.opacity = "0.6";
      return;
    }

    const open = this.threads.filter((t) => t.status === "open");
    const closed = this.threads.filter((t) => t.status !== "open");

    if (open.length > 0) {
      const section = el.createDiv();
      section.createEl("h4", { text: `Open (${open.length})` }).style.margin =
        "0.75em 0.5em 0.25em";
      for (const t of open) this.renderThread(section, t);
    }

    if (closed.length > 0) {
      const section = el.createDiv();
      section.createEl("h4", {
        text: `Resolved (${closed.length})`,
      }).style.margin = "0.75em 0.5em 0.25em";
      for (const t of closed) this.renderThread(section, t);
    }
  }

  private renderThread(parent: HTMLElement, thread: Thread): void {
    const card = parent.createDiv({ cls: "sheaf-thread" });
    card.style.padding = "0.5em 0.75em";
    card.style.borderBottom = "1px solid var(--background-modifier-border)";

    const anchor = thread.targets[0]?.anchor.anchored_text ?? "";
    if (anchor) {
      const anchorEl = card.createDiv();
      anchorEl.setText(anchor.length > 80 ? anchor.slice(0, 80) + "…" : anchor);
      anchorEl.style.fontStyle = "italic";
      anchorEl.style.opacity = "0.6";
      anchorEl.style.fontSize = "0.85em";
      anchorEl.style.borderLeft = "2px solid var(--text-muted)";
      anchorEl.style.paddingLeft = "0.5em";
      anchorEl.style.marginBottom = "0.5em";
    }

    for (const msg of thread.messages) {
      const m = card.createDiv();
      const author = m.createSpan({ text: `${msg.author}: ` });
      author.style.fontWeight = "600";
      author.style.fontSize = "0.85em";
      const body = m.createSpan({ text: msg.body });
      body.style.fontSize = "0.9em";
      m.style.marginBottom = "0.25em";
    }

    if (thread.status === "open") {
      const actions = card.createDiv();
      actions.style.marginTop = "0.5em";
      actions.style.display = "flex";
      actions.style.gap = "0.5em";

      const resolve = actions.createEl("button", { text: "Resolve" });
      resolve.style.fontSize = "0.8em";
      resolve.addEventListener("click", async () => {
        try {
          await this.plugin.client.resolveThread(thread.id);
          new Notice("Thread resolved");
          await this.refreshCurrent();
        } catch (err) {
          console.error("sheaf: resolve failed", err);
          new Notice("Resolve failed; see console");
        }
      });
    } else {
      const status = card.createDiv();
      status.setText(`✓ ${thread.status}`);
      status.style.fontSize = "0.75em";
      status.style.opacity = "0.5";
      status.style.marginTop = "0.25em";
    }
  }
}

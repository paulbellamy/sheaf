import {
  ItemView,
  MarkdownRenderer,
  MarkdownView,
  WorkspaceLeaf,
  TFile,
  Notice,
} from "obsidian";
import type SheafPlugin from "../main";
import type { Thread, ThreadDraftBody } from "../sheaf-client";

export const VIEW_TYPE_SHEAF_THREADS = "sheaf-threads";

/**
 * "Working" = thread is open AND the latest message is not from the user.
 * The agent's convention (per the MCP ReadMe) is to ReplyThread when it
 * picks up a thread, then Edit/Write, then ResolveThread — so any non-user
 * message on an open thread means the agent has it.
 */
function isWorking(thread: Thread): boolean {
  if (thread.status !== "open") return false;
  const last = thread.messages[thread.messages.length - 1];
  return !!last && last.author !== "user";
}

/**
 * Option leaves to render as a picker — but only while they're the *latest*
 * word on the thread. Once anyone posts after them (e.g. the user's "Selected
 * option N" pick, routed back to the agent), the picker hides: the ball is in
 * the agent's court now, and a lingering picker would invite a double-pick.
 * A single-leaf `draft` payload is treated as a one-element option list.
 */
function latestVariants(thread: Thread): ThreadDraftBody[] | null {
  const m = thread.messages[thread.messages.length - 1];
  if (!m) return null;
  if (m.draft_options && m.draft_options.length > 0) return m.draft_options;
  if (m.draft) return [m.draft];
  return null;
}

/**
 * Drift = thread is range-anchored but its anchored_text isn't found in the
 * current doc text. Anchor needs re-resolution or the thread is stale.
 */
function isDrifted(thread: Thread, docText: string | null): boolean {
  if (docText === null) return false;
  const target = thread.targets[0];
  if (target?.scope !== "range") return false;
  const anchored = target.anchor.anchored_text;
  if (!anchored) return false;
  return !docText.includes(anchored);
}

export class ThreadsView extends ItemView {
  private currentDocPath: string | null = null;
  private currentFile: TFile | null = null;
  private docText: string | null = null;
  private threads: Thread[] = [];
  private agentConnected = false;
  // Per-thread selected variant index. Resets when the thread's payload changes.
  private selectedVariant = new Map<string, number>();
  // Resolved section starts collapsed each session so the panel reads as
  // "what's outstanding" by default.
  private resolvedCollapsed = true;

  rerender(): void {
    this.render();
  }

  /**
   * Scroll the markdown editor showing `this.currentFile` to the thread's
   * anchor and select it. Range threads: search for `anchored_text` in the
   * current doc. Doc threads: scroll to the top. Drifted threads: notice.
   *
   * Looks up the editor by file rather than by `getActiveViewOfType` — the
   * click that triggered this navigation moves focus into the sidebar, so
   * the active view is the threads panel, not the editor.
   */
  private navigateToAnchor(thread: Thread): void {
    if (!this.currentFile) return;
    let mdView: MarkdownView | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      const v = leaf.view;
      if (v instanceof MarkdownView && v.file === this.currentFile) {
        mdView = v;
      }
    });
    if (!mdView) return;
    const editor = (mdView as MarkdownView).editor;
    const target = thread.targets[0];
    if (!target) return;

    if (target.scope === "doc") {
      const top = { line: 0, ch: 0 };
      editor.scrollIntoView({ from: top, to: top }, true);
      editor.setCursor(top);
      editor.focus();
      return;
    }

    const docText = editor.getValue();
    const anchored = target.anchor.anchored_text;
    if (!anchored) return;
    const idx = docText.indexOf(anchored);
    if (idx === -1) {
      new Notice("Anchor drifted — text not in doc", 4000);
      return;
    }
    const from = editor.offsetToPos(idx);
    const to = editor.offsetToPos(idx + anchored.length);
    editor.setSelection(from, to);
    editor.scrollIntoView({ from, to }, true);
    editor.focus();
  }

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
    this.agentConnected = this.plugin.agentConnected;
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        void this.onFileOpen(file);
      }),
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && file === this.currentFile) {
          void this.refreshDocText();
        }
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
    this.currentFile = file;
    this.currentDocPath = file ? this.plugin.vaultPathToSheafPath(file.path) : null;
    this.threads = [];
    this.docText = null;
    this.selectedVariant.clear();
    this.render();
    if (this.currentFile) {
      await this.refreshDocText();
    }
    if (this.currentDocPath) {
      await this.refreshCurrent();
    }
  }

  private async refreshDocText(): Promise<void> {
    if (!this.currentFile) return;
    try {
      this.docText = await this.app.vault.cachedRead(this.currentFile);
      this.render();
    } catch (err) {
      console.error("sheaf: read file failed", err);
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
      this.agentConnected ? "● agent connected" : "○ no agent listening",
    );
    presence.style.fontSize = "0.85em";
    presence.style.opacity = this.agentConnected ? "1" : "0.6";
    presence.style.color = this.agentConnected
      ? "var(--text-success)"
      : "var(--text-muted)";

    if (!this.currentDocPath) {
      const empty = el.createDiv({ cls: "sheaf-empty" });
      empty.setText("Open a markdown doc to see its threads.");
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
      empty.setText(
        'No threads. Select text and run "Sheaf: Comment for agent" (Cmd/Ctrl+Shift+M).',
      );
      empty.style.padding = "1em";
      empty.style.opacity = "0.6";
      return;
    }

    const open = this.threads.filter((t) => t.status === "open");
    const closed = this.threads.filter((t) => t.status !== "open");

    if (open.length > 0) {
      const section = el.createDiv();
      const h = section.createEl("h4", { text: `Open (${open.length})` });
      h.style.margin = "0.75em 0.5em 0.25em";
      for (const t of open) this.renderThread(section, t);
    }

    // Resolved section. Hidden entirely when settings.showResolved is off;
    // otherwise collapsible behind a ▶/▼ toggle that defaults to collapsed.
    if (this.plugin.settings.showResolved && closed.length > 0) {
      const section = el.createDiv();
      const h = section.createEl("h4");
      h.style.margin = "0.75em 0.5em 0.25em";
      h.style.cursor = "pointer";
      h.style.userSelect = "none";
      h.style.display = "flex";
      h.style.alignItems = "center";
      h.style.gap = "0.4em";

      const caret = h.createSpan();
      caret.setText(this.resolvedCollapsed ? "▶" : "▼");
      caret.style.fontSize = "0.7em";
      caret.style.opacity = "0.6";

      const label = h.createSpan();
      label.setText(`Resolved (${closed.length})`);
      label.style.opacity = "0.7";

      h.addEventListener("click", () => {
        this.resolvedCollapsed = !this.resolvedCollapsed;
        this.render();
      });

      if (!this.resolvedCollapsed) {
        const body = section.createDiv();
        body.style.opacity = "0.55";
        for (const t of closed) this.renderThread(body, t);
      }
    }
  }

  private renderThread(parent: HTMLElement, thread: Thread): void {
    const card = parent.createDiv({ cls: "sheaf-thread" });
    card.style.padding = "0.5em 0.75em";
    card.style.borderBottom = "1px solid var(--background-modifier-border)";
    card.style.cursor = "pointer";

    // Click anywhere on the card (except buttons/inputs) navigates the
    // editor to the anchor — range threads scroll to the highlighted text
    // and select it; doc threads scroll to the top.
    card.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("button, textarea, input, a")) return;
      this.navigateToAnchor(thread);
    });

    const drifted = isDrifted(thread, this.docText);

    if (isWorking(thread)) {
      const badge = card.createDiv();
      badge.setText("● agent working");
      badge.style.fontSize = "0.75em";
      badge.style.color = "var(--text-accent)";
      badge.style.marginBottom = "0.4em";
    }

    if (drifted) {
      const badge = card.createDiv();
      badge.setText("⚠ anchor drifted");
      badge.style.fontSize = "0.75em";
      badge.style.color = "var(--text-warning)";
      badge.style.marginBottom = "0.4em";
    }

    const target = thread.targets[0];
    if (target?.scope === "range") {
      const anchor = target.anchor.anchored_text;
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
    } else if (target?.scope === "doc") {
      const tag = card.createDiv();
      tag.setText("doc-level");
      tag.style.fontSize = "0.7em";
      tag.style.textTransform = "uppercase";
      tag.style.letterSpacing = "0.05em";
      tag.style.opacity = "0.5";
      tag.style.marginBottom = "0.5em";
    }

    for (const msg of thread.messages) {
      const m = card.createDiv();
      m.style.marginBottom = "0.5em";
      const author = m.createDiv({ text: `${msg.author}:` });
      author.style.fontWeight = "600";
      author.style.fontSize = "0.85em";
      // Render the comment body as markdown so lists, code, bold, and links
      // read properly instead of as raw source. `this` is the owning
      // Component so Obsidian cleans up the rendered subtree with the view.
      const body = m.createDiv({ cls: "sheaf-md" });
      body.style.fontSize = "0.9em";
      void MarkdownRenderer.render(
        this.app,
        msg.body,
        body,
        this.currentDocPath ?? "",
        this,
      );
    }

    const variants = latestVariants(thread);
    if (variants && thread.status === "open") {
      this.renderVariants(card, thread, variants);
    }

    if (thread.status === "open") {
      this.renderReplyInput(card, thread);

      const actions = card.createDiv();
      actions.style.marginTop = "0.5em";
      actions.style.display = "flex";
      actions.style.gap = "0.5em";

      // "Resolve" without applying. Use when the agent already did its work
      // via Edit/Write directly, or when the user wants to dismiss without
      // taking any of the variants.
      const resolve = actions.createEl("button", { text: "Resolve" });
      resolve.style.fontSize = "0.8em";
      resolve.addEventListener("click", async () => {
        try {
          await this.plugin.client.resolveThread(thread.id);
          new Notice("Thread resolved");
          await this.refreshCurrent();
        } catch (err) {
          console.error("sheaf: resolve failed", err);
          const msg = err instanceof Error ? err.message : String(err);
          new Notice(`Sheaf: ${msg}`, 8000);
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

  private renderReplyInput(parent: HTMLElement, thread: Thread): void {
    const wrap = parent.createDiv();
    wrap.style.marginTop = "0.5em";
    wrap.style.display = "flex";
    wrap.style.gap = "0.4em";
    wrap.style.alignItems = "flex-start";

    const input = wrap.createEl("textarea");
    input.placeholder = "Reply… (Shift+Enter for newline)";
    input.rows = 1;
    input.style.flex = "1";
    input.style.fontSize = "0.85em";
    input.style.padding = "0.3em 0.4em";
    input.style.resize = "vertical";
    input.style.minHeight = "1.8em";
    input.style.border = "1px solid var(--background-modifier-border)";
    input.style.borderRadius = "3px";
    input.style.background = "var(--background-primary)";
    input.style.color = "var(--text-normal)";

    const send = wrap.createEl("button", { text: "Send" });
    send.style.fontSize = "0.8em";

    const submit = async () => {
      const message = input.value.trim();
      if (!message) return;
      input.disabled = true;
      send.disabled = true;
      try {
        await this.plugin.client.replyThread(thread.id, message);
        input.value = "";
        await this.refreshCurrent();
      } catch (err) {
        console.error("sheaf: reply failed", err);
        const msg = err instanceof Error ? err.message : String(err);
        new Notice(`Sheaf: ${msg}`, 8000);
      } finally {
        input.disabled = false;
        send.disabled = false;
      }
    };

    send.addEventListener("click", () => void submit());
    input.addEventListener("keydown", (e) => {
      // Enter submits; Shift+Enter inserts a newline for multi-line replies.
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void submit();
      }
    });
  }

  private renderVariants(
    parent: HTMLElement,
    thread: Thread,
    variants: ThreadDraftBody[],
  ): void {
    const selected = Math.min(
      this.selectedVariant.get(thread.id) ?? 0,
      variants.length - 1,
    );

    const wrap = parent.createDiv();
    wrap.style.marginTop = "0.5em";
    wrap.style.padding = "0.4em";
    wrap.style.border = "1px solid var(--background-modifier-border)";
    wrap.style.borderRadius = "4px";
    wrap.style.background = "var(--background-secondary)";

    // Variant tabs (titles in a row, click to switch).
    const tabs = wrap.createDiv();
    tabs.style.display = "flex";
    tabs.style.gap = "0.25em";
    tabs.style.flexWrap = "wrap";
    tabs.style.marginBottom = "0.4em";

    variants.forEach((v, i) => {
      const tab = tabs.createEl("button", {
        text: v.name ?? `option ${i + 1}`,
      });
      tab.style.fontSize = "0.75em";
      tab.style.padding = "0.15em 0.5em";
      tab.style.border = "1px solid var(--background-modifier-border)";
      tab.style.borderRadius = "3px";
      tab.style.cursor = "pointer";
      if (i === selected) {
        tab.style.background = "var(--interactive-accent)";
        tab.style.color = "var(--text-on-accent)";
      } else {
        tab.style.background = "var(--background-primary)";
      }
      tab.addEventListener("click", () => {
        this.selectedVariant.set(thread.id, i);
        this.render();
      });
    });

    // Preview of the selected variant's text.
    const preview = wrap.createDiv();
    preview.setText(
      variants[selected].new_md.length > 240
        ? variants[selected].new_md.slice(0, 240) + "…"
        : variants[selected].new_md,
    );
    preview.style.fontSize = "0.85em";
    preview.style.fontFamily = "var(--font-monospace)";
    preview.style.padding = "0.4em";
    preview.style.background = "var(--background-primary)";
    preview.style.borderRadius = "3px";
    preview.style.whiteSpace = "pre-wrap";
    preview.style.maxHeight = "200px";
    preview.style.overflow = "auto";

    // Choose this option. Unlike "apply", this does NOT write the option's
    // text to the doc — it sends the pick back to the agent (like answering
    // an AskUserQuestion), and the agent makes the real edit. The previews
    // may be illustrative samples, not literal replacements.
    const label = variants[selected].name ?? `option ${selected + 1}`;
    const chooseBar = wrap.createDiv();
    chooseBar.style.display = "flex";
    chooseBar.style.gap = "0.5em";
    chooseBar.style.marginTop = "0.4em";
    const choose = chooseBar.createEl("button", { text: `Choose "${label}"` });
    choose.style.fontSize = "0.8em";
    choose.style.background = "var(--interactive-accent)";
    choose.style.color = "var(--text-on-accent)";
    choose.addEventListener("click", async () => {
      try {
        await this.plugin.client.chooseVariant(thread.id, selected + 1, label);
        new Notice(`Sent your pick "${label}" to the agent`);
        this.selectedVariant.delete(thread.id);
        await this.refreshCurrent();
      } catch (err) {
        console.error("sheaf: choose failed", err);
        const msg = err instanceof Error ? err.message : String(err);
        new Notice(`Sheaf: ${msg}`, 8000);
      }
    });
  }
}

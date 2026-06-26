import { ItemView, type TFile, type WorkspaceLeaf } from "obsidian";

import type SheafPlugin from "../main";
import type {
  ActivityEvent,
  ActivitySnapshot,
} from "../acp/activity-store";

export const VIEW_TYPE_SHEAF_ACTIVITY = "sheaf-activity";

/**
 * The full agent-activity transcript for the open doc: streamed messages and
 * thoughts, the plan, a tool-call timeline (expandable), fs ops, permission
 * cards, turn separators with stop reasons, and a crash banner — plus a Stop
 * button, a mode picker, and an interject box. A dedicated view so it doesn't
 * share the threads panel's keystroke-driven re-render; it patches on store
 * changes (debounced) and ticks for the elapsed/stalled counter.
 */
export class ActivityView extends ItemView {
  private readonly plugin: SheafPlugin;
  private currentDocPath: string | null = null;
  private storeUnsub: (() => void) | null = null;
  private renderQueued = false;
  private lastFlashedTool = -1;

  constructor(leaf: WorkspaceLeaf, plugin: SheafPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_SHEAF_ACTIVITY;
  }
  getDisplayText(): string {
    return "Sheaf activity";
  }
  getIcon(): string {
    return "activity";
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("sheaf-activity-view");
    this.contentEl.style.overflowY = "auto";
    this.registerEvent(
      this.app.workspace.on("file-open", (f) => this.onFileOpen(f)),
    );
    this.storeUnsub = this.plugin
      .acpActivity()
      .subscribe(() => this.scheduleRender());
    this.registerInterval(window.setInterval(() => this.tick(), 1500));
    this.onFileOpen(this.app.workspace.getActiveFile());
  }

  async onClose(): Promise<void> {
    this.storeUnsub?.();
    this.storeUnsub = null;
    this.contentEl.empty();
  }

  private onFileOpen(file: TFile | null): void {
    this.currentDocPath = file
      ? this.plugin.vaultPathToSheafPath(file.path)
      : null;
    this.render();
  }

  private scheduleRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    window.setTimeout(() => {
      this.renderQueued = false;
      this.render();
    }, 100);
  }

  private tick(): void {
    const snap = this.snapshot();
    if (snap && snap.state !== "idle" && snap.state !== "dead") this.render();
  }

  private snapshot(): ActivitySnapshot | null {
    return this.currentDocPath
      ? this.plugin.acpActivity().snapshot(this.currentDocPath)
      : null;
  }

  private render(): void {
    const el = this.contentEl;
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    el.empty();

    const docPath = this.currentDocPath;
    if (!docPath) {
      hint(el, "Open a markdown doc to watch the agent work on it.");
      return;
    }
    const snap = this.snapshot();
    if (!snap || (snap.timeline.length === 0 && snap.plan.length === 0)) {
      hint(el, "No agent activity on this doc yet.");
      return;
    }

    this.followAlong(snap);
    this.renderHeader(el, docPath, snap);
    if (snap.plan.length > 0) this.renderPlan(el, snap);
    this.renderTimeline(el, snap);
    this.renderInterject(el, docPath);

    if (atBottom) el.scrollTop = el.scrollHeight;
  }

  /** Flash the line the current in-progress tool touches, once per tool. */
  private followAlong(snap: ActivitySnapshot): void {
    const doc = this.currentDocPath;
    if (!doc) return;
    const tool = [...snap.timeline]
      .reverse()
      .find(
        (e): e is Extract<ActivityEvent, { kind: "tool" }> =>
          e.kind === "tool" &&
          e.status === "in_progress" &&
          !!e.locations?.length,
      );
    if (!tool || tool.id === this.lastFlashedTool) return;
    const loc = tool.locations?.find(
      (l) => l.line != null && (!l.path || l.path === doc),
    );
    if (!loc || loc.line == null) return;
    this.lastFlashedTool = tool.id;
    this.plugin.flashDocLine(doc, loc.line);
  }

  private renderHeader(
    el: HTMLElement,
    docPath: string,
    snap: ActivitySnapshot,
  ): void {
    const header = el.createDiv();
    header.style.position = "sticky";
    header.style.top = "0";
    header.style.background = "var(--background-primary)";
    header.style.borderBottom = "1px solid var(--background-modifier-border)";
    header.style.padding = "0.4em 0.5em";
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.gap = "0.5em";
    header.style.flexWrap = "wrap";

    const { text, color } = describeState(snap);
    const state = header.createDiv();
    state.setText(text);
    state.style.color = color;
    state.style.fontWeight = "500";
    state.style.flex = "1";
    state.style.minWidth = "8em";

    if (snap.mode.available.length > 0) {
      const sel = header.createEl("select");
      sel.style.fontSize = "0.8em";
      for (const m of snap.mode.available) {
        const o = sel.createEl("option", { text: m.name });
        o.value = m.id;
        if (m.id === snap.mode.current) o.selected = true;
      }
      sel.addEventListener("change", () =>
        this.plugin.setAcpMode(docPath, sel.value),
      );
    }

    if (
      snap.state === "working" ||
      snap.state === "thinking" ||
      snap.state === "stalled"
    ) {
      const stop = header.createEl("button", { text: "Stop" });
      stop.style.fontSize = "0.8em";
      stop.title = "Cancel the agent's current turn";
      stop.addEventListener("click", () =>
        this.plugin.cancelAgentTurn(docPath),
      );
    }
  }

  private renderPlan(el: HTMLElement, snap: ActivitySnapshot): void {
    const box = el.createDiv();
    box.style.padding = "0.5em";
    box.style.borderBottom = "1px solid var(--background-modifier-border)";
    box.style.fontSize = "0.85em";
    for (const p of snap.plan) {
      const row = box.createDiv();
      const mark =
        p.status === "completed" ? "☑" : p.status === "in_progress" ? "◐" : "☐";
      row.setText(`${mark} ${p.content}`);
      row.style.opacity = p.status === "completed" ? "0.6" : "1";
      if (p.status === "in_progress") row.style.fontWeight = "500";
    }
  }

  private renderTimeline(el: HTMLElement, snap: ActivitySnapshot): void {
    const log = el.createDiv();
    log.style.padding = "0.5em";
    log.style.fontSize = "0.85em";
    log.style.lineHeight = "1.4";
    for (const ev of snap.timeline) this.renderEvent(log, ev);
  }

  private renderEvent(log: HTMLElement, ev: ActivityEvent): void {
    switch (ev.kind) {
      case "turn_start": {
        const d = log.createDiv();
        d.setText("───");
        d.style.color = "var(--text-faint)";
        d.style.margin = "0.6em 0 0.2em";
        break;
      }
      case "message":
        block(log, "Agent", ev.text, "var(--text-normal)");
        break;
      case "thought": {
        const det = log.createEl("details");
        det.style.margin = "0.2em 0";
        const sum = det.createEl("summary", { text: "Thinking" });
        sum.style.color = "var(--text-muted)";
        sum.style.cursor = "pointer";
        const body = det.createEl("div");
        body.setText(ev.text);
        body.style.whiteSpace = "pre-wrap";
        body.style.color = "var(--text-muted)";
        body.style.fontStyle = "italic";
        break;
      }
      case "tool": {
        const icon =
          ev.status === "completed"
            ? "✓"
            : ev.status === "failed"
              ? "✗"
              : ev.status === "in_progress"
                ? "⟳"
                : "·";
        const content = toolContentText(ev.content);
        if (content) {
          const det = log.createEl("details");
          det.style.margin = "0.1em 0";
          const sum = det.createEl("summary");
          sum.setText(`${icon} ${ev.title}`);
          sum.style.cursor = "pointer";
          if (ev.status === "failed") sum.style.color = "var(--text-error)";
          const pre = det.createEl("pre");
          pre.setText(content);
          pre.style.whiteSpace = "pre-wrap";
          pre.style.fontSize = "0.8em";
          pre.style.opacity = "0.85";
          pre.style.margin = "0.2em 0 0.4em 1em";
        } else {
          const row = log.createDiv();
          row.setText(`${icon} ${ev.title}`);
          if (ev.status === "failed") row.style.color = "var(--text-error)";
        }
        break;
      }
      case "fs": {
        const row = log.createDiv();
        row.setText(`${ev.op === "write" ? "✎ wrote" : "▸ read"} ${ev.path}`);
        row.style.color = "var(--text-faint)";
        break;
      }
      case "permission": {
        const row = log.createDiv();
        row.style.margin = "0.2em 0";
        if (ev.resolved === undefined) {
          row.setText(`⏸ Permission requested: ${ev.title} — answer the prompt`);
          row.style.color = "var(--text-warning)";
        } else {
          row.setText(`Permission: ${ev.title} → ${ev.resolved}`);
          row.style.color = "var(--text-muted)";
        }
        break;
      }
      case "turn_end": {
        const d = log.createDiv();
        d.setText(
          ev.stopReason === "end_turn"
            ? "✓ done"
            : `■ ended: ${ev.stopReason}`,
        );
        d.style.color = "var(--text-muted)";
        d.style.margin = "0.2em 0 0.4em";
        break;
      }
      case "crash": {
        const d = log.createDiv();
        d.setText(`✗ ${ev.message}`);
        d.style.color = "var(--text-error)";
        d.style.fontWeight = "500";
        d.style.margin = "0.3em 0";
        break;
      }
    }
  }

  private renderInterject(el: HTMLElement, docPath: string): void {
    const bar = el.createDiv();
    bar.style.position = "sticky";
    bar.style.bottom = "0";
    bar.style.background = "var(--background-primary)";
    bar.style.borderTop = "1px solid var(--background-modifier-border)";
    bar.style.padding = "0.4em 0.5em";
    bar.style.display = "flex";
    bar.style.gap = "0.4em";

    const input = bar.createEl("input", { type: "text" });
    input.placeholder = this.plugin.acpConnected()
      ? "Say something to the agent…"
      : "Connect an agent to interject";
    input.disabled = !this.plugin.acpConnected();
    input.style.flex = "1";
    input.style.fontSize = "0.85em";

    const send = () => {
      const text = input.value.trim();
      if (!text || !this.plugin.acpConnected()) return;
      input.value = "";
      void this.plugin.interjectAcp(docPath, text);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        send();
      }
    });
    const btn = bar.createEl("button", { text: "Send" });
    btn.style.fontSize = "0.85em";
    btn.disabled = !this.plugin.acpConnected();
    btn.addEventListener("click", send);
  }
}

function describeState(snap: ActivitySnapshot): {
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
      return { text: "⏸ Waiting for your input", color: "var(--text-warning)" };
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
    default:
      return {
        text:
          snap.stopReason && snap.stopReason !== "end_turn"
            ? `■ Stopped (${snap.stopReason})`
            : "✓ Idle",
        color: "var(--text-muted)",
      };
  }
}

function block(
  parent: HTMLElement,
  label: string,
  text: string,
  color: string,
): void {
  const wrap = parent.createDiv();
  wrap.style.margin = "0.2em 0";
  const lbl = wrap.createEl("span", { text: `${label}: ` });
  lbl.style.color = "var(--text-faint)";
  lbl.style.fontSize = "0.8em";
  const body = wrap.createEl("span");
  body.setText(text); // plain text — injection-safe, no markdown auto-fetch
  body.style.whiteSpace = "pre-wrap";
  body.style.color = color;
}

function hint(el: HTMLElement, text: string): void {
  const d = el.createDiv();
  d.setText(text);
  d.style.padding = "1em";
  d.style.opacity = "0.6";
}

/** Best-effort plain-text extraction from a tool call's untyped content[]. */
function toolContentText(content: unknown[] | undefined): string {
  if (!Array.isArray(content) || content.length === 0) return "";
  const parts: string[] = [];
  for (const c of content) {
    if (c && typeof c === "object") {
      const o = c as Record<string, unknown>;
      if (typeof o.text === "string") parts.push(o.text);
      else if (
        o.content &&
        typeof o.content === "object" &&
        typeof (o.content as { text?: unknown }).text === "string"
      ) {
        parts.push((o.content as { text: string }).text);
      }
    }
  }
  return parts.join("\n");
}

import type {
  ContentBlock,
  PlanEntry,
  SessionUpdate,
  StopReason,
  ToolCall,
} from "./protocol";

/**
 * Per-doc model of what the agent is doing — the thing the harness renders.
 *
 * ACP already streams all of this (session/update + the turn's stop reason +
 * the permission asks + the fs ops we mediate); the old code collapsed it into
 * a 2-second status flash. This store ingests the raw stream keyed by doc and
 * exposes a derived snapshot for the UI. Liveness (ACP has no heartbeat) is
 * synthesized from the time since the last update.
 *
 * Pure + clock-injectable so it's unit-tested without Obsidian.
 */

export type TurnState =
  | "idle"
  | "thinking"
  | "working"
  | "waiting"
  | "stalled"
  | "dead";

/** How long a turn can go quiet (no updates) before we flag it stalled. */
export const STALL_MS = 45_000;

interface DocActivity {
  active: boolean; // a prompt turn is in flight
  plan: PlanEntry[];
  toolCalls: ToolCall[];
  message: string; // accumulated agent_message_chunk text
  thought: string; // accumulated agent_thought_chunk text
  stopReason: StopReason | null;
  waitingPermission: boolean;
  dead: string | null; // crash message, or null
  startedAt: number | null;
  lastUpdateAt: number;
}

export interface ActivitySnapshot {
  state: TurnState;
  plan: PlanEntry[];
  toolCalls: ToolCall[];
  message: string;
  thought: string;
  stopReason: StopReason | null;
  dead: string | null;
  /** ms since the turn started, if one has. */
  elapsedMs: number;
  /** ms since the last update (drives the stalled hint). */
  quietMs: number;
  /** title of the in-progress tool call, if any. */
  currentTool: string | null;
}

export class ActivityStore {
  private readonly docs = new Map<string, DocActivity>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Subscribe to changes; returns an unsubscribe fn. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Derived render view for a doc, or null if it has no activity yet. */
  snapshot(docPath: string): ActivitySnapshot | null {
    const a = this.docs.get(docPath);
    if (!a) return null;
    const now = this.now();
    const inProgress = a.toolCalls.find((t) => t.status === "in_progress");

    let state: TurnState;
    if (a.dead) state = "dead";
    else if (a.waitingPermission) state = "waiting";
    else if (!a.active) state = "idle";
    else if (now - a.lastUpdateAt > STALL_MS) state = "stalled";
    else if (inProgress) state = "working";
    else if (a.thought || a.message) state = "thinking";
    else state = "working";

    return {
      state,
      plan: a.plan,
      toolCalls: a.toolCalls,
      message: a.message,
      thought: a.thought,
      stopReason: a.stopReason,
      dead: a.dead,
      elapsedMs: a.startedAt ? now - a.startedAt : 0,
      quietMs: now - a.lastUpdateAt,
      currentTool: inProgress?.title ?? null,
    };
  }

  /** Begin a turn: clears the previous turn's transient state. */
  turnStarted(docPath: string): void {
    const a = this.ensure(docPath);
    a.active = true;
    a.startedAt = this.now();
    a.stopReason = null;
    a.dead = null;
    a.plan = [];
    a.toolCalls = [];
    a.message = "";
    a.thought = "";
    this.bump(a);
  }

  /** End a turn with its stop reason. */
  turnEnded(docPath: string, stopReason: StopReason): void {
    const a = this.ensure(docPath);
    a.active = false;
    a.stopReason = stopReason;
    a.waitingPermission = false;
    this.bump(a);
  }

  /** A turn ended without a clean stop reason (e.g. the prompt rejected). */
  turnAborted(docPath: string): void {
    const a = this.ensure(docPath);
    a.active = false;
    a.waitingPermission = false;
    this.bump(a);
  }

  /** The subprocess exited — mark every doc with an in-flight turn dead. */
  agentExited(message: string): void {
    let changed = false;
    for (const a of this.docs.values()) {
      if (a.active && !a.dead) {
        a.dead = message;
        a.active = false;
        a.waitingPermission = false;
        a.lastUpdateAt = this.now();
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  /** Mark a permission request open/closed (the "waiting for you" state). */
  setPermission(docPath: string, open: boolean): void {
    const a = this.ensure(docPath);
    a.waitingPermission = open;
    this.bump(a);
  }

  /** The agent crashed mid-turn. */
  markDead(docPath: string, message: string): void {
    const a = this.ensure(docPath);
    a.dead = message;
    a.active = false;
    a.waitingPermission = false;
    this.bump(a);
  }

  /** Drop a doc's activity (session teardown). */
  forget(docPath: string): void {
    if (this.docs.delete(docPath)) this.emit();
  }

  /** Fold one session/update into the doc's activity. */
  ingest(docPath: string, update: SessionUpdate): void {
    const a = this.ensure(docPath);
    switch (update.sessionUpdate) {
      case "plan":
        a.plan = update.entries;
        break;
      case "tool_call":
        a.toolCalls.push({
          toolCallId: update.toolCallId,
          title: update.title,
          kind: update.kind,
          status: update.status ?? "pending",
          content: update.content,
        });
        break;
      case "tool_call_update": {
        const tc = a.toolCalls.find((t) => t.toolCallId === update.toolCallId);
        if (tc) {
          if (update.title !== undefined) tc.title = update.title;
          if (update.kind !== undefined) tc.kind = update.kind;
          if (update.status !== undefined) tc.status = update.status;
          if (update.content !== undefined) tc.content = update.content;
        } else {
          a.toolCalls.push({
            toolCallId: update.toolCallId,
            title: update.title ?? update.toolCallId,
            status: update.status ?? "in_progress",
          });
        }
        break;
      }
      case "agent_message_chunk":
        a.message += textOf(update.content);
        break;
      case "agent_thought_chunk":
        a.thought += textOf(update.content);
        break;
      // user_message_chunk / available_commands_update / current_mode_update:
      // not surfaced in the MVP harness.
    }
    this.bump(a);
  }

  private ensure(docPath: string): DocActivity {
    let a = this.docs.get(docPath);
    if (!a) {
      a = {
        active: false,
        plan: [],
        toolCalls: [],
        message: "",
        thought: "",
        stopReason: null,
        waitingPermission: false,
        dead: null,
        startedAt: null,
        lastUpdateAt: this.now(),
      };
      this.docs.set(docPath, a);
    }
    return a;
  }

  private bump(a: DocActivity): void {
    a.lastUpdateAt = this.now();
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

function textOf(content: ContentBlock | undefined): string {
  return content && content.type === "text" ? content.text : "";
}

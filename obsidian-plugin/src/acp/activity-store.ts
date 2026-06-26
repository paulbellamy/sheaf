import type {
  ContentBlock,
  PermissionOption,
  PlanEntry,
  SessionUpdate,
  StopReason,
  ToolCallLocation,
  ToolCallStatus,
} from "./protocol";

/**
 * Per-doc model of what the agent is doing — the thing the harness renders.
 *
 * ACP already streams all of this (session/update + the turn's stop reason +
 * the permission asks + the fs ops we mediate); the old code collapsed it into
 * a 2-second status flash. This store ingests the raw stream keyed by doc into
 * an ordered **timeline** (the transcript) plus derived snapshot state, and
 * synthesizes liveness (ACP has no heartbeat) from the time since last update.
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
/** Per-doc timeline cap (ring buffer) to bound memory. */
const TIMELINE_CAP = 600;

export type ActivityEvent =
  | { id: number; ts: number; kind: "turn_start" }
  | { id: number; ts: number; kind: "message"; text: string }
  | { id: number; ts: number; kind: "thought"; text: string }
  | {
      id: number;
      ts: number;
      kind: "tool";
      toolCallId: string;
      title: string;
      toolKind?: string;
      status: ToolCallStatus;
      content?: unknown[];
      locations?: ToolCallLocation[];
    }
  | { id: number; ts: number; kind: "fs"; op: "read" | "write"; path: string }
  | {
      id: number;
      ts: number;
      kind: "permission";
      permId: number;
      title: string;
      options: PermissionOption[];
      resolved?: string; // chosen optionId, or "cancelled"
    }
  | { id: number; ts: number; kind: "turn_end"; stopReason: StopReason }
  | { id: number; ts: number; kind: "crash"; message: string };

/** A new event minus the fields the store stamps. Distributive so each union
 *  variant keeps its own discriminant-specific fields. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown
  ? Omit<T, K>
  : never;
type NewEvent = DistributiveOmit<ActivityEvent, "id" | "ts">;

export interface AgentMode {
  current: string | null;
  available: Array<{ id: string; name: string }>;
}

interface DocActivity {
  active: boolean;
  plan: PlanEntry[];
  mode: AgentMode;
  commands: string[];
  timeline: ActivityEvent[];
  stopReason: StopReason | null;
  dead: string | null;
  startedAt: number | null;
  lastUpdateAt: number;
}

export interface ActivitySnapshot {
  state: TurnState;
  plan: PlanEntry[];
  mode: AgentMode;
  commands: string[];
  timeline: ActivityEvent[];
  stopReason: StopReason | null;
  dead: string | null;
  elapsedMs: number;
  quietMs: number;
  /** in-progress tool title, if any. */
  currentTool: string | null;
  /** unresolved permission events (the "waiting for you" cards). */
  pendingPermissions: Extract<ActivityEvent, { kind: "permission" }>[];
}

export class ActivityStore {
  private readonly docs = new Map<string, DocActivity>();
  private readonly listeners = new Set<() => void>();
  private nextId = 1;

  constructor(private readonly now: () => number = () => Date.now()) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  snapshot(docPath: string): ActivitySnapshot | null {
    const a = this.docs.get(docPath);
    if (!a) return null;
    const now = this.now();

    const inProgress = lastInProgressTool(a.timeline);
    const pendingPermissions = a.timeline.filter(
      (e): e is Extract<ActivityEvent, { kind: "permission" }> =>
        e.kind === "permission" && e.resolved === undefined,
    );

    let state: TurnState;
    if (a.dead) state = "dead";
    else if (pendingPermissions.length > 0) state = "waiting";
    else if (!a.active) state = "idle";
    else if (now - a.lastUpdateAt > STALL_MS) state = "stalled";
    else if (inProgress) state = "working";
    else state = "thinking";

    return {
      state,
      plan: a.plan,
      mode: a.mode,
      commands: a.commands,
      timeline: a.timeline,
      stopReason: a.stopReason,
      dead: a.dead,
      elapsedMs: a.startedAt ? now - a.startedAt : 0,
      quietMs: now - a.lastUpdateAt,
      currentTool: inProgress?.title ?? null,
      pendingPermissions,
    };
  }

  /* ------------------------------------------------------ lifecycle -- */

  turnStarted(docPath: string): void {
    const a = this.ensure(docPath);
    a.active = true;
    a.startedAt = this.now();
    a.stopReason = null;
    a.dead = null;
    a.plan = [];
    this.push(a, { kind: "turn_start" });
  }

  turnEnded(docPath: string, stopReason: StopReason): void {
    const a = this.ensure(docPath);
    a.active = false;
    a.stopReason = stopReason;
    this.push(a, { kind: "turn_end", stopReason });
  }

  turnAborted(docPath: string): void {
    const a = this.ensure(docPath);
    a.active = false;
    this.bump(a);
  }

  markDead(docPath: string, message: string): void {
    const a = this.ensure(docPath);
    a.dead = message;
    a.active = false;
    this.push(a, { kind: "crash", message });
  }

  agentExited(message: string): void {
    let changed = false;
    for (const a of this.docs.values()) {
      if (a.active && !a.dead) {
        a.dead = message;
        a.active = false;
        this.pushNoEmit(a, { kind: "crash", message });
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  forget(docPath: string): void {
    if (this.docs.delete(docPath)) this.emit();
  }

  /* ----------------------------------------------- client-side events -- */

  /** Record an fs op the client serviced for the agent. */
  fileOp(docPath: string, op: "read" | "write", path: string): void {
    this.push(this.ensure(docPath), { kind: "fs", op, path });
  }

  /** Record a permission ask; returns its id for {@link resolvePermission}. */
  recordPermission(
    docPath: string,
    title: string,
    options: PermissionOption[],
  ): number {
    const a = this.ensure(docPath);
    const permId = this.nextId; // event id doubles as the perm id
    this.push(a, { kind: "permission", permId, title, options });
    return permId;
  }

  resolvePermission(docPath: string, permId: number, outcome: string): void {
    const a = this.docs.get(docPath);
    if (!a) return;
    const ev = a.timeline.find(
      (e) => e.kind === "permission" && e.permId === permId,
    );
    if (ev && ev.kind === "permission") ev.resolved = outcome;
    this.bump(a);
  }

  /* ------------------------------------------------- session/update -- */

  setMode(docPath: string, current: string | null): void {
    const a = this.ensure(docPath);
    a.mode.current = current;
    this.bump(a);
  }

  setAvailableModes(
    docPath: string,
    available: AgentMode["available"],
    current: string | null,
  ): void {
    const a = this.ensure(docPath);
    a.mode = { current, available };
    this.bump(a);
  }

  ingest(docPath: string, update: SessionUpdate): void {
    const a = this.ensure(docPath);
    switch (update.sessionUpdate) {
      case "plan":
        a.plan = update.entries;
        this.bump(a);
        break;
      case "tool_call":
        this.push(a, {
          kind: "tool",
          toolCallId: update.toolCallId,
          title: update.title,
          toolKind: update.kind,
          status: update.status ?? "pending",
          content: update.content,
          locations: update.locations,
        });
        break;
      case "tool_call_update": {
        const ev = lastToolEvent(a.timeline, update.toolCallId);
        if (ev) {
          if (update.title !== undefined) ev.title = update.title;
          if (update.kind !== undefined) ev.toolKind = update.kind;
          if (update.status !== undefined) ev.status = update.status;
          if (update.content !== undefined) ev.content = update.content;
          if (update.locations !== undefined) ev.locations = update.locations;
          this.bump(a);
        } else {
          this.push(a, {
            kind: "tool",
            toolCallId: update.toolCallId,
            title: update.title ?? update.toolCallId,
            status: update.status ?? "in_progress",
            locations: update.locations,
          });
        }
        break;
      }
      case "agent_message_chunk":
        this.appendChunk(a, "message", textOf(update.content));
        break;
      case "agent_thought_chunk":
        this.appendChunk(a, "thought", textOf(update.content));
        break;
      case "current_mode_update":
        a.mode.current = update.currentModeId;
        this.bump(a);
        break;
      case "available_commands_update":
        a.commands = parseCommandNames(update.availableCommands);
        this.bump(a);
        break;
      // user_message_chunk: not surfaced.
    }
  }

  /* ----------------------------------------------------- internals -- */

  /** Coalesce consecutive same-kind chunks into the trailing timeline entry. */
  private appendChunk(
    a: DocActivity,
    kind: "message" | "thought",
    text: string,
  ): void {
    if (text.length === 0) {
      this.bump(a);
      return;
    }
    const last = a.timeline[a.timeline.length - 1];
    if (last && last.kind === kind) {
      last.text += text;
      this.bump(a);
    } else {
      this.push(a, { kind, text });
    }
  }

  private ensure(docPath: string): DocActivity {
    let a = this.docs.get(docPath);
    if (!a) {
      a = {
        active: false,
        plan: [],
        mode: { current: null, available: [] },
        commands: [],
        timeline: [],
        stopReason: null,
        dead: null,
        startedAt: null,
        lastUpdateAt: this.now(),
      };
      this.docs.set(docPath, a);
    }
    return a;
  }

  private push(a: DocActivity, ev: NewEvent): void {
    this.pushNoEmit(a, ev);
    this.emit();
  }

  private pushNoEmit(a: DocActivity, ev: NewEvent): void {
    a.timeline.push({ id: this.nextId++, ts: this.now(), ...ev } as ActivityEvent);
    if (a.timeline.length > TIMELINE_CAP) {
      a.timeline.splice(0, a.timeline.length - TIMELINE_CAP);
    }
    a.lastUpdateAt = this.now();
  }

  private bump(a: DocActivity): void {
    a.lastUpdateAt = this.now();
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

function lastToolEvent(
  timeline: ActivityEvent[],
  toolCallId: string,
): Extract<ActivityEvent, { kind: "tool" }> | undefined {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i];
    if (e.kind === "tool" && e.toolCallId === toolCallId) return e;
  }
  return undefined;
}

function lastInProgressTool(
  timeline: ActivityEvent[],
): Extract<ActivityEvent, { kind: "tool" }> | undefined {
  // Most-recent tool whose latest known status is in_progress.
  const seen = new Set<string>();
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i];
    if (e.kind !== "tool" || seen.has(e.toolCallId)) continue;
    seen.add(e.toolCallId);
    if (e.status === "in_progress" || e.status === "pending") return e;
  }
  return undefined;
}

function textOf(content: ContentBlock | undefined): string {
  return content && content.type === "text" ? content.text : "";
}

function parseCommandNames(commands: unknown[]): string[] {
  if (!Array.isArray(commands)) return [];
  return commands
    .map((c) =>
      c && typeof c === "object" && typeof (c as { name?: unknown }).name === "string"
        ? (c as { name: string }).name
        : null,
    )
    .filter((n): n is string => n !== null);
}

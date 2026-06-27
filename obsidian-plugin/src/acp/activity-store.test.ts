import { describe, expect, it, vi } from "vitest";

import {
  ActivityStore,
  STALL_MS,
  type ActivityEvent,
} from "./activity-store";
import { textBlock } from "./protocol";

const A = "notes/a.md";

function makeStore() {
  let t = 1000;
  const store = new ActivityStore(() => t);
  return { store, advance: (ms: number) => (t += ms) };
}

const toolStatus = (
  snap: { timeline: ActivityEvent[] },
  id: string,
): string | undefined => {
  const ev = [...snap.timeline]
    .reverse()
    .find((e) => e.kind === "tool" && e.toolCallId === id);
  return ev && ev.kind === "tool" ? ev.status : undefined;
};

const kinds = (snap: { timeline: ActivityEvent[] }) =>
  snap.timeline.map((e) => e.kind);

describe("ActivityStore — state derivation", () => {
  it("has no snapshot before any activity", () => {
    expect(new ActivityStore().snapshot(A)).toBeNull();
  });

  it("a fresh turn with no tool reads as thinking; turnEnded → idle + reason", () => {
    const { store } = makeStore();
    store.turnStarted(A);
    expect(store.snapshot(A)!.state).toBe("thinking");
    store.turnEnded(A, "end_turn");
    const s = store.snapshot(A)!;
    expect(s.state).toBe("idle");
    expect(s.stopReason).toBe("end_turn");
  });

  it("an in-progress tool reads as working and exposes the current tool", () => {
    const { store } = makeStore();
    store.turnStarted(A);
    store.ingest(A, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Edit a.md",
      status: "in_progress",
    });
    const s = store.snapshot(A)!;
    expect(s.state).toBe("working");
    expect(s.currentTool).toBe("Edit a.md");
  });

  it("tool_call_update folds onto the existing call by id", () => {
    const { store } = makeStore();
    store.turnStarted(A);
    store.ingest(A, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Edit a.md",
      status: "in_progress",
    });
    store.ingest(A, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
    });
    const s = store.snapshot(A)!;
    expect(toolStatus(s, "t1")).toBe("completed");
    expect(s.currentTool).toBeNull();
    expect(s.timeline.filter((e) => e.kind === "tool")).toHaveLength(1);
  });

  it("goes stalled only when quiet on BOTH protocol and process", () => {
    const { store, advance } = makeStore();
    store.turnStarted(A);
    advance(STALL_MS + 1);
    // No process output → both channels quiet → stalled.
    expect(store.snapshot(A)!.state).toBe("stalled");
  });

  it("stays working when the process is still emitting, even if quiet on the protocol", () => {
    const { store, advance } = makeStore();
    store.turnStarted(A);
    advance(STALL_MS + 1); // protocol quiet
    store.processOutput(); // …but the subprocess just logged something
    const s = store.snapshot(A)!;
    expect(s.state).toBe("working"); // alive, just not narrating
    expect(s.quietMs).toBeGreaterThan(STALL_MS);
    expect(s.processQuietMs).toBe(0);
  });

  it("escalates to stalled once process output also goes quiet", () => {
    const { store, advance } = makeStore();
    store.turnStarted(A);
    store.processOutput();
    advance(STALL_MS + 1); // now both protocol and process are quiet
    expect(store.snapshot(A)!.state).toBe("stalled");
  });

  it("markDead wins over everything", () => {
    const { store } = makeStore();
    store.turnStarted(A);
    store.markDead(A, "exit 1");
    const s = store.snapshot(A)!;
    expect(s.state).toBe("dead");
    expect(s.dead).toBe("exit 1");
  });

  it("agentExited marks in-flight docs dead", () => {
    const { store } = makeStore();
    store.turnStarted(A);
    store.agentExited("agent exited (code 1)");
    expect(store.snapshot(A)!.state).toBe("dead");
  });

  it("turnStarted clears the plan and stop reason but keeps the transcript", () => {
    const { store } = makeStore();
    store.turnStarted(A);
    store.ingest(A, {
      sessionUpdate: "plan",
      entries: [{ content: "x", status: "pending" }],
    });
    store.turnEnded(A, "end_turn");
    store.turnStarted(A);
    const s = store.snapshot(A)!;
    expect(s.plan).toHaveLength(0);
    expect(s.stopReason).toBeNull();
    // transcript retains both turn_start/turn_end markers
    expect(kinds(s).filter((k) => k === "turn_start")).toHaveLength(2);
  });
});

describe("ActivityStore — timeline", () => {
  it("coalesces consecutive same-kind chunks into one entry", () => {
    const { store } = makeStore();
    store.turnStarted(A);
    store.ingest(A, { sessionUpdate: "agent_message_chunk", content: textBlock("Hello ") });
    store.ingest(A, { sessionUpdate: "agent_message_chunk", content: textBlock("world") });
    const msgs = store.snapshot(A)!.timeline.filter((e) => e.kind === "message");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].kind === "message" && msgs[0].text).toBe("Hello world");
  });

  it("a thought between messages starts a new entry", () => {
    const { store } = makeStore();
    store.turnStarted(A);
    store.ingest(A, { sessionUpdate: "agent_message_chunk", content: textBlock("a") });
    store.ingest(A, { sessionUpdate: "agent_thought_chunk", content: textBlock("hmm") });
    store.ingest(A, { sessionUpdate: "agent_message_chunk", content: textBlock("b") });
    expect(kinds(store.snapshot(A)!).filter((k) => k === "message" || k === "thought"))
      .toEqual(["message", "thought", "message"]);
  });

  it("records fs ops", () => {
    const { store } = makeStore();
    store.fileOp(A, "read", "notes/a.md");
    store.fileOp(A, "write", "notes/a.md");
    const fs = store.snapshot(A)!.timeline.filter((e) => e.kind === "fs");
    expect(fs).toHaveLength(2);
    expect(fs[1].kind === "fs" && fs[1].op).toBe("write");
  });
});

describe("ActivityStore — permissions", () => {
  it("an open permission is waiting; resolving clears it", () => {
    const { store, advance } = makeStore();
    store.turnStarted(A);
    const id = store.recordPermission(A, "Write a.md", [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
    ]);
    advance(STALL_MS + 1);
    let s = store.snapshot(A)!;
    expect(s.state).toBe("waiting"); // not stalled while waiting
    expect(s.pendingPermissions).toHaveLength(1);

    store.resolvePermission(A, id, "allow");
    s = store.snapshot(A)!;
    expect(s.pendingPermissions).toHaveLength(0);
    expect(s.state).not.toBe("waiting");
    const ev = s.timeline.find((e) => e.kind === "permission");
    expect(ev && ev.kind === "permission" && ev.resolved).toBe("allow");
  });
});

describe("ActivityStore — modes + commands", () => {
  it("tracks available modes and the current one", () => {
    const { store } = makeStore();
    store.setAvailableModes(
      A,
      [
        { id: "edit", name: "Edit" },
        { id: "review", name: "Review" },
      ],
      "edit",
    );
    expect(store.snapshot(A)!.mode).toEqual({
      current: "edit",
      available: [
        { id: "edit", name: "Edit" },
        { id: "review", name: "Review" },
      ],
    });
    store.ingest(A, { sessionUpdate: "current_mode_update", currentModeId: "review" });
    expect(store.snapshot(A)!.mode.current).toBe("review");
  });

  it("parses available command names defensively", () => {
    const { store } = makeStore();
    store.turnStarted(A);
    store.ingest(A, {
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "review" }, { name: "summarize" }, { nope: 1 }],
    });
    expect(store.snapshot(A)!.commands).toEqual(["review", "summarize"]);
  });
});

describe("ActivityStore — subscriptions", () => {
  it("notifies on change and stops after unsubscribe", () => {
    const { store } = makeStore();
    const fn = vi.fn();
    const unsub = store.subscribe(fn);
    store.turnStarted(A);
    store.ingest(A, { sessionUpdate: "agent_message_chunk", content: textBlock("x") });
    const n = fn.mock.calls.length;
    expect(n).toBeGreaterThanOrEqual(2);
    unsub();
    store.turnEnded(A, "end_turn");
    expect(fn.mock.calls.length).toBe(n);
  });
});

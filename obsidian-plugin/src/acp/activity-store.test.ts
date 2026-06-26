import { describe, expect, it, vi } from "vitest";

import { ActivityStore, STALL_MS } from "./activity-store";
import { textBlock, type SessionUpdate } from "./protocol";

const A = "notes/a.md";

/** A store with a controllable clock. */
function makeStore() {
  let t = 1000;
  const store = new ActivityStore(() => t);
  return {
    store,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

describe("ActivityStore — turn lifecycle + state derivation", () => {
  it("has no snapshot before any activity", () => {
    expect(new ActivityStore().snapshot(A)).toBeNull();
  });

  it("turnStarted → working; turnEnded → idle with stop reason", () => {
    const { store } = makeStore();
    store.turnStarted(A);
    expect(store.snapshot(A)!.state).toBe("working");
    store.turnEnded(A, "end_turn");
    const s = store.snapshot(A)!;
    expect(s.state).toBe("idle");
    expect(s.stopReason).toBe("end_turn");
  });

  it("a thought chunk with no tool in progress reads as thinking", () => {
    const { store } = makeStore();
    store.turnStarted(A);
    store.ingest(A, {
      sessionUpdate: "agent_thought_chunk",
      content: textBlock("hmm"),
    });
    const s = store.snapshot(A)!;
    expect(s.state).toBe("thinking");
    expect(s.thought).toBe("hmm");
  });

  it("an in-progress tool call reads as working and exposes the current tool", () => {
    const { store } = makeStore();
    store.turnStarted(A);
    store.ingest(A, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Edit a.md",
      status: "in_progress",
    } as SessionUpdate);
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
    } as SessionUpdate);
    store.ingest(A, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
    } as SessionUpdate);
    const s = store.snapshot(A)!;
    expect(s.toolCalls).toHaveLength(1);
    expect(s.toolCalls[0].status).toBe("completed");
    expect(s.currentTool).toBeNull(); // none in progress now
  });

  it("plan is a wholesale snapshot replace", () => {
    const { store } = makeStore();
    store.turnStarted(A);
    store.ingest(A, {
      sessionUpdate: "plan",
      entries: [{ content: "step one", status: "in_progress" }],
    });
    store.ingest(A, {
      sessionUpdate: "plan",
      entries: [
        { content: "step one", status: "completed" },
        { content: "step two", status: "pending" },
      ],
    });
    expect(store.snapshot(A)!.plan).toHaveLength(2);
    expect(store.snapshot(A)!.plan[0].status).toBe("completed");
  });

  it("goes stalled after STALL_MS of quiet while active", () => {
    const { store, advance } = makeStore();
    store.turnStarted(A);
    expect(store.snapshot(A)!.state).toBe("working");
    advance(STALL_MS + 1);
    const s = store.snapshot(A)!;
    expect(s.state).toBe("stalled");
    expect(s.quietMs).toBeGreaterThan(STALL_MS);
  });

  it("waiting (permission) overrides the stall timer", () => {
    const { store, advance } = makeStore();
    store.turnStarted(A);
    store.setPermission(A, true);
    advance(STALL_MS + 1);
    expect(store.snapshot(A)!.state).toBe("waiting"); // not stalled while waiting
    // Answering the prompt counts as activity, so the resumed turn is working.
    store.setPermission(A, false);
    expect(store.snapshot(A)!.state).toBe("working");
  });

  it("markDead wins over everything", () => {
    const { store } = makeStore();
    store.turnStarted(A);
    store.markDead(A, "exit 1");
    const s = store.snapshot(A)!;
    expect(s.state).toBe("dead");
    expect(s.dead).toBe("exit 1");
  });

  it("turnStarted clears the previous turn's plan/tools/buffers", () => {
    const { store } = makeStore();
    store.turnStarted(A);
    store.ingest(A, {
      sessionUpdate: "agent_message_chunk",
      content: textBlock("old"),
    });
    store.turnEnded(A, "end_turn");
    store.turnStarted(A);
    const s = store.snapshot(A)!;
    expect(s.message).toBe("");
    expect(s.toolCalls).toHaveLength(0);
    expect(s.stopReason).toBeNull();
  });
});

describe("ActivityStore — subscriptions", () => {
  it("notifies subscribers on change and stops after unsubscribe", () => {
    const { store } = makeStore();
    const fn = vi.fn();
    const unsub = store.subscribe(fn);
    store.turnStarted(A);
    store.ingest(A, { sessionUpdate: "agent_message_chunk", content: textBlock("x") });
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(2);
    const count = fn.mock.calls.length;
    unsub();
    store.turnEnded(A, "end_turn");
    expect(fn.mock.calls.length).toBe(count);
  });

  it("forget drops the doc and notifies", () => {
    const { store } = makeStore();
    const fn = vi.fn();
    store.turnStarted(A);
    store.subscribe(fn);
    store.forget(A);
    expect(store.snapshot(A)).toBeNull();
    expect(fn).toHaveBeenCalled();
  });
});

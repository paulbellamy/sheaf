import * as os from "node:os";
import { describe, expect, it } from "vitest";

import { StubBackend } from "./backend/stub";
import type { BackendEvent } from "./backend/index";
import { pipeEvents, reserveSseClient } from "./events";

describe("pipeEvents", () => {
  it("unsubscribes the listener when the primed/replayed frame fails to write", () => {
    // subscribe() emits agent_presence synchronously, so for role=agent the
    // first write happens *during* subscribe. If it throws, cleanup runs while
    // `unsubscribe` is still the no-op — the listener must not leak.
    const backend = new StubBackend(os.tmpdir());
    const throwingSink = {
      write: () => {
        throw new Error("socket gone");
      },
      close: () => {},
    };
    reserveSseClient();
    pipeEvents(backend, throwingSink, { role: "agent" });

    // A leaked agent listener would still count toward presence, so a fresh UI
    // subscriber would replay connected:true. With the leak fixed it's false.
    const seen: BackendEvent[] = [];
    backend.subscribe((e) => seen.push(e), { role: "ui" });
    const presence = seen.filter((e) => e.kind === "agent_presence");
    expect(presence).toHaveLength(1);
    expect(presence[0]).toMatchObject({ connected: false });
  });
});

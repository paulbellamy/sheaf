import { describe, expect, it, vi } from "vitest";

import { SessionManager } from "./session-manager";

describe("SessionManager — one session per doc", () => {
  it("creates a session lazily and caches it (factory runs once per doc)", async () => {
    let n = 0;
    const factory = vi.fn(async (doc: string) => `sess_${doc}_${n++}`);
    const mgr = new SessionManager(factory);

    const first = await mgr.sessionFor("a.md");
    const second = await mgr.sessionFor("a.md");
    expect(first).toBe(second);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight creation across concurrent callers", async () => {
    const factory = vi.fn(async () => "sess_1");
    const mgr = new SessionManager(factory);
    const [a, b] = await Promise.all([
      mgr.sessionFor("a.md"),
      mgr.sessionFor("a.md"),
    ]);
    expect(a).toBe("sess_1");
    expect(b).toBe("sess_1");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("gives different docs different sessions and maps each back", async () => {
    let n = 0;
    const mgr = new SessionManager(async () => `sess_${n++}`);
    const sa = await mgr.sessionFor("a.md");
    const sb = await mgr.sessionFor("b.md");
    expect(sa).not.toBe(sb);
    expect(mgr.docForSession(sa)).toBe("a.md");
    expect(mgr.docForSession(sb)).toBe("b.md");
    expect(mgr.docForSession("unknown")).toBeUndefined();
  });

  it("does not cache a failed creation — a later call retries", async () => {
    const factory = vi
      .fn<(doc: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error("spawn failed"))
      .mockResolvedValueOnce("sess_ok");
    const mgr = new SessionManager(factory);

    await expect(mgr.sessionFor("a.md")).rejects.toThrow("spawn failed");
    await expect(mgr.sessionFor("a.md")).resolves.toBe("sess_ok");
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("forget clears both mappings and lets a new session be created", async () => {
    let n = 0;
    const factory = vi.fn(async () => `sess_${n++}`);
    const mgr = new SessionManager(factory);

    const sa = await mgr.sessionFor("a.md");
    await mgr.forget("a.md");
    expect(mgr.docForSession(sa)).toBeUndefined();
    expect(mgr.has("a.md")).toBe(false);

    const sa2 = await mgr.sessionFor("a.md");
    expect(sa2).not.toBe(sa);
    expect(factory).toHaveBeenCalledTimes(2);
  });
});

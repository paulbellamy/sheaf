/**
 * One ACP session per doc (design §3.1): the doc is the concurrency boundary —
 * prompt turns serialize within a session, so a doc's threads are worked one at
 * a time, while different docs run concurrently in their own sessions.
 *
 * This maps docPath ↔ sessionId and lazily creates a session on first use via
 * an injected factory (which, in the glue, calls `session/new` with the vault
 * cwd and the sheaf MCP scoped to that doc). The reverse map lets incoming
 * agent→client calls (fs/*, request_permission) — which carry only a sessionId
 * — be routed back to their doc. Pure / unit-tested with a fake factory.
 */

export type SessionFactory = (docPath: string) => Promise<string>;

export class SessionManager {
  private readonly byDoc = new Map<string, Promise<string>>();
  private readonly bySession = new Map<string, string>();

  constructor(private readonly factory: SessionFactory) {}

  /**
   * The session id for a doc, created on first use and cached thereafter.
   * Concurrent callers share the one in-flight creation (the factory runs
   * once); a failed creation is not cached, so a later call retries.
   */
  sessionFor(docPath: string): Promise<string> {
    const existing = this.byDoc.get(docPath);
    if (existing) return existing;
    const created = this.factory(docPath)
      .then((sessionId) => {
        this.bySession.set(sessionId, docPath);
        return sessionId;
      })
      .catch((e) => {
        this.byDoc.delete(docPath); // don't cache a failure — allow retry
        throw e;
      });
    this.byDoc.set(docPath, created);
    return created;
  }

  /** Which doc a session belongs to — for routing incoming fs/permission calls. */
  docForSession(sessionId: string): string | undefined {
    return this.bySession.get(sessionId);
  }

  /** Whether a doc already has a session (created or in flight). */
  has(docPath: string): boolean {
    return this.byDoc.has(docPath);
  }

  /** Forget a doc's session mappings (teardown). Safe if creation failed. */
  async forget(docPath: string): Promise<void> {
    const created = this.byDoc.get(docPath);
    this.byDoc.delete(docPath);
    if (!created) return;
    try {
      this.bySession.delete(await created);
    } catch {
      // creation failed; nothing to unmap
    }
  }
}

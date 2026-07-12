export type BackendEvent =
  | { kind: "thread_changed"; thread_id: string; target_paths: string[] }
  | { kind: "doc_changed"; path: string }
  | { kind: "draft_changed"; draft_id: string; path: string }
  | {
      kind: "draft_state";
      draft_id: string;
      state: "open" | "submitted" | "accepted" | "declined";
    }
  | { kind: "draft_created"; draft_id: string; base_path: string }
  | {
      kind: "draft_merged";
      draft_id: string;
      target_paths: string[];
      versions: Array<{ path: string; from: number; to: number }>;
    }
  | { kind: "agent_presence"; connected: boolean; last_seen?: number }
  /**
   * The stream can't prove continuity with our last-seen position (fresh
   * connect, or a reconnect after the server restarted). Events may have
   * been missed — consumers should re-sync from the REST API.
   */
  | { kind: "stream_reset" };

export type EventListener = (event: BackendEvent) => void;

/**
 * Subscribes to sheaf's SSE stream. Reconnects with exponential backoff.
 * Obsidian's `requestUrl` is one-shot, so this uses the global `fetch` to
 * get a streaming body — fine on desktop where there's no CORS gate against
 * `localhost`.
 */
export class SheafEventStream {
  private abort: AbortController | null = null;
  private stopped = false;
  private backoffMs = 500;
  private readonly maxBackoffMs = 15_000;
  /**
   * Last SSE `id:` seen, sent back as `Last-Event-ID` on reconnect so the
   * server replays what we missed. When it can't (server restarted, buffer
   * outrun), it sends a `stream_reset` event instead — either way a
   * reconnect gap is never silent.
   */
  private lastEventId: string | null = null;

  constructor(
    private baseUrl: string,
    private listener: EventListener,
  ) {}

  setBaseUrl(url: string): void {
    this.baseUrl = url;
    this.restart();
  }

  start(): void {
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
    this.abort = null;
  }

  private restart(): void {
    this.abort?.abort();
    this.abort = null;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      this.abort = new AbortController();
      try {
        const headers: Record<string, string> = {
          accept: "text/event-stream",
        };
        if (this.lastEventId) headers["last-event-id"] = this.lastEventId;
        const res = await fetch(
          `${this.baseUrl}/api/ui/drafts/stream?role=ui`,
          {
            headers,
            signal: this.abort.signal,
          },
        );
        if (!res.ok || !res.body) {
          throw new Error(`HTTP ${res.status}`);
        }
        this.backoffMs = 500;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (!this.stopped) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            for (const line of frame.split("\n")) {
              if (line.startsWith("id:")) {
                const id = line.slice(3).trim();
                if (id) this.lastEventId = id;
                continue;
              }
              if (!line.startsWith("data:")) continue;
              const payload = line.slice(5).trimStart();
              if (!payload) continue;
              try {
                const event = JSON.parse(payload) as BackendEvent;
                this.listener(event);
              } catch {
                // ignore malformed
              }
            }
          }
        }
      } catch (err) {
        if (this.stopped) return;
        // network blip — fall through to backoff
      }
      if (this.stopped) return;
      await new Promise((r) => setTimeout(r, this.backoffMs));
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    }
  }
}

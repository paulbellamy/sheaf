import { requestUrl } from "obsidian";

export type ThreadTarget =
  | { path: string; scope: "doc" }
  | {
      path: string;
      scope: "range";
      anchor: {
        rel_pos: string;
        content_hash: string;
        anchored_text: string;
        context_before: string;
        context_after: string;
      };
    };

export type ThreadDraftBody = { new_md: string; name?: string };

export type ThreadMessage = {
  author: string;
  ts: number;
  body: string;
  draft?: ThreadDraftBody;
  draft_options?: ThreadDraftBody[];
};

export type Thread = {
  id: string;
  created: number;
  status: "open" | "accepted" | "declined" | "archived";
  draft_id?: string;
  targets: ThreadTarget[];
  messages: ThreadMessage[];
};

export class SheafApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "SheafApiError";
  }
}

function describeError(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    const e = body as { error?: string; details?: unknown };
    if (typeof e.error === "string") return `${status}: ${e.error}`;
  }
  return `HTTP ${status}`;
}

export class SheafClient {
  constructor(private baseUrl: string) {}

  setBaseUrl(url: string): void {
    this.baseUrl = url;
  }

  async listThreads(docPath: string): Promise<Thread[]> {
    const url = `${this.baseUrl}/api/ui/threads?path=${encodeURIComponent(docPath)}&ref=main`;
    const res = await requestUrl({ url, method: "GET", throw: false });
    if (res.status >= 400) {
      throw new SheafApiError(describeError(res.status, res.json), res.status, res.json);
    }
    return (res.json as { threads: Thread[] }).threads;
  }

  async addThread(
    docPath: string,
    charRange: { from: number; to: number } | null,
    message: string,
  ): Promise<string> {
    const url = `${this.baseUrl}/api/ui/threads?ref=main`;
    const target =
      charRange === null
        ? { scope: "doc" as const }
        : { scope: "range" as const, char_range: charRange };
    const res = await requestUrl({
      url,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: docPath,
        targets: [target],
        message,
      }),
      throw: false,
    });
    if (res.status >= 400) {
      throw new SheafApiError(describeError(res.status, res.json), res.status, res.json);
    }
    return (res.json as { thread_id: string }).thread_id;
  }

  async replyThread(threadId: string, message: string): Promise<void> {
    const url = `${this.baseUrl}/api/ui/threads/${threadId}/reply`;
    const res = await requestUrl({
      url,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
      throw: false,
    });
    if (res.status >= 400) {
      throw new SheafApiError(describeError(res.status, res.json), res.status, res.json);
    }
  }

  /**
   * Resolve a thread. Pass `optionIndex` to apply that variant from the
   * latest `draft_options` payload before resolving; omit to dismiss the
   * thread without applying anything (uses `?apply=false` so threads with
   * variants don't surprise-apply option 0).
   */
  async resolveThread(threadId: string, optionIndex?: number): Promise<void> {
    const url =
      optionIndex === undefined
        ? `${this.baseUrl}/api/ui/threads/${threadId}/resolve?apply=false`
        : `${this.baseUrl}/api/ui/threads/${threadId}/resolve?option_index=${optionIndex}`;
    const res = await requestUrl({ url, method: "POST", throw: false });
    if (res.status >= 400) {
      throw new SheafApiError(describeError(res.status, res.json), res.status, res.json);
    }
  }

  async ping(): Promise<boolean> {
    try {
      const res = await requestUrl({
        url: `${this.baseUrl}/api/ui/docs`,
        method: "GET",
        throw: false,
      });
      return res.status < 500;
    } catch {
      return false;
    }
  }
}


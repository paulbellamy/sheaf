import { requestUrl } from "obsidian";

export type Thread = {
  id: string;
  created: number;
  status: "open" | "accepted" | "declined" | "archived";
  draft_id?: string;
  targets: Array<{
    path: string;
    anchor: {
      rel_pos: string;
      content_hash: string;
      anchored_text: string;
      context_before: string;
      context_after: string;
    };
  }>;
  messages: Array<{
    author: string;
    ts: number;
    body: string;
  }>;
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
    charRange: { from: number; to: number },
    message: string,
  ): Promise<string> {
    const url = `${this.baseUrl}/api/ui/threads?ref=main`;
    const res = await requestUrl({
      url,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: docPath,
        targets: [{ char_range: charRange }],
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

  async resolveThread(threadId: string): Promise<void> {
    const url = `${this.baseUrl}/api/ui/threads/${threadId}/resolve`;
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


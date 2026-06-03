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

export type ThreadDraftBody = {
  new_md: string;
  name?: string;
  description?: string;
};

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
   * Send the user's option pick back to the agent (AskUserQuestion-style):
   * post it as a reply so the agent gets a `thread_changed` and makes the
   * real edit. The option's `new_md` is a preview, not applied verbatim — it
   * may be an illustrative sample, so we never write it to the doc here.
   */
  async chooseVariant(
    threadId: string,
    optionNumber: number,
    name: string,
  ): Promise<void> {
    await this.replyThread(
      threadId,
      `Selected option ${optionNumber}: "${name}". Please action this choice, then resolve the thread.`,
    );
  }

  /**
   * "Address" a virtual review comment: post a directive reply (as the user)
   * asking the agent to action the persona's note, scoped to its anchor. This
   * is the approval gate — until a user message lands, a `review:*` thread sits
   * outside the agent's queue (its latest author is a persona, not the user).
   * Distinct from a plain discussion reply, which the agent answers without
   * editing the doc.
   */
  async addressReview(threadId: string): Promise<void> {
    await this.replyThread(
      threadId,
      "Address this — make the change this review note calls for, scoped to the anchored passage, then resolve the thread.",
    );
  }

  /**
   * Resolve (dismiss) a thread without applying anything — used by the plain
   * "Resolve" button, including on threads that carry variants the user chose
   * not to take. Uses `?apply=false` so nothing is written to the doc.
   */
  async resolveThread(threadId: string): Promise<void> {
    const url = `${this.baseUrl}/api/ui/threads/${threadId}/resolve?apply=false`;
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


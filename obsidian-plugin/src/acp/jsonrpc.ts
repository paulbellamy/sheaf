/**
 * A minimal JSON-RPC 2.0 peer for ACP over a line-delimited transport.
 *
 * ACP frames each message as one line of JSON over the agent subprocess's
 * stdio. This peer is transport-agnostic: it takes a `write(line)` sink and is
 * fed incoming lines via `receive(line)`, so it's exercised in tests against a
 * fake transport with no real process. The subprocess wiring (spawn, split
 * stdout on "\n") lives in the Obsidian glue, not here.
 *
 * It is symmetric — ACP needs the client to both *call* the agent
 * (initialize / session.new / prompt) and *serve* the agent's calls back
 * (fs/read, fs/write, request_permission) — so the peer handles outgoing
 * requests/notifications and incoming requests/notifications alike.
 */

export type JsonRpcId = number | string;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** Standard JSON-RPC error codes we emit. */
export const RPC_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  internal: -32603,
} as const;

/** An error carrying a JSON-RPC error payload (thrown by a rejected request). */
export class JsonRpcResponseError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "JsonRpcResponseError";
  }
}

export type RequestHandler = (params: unknown) => Promise<unknown> | unknown;
export type NotificationHandler = (params: unknown) => void;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
};

export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private closed = false;

  /** @param write Sink for one outgoing message; the peer appends the newline. */
  constructor(private readonly write: (line: string) => void) {}

  /** Register a handler for an incoming request `method` (replaces any prior). */
  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  /** Register a handler for an incoming notification `method`. */
  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  /** Call the peer and await its result; rejects on an error response. */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("JsonRpcPeer is closed"));
    }
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
    });
    this.send({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  /** Fire-and-forget notification (no id, no response). */
  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** Feed one incoming line of JSON. Malformed lines are ignored (logged). */
  receive(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      console.error("acp: dropping malformed JSON-RPC line", trimmed);
      return;
    }
    const hasId = "id" in msg && msg.id !== null && msg.id !== undefined;
    const isResponse =
      hasId && typeof msg.method !== "string" && ("result" in msg || "error" in msg);
    if (isResponse) {
      this.handleResponse(msg);
    } else if (typeof msg.method === "string") {
      if (hasId) {
        void this.handleRequest(msg.id as JsonRpcId, msg.method, msg.params);
      } else {
        this.handleNotification(msg.method, msg.params);
      }
    }
  }

  /** Reject all in-flight requests; further calls are no-ops. Idempotent. */
  close(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    const err = new Error(reason ?? "JsonRpcPeer closed");
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  private handleResponse(msg: Record<string, unknown>): void {
    const id = msg.id as JsonRpcId;
    const pending = this.pending.get(id);
    if (!pending) return; // unknown id — late/duplicate response, ignore
    this.pending.delete(id);
    if ("error" in msg && msg.error) {
      const e = msg.error as JsonRpcError;
      pending.reject(new JsonRpcResponseError(e.code, e.message, e.data));
    } else {
      pending.resolve(msg.result);
    }
  }

  private async handleRequest(
    id: JsonRpcId,
    method: string,
    params: unknown,
  ): Promise<void> {
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      this.send({
        jsonrpc: "2.0",
        id,
        error: { code: RPC_ERROR.methodNotFound, message: `method not found: ${method}` },
      });
      return;
    }
    try {
      const result = await handler(params);
      this.send({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.send({
        jsonrpc: "2.0",
        id,
        error: { code: RPC_ERROR.internal, message },
      });
    }
  }

  private handleNotification(method: string, params: unknown): void {
    const handler = this.notificationHandlers.get(method);
    if (handler) handler(params);
  }

  private send(message: unknown): void {
    // Drop anything produced after close — e.g. a request handler (permission
    // modal) that resolves after the agent died must not write to a dead pipe.
    if (this.closed) return;
    this.write(JSON.stringify(message) + "\n");
  }
}

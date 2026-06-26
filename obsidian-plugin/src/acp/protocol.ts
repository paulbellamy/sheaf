/**
 * ACP message shapes — the subset sheaf uses. See
 * https://agentclientprotocol.com. Property names are camelCase; discriminator
 * fields (`type`, `sessionUpdate`, `outcome`) are snake_case per the spec.
 *
 * Kept deliberately partial: we type what the client sends and the handful of
 * agent→client calls we service. Unknown fields pass through untyped.
 */

/** The ACP protocol version sheaf implements against. */
export const ACP_PROTOCOL_VERSION = 1;

/** JSON-RPC method names. Client→agent unless noted. */
export const ACP_METHOD = {
  initialize: "initialize",
  authenticate: "authenticate",
  newSession: "session/new",
  loadSession: "session/load",
  prompt: "session/prompt",
  setMode: "session/set_mode",
  cancel: "session/cancel", // notification, client→agent
  // agent→client:
  sessionUpdate: "session/update", // notification
  requestPermission: "session/request_permission",
  readTextFile: "fs/read_text_file",
  writeTextFile: "fs/write_text_file",
} as const;

/* -------------------------------------------------------------- content -- */

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "resource_link"; uri: string; name: string }
  | { type: "resource"; resource: unknown }
  | { type: "image"; mimeType: string; data: string }
  | { type: "audio"; mimeType: string; data: string };

export function textBlock(text: string): ContentBlock {
  return { type: "text", text };
}

/* ------------------------------------------------------- initialize -- */

export interface InitializeParams {
  protocolVersion: number;
  clientCapabilities: {
    fs: { readTextFile: boolean; writeTextFile: boolean };
    terminal?: boolean;
  };
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities?: {
    loadSession?: boolean;
    promptCapabilities?: Record<string, boolean>;
  };
  authMethods?: Array<{ id: string; name: string; description?: string }>;
}

/* ----------------------------------------------------- mcp servers -- */

/** ACP wire shapes for MCP env vars / HTTP headers: arrays of {name,value},
 *  both required per the v1 schema (not maps, not optional). */
export interface EnvVariable {
  name: string;
  value: string;
}
export interface HttpHeader {
  name: string;
  value: string;
}

export type McpServerConfig =
  | { name: string; command: string; args: string[]; env: EnvVariable[] }
  | { type: "http"; name: string; url: string; headers: HttpHeader[] };

/* ----------------------------------------------------- session.new -- */

export interface NewSessionParams {
  cwd: string;
  mcpServers: McpServerConfig[];
}

export interface NewSessionResult {
  sessionId: string;
  modes?: { currentModeId: string; availableModes: Array<{ id: string; name: string }> };
}

export interface LoadSessionParams {
  sessionId: string;
  cwd: string;
  mcpServers: McpServerConfig[];
}

/* -------------------------------------------------------- prompt -- */

export interface PromptParams {
  sessionId: string;
  prompt: ContentBlock[];
}

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

export interface PromptResult {
  stopReason: StopReason;
}

export interface CancelParams {
  sessionId: string;
}

/* --------------------------------------------------- session/update -- */

export interface SessionNotification {
  sessionId: string;
  update: SessionUpdate;
}

export type SessionUpdate =
  | { sessionUpdate: "agent_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_thought_chunk"; content: ContentBlock }
  | { sessionUpdate: "user_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "plan"; entries: PlanEntry[] }
  | ({ sessionUpdate: "tool_call" } & ToolCall)
  | ({ sessionUpdate: "tool_call_update" } & Partial<ToolCall> & { toolCallId: string })
  | { sessionUpdate: "available_commands_update"; availableCommands: unknown[] }
  | { sessionUpdate: "current_mode_update"; currentModeId: string };

export interface PlanEntry {
  content: string;
  priority?: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export interface ToolCall {
  toolCallId: string;
  title: string;
  kind?: string;
  status?: ToolCallStatus;
  content?: unknown[];
}

/* --------------------------------------------------- permission -- */

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface RequestPermissionParams {
  sessionId: string;
  toolCall: { toolCallId: string; title?: string };
  options: PermissionOption[];
}

export type RequestPermissionResult = {
  outcome:
    | { outcome: "selected"; optionId: string }
    | { outcome: "cancelled" };
};

/* ----------------------------------------------------------- fs -- */

export interface ReadTextFileParams {
  sessionId: string;
  path: string;
  line?: number;
  limit?: number;
}

export interface ReadTextFileResult {
  content: string;
}

export interface WriteTextFileParams {
  sessionId: string;
  path: string;
  content: string;
}

export type ThreadKind = "redline" | "structural" | "note";

export type ThreadState = "pending" | "submitted" | "accepted" | "declined";

export type Thread = {
  id: string;
  kind: ThreadKind;
  note: string;
  state: ThreadState;
  createdAt: number;
  structural?: { label: string; range?: { from: number; to: number } };
  anchor?: { from: number; to: number };
  autoFocusNote?: boolean;
  collapsed?: boolean;
};

export type Review = {
  id: string;
  coverNote: string;
  verdict: "comment" | "approve" | "request-changes";
  threadIds: string[];
  submittedAt: number;
};

export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

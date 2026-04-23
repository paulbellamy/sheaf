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
  // Use crypto.randomUUID() when available for collision-resistant ids.
  // Fall back to Math.random on older runtimes (e.g. non-secure contexts).
  const uuid =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${uuid}`;
}

import type { ThreadMessage } from "@/lib/mcp/backend";

export type { ThreadMessage };

export type ThreadKind = "redline" | "structural" | "note";

export type ThreadState = "pending" | "submitted" | "accepted" | "declined";

export type ThreadDraftOption = { name: string; new_md: string };

export type Thread = {
  id: string;
  kind: ThreadKind;
  note: string;
  state: ThreadState;
  createdAt: number;
  structural?: { label: string; range?: { from: number; to: number } };
  anchor?: { from: number; to: number };
  /**
   * Server-side anchor hint for threads hydrated from the backend. The server
   * stores positions as MD char offsets, but the client uses ProseMirror
   * positions; `getAnchorTop` resolves this lazily by text-searching the live
   * PM doc for `anchored_text` (closest occurrence to `char_range.from`).
   */
  serverAnchor?: {
    char_range: { from: number; to: number };
    anchored_text: string;
  };
  autoFocusNote?: boolean;
  collapsed?: boolean;
  /**
   * Server-side message history. Populated for submitted/accepted threads
   * hydrated from the backend; absent on pending local threads.
   */
  messages?: ThreadMessage[];
  /**
   * Multi-option α payload surfaced from the latest message that carries
   * `draft_options`. Phase F: when set with length >= 2, the thread card
   * renders a leaf selector instead of the single-payload redline visual.
   */
  draftOptions?: ThreadDraftOption[];
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

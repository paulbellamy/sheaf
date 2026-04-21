import type { ThreadSummary } from "@/lib/mcp/backend";
import type { Thread as UiThread } from "@/lib/types";

export function backendSummaryToUiThread(s: ThreadSummary): UiThread {
  return {
    id: s.id,
    kind: "note",
    note: s.last_message_preview,
    state: s.status === "accepted" || s.status === "archived"
      ? "accepted"
      : s.status === "declined"
        ? "declined"
        : "submitted",
    createdAt: s.created,
  };
}

import type { ReviewPersona } from "./settings";
import type { Thread } from "./sheaf-client";

/**
 * Marker that opens a panel-review request thread. The agent recognizes this
 * prefix (see the MCP ReadMe "Panel review" section) and channels the listed
 * roles instead of treating the thread as an ordinary edit brief.
 */
export const PANEL_REVIEW_MARKER = "[sheaf:panel-review]";

/** Author-handle prefix for a virtual (simulated) review comment. */
export const REVIEW_AUTHOR_PREFIX = "review:";

/**
 * Build the doc-level request message. It both *signals* the agent (marker)
 * and *carries the roster* — the agent only sees threads, so the selected
 * personas have to travel in-band. Briefs are trimmed to keep the request
 * legible; the role id becomes the `review:<id>` author the agent posts under.
 */
export function buildPanelRequestMessage(personas: ReviewPersona[]): string {
  const roles = personas
    .map((p) => {
      const brief = p.brief.trim().replace(/\s+/g, " ");
      return `- review:${p.id} — ${p.name}${brief ? `: ${brief}` : ""}`;
    })
    .join("\n");

  return [
    PANEL_REVIEW_MARKER,
    "Run a panel review of this doc. For each role below, launch a clean subagent with the doc and only that role's brief so the perspectives stay independent, then synthesize the findings — drop weak or duplicate points — and post the survivors as separate, anchored threads, authored `review:<id>`, one thread per substantive point. Stay silent where a role has nothing material to add; a short sharp panel beats an exhaustive one.",
    "Do not edit the doc and do not resolve the review threads you create — they are mine to address or dismiss.",
    "",
    "Roles:",
    roles,
  ].join("\n");
}

/** True if a thread is a panel-review *request* (the human's trigger). */
export function isPanelRequest(thread: Thread): boolean {
  return thread.messages[0]?.body.startsWith(PANEL_REVIEW_MARKER) ?? false;
}

/**
 * The persona handle of a virtual review comment, or null for ordinary
 * threads. Keyed off the first message's author (`review:<id>`); the `<id>`
 * is returned so the UI can label the card.
 */
export function reviewPersonaId(thread: Thread): string | null {
  const author = thread.messages[0]?.author ?? "";
  return author.startsWith(REVIEW_AUTHOR_PREFIX)
    ? author.slice(REVIEW_AUTHOR_PREFIX.length)
    : null;
}

/** Prettify a persona id (`on-call-sre` → `On-call sre`) for display. */
export function prettyPersona(id: string): string {
  const s = id.replace(/[-_]+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : id;
}

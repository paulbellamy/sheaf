/**
 * Coarse "how long ago" label for thread messages. Intentionally lo-fi:
 * minute/hour/day granularity, no locale formatting, no pluralization quirks.
 * Falls back to a short date once the value crosses a week.
 */
export function formatRelative(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;
  if (diff < 45_000) return "just now";
  if (diff < hr) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hr)}h ago`;
  if (diff < 2 * day) return "yesterday";
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

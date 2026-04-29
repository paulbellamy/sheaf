#!/usr/bin/env node
// Streams sheaf backend events from /api/ui/drafts/stream and emits one
// compact JSON line per event. Intended as the stdin of Claude Code's
// `Monitor` tool so an idle agent wakes on each mutation.
//
// Usage:
//   node scripts/watch-events.mjs
// Endpoint override: SHEAF_STREAM_URL (default http://localhost:3000/api/ui/drafts/stream).
//
// We append `role=agent` to the URL so the backend counts this watcher
// toward `agent_presence` (Phase E). The default for the SSE route is
// `role=ui`, which is what plain browser tabs use.

const baseUrl =
  process.env.SHEAF_STREAM_URL ??
  "http://localhost:3000/api/ui/drafts/stream";

const url = (() => {
  try {
    const u = new URL(baseUrl);
    if (!u.searchParams.has("role")) u.searchParams.set("role", "agent");
    return u.toString();
  } catch {
    // Non-absolute override (rare); fall back to a string append.
    return baseUrl.includes("?")
      ? `${baseUrl}&role=agent`
      : `${baseUrl}?role=agent`;
  }
})();

let backoffMs = 500;
const maxBackoffMs = 15_000;

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

while (true) {
  try {
    const res = await fetch(url, { headers: { accept: "text/event-stream" } });
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}`);
    }
    backoffMs = 500;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trimStart();
          if (!payload) continue;
          try {
            const event = JSON.parse(payload);
            process.stdout.write(JSON.stringify(event) + "\n");
          } catch {
            process.stderr.write(`skip malformed frame: ${payload}\n`);
          }
        }
      }
    }
    process.stderr.write("stream closed, reconnecting\n");
  } catch (err) {
    process.stderr.write(`connect failed: ${err.message}; retry in ${backoffMs}ms\n`);
  }
  await new Promise((r) => setTimeout(r, backoffMs));
  backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
}

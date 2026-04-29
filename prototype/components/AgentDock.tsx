"use client";

import { useEffect, useState } from "react";

import { subscribeBackendEvents } from "@/lib/hooks/useBackendEvents";
import { formatRelative } from "@/lib/time";

type Presence = {
  connected: boolean;
  lastSeen?: number;
};

/**
 * Phase E: top-chrome indicator showing whether an MCP/event-watcher
 * session is currently subscribed to the backend's SSE stream.
 *
 * Driven entirely by `agent_presence` events on the existing backend
 * stream (see `backendEventSchema`). The backend replays the current
 * presence state to every new UI subscriber on connect, so this dock
 * resolves immediately rather than waiting for the next transition.
 */
export function AgentDock() {
  const [presence, setPresence] = useState<Presence>({ connected: false });

  useEffect(() => {
    return subscribeBackendEvents((event) => {
      if (event.kind !== "agent_presence") return;
      setPresence({
        connected: event.connected,
        lastSeen: event.last_seen,
      });
    });
  }, []);

  const label = presence.connected
    ? "agent connected"
    : presence.lastSeen !== undefined
      ? `agent not connected (last seen ${formatRelative(presence.lastSeen)})`
      : "agent not connected";

  return (
    <span
      className="agent-dock"
      role="status"
      aria-label={label}
      title={label}
    >
      <span
        className="agent-dock-dot"
        data-connected={presence.connected ? "true" : "false"}
        aria-hidden="true"
      />
      <span className="agent-dock-label">
        {presence.connected ? "agent connected" : "agent not connected"}
      </span>
    </span>
  );
}

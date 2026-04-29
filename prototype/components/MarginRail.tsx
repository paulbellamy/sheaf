"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Thread } from "@/lib/types";
import { ThreadCard, type ThreadView } from "./ThreadCard";

type Props = {
  threads: Thread[];
  activeThreadId: string | null;
  getAnchorTop: (threadId: string) => number | null;
  getThreadView: (threadId: string) => ThreadView | null;
  onActivate: (id: string) => void;
  onSetNote: (threadId: string, note: string) => void;
  onReply: (threadId: string, message: string) => Promise<void>;
  onAccept: (threadId: string, optionIndex?: number) => void;
  onDecline: (threadId: string) => void;
  onToggleCollapsed: (threadId: string, collapsed: boolean) => void;
  onSetAllCollapsed: (collapsed: boolean) => void;
  onRemix?: (threadId: string) => Promise<void>;
  onAddOption?: (
    threadId: string,
    name: string,
    newMd: string,
  ) => Promise<void>;
};

const CARD_GAP = 12;

export function MarginRail({
  threads,
  activeThreadId,
  getAnchorTop,
  getThreadView,
  onActivate,
  onSetNote,
  onReply,
  onAccept,
  onDecline,
  onToggleCollapsed,
  onSetAllCollapsed,
  onRemix,
  onAddOption,
}: Props) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [tops, setTops] = useState<Record<string, number>>({});

  // Signature of collapsed state — recompute layout when any card expands or
  // collapses (card height changes).
  const collapsedSig = useMemo(
    () => threads.map((t) => `${t.id}:${t.collapsed ? 1 : 0}`).join(","),
    [threads],
  );

  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail) return;

    // Batch DOM reads: call getAnchorTop once per thread (each coordsAtPos
    // forces a layout flush), then sort/layout against the memoized values.
    // Before this, the sort comparator called getAnchorTop N² times.
    const anchorTopById = new Map<string, number | null>();
    for (const t of threads) anchorTopById.set(t.id, getAnchorTop(t.id));

    const ordered = [...threads].sort((a, b) => {
      const ta = anchorTopById.get(a.id);
      const tb = anchorTopById.get(b.id);
      if (ta == null || tb == null) return 0;
      return ta - tb;
    });

    const next: Record<string, number> = {};
    let cursor = 0;
    for (const t of ordered) {
      const anchorTop = anchorTopById.get(t.id) ?? null;
      const el = cardRefs.current.get(t.id);
      const h = el ? el.getBoundingClientRect().height : 80;
      const desired = anchorTop ?? cursor;
      const top = Math.max(desired, cursor);
      next[t.id] = top;
      cursor = top + h + CARD_GAP;
    }
    setTops(next);
  }, [threads, getAnchorTop, collapsedSig]);

  if (threads.length === 0) {
    return (
      <div className="margin-rail rail-wrap" ref={railRef}>
        <div className="empty-rail">
          edit to propose. submit when ready.
        </div>
      </div>
    );
  }

  const anyExpanded = threads.some((t) => !t.collapsed);

  return (
    <div className="margin-rail rail-wrap" ref={railRef}>
      <div className="rail-header">
        <button
          type="button"
          className="rail-header-btn"
          onClick={() => onSetAllCollapsed(anyExpanded)}
          title={anyExpanded ? "collapse all" : "expand all"}
        >
          {anyExpanded ? "collapse all" : "expand all"}
        </button>
      </div>
      {threads.map((t) => (
        <div
          key={t.id}
          ref={(el) => {
            if (el) cardRefs.current.set(t.id, el);
            else cardRefs.current.delete(t.id);
          }}
          style={{
            position: "absolute",
            top: tops[t.id] ?? 0,
            left: 0,
            right: 0,
            transition: "top 140ms cubic-bezier(0.2, 0.7, 0.2, 1)",
          }}
        >
          <ThreadCard
            thread={t}
            view={getThreadView(t.id)}
            active={t.id === activeThreadId}
            onActivate={() => onActivate(t.id)}
            onSetNote={(note) => onSetNote(t.id, note)}
            onReply={(message) => onReply(t.id, message)}
            onAccept={(optionIndex) => onAccept(t.id, optionIndex)}
            onDecline={() => onDecline(t.id)}
            onToggleCollapsed={() => onToggleCollapsed(t.id, !t.collapsed)}
            onRemix={onRemix ? () => onRemix(t.id) : undefined}
            onAddOption={
              onAddOption
                ? (name, newMd) => onAddOption(t.id, name, newMd)
                : undefined
            }
          />
        </div>
      ))}
    </div>
  );
}

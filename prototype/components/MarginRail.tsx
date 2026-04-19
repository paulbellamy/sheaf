"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { Thread } from "@/lib/types";
import { ThreadCard, type ThreadView } from "./ThreadCard";

type Props = {
  threads: Thread[];
  activeThreadId: string | null;
  getAnchorTop: (threadId: string) => number | null;
  getThreadView: (threadId: string) => ThreadView | null;
  onActivate: (id: string) => void;
  onSetNote: (threadId: string, note: string) => void;
  onAccept: (threadId: string) => void;
  onDecline: (threadId: string) => void;
};

const CARD_GAP = 12;

export function MarginRail({
  threads,
  activeThreadId,
  getAnchorTop,
  getThreadView,
  onActivate,
  onSetNote,
  onAccept,
  onDecline,
}: Props) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [tops, setTops] = useState<Record<string, number>>({});

  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail) return;

    const ordered = [...threads].sort((a, b) => {
      const ta = getAnchorTop(a.id);
      const tb = getAnchorTop(b.id);
      if (ta === null || tb === null) return 0;
      return ta - tb;
    });

    const next: Record<string, number> = {};
    let cursor = 0;
    for (const t of ordered) {
      const anchorTop = getAnchorTop(t.id);
      const el = cardRefs.current.get(t.id);
      const h = el ? el.getBoundingClientRect().height : 80;
      const desired = anchorTop ?? cursor;
      const top = Math.max(desired, cursor);
      next[t.id] = top;
      cursor = top + h + CARD_GAP;
    }
    setTops(next);
  }, [threads, getAnchorTop]);

  if (threads.length === 0) {
    return (
      <div className="margin-rail rail-wrap" ref={railRef}>
        <div className="empty-rail">
          edit anywhere in the manuscript. your changes become suggestions
          in the margin.
        </div>
      </div>
    );
  }

  return (
    <div className="margin-rail rail-wrap" ref={railRef}>
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
            onAccept={() => onAccept(t.id)}
            onDecline={() => onDecline(t.id)}
          />
        </div>
      ))}
    </div>
  );
}

"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { Thread, DraftVariant } from "@/lib/types";
import { ThreadCard } from "./ThreadCard";

type Props = {
  threads: Thread[];
  activeThreadId: string | null;
  justCreatedId: string | null;
  getAnchorTop: (threadId: string) => number | null;
  onActivate: (id: string) => void;
  onUpdateVariant: (
    threadId: string,
    variantId: string,
    patch: Partial<DraftVariant>,
  ) => void;
  onSelectVariant: (threadId: string, variantId: string) => void;
  onForkVariant: (threadId: string) => void;
  onAccept: (threadId: string) => void;
  onDecline: (threadId: string) => void;
};

const CARD_GAP = 12;

export function MarginRail({
  threads,
  activeThreadId,
  justCreatedId,
  getAnchorTop,
  onActivate,
  onUpdateVariant,
  onSelectVariant,
  onForkVariant,
  onAccept,
  onDecline,
}: Props) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [tops, setTops] = useState<Record<string, number>>({});

  // Recompute card positions: align to anchor, then push down to avoid overlap.
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
          select a phrase and press{" "}
          <kbd style={{ fontSize: "0.7rem" }}>⌘E</kbd> to start a thread.
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
            active={t.id === activeThreadId}
            autoFocus={t.id === justCreatedId}
            onActivate={() => onActivate(t.id)}
            onUpdateVariant={(variantId, patch) =>
              onUpdateVariant(t.id, variantId, patch)
            }
            onSelectVariant={(variantId) => onSelectVariant(t.id, variantId)}
            onForkVariant={() => onForkVariant(t.id)}
            onAccept={() => onAccept(t.id)}
            onDecline={() => onDecline(t.id)}
          />
        </div>
      ))}
    </div>
  );
}

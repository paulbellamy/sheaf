"use client";

import { useEffect, useRef } from "react";
import type { Thread } from "@/lib/types";

export type ThreadView = {
  del: { from: number; to: number; text: string } | null;
  ins: { from: number; to: number; text: string } | null;
};

type Props = {
  thread: Thread;
  view: ThreadView | null;
  active: boolean;
  onActivate: () => void;
  onSetNote: (note: string) => void;
  onAccept: () => void;
  onDecline: () => void;
};

export function ThreadCard({
  thread,
  view,
  active,
  onActivate,
  onSetNote,
  onAccept,
  onDecline,
}: Props) {
  const delText = view?.del?.text ?? "";
  const insText = view?.ins?.text ?? "";

  return (
    <div
      className="thread-card"
      data-active={active ? "true" : "false"}
      data-thread-id={thread.id}
      onMouseDown={onActivate}
    >
      {(delText || insText) && (
        <div className="diff-preview">
          {delText && (
            <span className="del" title={delText}>
              {delText}
            </span>
          )}
          {delText && insText && <span className="arrow">→</span>}
          {insText && (
            <span className="ins" title={insText}>
              {insText}
            </span>
          )}
        </div>
      )}

      <AutoGrowTextarea
        className="note"
        placeholder="a note in the margin…"
        value={thread.note}
        onChange={onSetNote}
      />

      <div className="actions">
        <button className="accept" onClick={onAccept}>
          accept
        </button>
        <button className="decline" onClick={onDecline}>
          discard
        </button>
      </div>
    </div>
  );
}

function AutoGrowTextarea({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      className={className}
      placeholder={placeholder}
      value={value}
      rows={1}
      onChange={(e) => onChange(e.target.value)}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    />
  );
}

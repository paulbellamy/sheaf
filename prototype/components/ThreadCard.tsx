"use client";

import { useEffect, useRef, useState } from "react";
import type { Thread } from "@/lib/types";
import { formatRelative } from "@/lib/time";

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
  onReply: (message: string) => Promise<void>;
  onAccept: () => void;
  onDecline: () => void;
  onToggleCollapsed: () => void;
};

function Chevron({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      viewBox="0 0 12 12"
      width="10"
      height="10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{
        transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
        transition: "transform 120ms ease",
      }}
    >
      <path d="M3 5l3 3 3-3" />
    </svg>
  );
}

export function ThreadCard({
  thread,
  view,
  active,
  onActivate,
  onSetNote,
  onReply,
  onAccept,
  onDecline,
  onToggleCollapsed,
}: Props) {
  const delText = view?.del?.text ?? "";
  const insText = view?.ins?.text ?? "";
  const submitted = thread.state === "submitted";
  const kind = thread.kind;
  const collapsed = !!thread.collapsed;
  const messages = thread.messages ?? [];
  const hasMessages = messages.length > 0;
  const hasNote = thread.note !== "";
  const [replying, setReplying] = useState(false);

  const submitReply = async () => {
    const body = thread.note.trim();
    if (!body || replying) return;
    setReplying(true);
    try {
      await onReply(body);
      onSetNote("");
    } catch {
      // Caller surfaces the error; preserve composer text so the user can retry.
    } finally {
      setReplying(false);
    }
  };

  return (
    <div
      className="thread-card"
      data-active={active ? "true" : "false"}
      data-state={thread.state}
      data-kind={kind}
      data-collapsed={collapsed ? "true" : "false"}
      data-thread-id={thread.id}
      onMouseDown={onActivate}
    >
      <button
        type="button"
        className="thread-chevron"
        aria-label={collapsed ? "expand" : "collapse"}
        title={collapsed ? "expand" : "collapse"}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onToggleCollapsed();
        }}
      >
        <Chevron collapsed={collapsed} />
        {collapsed && hasNote && <span className="note-dot" aria-hidden />}
      </button>

      {kind === "structural" && thread.structural && (
        <div className="structural-preview">
          <span className="tag">structure</span>
          <span className="label">{thread.structural.label}</span>
        </div>
      )}

      {kind === "note" && (
        <div className="structural-preview">
          <span className="tag">note</span>
          <span className="label">comment</span>
        </div>
      )}

      {kind === "redline" && (delText || insText) && (
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

      {!collapsed && (
        <>
          {hasMessages && (
            <ul className="thread-messages">
              {messages.map((m, i) => (
                <li key={i} className="thread-message">
                  <div className="thread-message-meta">
                    <span className="author">{m.author}</span>
                    <span className="ts">{formatRelative(m.ts)}</span>
                  </div>
                  <div className="thread-message-body">{m.body}</div>
                </li>
              ))}
            </ul>
          )}

          <AutoGrowTextarea
            className="note"
            placeholder={
              submitted
                ? "＋ reply"
                : kind === "structural"
                  ? "＋ add a note explaining this structural change"
                  : kind === "note"
                    ? "＋ write your comment"
                    : "＋ add a note alongside this change"
            }
            value={thread.note}
            onChange={onSetNote}
            autoFocus={!!thread.autoFocusNote}
            submitOnEnter
            onSubmit={submitted ? submitReply : undefined}
            disabled={replying}
          />

          <div className="actions">
            {kind === "redline" && submitted ? (
              <>
                <button className="accept" onClick={onAccept}>
                  accept
                </button>
                <button className="decline" onClick={onDecline}>
                  decline
                </button>
              </>
            ) : (
              <button className="decline" onClick={onDecline}>
                {kind === "redline" ? "discard" : "dismiss"}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function AutoGrowTextarea({
  value,
  onChange,
  placeholder,
  className,
  autoFocus,
  submitOnEnter,
  onSubmit,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  submitOnEnter?: boolean;
  onSubmit?: () => void;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  useEffect(() => {
    if (autoFocus) {
      ref.current?.focus({ preventScroll: true });
    }
    // Fire once on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <textarea
      ref={ref}
      className={className}
      placeholder={placeholder}
      value={value}
      rows={1}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (submitOnEnter && e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          if (onSubmit) onSubmit();
          else ref.current?.blur();
        }
      }}
    />
  );
}

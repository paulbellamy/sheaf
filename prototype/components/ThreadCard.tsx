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
  onAccept: (optionIndex?: number) => void;
  onDecline: () => void;
  onToggleCollapsed: () => void;
  onRemix?: () => Promise<void>;
  onAddOption?: (name: string, newMd: string) => Promise<void>;
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
  onRemix,
  onAddOption,
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
  // Multi-option α: when the thread carries 2+ draft_options the reviewer
  // picks one before accept. Default to the first leaf so a quick accept
  // still does something sensible.
  const draftOptions = thread.draftOptions ?? [];
  const isMultiOption = draftOptions.length >= 2;
  const [focusedOption, setFocusedOption] = useState(0);
  // Clamp the focused index when the option list shrinks (e.g. after a
  // server-side prune). Keeps `accept` from indexing off the end.
  useEffect(() => {
    if (focusedOption >= draftOptions.length && draftOptions.length > 0) {
      setFocusedOption(0);
    }
  }, [draftOptions.length, focusedOption]);

  const accepted = thread.state === "accepted";
  const [remixing, setRemixing] = useState(false);
  const [addingOption, setAddingOption] = useState(false);
  const [optionName, setOptionName] = useState("");
  const [optionMd, setOptionMd] = useState("");
  const [optionBusy, setOptionBusy] = useState(false);

  const handleRemix = async () => {
    if (!onRemix || remixing) return;
    setRemixing(true);
    try {
      await onRemix();
    } catch {
      /* caller surfaces the error */
    } finally {
      setRemixing(false);
    }
  };

  const submitOption = async () => {
    if (!onAddOption || optionBusy) return;
    const name = optionName.trim();
    const md = optionMd;
    if (!name || md.length === 0) return;
    setOptionBusy(true);
    try {
      await onAddOption(name, md);
      setAddingOption(false);
      setOptionName("");
      setOptionMd("");
    } catch {
      /* caller surfaces the error; keep the form so the user can retry */
    } finally {
      setOptionBusy(false);
    }
  };

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

          {isMultiOption && (
            <div
              className="thread-options"
              role="radiogroup"
              aria-label="proposed options"
            >
              {draftOptions.map((opt, i) => (
                <label
                  key={i}
                  className="thread-option"
                  data-focused={i === focusedOption ? "true" : "false"}
                >
                  <input
                    type="radio"
                    name={`thread-options-${thread.id}`}
                    checked={i === focusedOption}
                    onChange={() => setFocusedOption(i)}
                    onMouseDown={(e) => e.stopPropagation()}
                  />
                  <span className="thread-option-name">{opt.name}</span>
                </label>
              ))}
            </div>
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
            {isMultiOption && submitted ? (
              <>
                <button
                  className="accept"
                  onClick={() => onAccept(focusedOption)}
                >
                  accept this option
                </button>
                <button className="decline" onClick={onDecline}>
                  decline
                </button>
              </>
            ) : kind === "redline" && submitted ? (
              <>
                <button className="accept" onClick={() => onAccept()}>
                  accept
                </button>
                <button className="decline" onClick={onDecline}>
                  decline
                </button>
              </>
            ) : accepted && onRemix ? (
              <button
                className="remix"
                onClick={handleRemix}
                disabled={remixing}
              >
                {remixing ? "…" : "remix"}
              </button>
            ) : (
              <button className="decline" onClick={onDecline}>
                {kind === "redline" ? "discard" : "dismiss"}
              </button>
            )}
            {submitted && onAddOption && !addingOption ? (
              <button
                type="button"
                className="add-option"
                onClick={() => setAddingOption(true)}
              >
                add option
              </button>
            ) : null}
          </div>

          {addingOption && onAddOption ? (
            <div className="thread-add-option">
              <input
                type="text"
                className="thread-add-option-name"
                placeholder="option name (e.g. bob's counter)"
                value={optionName}
                onChange={(e) => setOptionName(e.target.value)}
                onMouseDown={(e) => e.stopPropagation()}
                disabled={optionBusy}
              />
              <textarea
                className="thread-add-option-md"
                placeholder="proposed new_md for this anchor range"
                value={optionMd}
                rows={3}
                onChange={(e) => setOptionMd(e.target.value)}
                onMouseDown={(e) => e.stopPropagation()}
                disabled={optionBusy}
              />
              <div className="actions">
                <button
                  type="button"
                  className="accept"
                  onClick={() => void submitOption()}
                  disabled={
                    optionBusy ||
                    optionName.trim().length === 0 ||
                    optionMd.length === 0
                  }
                >
                  {optionBusy ? "…" : "submit option"}
                </button>
                <button
                  type="button"
                  className="decline"
                  onClick={() => {
                    setAddingOption(false);
                    setOptionName("");
                    setOptionMd("");
                  }}
                  disabled={optionBusy}
                >
                  cancel
                </button>
              </div>
            </div>
          ) : null}
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

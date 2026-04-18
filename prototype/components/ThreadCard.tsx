"use client";

import { useEffect, useRef } from "react";
import type { Thread, DraftVariant } from "@/lib/types";
import { newId } from "@/lib/types";

type Props = {
  thread: Thread;
  active: boolean;
  autoFocus?: boolean;
  onActivate: () => void;
  onUpdateVariant: (variantId: string, patch: Partial<DraftVariant>) => void;
  onSelectVariant: (variantId: string) => void;
  onForkVariant: () => void;
  onAccept: () => void;
  onDecline: () => void;
};

export function ThreadCard({
  thread,
  active,
  autoFocus,
  onActivate,
  onUpdateVariant,
  onSelectVariant,
  onForkVariant,
  onAccept,
  onDecline,
}: Props) {
  const replacementRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (autoFocus && replacementRef.current) {
      replacementRef.current.focus();
    }
  }, [autoFocus]);

  const variant =
    thread.variants.find((v) => v.id === thread.activeVariantId) ||
    thread.variants[0];

  return (
    <div
      className="thread-card"
      data-active={active ? "true" : "false"}
      data-thread-id={thread.id}
      onMouseDown={onActivate}
    >
      <span className="anchor-quote" title={thread.anchorText}>
        {thread.anchorText}
      </span>

      <AutoGrowTextarea
        className="replacement"
        placeholder="replace with…"
        value={variant.replacement}
        onChange={(v) => onUpdateVariant(variant.id, { replacement: v })}
        textareaRef={replacementRef}
      />

      <AutoGrowTextarea
        className="note"
        placeholder="a note in the margin…"
        value={variant.note}
        onChange={(v) => onUpdateVariant(variant.id, { note: v })}
      />

      {thread.variants.length > 1 && (
        <div className="variants">
          <span
            className="meta"
            style={{ marginRight: "0.2rem", marginTop: 0 }}
          >
            drafts:
          </span>
          {thread.variants.map((v, i) => (
            <button
              key={v.id}
              className="variant-chip"
              data-active={v.id === thread.activeVariantId ? "true" : "false"}
              onClick={(e) => {
                e.stopPropagation();
                onSelectVariant(v.id);
              }}
              title={v.replacement || "(empty)"}
            >
              {v.author}·{i + 1}
            </button>
          ))}
        </div>
      )}

      <div className="actions">
        <button className="accept" onClick={onAccept}>
          accept
        </button>
        <button onClick={onForkVariant}>draft another way</button>
        <button className="decline" onClick={onDecline}>
          discard
        </button>
      </div>

      <div className="meta">
        <span>{variant.author}</span>
        <span>
          {thread.state === "open"
            ? "open"
            : thread.state === "accepted"
              ? "accepted"
              : "declined"}
        </span>
      </div>
    </div>
  );
}

function AutoGrowTextarea({
  value,
  onChange,
  placeholder,
  className,
  textareaRef,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const internalRef = useRef<HTMLTextAreaElement | null>(null);
  const ref = textareaRef ?? internalRef;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value, ref]);

  return (
    <textarea
      ref={ref}
      className={className}
      placeholder={placeholder}
      value={value}
      rows={1}
      onChange={(e) => onChange(e.target.value)}
      onMouseDown={(e) => e.stopPropagation()}
    />
  );
}

export { newId };

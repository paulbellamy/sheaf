"use client";

import { useEffect, useRef } from "react";

type Props = {
  onClose: () => void;
};

export function HelpModal({ onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  return (
    <div
      className="help-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="sheaf help"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="help-dialog"
        tabIndex={-1}
        ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="help-header">
          <span className="title">sheaf · notation</span>
          <button
            className="help-close"
            aria-label="close help"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <section className="help-section">
          <h3>gestures</h3>
          <dl>
            <dt>type anywhere</dt>
            <dd>
              new text appears as a <em>green proposed insertion</em>, opening a
              thread in the margin.
            </dd>
            <dt>backspace / delete</dt>
            <dd>
              strikes through the text in <em>redline</em>; it stays visible
              until accepted.
            </dd>
            <dt>select + type</dt>
            <dd>proposes a replacement — both the original and the new text live together.</dd>
            <dt>select + ⌘B / ⌘I / ⌘K</dt>
            <dd>formats via the selection bubble — bold, italic, link, inline code, or note.</dd>
            <dt>click a marked passage</dt>
            <dd>focuses its thread card in the margin.</dd>
          </dl>
        </section>

        <section className="help-section">
          <h3>markdown shortcuts</h3>
          <dl>
            <dt><code># </code> … <code>###### </code></dt>
            <dd>headings, level 1 through 6.</dd>
            <dt><code>- </code> or <code>* </code></dt>
            <dd>bullet list.</dd>
            <dt><code>1. </code></dt>
            <dd>numbered list.</dd>
            <dt><code>&gt; </code></dt>
            <dd>blockquote.</dd>
            <dt><code>```</code></dt>
            <dd>code block with syntax highlighting.</dd>
          </dl>
          <p className="help-note">
            each structural change is recorded as a margin thread so it remains reviewable.
          </p>
        </section>

        <section className="help-section">
          <h3>review flow</h3>
          <dl>
            <dt>pending</dt>
            <dd>new threads are drafts, visible only to you. a dotted rail marks the margin.</dd>
            <dt>submit review</dt>
            <dd>bundles all pending threads into one review with an optional cover note.</dd>
            <dt>accept / decline</dt>
            <dd>applied to submitted threads — accept replaces, decline reverts.</dd>
          </dl>
        </section>

        <div className="help-footer">
          <kbd>?</kbd> toggle · <kbd>Esc</kbd> close
        </div>
      </div>
    </div>
  );
}

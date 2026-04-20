"use client";

import { useState } from "react";
import type { Thread } from "@/lib/types";

type Props = {
  pendingCount: number;
  pending: Thread[];
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onSubmit: (coverNote: string) => void;
};

export function ReviewBundle({
  pendingCount,
  pending,
  open,
  onOpen,
  onClose,
  onSubmit,
}: Props) {
  const [coverNote, setCoverNote] = useState("");

  if (pendingCount === 0 && !open) return null;

  return (
    <>
      {!open && pendingCount > 0 && (
        <button className="review-pill" onClick={onOpen}>
          submit review <span className="count">({pendingCount})</span>
        </button>
      )}

      {open && (
        <aside
          className="review-panel"
          role="dialog"
          aria-label="submit review"
        >
          <header>
            <span className="title">submit review</span>
            <button
              className="review-close"
              aria-label="close"
              onClick={onClose}
            >
              ×
            </button>
          </header>

          <div className="review-body">
            <label className="review-label" htmlFor="review-cover">
              cover note (optional)
            </label>
            <textarea
              id="review-cover"
              className="review-cover"
              placeholder="a sentence of context for the author…"
              value={coverNote}
              rows={3}
              onChange={(e) => setCoverNote(e.target.value)}
            />

            <div className="review-list-label">
              {pendingCount} thread{pendingCount === 1 ? "" : "s"} in this review
            </div>
            <ul className="review-list">
              {pending.map((t) => (
                <li key={t.id} className="review-list-item" data-kind={t.kind}>
                  <span className="review-kind">
                    {t.kind === "structural"
                      ? t.structural?.label ?? "structure"
                      : t.kind === "note"
                        ? "note"
                        : "redline"}
                  </span>
                  {t.note && <span className="review-note">“{t.note}”</span>}
                </li>
              ))}
            </ul>
          </div>

          <footer>
            <button className="review-cancel" onClick={onClose}>
              cancel
            </button>
            <button
              className="review-submit"
              onClick={() => {
                onSubmit(coverNote);
                setCoverNote("");
              }}
            >
              submit
            </button>
          </footer>
        </aside>
      )}
    </>
  );
}

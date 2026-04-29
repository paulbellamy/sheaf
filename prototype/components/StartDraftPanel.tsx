"use client";

import { useEffect, useState } from "react";
import type { Thread } from "@/lib/types";

type Props = {
  pendingCount: number;
  pending: Thread[];
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onStartDraft: (args: { name: string }) => void | Promise<void>;
};

function defaultDraftName(): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `draft-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

export function StartDraftPanel({
  pendingCount,
  pending,
  open,
  onOpen,
  onClose,
  onStartDraft,
}: Props) {
  const [name, setName] = useState(() => defaultDraftName());
  const [busy, setBusy] = useState(false);

  // Each time the modal opens, reset to a freshly-stamped default. Mid-flight
  // typing isn't preserved across cancel/reopen — minimal modal scope.
  useEffect(() => {
    if (open) setName(defaultDraftName());
  }, [open]);

  const disabled = pendingCount === 0;

  return (
    <>
      {!open && (
        <button
          className="review-pill"
          onClick={onOpen}
          disabled={disabled}
          aria-disabled={disabled}
        >
          Start Draft <span className="count">({pendingCount})</span>
        </button>
      )}

      {open && (
        <aside
          className="review-panel"
          role="dialog"
          aria-label="start draft"
        >
          <header>
            <span className="title">start draft</span>
            <button
              className="review-close"
              aria-label="close"
              onClick={onClose}
            >
              ×
            </button>
          </header>

          <div className="review-body">
            <label className="review-label" htmlFor="start-draft-name">
              draft name
            </label>
            <input
              id="start-draft-name"
              className="review-cover"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />

            <div className="review-list-label">
              {pendingCount} thread{pendingCount === 1 ? "" : "s"} on this draft
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
            <button className="review-cancel" onClick={onClose} disabled={busy}>
              cancel
            </button>
            <button
              className="review-submit"
              disabled={busy || pendingCount === 0 || name.trim() === ""}
              onClick={async () => {
                if (busy) return;
                setBusy(true);
                try {
                  await onStartDraft({ name: name.trim() });
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "starting…" : "Start Draft"}
            </button>
          </footer>
        </aside>
      )}
    </>
  );
}

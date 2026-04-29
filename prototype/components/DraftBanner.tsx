"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useDraftMeta } from "@/lib/hooks/useDraftMeta";

type Props = {
  docPath: string;
  docRef: string; // already known to be a draft id by the parent
  onDiscarded?: () => void;
  onAccepted?: () => void;
  onError?: (msg: string) => void;
};

const COPIED_VISIBLE_MS = 1500;

/**
 * Phase D: top banner shown when the editor's ref is a draft id.
 *
 * Server-derived `open_count` gates the Accept button. Discard +
 * Accept go through confirm modals because both are destructive
 * (Discard deletes the draft; Accept lands prose on main).
 *
 * Display falls back to the bare draft id if the server hasn't yet
 * populated `display_name` on legacy drafts (created via the bare
 * MCP `Fork` path before Phase C).
 */
export function DraftBanner({
  docPath,
  docRef,
  onDiscarded,
  onAccepted,
  onError,
}: Props) {
  const { data, isLoading } = useDraftMeta(docRef);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState<"discard" | "accept" | null>(null);
  const [busy, setBusy] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null)
        window.clearTimeout(copiedTimerRef.current);
    };
  }, []);

  const onShareLink = useCallback(async () => {
    const origin =
      typeof window !== "undefined" ? window.location.origin : "";
    const url = `${origin}/doc/${docPath}?ref=${encodeURIComponent(docRef)}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      if (copiedTimerRef.current !== null)
        window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => {
        setCopied(false);
      }, COPIED_VISIBLE_MS);
    } catch (e) {
      onError?.(e instanceof Error ? e.message : "clipboard write failed");
    }
  }, [docPath, docRef, onError]);

  const doDiscard = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch(
        `/api/ui/drafts/${encodeURIComponent(docRef)}/decline`,
        { method: "POST" },
      );
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as {
          error?: string;
        };
        onError?.(body.error ?? `discard failed (HTTP ${r.status})`);
        return;
      }
      setConfirm(null);
      onDiscarded?.();
    } catch (e) {
      onError?.(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [docRef, onDiscarded, onError]);

  const doAccept = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch(
        `/api/ui/drafts/${encodeURIComponent(docRef)}/accept`,
        { method: "POST" },
      );
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as {
          error?: string;
        };
        onError?.(body.error ?? `accept failed (HTTP ${r.status})`);
        return;
      }
      setConfirm(null);
      onAccepted?.();
    } catch (e) {
      onError?.(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [docRef, onAccepted, onError]);

  // Fallbacks keep the banner non-crashing on legacy drafts that lack
  // server-side display_name / base_version.
  const displayName = data?.display_name ?? docRef;
  const baseVersion = data?.base_version;
  const openCount = data?.open_count ?? 0;
  const acceptDisabled = busy || isLoading || openCount > 0 || !data;
  const acceptLabel =
    baseVersion !== undefined
      ? `Accept as v${baseVersion + 1}`
      : "Accept";

  return (
    <div className="draft-banner" role="status">
      <div className="draft-banner-left">
        <span className="draft-banner-name">draft: {displayName}</span>
        {baseVersion !== undefined ? (
          <>
            <span className="draft-banner-sep">·</span>
            <span>based on v{baseVersion}</span>
          </>
        ) : null}
        <span className="draft-banner-sep">·</span>
        <span>{openCount} open</span>
      </div>
      <div className="draft-banner-right">
        <button
          type="button"
          className="draft-banner-btn"
          onClick={() => void onShareLink()}
        >
          Share link
        </button>
        {copied ? (
          <span className="draft-banner-copied" aria-live="polite">
            copied
          </span>
        ) : null}
        <button
          type="button"
          className="draft-banner-btn"
          onClick={() => setConfirm("discard")}
          disabled={busy}
        >
          Discard draft
        </button>
        <button
          type="button"
          className="draft-banner-btn draft-banner-accept"
          onClick={() => setConfirm("accept")}
          disabled={acceptDisabled}
          aria-disabled={acceptDisabled}
          title={
            openCount > 0
              ? `${openCount} open thread${openCount === 1 ? "" : "s"} — resolve before accepting`
              : undefined
          }
        >
          {acceptLabel}
        </button>
      </div>
      {confirm === "discard" ? (
        <ConfirmModal
          title="discard draft?"
          body="this deletes the draft and all threads on it."
          confirmLabel="discard"
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void doDiscard()}
        />
      ) : null}
      {confirm === "accept" ? (
        <ConfirmModal
          title={acceptLabel}
          body={
            data
              ? `bumps ${touchesSummary(data.touches)} from v${data.base_version} to v${data.base_version + 1}.`
              : ""
          }
          confirmLabel="accept"
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void doAccept()}
        />
      ) : null}
    </div>
  );
}

function touchesSummary(touches: string[]): string {
  if (touches.length === 0) return "this draft";
  if (touches.length === 1) return touches[0];
  return `${touches.length} docs`;
}

function ConfirmModal({
  title,
  body,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="draft-banner-modal-overlay" role="dialog" aria-modal="true">
      <div className="draft-banner-modal">
        <div className="draft-banner-modal-title">{title}</div>
        {body ? <div className="draft-banner-modal-body">{body}</div> : null}
        <div className="draft-banner-modal-actions">
          <button
            type="button"
            className="review-cancel"
            onClick={onCancel}
            disabled={busy}
          >
            cancel
          </button>
          <button
            type="button"
            className="review-submit"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

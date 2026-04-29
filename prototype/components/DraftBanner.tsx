"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useDraftMeta } from "@/lib/hooks/useDraftMeta";

type Props = {
  docPath: string;
  docRef: string; // already known to be a draft id by the parent
  onDiscarded?: () => void;
  onAccepted?: () => void;
  onError?: (msg: string) => void;
  /**
   * Phase K: when true, the draft is `state === "accepted"` and we're
   * viewing it for historical context only. The banner replaces its
   * action buttons with a `viewing v<N> · v<latest> is current` message
   * and accept/discard are suppressed.
   */
  readOnly?: boolean;
  /** Phase K: current main version of `base_path`, used in the read-only label. */
  latestVersion?: number;
};

const COPIED_VISIBLE_MS = 1500;
const SUCCESS_VISIBLE_MS = 1800;

type AcceptVersion = { path: string; from: number; to: number };

type ConflictDetail = {
  path: string;
  base_version: number;
  main_version: number;
};

type AcceptBlocked = { open_count: number };

/**
 * Phase D + I: top banner shown when the editor's ref is a draft id.
 *
 * Server-derived `open_count` gates the Accept button. The Accept modal
 * lists every touched path's predicted vN to vN+1 bump pre-click; on
 * success, the banner briefly shows the per-path actual transitions
 * (Phase I `versions` payload) before the parent navigates to main.
 *
 * Conflict (HTTP 409): the merge is atomic, so nothing landed. The banner
 * stays in draft mode and surfaces the conflicting paths.
 */
export function DraftBanner({
  docPath,
  docRef,
  onDiscarded,
  onAccepted,
  onError,
  readOnly = false,
  latestVersion,
}: Props) {
  const { data, isLoading } = useDraftMeta(docRef);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState<"discard" | "accept" | null>(null);
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState<AcceptVersion[] | null>(null);
  const [conflicts, setConflicts] = useState<ConflictDetail[] | null>(null);
  const [blocked, setBlocked] = useState<AcceptBlocked | null>(null);
  const [producedVersion, setProducedVersion] = useState<number | null>(null);
  const copiedTimerRef = useRef<number | null>(null);
  const successTimerRef = useRef<number | null>(null);

  // Phase K: in read-only mode, look up which version this draft produced
  // for `docPath` by walking the per-doc history. Only fires for accepted
  // drafts; historical drafts that never landed (declined) leave the value
  // null and the banner falls back to the docRef.
  useEffect(() => {
    if (!readOnly) {
      setProducedVersion(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(
          `/api/ui/doc-versions/${docPath}`,
          { cache: "no-store" },
        );
        if (cancelled || !r.ok) return;
        const body = (await r.json()) as {
          versions: { version: number; draft_id?: string }[];
        };
        const match = body.versions.find((v) => v.draft_id === docRef);
        if (!cancelled) setProducedVersion(match?.version ?? null);
      } catch {
        /* silent — read-only label gracefully degrades */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [readOnly, docPath, docRef]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null)
        window.clearTimeout(copiedTimerRef.current);
      if (successTimerRef.current !== null)
        window.clearTimeout(successTimerRef.current);
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
    setConflicts(null);
    setBlocked(null);
    try {
      const r = await fetch(
        `/api/ui/drafts/${encodeURIComponent(docRef)}/accept`,
        { method: "POST" },
      );
      const body = (await r.json().catch(() => ({}))) as {
        error?: string;
        versions?: AcceptVersion[];
        conflicts?: ConflictDetail[];
        open_count?: number;
        code?: string;
      };
      if (r.status === 409 && body.conflicts && body.conflicts.length > 0) {
        setConflicts(body.conflicts);
        setConfirm(null);
        return;
      }
      if (
        r.status === 422 &&
        body.code === "accept_blocked" &&
        typeof body.open_count === "number"
      ) {
        setBlocked({ open_count: body.open_count });
        setConfirm(null);
        return;
      }
      if (!r.ok) {
        onError?.(body.error ?? `accept failed (HTTP ${r.status})`);
        return;
      }
      setConfirm(null);
      const versions = body.versions ?? [];
      setSuccess(versions);
      if (successTimerRef.current !== null)
        window.clearTimeout(successTimerRef.current);
      successTimerRef.current = window.setTimeout(() => {
        setSuccess(null);
        onAccepted?.();
      }, SUCCESS_VISIBLE_MS);
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
  const touches = data?.touches ?? [];
  const touchesCount = touches.length;
  const versionsBehind = data?.versions_behind ?? 0;
  const acceptDisabled =
    busy || isLoading || openCount > 0 || !data || success !== null;
  const acceptLabel =
    baseVersion !== undefined
      ? `Accept as v${baseVersion + 1}`
      : "Accept";

  if (success) {
    return (
      <div className="draft-banner draft-banner-success" role="status">
        <div className="draft-banner-left">
          <span className="draft-banner-name">accepted</span>
          {success.length > 0 ? (
            <span className="draft-banner-success-list">
              {success
                .map((v) => `${v.path}: v${v.from} → v${v.to}`)
                .join(" · ")}
            </span>
          ) : null}
        </div>
      </div>
    );
  }

  if (readOnly) {
    const viewingLabel =
      producedVersion !== null
        ? `viewing v${producedVersion}`
        : `viewing ${displayName}`;
    return (
      <div className="draft-banner draft-banner-readonly" role="status">
        <div className="draft-banner-left">
          <span className="draft-banner-name">{viewingLabel}</span>
          {latestVersion !== undefined ? (
            <>
              <span className="draft-banner-sep">·</span>
              <span>v{latestVersion} is current</span>
            </>
          ) : null}
        </div>
      </div>
    );
  }

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
        {touchesCount > 1 ? (
          <span
            className="draft-banner-chip"
            title={touches.join("\n")}
          >
            cross-cutting · {touchesCount} docs
          </span>
        ) : null}
        {versionsBehind > 0 ? (
          <span
            className="draft-banner-chip draft-banner-stale"
            role="status"
            title="main has advanced since this draft was forked"
          >
            main has advanced {versionsBehind} version
            {versionsBehind === 1 ? "" : "s"} since this draft started
          </span>
        ) : null}
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
      {conflicts ? (
        <ConflictBanner
          conflicts={conflicts}
          onDismiss={() => setConflicts(null)}
        />
      ) : null}
      {blocked ? (
        <div className="draft-banner-conflict" role="alert">
          <div className="draft-banner-conflict-title">
            {blocked.open_count} thread
            {blocked.open_count === 1 ? "" : "s"} still open · cannot accept
          </div>
          <button
            type="button"
            className="draft-banner-btn"
            onClick={() => setBlocked(null)}
            aria-label="dismiss"
          >
            dismiss
          </button>
        </div>
      ) : null}
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
        <AcceptConfirmModal
          title={acceptLabel}
          touches={touches}
          baseVersion={baseVersion}
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void doAccept()}
        />
      ) : null}
    </div>
  );
}

function AcceptConfirmModal({
  title,
  touches,
  baseVersion,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  touches: string[];
  baseVersion: number | undefined;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="draft-banner-modal-overlay" role="dialog" aria-modal="true">
      <div className="draft-banner-modal">
        <div className="draft-banner-modal-title">{title}</div>
        <div className="draft-banner-modal-body">
          {touches.length === 0 ? (
            <span>nothing to bump.</span>
          ) : (
            <>
              <div>
                bumps {touches.length} doc{touches.length === 1 ? "" : "s"} to
                its next version:
              </div>
              <ul className="draft-banner-bump-list">
                {touches.map((p) => (
                  <li key={p}>
                    <code>{p}</code>
                    {baseVersion !== undefined ? (
                      <>
                        {" "}
                        v{baseVersion} → v{baseVersion + 1}
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
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
            {busy ? "…" : "accept"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConflictBanner({
  conflicts,
  onDismiss,
}: {
  conflicts: ConflictDetail[];
  onDismiss: () => void;
}) {
  return (
    <div className="draft-banner-conflict" role="alert">
      <div className="draft-banner-conflict-title">
        accept blocked: {conflicts.length} conflict
        {conflicts.length === 1 ? "" : "s"}
      </div>
      <ul className="draft-banner-conflict-list">
        {conflicts.map((c) => (
          <li key={c.path}>
            <code>{c.path}</code>: main is at v{c.main_version}, draft based
            on v{c.base_version}
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="draft-banner-btn"
        onClick={onDismiss}
        aria-label="dismiss conflict"
      >
        dismiss
      </button>
    </div>
  );
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

"use client";

import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { CodeBlockView } from "./CodeBlockView";
import type { Node as PMNode } from "@tiptap/pm/model";
import { common, createLowlight } from "lowlight";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { newId, type Thread } from "@/lib/types";
import { sampleManuscript } from "@/lib/sampleText";
import {
  BlockIndent,
  findContiguousThreadId,
  tryIndent,
} from "@/lib/editor-helpers";
import { useFormattingDiff } from "@/lib/hooks/useFormattingDiff";
import { useServerThreads } from "@/lib/hooks/useServerThreads";
import { useSubmitReview } from "@/lib/hooks/useSubmitReview";
import { useProposedEditHandlers } from "@/lib/hooks/useProposedEditHandlers";
import { useThreadOutcome } from "@/lib/hooks/useThreadOutcome";
import {
  ProposedDeletion,
  findThreadRange,
} from "./extensions/ProposedDeletion";
import {
  ProposedInsertion,
  findInsertionRange,
} from "./extensions/ProposedInsertion";
import { ThreadInteraction } from "./extensions/ThreadInteraction";
import { MarginRail } from "./MarginRail";
import { HelpModal } from "./HelpModal";
import { ReviewBundle } from "./ReviewBundle";
import { SelectionBubble } from "./SelectionBubble";

const THREAD_IDLE_MS = 4000;

type EditContext = {
  threadId: string;
  lastPos: number;
  lastTime: number;
};

type ManuscriptProps = {
  initialContent?: string;
  md?: string;
  docPath?: string;
  docRef?: string;
};

export function Manuscript({
  initialContent,
  md,
  docPath,
  docRef = "main",
}: ManuscriptProps = {}) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [, bumpLayout] = useState(0);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const router = useRouter();
  const mdRef = useRef<string>(md ?? "");
  // Keep mdRef in sync with the prop via effect rather than mutating during
  // render — avoids surprise if React re-invokes the render before commit.
  useEffect(() => {
    mdRef.current = md ?? "";
  }, [md]);

  const editContextRef = useRef<EditContext | null>(null);
  const manuscriptRef = useRef<HTMLDivElement | null>(null);

  const lowlight = useMemo(() => createLowlight(common), []);

  const CodeBlock = useMemo(
    () =>
      CodeBlockLowlight.extend({
        addAttributes() {
          return {
            ...this.parent?.(),
            wrap: {
              default: false,
              parseHTML: (el) => el.getAttribute("data-wrap") === "true",
              renderHTML: (attrs) =>
                attrs.wrap ? { "data-wrap": "true" } : {},
            },
          };
        },
        addNodeView() {
          return ReactNodeViewRenderer(CodeBlockView);
        },
      }).configure({ lowlight }),
    [lowlight],
  );

  const pickThreadId = useCallback(
    (doc: PMNode, pos: number, schema: PMNode["type"]["schema"]): {
      threadId: string;
      isNew: boolean;
    } => {
      const insType = schema.marks.proposedInsertion;
      const delType = schema.marks.proposedDeletion;
      const existing = findContiguousThreadId(doc, pos, [insType, delType]);
      if (existing) {
        editContextRef.current = {
          threadId: existing,
          lastPos: pos,
          lastTime: Date.now(),
        };
        return { threadId: existing, isNew: false };
      }

      const now = Date.now();
      const ctx = editContextRef.current;
      if (ctx && now - ctx.lastTime < THREAD_IDLE_MS) {
        ctx.lastTime = now;
        ctx.lastPos = pos;
        return { threadId: ctx.threadId, isNew: false };
      }

      const threadId = newId("thrd");
      editContextRef.current = { threadId, lastPos: pos, lastTime: now };
      return { threadId, isNew: true };
    },
    [],
  );

  const registerThread = useCallback((threadId: string) => {
    setThreads((prev) => [
      ...prev,
      {
        id: threadId,
        kind: "redline",
        note: "",
        state: "pending",
        createdAt: Date.now(),
      },
    ]);
  }, []);

  const registerStructuralThread = useCallback(
    (label: string, range?: { from: number; to: number }) => {
      const id = newId("strc");
      // Block-type transitions carry an arrow in their label ("¶ → H2",
      // "bullet list → numbered list"). Formatting-mark labels do not.
      const isBlockTransition = label.includes(" → ");
      const parts = isBlockTransition ? label.match(/^(.+?) → (.+)$/) : null;
      const newFrom = parts?.[1];
      const newTo = parts?.[2];
      let addedThread = false;
      setThreads((prev) => {
        // Block transitions: diff is always "original state → current state".
        // Any overlapping pending block-transition thread represents the
        // same block; inherit its "from" (the original state) and purge it.
        // If the inherited original equals the new target, the block is
        // back to its baseline — emit no note.
        if (isBlockTransition && range && newFrom && newTo) {
          let inheritedFrom: string | null = null;
          const remaining = prev.filter((t) => {
            if (
              t.kind !== "structural" ||
              t.state !== "pending" ||
              t.note !== ""
            )
              return true;
            const r = t.structural?.range;
            if (!r) return true;
            const existingLabel = t.structural?.label ?? "";
            if (!existingLabel.includes(" → ")) return true;
            const overlaps =
              Math.max(r.from, range.from) <= Math.min(r.to, range.to);
            if (!overlaps) return true;
            const m = existingLabel.match(/^(.+?) → (.+)$/);
            if (m) inheritedFrom = m[1];
            return false;
          });
          const effectiveFrom = inheritedFrom ?? newFrom;
          if (effectiveFrom === newTo) {
            return remaining;
          }
          addedThread = true;
          return [
            ...remaining,
            {
              id,
              kind: "structural",
              note: "",
              state: "pending",
              createdAt: Date.now(),
              structural: {
                label: `${effectiveFrom} → ${newTo}`,
                range,
              },
            },
          ];
        }

        // Formatting marks / label-only structural threads.
        let purgedSameLabel = false;
        const filtered = prev.filter((t) => {
          if (!range) return true;
          if (
            t.kind !== "structural" ||
            t.state !== "pending" ||
            t.note !== ""
          )
            return true;
          const r = t.structural?.range;
          if (!r || r.from !== range.from || r.to !== range.to) return true;
          if (t.structural?.label === label) purgedSameLabel = true;
          return false;
        });
        if (range && purgedSameLabel) return filtered;
        addedThread = true;
        return [
          ...filtered,
          {
            id,
            kind: "structural",
            note: "",
            state: "pending",
            createdAt: Date.now(),
            structural: range ? { label, range } : { label },
          },
        ];
      });
      if (addedThread) setActiveThreadId(id);
      else setActiveThreadId(null);
      editContextRef.current = null;
    },
    [],
  );

  const registerNoteThread = useCallback(
    (threadId: string, anchor?: { from: number; to: number }) => {
      setThreads((prev) => [
        ...prev,
        {
          id: threadId,
          kind: "note",
          note: "",
          state: "pending",
          createdAt: Date.now(),
          anchor,
          autoFocusNote: true,
        },
      ]);
      setActiveThreadId(threadId);
    },
    [],
  );

  const activateThread = useCallback((id: string | null) => {
    setActiveThreadId(id);
    if (id === null) return;
    setThreads((prev) =>
      prev.map((t) => (t.id === id && t.collapsed ? { ...t, collapsed: false } : t)),
    );
  }, []);

  const onEditContext = useCallback((ctx: EditContext) => {
    editContextRef.current = ctx;
  }, []);

  const onResetEditContext = useCallback(() => {
    editContextRef.current = null;
  }, []);

  const editorProps = useProposedEditHandlers({
    pickThreadId,
    registerThread,
    registerStructuralThread,
    activateThread,
    onEditContext,
    onResetEditContext,
  });

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        codeBlock: false,
      }),
      BlockIndent,
      CodeBlock,
      TaskList,
      TaskItem.configure({ nested: true }),
      ProposedDeletion,
      ProposedInsertion,
      ThreadInteraction.configure({
        onThreadClick: (id) => activateThread(id),
      }),
    ],
    content: initialContent ?? sampleManuscript,
    autofocus: false,
    immediatelyRender: false,
    editorProps,
  });

  const bump = useCallback(() => bumpLayout((n) => n + 1), []);
  const { resetBaseline } = useFormattingDiff(editor, setThreads, bump);

  // When the server-driven initialContent changes, fold the new doc into the
  // existing editor instead of remounting. This preserves selection, undo
  // history, and any proposed marks whose threadId is still present.
  //
  // Safety: if the user has pending redline/note work against positions that
  // no longer exist in the new doc, setContent will drop those marks when
  // re-parsing HTML. We keep the thread objects in state regardless — the
  // formatting-diff hook will GC stranded entries on the next transaction.
  const lastAppliedContentRef = useRef<string | null>(null);
  useEffect(() => {
    if (!editor) return;
    const incoming = initialContent ?? sampleManuscript;
    if (lastAppliedContentRef.current === null) {
      lastAppliedContentRef.current = incoming;
      return;
    }
    if (lastAppliedContentRef.current === incoming) return;
    lastAppliedContentRef.current = incoming;

    // If the user has in-flight pending edits or the editor is focused,
    // don't stomp their work. The SSE diff can still flash in DocView.
    const hasPending = threads.some((t) => t.state === "pending");
    if (hasPending || editor.isFocused) return;

    const prevSelection = editor.state.selection;
    const prevFrom = prevSelection.from;
    const prevTo = prevSelection.to;
    editor.commands.setContent(incoming, { emitUpdate: false });
    resetBaseline();
    const size = editor.state.doc.content.size;
    if (prevFrom <= size && prevTo <= size) {
      try {
        editor.commands.setTextSelection({
          from: Math.min(prevFrom, size),
          to: Math.min(prevTo, size),
        });
      } catch {
        /* selection drift is non-fatal */
      }
    }
  }, [editor, initialContent, threads, resetBaseline]);

  useLayoutEffect(() => {
    const onResize = () => bumpLayout((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useServerThreads(docPath, docRef, setThreads);

  // Global keyboard: "?" toggles help, Esc closes panels.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inField =
        target &&
        (target.tagName === "TEXTAREA" ||
          target.tagName === "INPUT" ||
          target.isContentEditable);
      if (e.key === "?" && !inField) {
        e.preventDefault();
        setShowHelp((v) => !v);
      } else if (e.key === "Escape") {
        setShowHelp(false);
        setShowReview(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Help is always closed on load. Users press `?` (or the fab/kbd button)
  // to open it. Dismissing just closes — no localStorage, no first-run pop.
  const dismissHelp = useCallback(() => {
    setShowHelp(false);
  }, []);

  const getThreadView = useCallback(
    (threadId: string) => {
      if (!editor) return null;
      const del = findThreadRange(editor.state.doc, threadId);
      const ins = findInsertionRange(editor.state.doc, threadId);
      if (!del && !ins) return null;
      return { del, ins };
    },
    [editor],
  );

  const getAnchorTop = useCallback(
    (threadId: string): number | null => {
      if (!editor || !manuscriptRef.current) return null;
      const view = getThreadView(threadId);
      let pos = view?.del?.from ?? view?.ins?.from ?? null;
      if (pos === null) {
        const thread = threads.find((t) => t.id === threadId);
        pos = thread?.anchor?.from ?? null;
      }
      if (pos === null) return null;
      try {
        const coords = editor.view.coordsAtPos(pos);
        const wrapRect = manuscriptRef.current.getBoundingClientRect();
        return coords.top - wrapRect.top;
      } catch {
        return null;
      }
    },
    [editor, getThreadView, threads],
  );

  const setNote = useCallback((threadId: string, note: string) => {
    setThreads((prev) =>
      prev.map((t) => (t.id === threadId ? { ...t, note } : t)),
    );
  }, []);

  const setThreadCollapsed = useCallback(
    (threadId: string, collapsed: boolean) => {
      setThreads((prev) =>
        prev.map((t) => (t.id === threadId ? { ...t, collapsed } : t)),
      );
    },
    [],
  );

  const setAllCollapsed = useCallback((collapsed: boolean) => {
    setThreads((prev) => prev.map((t) => ({ ...t, collapsed })));
  }, []);

  const onClearContextFor = useCallback((threadId: string) => {
    if (editContextRef.current?.threadId === threadId) {
      editContextRef.current = null;
    }
  }, []);

  const { acceptThread, declineThread } = useThreadOutcome({
    editor,
    threads,
    getThreadView,
    setThreads,
    setActiveThreadId,
    onClearContextFor,
  });

  const submitReview = useSubmitReview({
    editor,
    docPath,
    docRef,
    threads,
    mdRef,
    getThreadView,
    setThreads,
    setSubmitError,
    setShowReview,
  });

  const actOnDraft = useCallback(
    async (kind: "accept" | "decline") => {
      if (docRef === "main") return;
      setDraftBusy(true);
      try {
        const r = await fetch(`/api/ui/drafts/${docRef}/${kind}`, {
          method: "POST",
        });
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          setSubmitError(body.error ?? `${kind} failed`);
          return;
        }
        router.push(docPath ? `/doc/${docPath}` : "/");
      } catch (e) {
        setSubmitError(e instanceof Error ? e.message : String(e));
      } finally {
        setDraftBusy(false);
      }
    },
    [docRef, docPath, router],
  );

  const pendingThreads = useMemo(
    () => threads.filter((t) => t.state === "pending"),
    [threads],
  );

  const startNoteThread = useCallback(() => {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    if (from === to) return;
    const threadId = newId("note");
    registerNoteThread(threadId, { from, to });
    editor.commands.setTextSelection(to);
  }, [editor, registerNoteThread]);

  return (
    <>
      <header className="page-header">
        <span className="title">
          {docRef !== "main" ? `draft · ${docPath ?? ""}` : "sheaf · redline prototype"}
        </span>
        <span className="page-header-right">
          {docRef !== "main" ? (
            <>
              <button
                type="button"
                className="draft-accept"
                disabled={draftBusy}
                onClick={() => void actOnDraft("accept")}
              >
                accept draft
              </button>
              <button
                type="button"
                className="draft-decline"
                disabled={draftBusy}
                onClick={() => void actOnDraft("decline")}
              >
                decline draft
              </button>
            </>
          ) : (
            <>
              edit anywhere — your changes become suggestions. press{" "}
              <button
                type="button"
                className="help-key-btn"
                onClick={() => setShowHelp(true)}
                aria-label="open help"
              >
                <kbd>?</kbd>
              </button>{" "}
              for help.
            </>
          )}
        </span>
      </header>
      {submitError ? (
        <div className="submit-error" role="alert">
          {submitError}
          <button
            type="button"
            onClick={() => setSubmitError(null)}
            aria-label="dismiss"
          >
            ×
          </button>
        </div>
      ) : null}
      <div className="layout">
        <div className="manuscript-wrap" ref={manuscriptRef}>
          <div className="manuscript">
            <EditorContent editor={editor} />
          </div>
        </div>
        <MarginRail
          threads={threads}
          activeThreadId={activeThreadId}
          getAnchorTop={getAnchorTop}
          getThreadView={getThreadView}
          onActivate={activateThread}
          onSetNote={setNote}
          onAccept={acceptThread}
          onDecline={declineThread}
          onToggleCollapsed={setThreadCollapsed}
          onSetAllCollapsed={setAllCollapsed}
        />
      </div>
      <SelectionBubble
        editor={editor}
        onComment={startNoteThread}
        onStructuralMark={(label, range) => registerStructuralThread(label, range)}
        onIndent={() => {
          if (!editor) return;
          tryIndent(editor.state, editor.view.dispatch, "in");
          editor.view.focus();
        }}
        onOutdent={() => {
          if (!editor) return;
          tryIndent(editor.state, editor.view.dispatch, "out");
          editor.view.focus();
        }}
      />
      <ReviewBundle
        pendingCount={pendingThreads.length}
        open={showReview}
        onOpen={() => setShowReview(true)}
        onClose={() => setShowReview(false)}
        onSubmit={submitReview}
        pending={pendingThreads}
      />
      <button
        className="help-fab"
        onClick={() => setShowHelp(true)}
        aria-label="help"
        title="help (?)"
      >
        ?
      </button>
      {showHelp && <HelpModal onClose={dismissHelp} />}
    </>
  );
}

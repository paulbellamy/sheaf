"use client";

import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { newId, type DraftVariant, type Thread } from "@/lib/types";
import { sampleManuscript } from "@/lib/sampleText";
import { ProposedDeletion, findThreadRange } from "./extensions/ProposedDeletion";
import { ReplacementWidget } from "./extensions/ReplacementWidget";
import { MarginRail } from "./MarginRail";

export function Manuscript() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [justCreatedId, setJustCreatedId] = useState<string | null>(null);
  const [, bumpLayout] = useState(0);

  const threadsRef = useRef<Thread[]>([]);
  const manuscriptRef = useRef<HTMLDivElement | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({}),
      ProposedDeletion,
      ReplacementWidget.configure({
        getThreads: () => threadsRef.current,
        onThreadClick: (id) => {
          setActiveThreadId(id);
        },
      }),
    ],
    content: sampleManuscript,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: "ProseMirror manuscript-prose",
        spellcheck: "false",
      },
    },
  });

  // Keep threadsRef current + nudge editor to recompute decorations.
  useEffect(() => {
    threadsRef.current = threads;
    if (editor) {
      editor.view.dispatch(editor.state.tr);
    }
  }, [threads, editor]);

  // Force a layout recompute after the editor settles.
  useEffect(() => {
    if (!editor) return;
    const handler = () => bumpLayout((n) => n + 1);
    editor.on("transaction", handler);
    return () => {
      editor.off("transaction", handler);
    };
  }, [editor]);

  // Recompute rail alignment on window resize.
  useLayoutEffect(() => {
    const onResize = () => bumpLayout((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const startThread = useCallback(() => {
    if (!editor) return;
    const { from, to, empty } = editor.state.selection;
    if (empty) return;

    const anchorText = editor.state.doc.textBetween(from, to, " ");
    if (!anchorText.trim()) return;

    // Refuse to start a thread inside an existing thread range.
    let overlap = false;
    editor.state.doc.nodesBetween(from, to, (node) => {
      if (overlap) return false;
      if (node.marks?.some((m) => m.type.name === "proposedDeletion")) {
        overlap = true;
      }
      return true;
    });
    if (overlap) return;

    const threadId = newId("thrd");
    const variantId = newId("var");

    editor
      .chain()
      .focus()
      .setMark("proposedDeletion", { threadId })
      .setTextSelection(to)
      .run();

    const thread: Thread = {
      id: threadId,
      anchorText,
      variants: [
        { id: variantId, author: "you", replacement: "", note: "" },
      ],
      activeVariantId: variantId,
      state: "open",
      createdAt: Date.now(),
    };

    setThreads((prev) => [...prev, thread]);
    setActiveThreadId(threadId);
    setJustCreatedId(threadId);
    window.setTimeout(() => setJustCreatedId(null), 200);
  }, [editor]);

  // Keyboard shortcut: cmd/ctrl + e to start a thread.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "e") {
        e.preventDefault();
        startThread();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [startThread]);

  const getAnchorTop = useCallback(
    (threadId: string): number | null => {
      if (!editor || !manuscriptRef.current) return null;
      const range = findThreadRange(editor.state.doc, threadId);
      if (!range) return null;
      try {
        const coords = editor.view.coordsAtPos(range.from);
        const wrapRect = manuscriptRef.current.getBoundingClientRect();
        return coords.top - wrapRect.top;
      } catch {
        return null;
      }
    },
    [editor],
  );

  const updateVariant = useCallback(
    (threadId: string, variantId: string, patch: Partial<DraftVariant>) => {
      setThreads((prev) =>
        prev.map((t) =>
          t.id !== threadId
            ? t
            : {
                ...t,
                variants: t.variants.map((v) =>
                  v.id === variantId ? { ...v, ...patch } : v,
                ),
              },
        ),
      );
    },
    [],
  );

  const selectVariant = useCallback((threadId: string, variantId: string) => {
    setThreads((prev) =>
      prev.map((t) =>
        t.id !== threadId ? t : { ...t, activeVariantId: variantId },
      ),
    );
  }, []);

  const forkVariant = useCallback((threadId: string) => {
    setThreads((prev) =>
      prev.map((t) => {
        if (t.id !== threadId) return t;
        const parent = t.variants.find((v) => v.id === t.activeVariantId);
        const newVariant: DraftVariant = {
          id: newId("var"),
          author: "you",
          replacement: parent?.replacement ?? "",
          note: "",
        };
        return {
          ...t,
          variants: [...t.variants, newVariant],
          activeVariantId: newVariant.id,
        };
      }),
    );
  }, []);

  const acceptThread = useCallback(
    (threadId: string) => {
      if (!editor) return;
      const thread = threadsRef.current.find((t) => t.id === threadId);
      if (!thread) return;
      const variant =
        thread.variants.find((v) => v.id === thread.activeVariantId) ||
        thread.variants[0];
      const range = findThreadRange(editor.state.doc, threadId);
      if (!range) return;

      const tr = editor.state.tr;
      if (variant.replacement.length > 0) {
        tr.insertText(variant.replacement, range.from, range.to);
      } else {
        tr.delete(range.from, range.to);
      }
      editor.view.dispatch(tr);

      setThreads((prev) => prev.filter((t) => t.id !== threadId));
      setActiveThreadId(null);
    },
    [editor],
  );

  const declineThread = useCallback(
    (threadId: string) => {
      if (!editor) return;
      editor.commands.unsetProposedDeletion(threadId);
      setThreads((prev) => prev.filter((t) => t.id !== threadId));
      setActiveThreadId(null);
    },
    [editor],
  );

  return (
    <>
      <header className="page-header">
        <span className="title">sheaf · redline prototype</span>
        <span>
          select text, press <kbd>⌘</kbd>
          <kbd>E</kbd> to start a thread
        </span>
      </header>
      <div className="layout">
        <div className="manuscript-wrap" ref={manuscriptRef}>
          <div className="manuscript">
            <EditorContent editor={editor} />
          </div>
        </div>
        <MarginRail
          threads={threads}
          activeThreadId={activeThreadId}
          justCreatedId={justCreatedId}
          getAnchorTop={getAnchorTop}
          onActivate={setActiveThreadId}
          onUpdateVariant={updateVariant}
          onSelectVariant={selectVariant}
          onForkVariant={forkVariant}
          onAccept={acceptThread}
          onDecline={declineThread}
        />
      </div>
    </>
  );
}

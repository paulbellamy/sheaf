"use client";

import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TextSelection } from "@tiptap/pm/state";
import type { MarkType, Node as PMNode } from "@tiptap/pm/model";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { newId, type Thread } from "@/lib/types";
import { sampleManuscript } from "@/lib/sampleText";
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

const THREAD_IDLE_MS = 1800;
const THREAD_NEAR_POS = 2;

type EditContext = {
  threadId: string;
  lastPos: number;
  lastTime: number;
};

function findThreadIdAt(
  doc: PMNode,
  pos: number,
  types: MarkType[],
): string | null {
  let found: string | null = null;
  doc.nodesBetween(Math.max(0, pos - 1), Math.min(doc.content.size, pos + 1), (node) => {
    if (found) return false;
    if (!node.isText) return true;
    for (const m of node.marks) {
      if (types.includes(m.type) && typeof m.attrs.threadId === "string") {
        found = m.attrs.threadId;
        return false;
      }
    }
    return true;
  });
  return found;
}

export function Manuscript() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [, bumpLayout] = useState(0);

  const editContextRef = useRef<EditContext | null>(null);
  const manuscriptRef = useRef<HTMLDivElement | null>(null);

  // Shared helper: decide which thread an edit belongs to.
  const pickThreadId = useCallback(
    (doc: PMNode, pos: number, schema: PMNode["type"]["schema"]): {
      threadId: string;
      isNew: boolean;
    } => {
      const insType = schema.marks.proposedInsertion;
      const delType = schema.marks.proposedDeletion;
      const existing = findThreadIdAt(doc, pos, [insType, delType]);
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
      if (
        ctx &&
        now - ctx.lastTime < THREAD_IDLE_MS &&
        Math.abs(pos - ctx.lastPos) <= THREAD_NEAR_POS
      ) {
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
      { id: threadId, note: "", state: "open", createdAt: Date.now() },
    ]);
  }, []);

  const editor = useEditor({
    extensions: [
      StarterKit,
      ProposedDeletion,
      ProposedInsertion,
      ThreadInteraction.configure({
        onThreadClick: (id) => setActiveThreadId(id),
      }),
    ],
    content: sampleManuscript,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: "ProseMirror manuscript-prose",
        spellcheck: "false",
      },

      // Any character typed becomes a proposed insertion.
      handleTextInput(view, from, to, text) {
        const schema = view.state.schema;
        const insType = schema.marks.proposedInsertion;
        const delType = schema.marks.proposedDeletion;

        const { threadId, isNew } = pickThreadId(view.state.doc, from, schema);

        const insMark = insType.create({ threadId });
        const delMark = delType.create({ threadId });

        let tr = view.state.tr;

        if (from !== to) {
          // Replacement: mark original range as deletion, insert new text after.
          tr = tr.addMark(from, to, delMark);
          tr = tr.insert(to, schema.text(text, [insMark]));
          tr = tr.setSelection(TextSelection.create(tr.doc, to + text.length));
        } else {
          // Pure insertion.
          tr = tr.insert(from, schema.text(text, [insMark]));
          tr = tr.setSelection(TextSelection.create(tr.doc, from + text.length));
        }

        editContextRef.current = {
          threadId,
          lastPos: (from !== to ? to : from) + text.length,
          lastTime: Date.now(),
        };

        view.dispatch(tr);
        if (isNew) registerThread(threadId);
        setActiveThreadId(threadId);
        return true;
      },

      // Backspace / Delete → proposed deletion (unless undoing your own insertion).
      handleKeyDown(view, event) {
        if (event.key !== "Backspace" && event.key !== "Delete") return false;

        const { from, to, empty } = view.state.selection;
        let delFrom: number;
        let delTo: number;

        if (!empty) {
          delFrom = from;
          delTo = to;
        } else if (event.key === "Backspace") {
          if (from === 0) return false;
          delFrom = from - 1;
          delTo = from;
        } else {
          if (to >= view.state.doc.content.size) return false;
          delFrom = to;
          delTo = to + 1;
        }

        const schema = view.state.schema;
        const insType = schema.marks.proposedInsertion;
        const delType = schema.marks.proposedDeletion;

        let sawText = false;
        let allInsertion = true;
        let allAlreadyDeleted = true;
        view.state.doc.nodesBetween(delFrom, delTo, (node) => {
          if (!node.isText) return true;
          sawText = true;
          if (!node.marks.some((m) => m.type === insType)) allInsertion = false;
          if (!node.marks.some((m) => m.type === delType))
            allAlreadyDeleted = false;
          return true;
        });
        if (!sawText) {
          allInsertion = false;
          allAlreadyDeleted = false;
        }

        let tr = view.state.tr;

        if (sawText && allInsertion) {
          // Undoing one's own proposed insertion → actually delete from doc.
          tr = tr.delete(delFrom, delTo);
          tr = tr.setSelection(TextSelection.create(tr.doc, delFrom));
        } else if (sawText && allAlreadyDeleted) {
          // Already marked for deletion → just move cursor past the strikethrough.
          const newPos = event.key === "Backspace" ? delFrom : delTo;
          tr = tr.setSelection(TextSelection.create(view.state.doc, newPos));
        } else {
          const { threadId, isNew } = pickThreadId(
            view.state.doc,
            delFrom,
            schema,
          );
          tr = tr.addMark(delFrom, delTo, delType.create({ threadId }));
          const newPos = event.key === "Backspace" ? delFrom : delTo;
          tr = tr.setSelection(TextSelection.create(tr.doc, newPos));

          editContextRef.current = {
            threadId,
            lastPos: delFrom,
            lastTime: Date.now(),
          };

          if (isNew) registerThread(threadId);
          setActiveThreadId(threadId);
        }

        view.dispatch(tr);
        event.preventDefault();
        return true;
      },

      // Paste → convert pasted text into a proposed insertion as well.
      handlePaste(view, event) {
        const text = event.clipboardData?.getData("text/plain");
        if (!text) return false;
        const { from, to } = view.state.selection;
        const schema = view.state.schema;
        const insType = schema.marks.proposedInsertion;
        const delType = schema.marks.proposedDeletion;
        const { threadId, isNew } = pickThreadId(view.state.doc, from, schema);

        let tr = view.state.tr;
        if (from !== to) {
          tr = tr.addMark(from, to, delType.create({ threadId }));
          tr = tr.insert(
            to,
            schema.text(text, [insType.create({ threadId })]),
          );
          tr = tr.setSelection(TextSelection.create(tr.doc, to + text.length));
        } else {
          tr = tr.insert(
            from,
            schema.text(text, [insType.create({ threadId })]),
          );
          tr = tr.setSelection(
            TextSelection.create(tr.doc, from + text.length),
          );
        }

        editContextRef.current = {
          threadId,
          lastPos: (from !== to ? to : from) + text.length,
          lastTime: Date.now(),
        };

        view.dispatch(tr);
        if (isNew) registerThread(threadId);
        setActiveThreadId(threadId);
        event.preventDefault();
        return true;
      },
    },
  });

  // Force MarginRail layout recompute whenever the doc changes.
  useEffect(() => {
    if (!editor) return;
    const handler = () => bumpLayout((n) => n + 1);
    editor.on("transaction", handler);
    return () => {
      editor.off("transaction", handler);
    };
  }, [editor]);

  useLayoutEffect(() => {
    const onResize = () => bumpLayout((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
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
      if (!view) return null;
      const pos = view.del?.from ?? view.ins?.from ?? null;
      if (pos === null) return null;
      try {
        const coords = editor.view.coordsAtPos(pos);
        const wrapRect = manuscriptRef.current.getBoundingClientRect();
        return coords.top - wrapRect.top;
      } catch {
        return null;
      }
    },
    [editor, getThreadView],
  );

  const setNote = useCallback((threadId: string, note: string) => {
    setThreads((prev) =>
      prev.map((t) => (t.id === threadId ? { ...t, note } : t)),
    );
  }, []);

  const acceptThread = useCallback(
    (threadId: string) => {
      if (!editor) return;
      const view = getThreadView(threadId);
      if (!view) {
        setThreads((prev) => prev.filter((t) => t.id !== threadId));
        return;
      }

      const schema = editor.state.schema;
      const insType = schema.marks.proposedInsertion;

      // Positions can shift when we delete; do the later op first.
      const ops: Array<{ kind: "delete" | "unmark"; from: number; to: number }> =
        [];
      if (view.del) ops.push({ kind: "delete", from: view.del.from, to: view.del.to });
      if (view.ins) ops.push({ kind: "unmark", from: view.ins.from, to: view.ins.to });
      ops.sort((a, b) => b.from - a.from);

      let tr = editor.state.tr;
      for (const op of ops) {
        if (op.kind === "delete") tr = tr.delete(op.from, op.to);
        else tr = tr.removeMark(op.from, op.to, insType);
      }
      editor.view.dispatch(tr);

      setThreads((prev) => prev.filter((t) => t.id !== threadId));
      setActiveThreadId(null);
      if (editContextRef.current?.threadId === threadId) {
        editContextRef.current = null;
      }
    },
    [editor, getThreadView],
  );

  const declineThread = useCallback(
    (threadId: string) => {
      if (!editor) return;
      const view = getThreadView(threadId);
      if (!view) {
        setThreads((prev) => prev.filter((t) => t.id !== threadId));
        return;
      }
      const schema = editor.state.schema;
      const delType = schema.marks.proposedDeletion;

      const ops: Array<{ kind: "unmark" | "delete"; from: number; to: number }> =
        [];
      if (view.del) ops.push({ kind: "unmark", from: view.del.from, to: view.del.to });
      if (view.ins) ops.push({ kind: "delete", from: view.ins.from, to: view.ins.to });
      ops.sort((a, b) => b.from - a.from);

      let tr = editor.state.tr;
      for (const op of ops) {
        if (op.kind === "delete") tr = tr.delete(op.from, op.to);
        else tr = tr.removeMark(op.from, op.to, delType);
      }
      editor.view.dispatch(tr);

      setThreads((prev) => prev.filter((t) => t.id !== threadId));
      setActiveThreadId(null);
      if (editContextRef.current?.threadId === threadId) {
        editContextRef.current = null;
      }
    },
    [editor, getThreadView],
  );

  return (
    <>
      <header className="page-header">
        <span className="title">sheaf · redline prototype</span>
        <span>edit anywhere — your changes become suggestions.</span>
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
          getAnchorTop={getAnchorTop}
          getThreadView={getThreadView}
          onActivate={setActiveThreadId}
          onSetNote={setNote}
          onAccept={acceptThread}
          onDecline={declineThread}
        />
      </div>
    </>
  );
}

"use client";

import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Extension } from "@tiptap/core";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { CodeBlockView } from "./CodeBlockView";
import { TextSelection } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { MarkType, Node as PMNode } from "@tiptap/pm/model";
import { liftListItem, sinkListItem } from "@tiptap/pm/schema-list";
import { common, createLowlight } from "lowlight";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

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
import { HelpModal } from "./HelpModal";
import { ReviewBundle } from "./ReviewBundle";
import { SelectionBubble } from "./SelectionBubble";

const THREAD_IDLE_MS = 4000;

type EditContext = {
  threadId: string;
  lastPos: number;
  lastTime: number;
};

type MarkdownTrigger =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6 }
  | { kind: "bulletList" }
  | { kind: "orderedList" }
  | { kind: "blockquote" }
  | { kind: "codeBlock"; language: string | null };

function detectMarkdownTrigger(
  doc: PMNode,
  from: number,
  text: string,
): MarkdownTrigger | null {
  if (text !== " ") return null;

  const $from = doc.resolve(from);
  const block = $from.parent;
  if (block.type.name !== "paragraph") return null;

  const blockStart = $from.start();
  const before = block.textBetween(0, from - blockStart, "\n", "\n");

  const hashes = before.match(/^(#{1,6})$/);
  if (hashes) {
    const level = hashes[1].length as 1 | 2 | 3 | 4 | 5 | 6;
    return { kind: "heading", level };
  }
  if (/^[-*+]$/.test(before)) return { kind: "bulletList" };
  if (/^\d+\.$/.test(before)) return { kind: "orderedList" };
  if (/^>$/.test(before)) return { kind: "blockquote" };
  const code = before.match(/^```([a-z]*)$/i);
  if (code) {
    return { kind: "codeBlock", language: code[1] ? code[1].toLowerCase() : null };
  }
  return null;
}

function structuralLabelFor(trigger: MarkdownTrigger): string {
  switch (trigger.kind) {
    case "heading":
      return `¶ → H${trigger.level}`;
    case "bulletList":
      return "¶ → bullet list";
    case "orderedList":
      return "¶ → numbered list";
    case "blockquote":
      return "¶ → blockquote";
    case "codeBlock":
      return `¶ → code block${trigger.language ? ` (${trigger.language})` : ""}`;
  }
}

const MAX_INDENT = 6;

const BlockIndent = Extension.create({
  name: "blockIndent",
  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: {
          indent: {
            default: 0,
            parseHTML: (el) =>
              parseInt(el.getAttribute("data-indent") ?? "0", 10) || 0,
            renderHTML: (attrs) => {
              const v = (attrs as { indent?: number }).indent ?? 0;
              return v > 0 ? { "data-indent": String(v) } : {};
            },
          },
        },
      },
    ];
  },
});

function tryIndent(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  direction: "in" | "out",
): boolean {
  const li = state.schema.nodes.listItem;
  if (li) {
    const cmd = direction === "out" ? liftListItem(li) : sinkListItem(li);
    if (cmd(state, dispatch)) return true;
  }
  const $from = state.selection.$from;
  const block = $from.parent;
  if (!["paragraph", "heading"].includes(block.type.name)) return false;
  const current = (block.attrs.indent as number | undefined) ?? 0;
  const next =
    direction === "out"
      ? Math.max(0, current - 1)
      : Math.min(MAX_INDENT, current + 1);
  if (next === current) return false;
  if (dispatch) {
    const before = $from.before();
    const tr = state.tr.setNodeMarkup(before, null, {
      ...block.attrs,
      indent: next,
    });
    dispatch(tr);
  }
  return true;
}

// Walk outward from `pos` in each direction. A mark is "contiguous" if we
// encounter it before we cross any unmarked text. Block boundaries (closing
// </p>, opening <li>, etc.) are transparent — they do not break contiguity,
// so edits spanning adjacent paragraphs or list items collapse into one
// thread.
function findContiguousThreadId(
  doc: PMNode,
  pos: number,
  types: MarkType[],
): string | null {
  const walk = (direction: -1 | 1): string | null => {
    let p = pos;
    const limit = direction === -1 ? 0 : doc.content.size;
    while (p !== limit) {
      const $p = doc.resolve(p);
      const node = direction === -1 ? $p.nodeBefore : $p.nodeAfter;
      if (node && node.isText) {
        for (const m of node.marks) {
          if (types.includes(m.type) && typeof m.attrs.threadId === "string") {
            return m.attrs.threadId;
          }
        }
        return null;
      }
      p += direction;
    }
    return null;
  };
  return walk(-1) ?? walk(1);
}

export function Manuscript() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [, bumpLayout] = useState(0);

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

  // Shared helper: decide which thread an edit belongs to.
  const pickThreadId = useCallback(
    (doc: PMNode, pos: number, schema: PMNode["type"]["schema"]): {
      threadId: string;
      isNew: boolean;
    } => {
      const insType = schema.marks.proposedInsertion;
      const delType = schema.marks.proposedDeletion;
      // 1. Contiguous with an existing marked range? Reuse that thread —
      //    this is the primary merge rule, covering edits that span
      //    paragraph / list-item boundaries.
      const existing = findContiguousThreadId(doc, pos, [insType, delType]);
      if (existing) {
        editContextRef.current = {
          threadId: existing,
          lastPos: pos,
          lastTime: Date.now(),
        };
        return { threadId: existing, isNew: false };
      }

      // 2. Soft fallback: if the user is still in a short idle window
      //    from their previous edit (e.g. they just pressed Enter into
      //    an empty block that has no marks yet), keep extending the
      //    same thread so the very first character of the next block
      //    joins the previous one.
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

  const registerStructuralThread = useCallback((label: string) => {
    const id = newId("strc");
    setThreads((prev) => [
      ...prev,
      {
        id,
        kind: "structural",
        note: "",
        state: "pending",
        createdAt: Date.now(),
        structural: { label },
      },
    ]);
    setActiveThreadId(id);
    // A structural transform (e.g. "- " → bullet list) dropped the trigger
    // text; reset the edit context so follow-on typing starts a fresh
    // redline thread rather than inheriting the (now orphaned) previous id.
    editContextRef.current = null;
  }, []);

  const registerNoteThread = useCallback((threadId: string) => {
    setThreads((prev) => [
      ...prev,
      {
        id: threadId,
        kind: "note",
        note: "",
        state: "pending",
        createdAt: Date.now(),
        autoFocusNote: true,
      },
    ]);
    setActiveThreadId(threadId);
  }, []);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        codeBlock: false,
      }),
      BlockIndent,
      CodeBlock,
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

      // Any character typed becomes a proposed insertion — unless it completes
      // a markdown trigger (e.g. "# " → heading), in which case we let TipTap's
      // built-in input rules fire and record the transform as a structural thread.
      handleTextInput(view, from, to, text) {
        // Inside a code block: no suggestion wrapping, plain editing.
        const parentType = view.state.doc.resolve(from).parent.type.name;
        if (parentType === "codeBlock") return false;

        const trigger = detectMarkdownTrigger(view.state.doc, from, text);
        if (trigger && from === to) {
          const label = structuralLabelFor(trigger);
          // Let default behaviour run so input rules fire. Schedule the
          // structural thread after the transaction settles.
          queueMicrotask(() => registerStructuralThread(label));
          return false;
        }

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
        if (event.key === "Tab") {
          tryIndent(view.state, view.dispatch, event.shiftKey ? "out" : "in");
          event.preventDefault();
          return true;
        }

        // In code blocks: fall through to default editing behaviour for all keys.
        const $selFrom = view.state.selection.$from;
        if ($selFrom.parent.type.name === "codeBlock") return false;

        if (event.key !== "Backspace" && event.key !== "Delete") return false;

        const { from, to, empty } = view.state.selection;

        // At block boundary with empty selection: let ProseMirror's default join
        // adjacent blocks instead of trying to mark-as-deletion across the gap.
        if (empty) {
          const $from = view.state.selection.$from;
          const $to = view.state.selection.$to;
          if (event.key === "Backspace" && $from.parentOffset === 0) {
            return false;
          }
          if (
            event.key === "Delete" &&
            $to.parentOffset === $to.parent.content.size
          ) {
            return false;
          }
        }
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

  // Force MarginRail layout recompute whenever the doc changes; also GC
  // redline threads whose marks have been stripped (e.g. by an input-rule
  // transform that deleted the trigger text).
  useEffect(() => {
    if (!editor) return;
    const handler = () => {
      bumpLayout((n) => n + 1);
      setThreads((prev) => {
        let changed = false;
        const next = prev.filter((t) => {
          if (t.kind !== "redline") return true;
          const hasDel = !!findThreadRange(editor.state.doc, t.id);
          const hasIns = !!findInsertionRange(editor.state.doc, t.id);
          if (!hasDel && !hasIns) {
            changed = true;
            return false;
          }
          return true;
        });
        return changed ? next : prev;
      });
    };
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

  // First-run help.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!window.localStorage.getItem("sheaf.seen-help")) {
      setShowHelp(true);
    }
  }, []);

  const dismissHelp = useCallback(() => {
    setShowHelp(false);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("sheaf.seen-help", "1");
    }
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
      const target = threads.find((t) => t.id === threadId);
      if (!target) return;

      if (target.kind !== "redline") {
        // Structural + note threads: accept = dismiss card.
        setThreads((prev) => prev.filter((t) => t.id !== threadId));
        setActiveThreadId(null);
        return;
      }

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
    [editor, threads, getThreadView],
  );

  const declineThread = useCallback(
    (threadId: string) => {
      if (!editor) return;
      const target = threads.find((t) => t.id === threadId);
      if (!target) return;

      if (target.kind !== "redline") {
        setThreads((prev) => prev.filter((t) => t.id !== threadId));
        setActiveThreadId(null);
        return;
      }

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
    [editor, threads, getThreadView],
  );

  const submitReview = useCallback((coverNote: string) => {
    setThreads((prev) =>
      prev.map((t) => {
        if (t.state !== "pending") return t;
        const note = coverNote && !t.note ? coverNote : t.note;
        return { ...t, state: "submitted", note };
      }),
    );
    setShowReview(false);
  }, []);

  const pendingThreads = useMemo(
    () => threads.filter((t) => t.state === "pending"),
    [threads],
  );

  const startNoteThread = useCallback(() => {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    if (from === to) return;
    const schema = editor.state.schema;
    const threadId = newId("note");
    const delType = schema.marks.proposedDeletion;
    // We don't want the range to look deleted, so instead we use an
    // insertion-over-nothing trick: add a zero-width marker? Simpler for v0.2:
    // record the selected text range via an insertion mark on a shadow char.
    // For now, just register a note-thread without text anchoring — the user
    // can refer to the selection via their note.
    void delType;
    registerNoteThread(threadId);
  }, [editor, registerNoteThread]);

  return (
    <>
      <header className="page-header">
        <span className="title">sheaf · redline prototype</span>
        <span>
          edit anywhere — your changes become suggestions. press{" "}
          <kbd>?</kbd> for help.
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
          getAnchorTop={getAnchorTop}
          getThreadView={getThreadView}
          onActivate={setActiveThreadId}
          onSetNote={setNote}
          onAccept={acceptThread}
          onDecline={declineThread}
        />
      </div>
      <SelectionBubble
        editor={editor}
        onComment={startNoteThread}
        onStructuralMark={(label) => registerStructuralThread(label)}
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

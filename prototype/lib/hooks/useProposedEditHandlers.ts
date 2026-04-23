import { useMemo } from "react";
import { TextSelection } from "@tiptap/pm/state";
import type { Transaction } from "@tiptap/pm/state";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import type { EditorProps, EditorView } from "@tiptap/pm/view";

import {
  detectMarkdownTrigger,
  structuralLabelFor,
  tryIndent,
} from "@/lib/editor-helpers";

type PickThreadId = (
  doc: PMNode,
  pos: number,
  schema: Schema,
) => { threadId: string; isNew: boolean };

type EditContext = { threadId: string; lastPos: number; lastTime: number };

type Params = {
  pickThreadId: PickThreadId;
  registerThread: (threadId: string) => void;
  registerStructuralThread: (
    label: string,
    range?: { from: number; to: number },
  ) => void;
  activateThread: (id: string | null) => void;
  onEditContext: (ctx: EditContext) => void;
  onResetEditContext: () => void;
};

/**
 * Shared "replace [from, to] with text as a proposed edit" operation used by
 * both handleTextInput and handlePaste. Marks the original range as a
 * proposedDeletion (when from !== to), inserts the new text wrapped in a
 * proposedInsertion, and moves the cursor past the insertion.
 */
function proposeReplacement(
  view: EditorView,
  range: { from: number; to: number },
  text: string,
  threadId: string,
): Transaction {
  const schema = view.state.schema;
  const insType = schema.marks.proposedInsertion;
  const delType = schema.marks.proposedDeletion;

  let tr = view.state.tr;
  const { from, to } = range;

  if (from !== to) {
    tr = tr.addMark(from, to, delType.create({ threadId }));
    tr = tr.insert(to, schema.text(text, [insType.create({ threadId })]));
    tr = tr.setSelection(TextSelection.create(tr.doc, to + text.length));
  } else {
    tr = tr.insert(from, schema.text(text, [insType.create({ threadId })]));
    tr = tr.setSelection(TextSelection.create(tr.doc, from + text.length));
  }
  return tr;
}

/**
 * ProseMirror editorProps handlers for the proposed-edit UX: every text input
 * becomes a proposedInsertion, Backspace/Delete becomes proposedDeletion,
 * paste becomes a bulk insertion. Markdown shortcuts like `# ` flow through
 * input rules and spawn a structural thread.
 */
export function useProposedEditHandlers({
  pickThreadId,
  registerThread,
  registerStructuralThread,
  activateThread,
  onEditContext,
}: Params): EditorProps {
  return useMemo<EditorProps>(() => {
    // Shared commit tail: dispatch, register, activate, stamp context.
    const commit = (
      view: EditorView,
      tr: Transaction,
      threadId: string,
      isNew: boolean,
      cursorPos: number,
    ) => {
      onEditContext({ threadId, lastPos: cursorPos, lastTime: Date.now() });
      view.dispatch(tr);
      if (isNew) registerThread(threadId);
      activateThread(threadId);
    };

    return {
      attributes: {
        class: "ProseMirror manuscript-prose",
        spellcheck: "false",
      },

      handleTextInput(view, from, to, text) {
        const parentType = view.state.doc.resolve(from).parent.type.name;
        if (parentType === "codeBlock") return false;

        const trigger = detectMarkdownTrigger(view.state.doc, from, text);
        if (trigger && from === to) {
          const label = structuralLabelFor(trigger);
          const triggerPos = from;
          queueMicrotask(() =>
            registerStructuralThread(label, {
              from: triggerPos,
              to: triggerPos,
            }),
          );
          return false;
        }

        const { threadId, isNew } = pickThreadId(
          view.state.doc,
          from,
          view.state.schema,
        );
        const tr = proposeReplacement(view, { from, to }, text, threadId);
        commit(view, tr, threadId, isNew, (from !== to ? to : from) + text.length);
        return true;
      },

      handleKeyDown(view, event) {
        if (event.key === "Tab") {
          tryIndent(view.state, view.dispatch, event.shiftKey ? "out" : "in");
          event.preventDefault();
          return true;
        }

        const $selFrom = view.state.selection.$from;
        if ($selFrom.parent.type.name === "codeBlock") return false;

        if (event.key !== "Backspace" && event.key !== "Delete") return false;

        const { from, to, empty } = view.state.selection;

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
          tr = tr.delete(delFrom, delTo);
          tr = tr.setSelection(TextSelection.create(tr.doc, delFrom));
        } else if (sawText && allAlreadyDeleted) {
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

          commit(view, tr, threadId, isNew, delFrom);
          event.preventDefault();
          return true;
        }

        view.dispatch(tr);
        event.preventDefault();
        return true;
      },

      handlePaste(view, event) {
        const text = event.clipboardData?.getData("text/plain");
        if (!text) return false;
        const { from, to } = view.state.selection;
        const { threadId, isNew } = pickThreadId(
          view.state.doc,
          from,
          view.state.schema,
        );
        const tr = proposeReplacement(view, { from, to }, text, threadId);
        commit(view, tr, threadId, isNew, (from !== to ? to : from) + text.length);
        event.preventDefault();
        return true;
      },
    };
  }, [
    pickThreadId,
    registerThread,
    registerStructuralThread,
    activateThread,
    onEditContext,
  ]);
}

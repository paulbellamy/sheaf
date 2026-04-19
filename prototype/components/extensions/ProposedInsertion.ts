import { Mark, mergeAttributes } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";

export interface ProposedInsertionOptions {
  HTMLAttributes: Record<string, unknown>;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    proposedInsertion: {
      setProposedInsertion: (attrs: { threadId: string }) => ReturnType;
      unsetProposedInsertion: (threadId: string) => ReturnType;
    };
  }
}

export const ProposedInsertion = Mark.create<ProposedInsertionOptions>({
  name: "proposedInsertion",

  inclusive: true,

  addOptions() {
    return { HTMLAttributes: {} };
  },

  addAttributes() {
    return {
      threadId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-thread-id"),
        renderHTML: (attrs) => ({ "data-thread-id": attrs.threadId }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "ins[data-thread-id]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "ins",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        class: "proposed-insertion",
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setProposedInsertion:
        (attrs) =>
        ({ commands }) =>
          commands.setMark(this.name, attrs),
      unsetProposedInsertion:
        (threadId) =>
        ({ tr, state, dispatch }) => {
          const type = state.schema.marks[this.name];
          if (!type) return false;
          let changed = false;
          state.doc.descendants((node, pos) => {
            if (!node.isText) return true;
            const mark = node.marks.find(
              (m) => m.type === type && m.attrs.threadId === threadId,
            );
            if (mark) {
              tr.removeMark(pos, pos + node.nodeSize, mark);
              changed = true;
            }
            return true;
          });
          if (changed && dispatch) dispatch(tr);
          return changed;
        },
    };
  },
});

export function findInsertionRange(
  doc: PMNode,
  threadId: string,
): { from: number; to: number; text: string } | null {
  let from: number | null = null;
  let to: number | null = null;
  let text = "";
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const has = node.marks.some(
      (m) => m.type.name === "proposedInsertion" && m.attrs.threadId === threadId,
    );
    if (has) {
      if (from === null) from = pos;
      to = pos + node.nodeSize;
      text += node.text ?? "";
    }
    return true;
  });
  if (from === null || to === null) return null;
  return { from, to, text };
}

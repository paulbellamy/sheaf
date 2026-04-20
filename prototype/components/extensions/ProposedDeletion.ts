import { Mark, mergeAttributes } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { extractMarkedRange } from "./extractMarkedRange";

export interface ProposedDeletionOptions {
  HTMLAttributes: Record<string, unknown>;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    proposedDeletion: {
      setProposedDeletion: (attrs: { threadId: string }) => ReturnType;
      unsetProposedDeletion: (threadId: string) => ReturnType;
    };
  }
}

export const ProposedDeletion = Mark.create<ProposedDeletionOptions>({
  name: "proposedDeletion",

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
    return [{ tag: "del[data-thread-id]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "del",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        class: "proposed-deletion",
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setProposedDeletion:
        (attrs) =>
        ({ commands }) =>
          commands.setMark(this.name, attrs),
      unsetProposedDeletion:
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

export function findThreadRange(
  doc: PMNode,
  threadId: string,
): { from: number; to: number; text: string } | null {
  return extractMarkedRange(doc, "proposedDeletion", threadId);
}

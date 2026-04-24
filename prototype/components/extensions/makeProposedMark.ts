import { Mark, mergeAttributes } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";

import { extractMarkedRange } from "./extractMarkedRange";

type Params = {
  name: string;
  tag: string;
  className: string;
  inclusive?: boolean;
};

/**
 * Factory for the "proposed insertion/deletion" marks. Both marks carry a
 * threadId attribute, serialize to a specific HTML tag, and provide a
 * findRange helper for locating the span of any given thread.
 */
export function makeProposedMark({ name, tag, className, inclusive }: Params) {
  const mark = Mark.create<{ HTMLAttributes: Record<string, unknown> }>({
    name,
    ...(inclusive ? { inclusive: true } : {}),

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
      return [{ tag: `${tag}[data-thread-id]` }];
    },

    renderHTML({ HTMLAttributes }) {
      return [
        tag,
        mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
          class: className,
        }),
        0,
      ];
    },
  });

  const findRange = (
    doc: PMNode,
    threadId: string,
  ): { from: number; to: number; text: string } | null =>
    extractMarkedRange(doc, name, threadId);

  return { mark, findRange };
}

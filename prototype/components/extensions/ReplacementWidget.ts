import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Thread } from "@/lib/types";
import { findThreadRange } from "./ProposedDeletion";

export interface ReplacementWidgetOptions {
  getThreads: () => Thread[];
  onThreadClick: (threadId: string) => void;
}

export const replacementPluginKey = new PluginKey("sheaf-replacements");

export const ReplacementWidget = Extension.create<ReplacementWidgetOptions>({
  name: "replacementWidget",

  addOptions() {
    return {
      getThreads: () => [],
      onThreadClick: () => {},
    };
  },

  addProseMirrorPlugins() {
    const getThreads = this.options.getThreads;
    const onThreadClick = this.options.onThreadClick;

    return [
      new Plugin({
        key: replacementPluginKey,
        props: {
          decorations: (state) => {
            const threads = getThreads();
            const decos: Decoration[] = [];

            for (const t of threads) {
              if (t.state !== "open") continue;
              const variant = t.variants.find((v) => v.id === t.activeVariantId);
              if (!variant) continue;

              const range = findThreadRange(state.doc, t.id);
              if (!range) continue;

              // Widget for the inline replacement text (if any)
              if (variant.replacement.trim().length > 0) {
                const widget = document.createElement("ins");
                widget.className = "proposed-insertion";
                widget.setAttribute("data-thread-id", t.id);
                widget.textContent = variant.replacement;
                widget.addEventListener("mousedown", (e) => {
                  e.preventDefault();
                  onThreadClick(t.id);
                });
                decos.push(
                  Decoration.widget(range.to, widget, {
                    side: 1,
                    ignoreSelection: true,
                  }),
                );
              }

              // Click handler decoration on the strike range
              decos.push(
                Decoration.inline(range.from, range.to, {
                  class: "proposed-deletion-clickable",
                  "data-thread-id": t.id,
                }),
              );
            }

            return DecorationSet.create(state.doc, decos);
          },

          handleClick: (view, _pos, event) => {
            const target = event.target as HTMLElement | null;
            if (!target) return false;
            const el = target.closest("[data-thread-id]") as HTMLElement | null;
            if (!el) return false;
            const id = el.getAttribute("data-thread-id");
            if (!id) return false;
            onThreadClick(id);
            return true;
          },
        },
      }),
    ];
  },
});

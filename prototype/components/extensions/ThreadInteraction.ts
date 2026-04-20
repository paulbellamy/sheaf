import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

export interface ThreadInteractionOptions {
  onThreadClick: (threadId: string) => void;
}

export const threadInteractionKey = new PluginKey("sheaf-thread-interaction");

export const ThreadInteraction = Extension.create<ThreadInteractionOptions>({
  name: "threadInteraction",

  addOptions() {
    return { onThreadClick: () => {} };
  },

  addProseMirrorPlugins() {
    const onThreadClick = this.options.onThreadClick;
    return [
      new Plugin({
        key: threadInteractionKey,
        props: {
          handleClick: (_view, _pos, event) => {
            const target = event.target as HTMLElement | null;
            if (!target) return false;
            const el = target.closest("[data-thread-id]") as HTMLElement | null;
            if (!el) return false;
            const id = el.getAttribute("data-thread-id");
            if (!id) return false;
            onThreadClick(id);
            return false; // let prosemirror also place cursor
          },
        },
      }),
    ];
  },
});

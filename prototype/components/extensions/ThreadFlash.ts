import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/**
 * A transient highlight on a doc range — used when the user clicks a thread to
 * draw their eye to the anchored text. Unlike a text selection it's
 * non-destructive: it doesn't move the cursor, steal focus, or clobber the
 * user's current selection. The decoration paints a `thread-flash` class over
 * the range, then clears itself after FLASH_MS.
 */
export const threadFlashKey = new PluginKey<DecorationSet>(
  "sheaf-thread-flash",
);

const FLASH_MS = 900;

type FlashMeta =
  | { type: "set"; from: number; to: number }
  | { type: "clear" };

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    threadFlash: {
      /** Briefly highlight `{ from, to }`, then auto-clear. */
      flashRange: (range: { from: number; to: number }) => ReturnType;
    };
  }
}

export const ThreadFlash = Extension.create({
  name: "threadFlash",

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: threadFlashKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, value) {
            const meta = tr.getMeta(threadFlashKey) as FlashMeta | undefined;
            if (meta?.type === "set") {
              return DecorationSet.create(tr.doc, [
                Decoration.inline(meta.from, meta.to, {
                  class: "thread-flash",
                }),
              ]);
            }
            if (meta?.type === "clear") return DecorationSet.empty;
            // No flash meta: map the existing decoration through doc changes.
            return value.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return threadFlashKey.getState(state);
          },
        },
      }),
    ];
  },

  addCommands() {
    return {
      flashRange:
        ({ from, to }) =>
        ({ dispatch, tr, editor }) => {
          if (dispatch) {
            dispatch(tr.setMeta(threadFlashKey, { type: "set", from, to }));
            window.setTimeout(() => {
              const { view } = editor;
              if (view.isDestroyed) return;
              view.dispatch(
                view.state.tr.setMeta(threadFlashKey, { type: "clear" }),
              );
            }, FLASH_MS);
          }
          return true;
        },
    };
  },
});

import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";

/**
 * Transient highlight on a CM6 document range — used when the user clicks a
 * thread to draw their eye to its anchored text. Non-destructive: unlike
 * `editor.setSelection` it doesn't move the cursor or steal the selection.
 *
 * Register `flashField` once as an editor extension (see main.ts), then call
 * `flashRange(view, from, to)` to paint and auto-clear the highlight.
 */
const FLASH_MS = 900;

const setFlash = StateEffect.define<{ from: number; to: number }>();
const clearFlash = StateEffect.define<null>();

const flashMark = Decoration.mark({ class: "sheaf-flash" });

export const flashField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setFlash)) {
        deco = Decoration.set([
          flashMark.range(effect.value.from, effect.value.to),
        ]);
      } else if (effect.is(clearFlash)) {
        deco = Decoration.none;
      }
    }
    return deco;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Flash `[from, to)` (CM6 document offsets), clearing after FLASH_MS. */
export function flashRange(view: EditorView, from: number, to: number): void {
  view.dispatch({ effects: setFlash.of({ from, to }) });
  window.setTimeout(() => {
    // The view may have been torn down (file closed) before the timer fires.
    if ((view as unknown as { destroyed?: boolean }).destroyed) return;
    view.dispatch({ effects: clearFlash.of(null) });
  }, FLASH_MS);
}

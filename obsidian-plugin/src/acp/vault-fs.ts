import { type App, MarkdownView } from "obsidian";

import type { VaultFs } from "./doc-store";
import { minimalEdit } from "../editor/minimal-edit";

/**
 * A {@link VaultFs} backed by Obsidian's vault. Paths are vault-relative (the
 * adapter's native form). Parent folders are created on write so the hidden
 * `.sheaf/ycrdt/` snapshot mirror materializes on demand.
 *
 * Text writes are *editor-aware*: when the target doc is open in a markdown
 * editor, the new content is reconciled into that editor as a minimal change
 * and saved through the view, instead of stomping the file on disk. A raw
 * `adapter.write` to an open file reads to Obsidian as an *external*
 * modification, and its reconcile moves the cursor/viewport to the changed
 * region — so every agent edit would yank the user to wherever the agent is
 * writing. Routing through the editor keeps the user's cursor and scroll where
 * they are (see {@link minimalEdit}). Docs that aren't open fall back to a
 * plain disk write.
 */
export function obsidianVaultFs(app: App): VaultFs {
  const adapter = app.vault.adapter;
  return {
    exists: (p) => adapter.exists(p),
    readText: (p) => adapter.read(p),
    async writeText(p, data) {
      const views = openViewsFor(app, p);
      if (views.length > 0) {
        for (const view of views) reconcileEditor(view, data);
        // Persist through the view so Obsidian sees its own write (no
        // external-change reconcile) and the .md lands before DocStore writes
        // the .ycrdt snapshot (its ordering invariant). One save covers every
        // view — they share the file.
        await views[0].save();
        return;
      }
      await ensureParent(adapter, p);
      await adapter.write(p, data);
    },
    async readBinary(p) {
      return new Uint8Array(await adapter.readBinary(p));
    },
    async writeBinary(p, data) {
      await ensureParent(adapter, p);
      await adapter.writeBinary(p, toArrayBuffer(data));
    },
  };
}

/** Open markdown views showing the vault-relative doc `p`. */
function openViewsFor(app: App, p: string): MarkdownView[] {
  return app.workspace
    .getLeavesOfType("markdown")
    .map((leaf) => leaf.view)
    .filter(
      (v): v is MarkdownView => v instanceof MarkdownView && v.file?.path === p,
    );
}

/**
 * Reconcile `data` into a view's editor as a minimal change, preserving the
 * editor's selection and scroll. A no-op when the editor already holds `data`.
 */
function reconcileEditor(view: MarkdownView, data: string): void {
  const editor = view.editor;
  const edit = minimalEdit(editor.getValue(), data);
  if (!edit) return;
  // Omitting `selection` lets the editor map the user's existing cursor through
  // the change instead of moving it onto the edit.
  editor.transaction({
    changes: [
      {
        from: editor.offsetToPos(edit.from),
        to: editor.offsetToPos(edit.to),
        text: edit.text,
      },
    ],
  });
}

async function ensureParent(
  adapter: App["vault"]["adapter"],
  p: string,
): Promise<void> {
  const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
  if (dir && !(await adapter.exists(dir))) {
    await adapter.mkdir(dir);
  }
}

function toArrayBuffer(d: Uint8Array): ArrayBuffer {
  return d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer;
}

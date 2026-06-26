import {
  applyMarkdown,
  decodeYDoc,
  encodeYDoc,
  markdownToYDoc,
  renderYDoc,
  type YDoc,
} from "sheaf-server/ydoc";

/**
 * The client-write path's storage layer. ACP routes the agent's doc reads and
 * writes through the *client* (`fs/read_text_file` / `fs/write_text_file`); we
 * service them here through a per-doc ydoc instead of stomping the file:
 *
 * - read  → render(ydoc): the live doc, including edits not yet re-read by the
 *   editor.
 * - write → applyMarkdown(ydoc, content): reconcile as minimal CRDT ops so
 *   comment anchors survive (design §4.2 / invariant 3), then persist the
 *   rendered markdown AND the ycrdt snapshot.
 *
 * The ydoc — not the file — is the merge truth. Pure: it takes an injected
 * filesystem so it's unit-tested with no Obsidian vault.
 */

export interface VaultFs {
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  writeText(path: string, data: string): Promise<void>;
  readBinary(path: string): Promise<Uint8Array>;
  writeBinary(path: string, data: Uint8Array): Promise<void>;
}

export interface DocStoreOptions {
  /**
   * Where a doc's binary ycrdt snapshot lives. Defaults to a hidden infra
   * mirror (`.sheaf/ycrdt/<path>.ycrdt`) so the vault explorer stays clean and
   * the snapshot never surfaces as a sheaf doc (dot-prefixed = infra).
   */
  ycrdtPathFor?: (docPath: string) => string;
}

const defaultYcrdtPathFor = (docPath: string): string =>
  `.sheaf/ycrdt/${docPath}.ycrdt`;

export class DocStore {
  private readonly docs = new Map<string, YDoc>();
  private readonly ycrdtPathFor: (docPath: string) => string;

  constructor(
    private readonly fs: VaultFs,
    opts: DocStoreOptions = {},
  ) {
    this.ycrdtPathFor = opts.ycrdtPathFor ?? defaultYcrdtPathFor;
  }

  /** Live markdown for a doc (the ydoc render), loading it on first access. */
  async read(docPath: string): Promise<string> {
    return renderYDoc(await this.load(docPath));
  }

  /**
   * Reconcile a doc to `content` through its ydoc (minimal ops → anchors
   * survive), then persist the rendered markdown and the ycrdt snapshot.
   */
  async write(docPath: string, content: string): Promise<void> {
    const doc = await this.load(docPath);
    applyMarkdown(doc, content, "acp-fs");
    await this.fs.writeText(docPath, renderYDoc(doc));
    await this.fs.writeBinary(this.ycrdtPathFor(docPath), encodeYDoc(doc));
  }

  /** Drop the in-memory ydoc for a doc (e.g. on session teardown). */
  forget(docPath: string): void {
    this.docs.delete(docPath);
  }

  private async load(docPath: string): Promise<YDoc> {
    const cached = this.docs.get(docPath);
    if (cached) return cached;
    const doc = await this.loadFromDisk(docPath);
    this.docs.set(docPath, doc);
    return doc;
  }

  private async loadFromDisk(docPath: string): Promise<YDoc> {
    const ycrdtPath = this.ycrdtPathFor(docPath);
    // Prefer the ycrdt snapshot — the merge-truth carrying anchor history.
    if (await this.fs.exists(ycrdtPath)) {
      try {
        const doc = decodeYDoc(await this.fs.readBinary(ycrdtPath));
        // If the .md was edited out-of-band (user typed in Obsidian) the
        // snapshot is stale; reconcile so render === md before serving.
        if (await this.fs.exists(docPath)) {
          const md = await this.fs.readText(docPath);
          if (renderYDoc(doc) !== md) applyMarkdown(doc, md, "disk-drift");
        }
        return doc;
      } catch {
        // Corrupt snapshot — fall through and rebuild from markdown (§4.4).
      }
    }
    const md = (await this.fs.exists(docPath))
      ? await this.fs.readText(docPath)
      : "";
    return markdownToYDoc(md);
  }
}

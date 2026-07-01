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
  // Cache the load *promise*, not the doc, so concurrent first-access callers
  // share one ydoc instance instead of each building their own.
  private readonly docs = new Map<string, Promise<YDoc>>();
  // Per-path serialization for writes: apply+persist of one write completes
  // before the next to that path begins, so .md and .ycrdt never diverge.
  private readonly writeChains = new Map<string, Promise<unknown>>();
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
   * Serialized per path so overlapping writes can't interleave their persists.
   */
  write(docPath: string, content: string): Promise<void> {
    return this.serializeWrite(docPath, async () => {
      const doc = await this.load(docPath);
      try {
        applyMarkdown(doc, content, "acp-fs");
      } catch (e) {
        // Reconcile failed mid-flight — the cached ydoc may be inconsistent;
        // evict it so the next access reloads a clean copy from disk.
        this.docs.delete(docPath);
        throw e;
      }
      // .md first, then the snapshot: a crash between them leaves .md ahead of
      // .ycrdt, which the drift-reconcile on next load repairs without loss
      // (the reverse order could revert the doc to a stale .md).
      await this.fs.writeText(docPath, renderYDoc(doc));
      await this.fs.writeBinary(this.ycrdtPathFor(docPath), encodeYDoc(doc));
    });
  }

  /** Drop the in-memory ydoc for a doc (e.g. on session teardown). */
  forget(docPath: string): void {
    this.docs.delete(docPath);
  }

  private load(docPath: string): Promise<YDoc> {
    let pending = this.docs.get(docPath);
    if (!pending) {
      // Don't cache a rejected load — let the next access retry.
      pending = this.loadFromDisk(docPath).catch((e) => {
        this.docs.delete(docPath);
        throw e;
      });
      this.docs.set(docPath, pending);
    }
    return pending;
  }

  private serializeWrite<T>(
    docPath: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = this.writeChains.get(docPath) ?? Promise.resolve();
    // Run fn after the prior write settles (success or failure).
    const next = prev.then(fn, fn);
    // The stored tail swallows rejections so one failed write doesn't wedge the
    // chain; the caller still sees its own result/rejection via `next`.
    this.writeChains.set(
      docPath,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private async loadFromDisk(docPath: string): Promise<YDoc> {
    const ycrdtPath = this.ycrdtPathFor(docPath);
    let doc: YDoc | null = null;
    // Prefer the ycrdt snapshot — the merge-truth carrying anchor history.
    if (await this.fs.exists(ycrdtPath)) {
      try {
        doc = decodeYDoc(await this.fs.readBinary(ycrdtPath));
      } catch {
        doc = null; // corrupt snapshot — rebuild from markdown (§4.4)
      }
    }
    if (doc) {
      // If the .md was edited out-of-band (user typed in Obsidian) the snapshot
      // is stale; reconcile so render === md before serving. Done OUTSIDE the
      // decode catch so a reconcile failure surfaces rather than silently
      // rebuilding and tombstoning every anchor.
      if (await this.fs.exists(docPath)) {
        const md = await this.fs.readText(docPath);
        if (renderYDoc(doc) !== md) applyMarkdown(doc, md, "disk-drift");
      }
      return doc;
    }
    const md = (await this.fs.exists(docPath))
      ? await this.fs.readText(docPath)
      : "";
    return markdownToYDoc(md);
  }
}

import { App, ButtonComponent, Modal, Setting } from "obsidian";

export class CommentModal extends Modal {
  private message = "";

  constructor(
    app: App,
    private selection: string,
    // Resolves on a successful post; rejects (throws) on failure. The modal
    // stays open and keeps the typed text when this rejects, so a transient
    // network blip never discards the user's comment.
    private onSubmit: (message: string) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h3", { text: "Comment for agent" });

    if (this.selection.length > 0) {
      const preview = contentEl.createDiv({ cls: "sheaf-selection-preview" });
      preview.setText(
        this.selection.length > 200
          ? this.selection.slice(0, 200) + "…"
          : this.selection,
      );
      preview.style.fontStyle = "italic";
      preview.style.opacity = "0.7";
      preview.style.marginBottom = "0.5em";
      preview.style.padding = "0.5em";
      preview.style.borderLeft = "2px solid var(--text-muted)";
    }

    new Setting(contentEl)
      .setName("Comment")
      .setDesc("What should the agent do with this passage?")
      .addTextArea((t) => {
        t.setPlaceholder("e.g. tighten this · cite a source · break into bullets");
        t.setValue(this.message);
        t.onChange((value) => {
          this.message = value;
        });
        t.inputEl.rows = 4;
        t.inputEl.style.width = "100%";
        // Enter submits; Shift+Enter inserts a newline for multi-line briefs.
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void submit();
          }
        });
        setTimeout(() => t.inputEl.focus(), 0);
      });

    const errorEl = contentEl.createDiv({ cls: "sheaf-modal-error" });
    errorEl.style.display = "none";
    errorEl.style.color = "var(--text-error)";
    errorEl.style.fontSize = "0.85em";
    errorEl.style.marginBottom = "0.5em";

    let sendBtn: ButtonComponent | null = null;
    let sending = false;

    const submit = async () => {
      const msg = this.message.trim();
      if (msg.length === 0 || sending) return;
      sending = true;
      errorEl.style.display = "none";
      sendBtn?.setDisabled(true).setButtonText("Sending…");
      try {
        await this.onSubmit(msg);
        this.close(); // only on success — otherwise the text is kept
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        errorEl.setText(`Couldn't post — ${m}. Your comment is kept; try again.`);
        errorEl.style.display = "block";
        sendBtn?.setDisabled(false).setButtonText("Send");
      } finally {
        sending = false;
      }
    };

    new Setting(contentEl)
      .addButton((b) => {
        sendBtn = b;
        b.setButtonText("Send")
          .setCta()
          .onClick(() => void submit());
      })
      .addButton((b) =>
        b.setButtonText("Cancel").onClick(() => this.close()),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

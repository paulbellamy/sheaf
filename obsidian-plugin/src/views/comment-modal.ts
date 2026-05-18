import { App, Modal, Setting } from "obsidian";

export class CommentModal extends Modal {
  private message = "";

  constructor(
    app: App,
    private selection: string,
    private onSubmit: (message: string) => void,
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

    const submit = () => {
      if (this.message.trim().length === 0) return;
      this.onSubmit(this.message.trim());
      this.close();
    };

    new Setting(contentEl)
      .setName("Comment")
      .setDesc("What should the agent do with this passage?")
      .addTextArea((t) => {
        t.setPlaceholder("e.g. tighten this · cite a source · break into bullets");
        t.onChange((value) => {
          this.message = value;
        });
        t.inputEl.rows = 4;
        t.inputEl.style.width = "100%";
        // Enter submits; Shift+Enter inserts a newline for multi-line briefs.
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        });
        setTimeout(() => t.inputEl.focus(), 0);
      });

    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText("Send").setCta().onClick(submit),
      )
      .addButton((b) =>
        b.setButtonText("Cancel").onClick(() => this.close()),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

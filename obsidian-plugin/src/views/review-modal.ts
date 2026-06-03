import { App, ButtonComponent, Modal, Setting } from "obsidian";
import type { ReviewPersona } from "../settings";

/**
 * Per-run panel picker. Pre-checks the personas enabled in settings; the user
 * can narrow the panel for this one review. "select role personas" from the
 * design decision — the settings roster is the menu, this is the order.
 */
export class ReviewModal extends Modal {
  private checked: Set<string>;

  constructor(
    app: App,
    private personas: ReviewPersona[],
    private onRun: (selected: ReviewPersona[]) => Promise<void>,
  ) {
    super(app);
    this.checked = new Set(personas.filter((p) => p.enabled).map((p) => p.id));
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h3", { text: "Request panel review" });

    if (this.personas.length === 0) {
      const empty = contentEl.createDiv();
      empty.style.opacity = "0.7";
      empty.style.marginBottom = "0.5em";
      empty.setText(
        "No reviewer roles defined. Add some in Settings → Sheaf → Review panel.",
      );
      new Setting(contentEl).addButton((b) =>
        b.setButtonText("Close").onClick(() => this.close()),
      );
      return;
    }

    const intro = contentEl.createDiv();
    intro.style.fontSize = "0.85em";
    intro.style.opacity = "0.7";
    intro.style.marginBottom = "0.5em";
    intro.setText(
      "Each selected role posts simulated feedback you can address or dismiss. The agent won't edit the doc.",
    );

    for (const persona of this.personas) {
      new Setting(contentEl)
        .setName(persona.name)
        .setDesc(`review:${persona.id}`)
        .addToggle((t) =>
          t.setValue(this.checked.has(persona.id)).onChange((v) => {
            if (v) this.checked.add(persona.id);
            else this.checked.delete(persona.id);
          }),
        );
    }

    const errorEl = contentEl.createDiv();
    errorEl.style.display = "none";
    errorEl.style.color = "var(--text-error)";
    errorEl.style.fontSize = "0.85em";
    errorEl.style.marginBottom = "0.5em";

    let runBtn: ButtonComponent | null = null;
    let running = false;

    const run = async () => {
      if (running) return;
      const selected = this.personas.filter((p) => this.checked.has(p.id));
      if (selected.length === 0) {
        errorEl.setText("Pick at least one role.");
        errorEl.style.display = "block";
        return;
      }
      running = true;
      errorEl.style.display = "none";
      runBtn?.setDisabled(true).setButtonText("Requesting…");
      try {
        await this.onRun(selected);
        this.close();
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        errorEl.setText(`Couldn't request review — ${m}.`);
        errorEl.style.display = "block";
        runBtn?.setDisabled(false).setButtonText("Request review");
      } finally {
        running = false;
      }
    };

    new Setting(contentEl)
      .addButton((b) => {
        runBtn = b;
        b.setButtonText("Request review")
          .setCta()
          .onClick(() => void run());
      })
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

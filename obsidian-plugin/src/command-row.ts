import { Notice } from "obsidian";

/**
 * A monospace command box with a Copy button. Shared by the threads sidebar
 * (`renderConnectPanel`) and the settings tab so both render the connect
 * commands copy-ready, identically.
 */
export function renderCommandRow(parent: HTMLElement, command: string): void {
  const row = parent.createDiv();
  row.style.display = "flex";
  row.style.gap = "0.4em";
  row.style.alignItems = "stretch";

  const code = row.createEl("code");
  code.setText(command);
  code.style.flex = "1";
  code.style.userSelect = "all";
  code.style.fontSize = "0.8em";
  code.style.padding = "0.35em 0.5em";
  code.style.background = "var(--background-primary)";
  code.style.border = "1px solid var(--background-modifier-border)";
  code.style.borderRadius = "4px";
  code.style.whiteSpace = "pre-wrap";
  code.style.wordBreak = "break-all";

  const copy = row.createEl("button", { text: "Copy" });
  copy.style.fontSize = "0.8em";
  copy.style.flexShrink = "0";
  copy.addEventListener("click", () => {
    void navigator.clipboard.writeText(command).then(
      () => new Notice("Copied"),
      () => new Notice("Copy failed"),
    );
  });
}

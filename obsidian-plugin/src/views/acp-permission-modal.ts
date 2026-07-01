import { App, Modal, Setting } from "obsidian";

import type {
  RequestPermissionParams,
  RequestPermissionResult,
} from "../acp/protocol";

/**
 * Render an ACP permission request as a modal and resolve to the chosen option
 * (or "cancelled" if dismissed). This is the human-gated accept point the
 * design wants — the agent asks before a write lands, and the user's pick maps
 * straight to the ACP outcome.
 */
export function requestAcpPermission(
  app: App,
  params: RequestPermissionParams,
): Promise<RequestPermissionResult> {
  return new Promise((resolve) => {
    new AcpPermissionModal(app, params, resolve).open();
  });
}

class AcpPermissionModal extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private readonly params: RequestPermissionParams,
    private readonly resolve: (r: RequestPermissionResult) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Sheaf: agent permission");
    this.contentEl.createEl("p", {
      text:
        this.params.toolCall.title ??
        "The agent wants to perform an action on this doc.",
    });
    for (const opt of this.params.options) {
      new Setting(this.contentEl).addButton((btn) => {
        btn.setButtonText(opt.name);
        if (opt.kind === "allow_once" || opt.kind === "allow_always") {
          btn.setCta();
        } else {
          btn.setWarning();
        }
        btn.onClick(() => this.choose(opt.optionId));
      });
    }
  }

  private choose(optionId: string): void {
    this.resolved = true;
    this.resolve({ outcome: { outcome: "selected", optionId } });
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    // Dismissed without a choice → cancel the request (fail safe: no action).
    if (!this.resolved) this.resolve({ outcome: { outcome: "cancelled" } });
  }
}

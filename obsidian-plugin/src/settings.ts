import { App, PluginSettingTab, Setting } from "obsidian";
import type SheafPlugin from "./main";

export type SheafSettings = {
  serverUrl: string;
  defaultAuthor: string;
};

export const DEFAULT_SETTINGS: SheafSettings = {
  serverUrl: "http://localhost:3000",
  defaultAuthor: "user",
};

export class SheafSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: SheafPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Sheaf server URL")
      .setDesc(
        "Where the sheaf server is reachable. Defaults to http://localhost:3000 (the prototype's `next dev` port).",
      )
      .addText((t) =>
        t
          .setPlaceholder("http://localhost:3000")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim();
            await this.plugin.saveSettings();
            this.plugin.onConnectionChanged();
          }),
      );

    new Setting(containerEl)
      .setName("Default author")
      .setDesc("Author name attached to comments you create.")
      .addText((t) =>
        t
          .setPlaceholder("user")
          .setValue(this.plugin.settings.defaultAuthor)
          .onChange(async (value) => {
            this.plugin.settings.defaultAuthor = value.trim() || "user";
            await this.plugin.saveSettings();
          }),
      );
  }
}

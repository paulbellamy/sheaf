import { App, PluginSettingTab, Setting } from "obsidian";
import type SheafPlugin from "./main";

export type SheafSettings = {
  serverUrl: string;
  defaultAuthor: string;
  showResolved: boolean;
  /** Run the sheaf server (backend + MCP + API) inside Obsidian itself. */
  runServer: boolean;
};

export const DEFAULT_SETTINGS: SheafSettings = {
  serverUrl: "http://localhost:31415",
  defaultAuthor: "user",
  showResolved: true,
  runServer: true,
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
      .setName("Run sheaf server inside Obsidian")
      .setDesc(
        "Host the backend, MCP server, and API in the plugin — no separate process to start. The vault is the data root. Turn off to connect to a server you run yourself at the URL below.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.runServer).onChange(async (value) => {
          this.plugin.settings.runServer = value;
          await this.plugin.saveSettings();
          await this.plugin.onConnectionChanged();
        }),
      );

    new Setting(containerEl)
      .setName("Sheaf server URL")
      .setDesc(
        "Where sheaf is reachable. When the embedded server is on, its port comes from this URL (default http://localhost:31415).",
      )
      .addText((t) =>
        t
          .setPlaceholder("http://localhost:31415")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim();
            await this.plugin.saveSettings();
            await this.plugin.onConnectionChanged();
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

    new Setting(containerEl)
      .setName("Show resolved threads")
      .setDesc(
        "When off, resolved threads are hidden from the sidebar entirely. When on, they appear in a collapsed Resolved section.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showResolved).onChange(async (value) => {
          this.plugin.settings.showResolved = value;
          await this.plugin.saveSettings();
          this.plugin.refreshThreadsView();
        }),
      );

    // Surface the connect command so it's copy-pasteable from settings too.
    const mcpUrl = `${this.plugin.settings.serverUrl.replace(/\/$/, "")}/api/mcp`;
    new Setting(containerEl)
      .setName("Connect an agent")
      .setDesc(
        `In a terminal: claude mcp add --transport http sheaf ${mcpUrl} — then run \`claude\` and say "use the sheaf MCP and watch for events; action and resolve each thread as it appears, and keep handling new ones until I stop you".`,
      );
  }
}

import { App, PluginSettingTab, Setting } from "obsidian";
import type SheafPlugin from "./main";

/**
 * A reviewer role the agent channels during a panel review. `id` is the slug
 * used in the thread author handle `review:<id>` (so it must survive the
 * server's author charset, `^[a-zA-Z0-9._@:\- ]{1,64}$` — lowercase + dashes
 * are safe). `brief` is the instruction handed to the agent for this role.
 */
export type ReviewPersona = {
  id: string;
  name: string;
  brief: string;
  enabled: boolean;
};

export type SheafSettings = {
  serverUrl: string;
  defaultAuthor: string;
  showResolved: boolean;
  personas: ReviewPersona[];
};

/**
 * Role-based default panel. Deliberately roles, not named people — safe in a
 * shared work tool and more useful for specs than celebrity simulation. Users
 * edit, disable, or add their own from the settings tab.
 */
export const DEFAULT_PERSONAS: ReviewPersona[] = [
  {
    id: "skeptic",
    name: "Skeptic",
    brief:
      "Play devil's advocate. Find the weakest claim, the unstated assumption, the place the argument doesn't actually hold. One sharp objection beats five soft ones.",
    enabled: true,
  },
  {
    id: "sre",
    name: "On-call SRE",
    brief:
      "You get paged when this ships. What breaks in production? Call out failure modes, rollback, observability gaps, and operational cost the doc hand-waves.",
    enabled: true,
  },
  {
    id: "security",
    name: "Security reviewer",
    brief:
      "Threat-model this. Trust boundaries, authn/authz, data handling, injection, and anything that widens the attack surface.",
    enabled: true,
  },
  {
    id: "newcomer",
    name: "New hire",
    brief:
      "You have zero prior context. Flag undefined jargon, unexplained leaps, and terms used before they're introduced. If you can't follow it, say where you got lost.",
    enabled: true,
  },
  {
    id: "pm",
    name: "Product / scope",
    brief:
      "Is the scope right? Push on user value, priority, and what's out of scope but probably shouldn't be (or vice versa).",
    enabled: false,
  },
];

export const DEFAULT_SETTINGS: SheafSettings = {
  serverUrl: "http://localhost:3000",
  defaultAuthor: "user",
  showResolved: true,
  personas: DEFAULT_PERSONAS,
};

/** Slugify a free-text name into a `review:<id>`-safe id. */
export function slugifyPersonaId(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

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

    this.renderPersonas(containerEl);
  }

  /**
   * The panel roster. "Request review" channels every *enabled* persona (the
   * per-run picker is pre-checked from these); disabled ones stay defined but
   * out of the default panel.
   */
  private renderPersonas(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Review panel").setHeading();

    const intro = containerEl.createDiv();
    intro.style.fontSize = "0.85em";
    intro.style.opacity = "0.7";
    intro.style.marginBottom = "0.75em";
    intro.setText(
      'Roles the agent channels when you run "Request review". Each posts feedback as simulated comments (author review:<id>) for you to address or dismiss — it never edits the doc on its own.',
    );

    const list = containerEl.createDiv();
    this.renderPersonaList(list);

    new Setting(containerEl).addButton((b) =>
      b
        .setButtonText("Add role")
        .setCta()
        .onClick(async () => {
          const id = this.uniquePersonaId("role");
          this.plugin.settings.personas.push({
            id,
            name: "New role",
            brief: "",
            enabled: true,
          });
          await this.plugin.saveSettings();
          this.renderPersonaList(list);
        }),
    );
  }

  private renderPersonaList(list: HTMLElement): void {
    list.empty();
    const personas = this.plugin.settings.personas;

    if (personas.length === 0) {
      const empty = list.createDiv();
      empty.style.opacity = "0.6";
      empty.style.fontSize = "0.85em";
      empty.style.marginBottom = "0.5em";
      empty.setText("No roles defined. Add one below.");
      return;
    }

    personas.forEach((persona, index) => {
      const row = new Setting(list)
        .setName(`review:${persona.id}`)
        .addToggle((t) =>
          t.setValue(persona.enabled).onChange(async (v) => {
            persona.enabled = v;
            await this.plugin.saveSettings();
          }),
        )
        .addText((t) =>
          t
            .setPlaceholder("Display name")
            .setValue(persona.name)
            .onChange(async (v) => {
              persona.name = v;
              await this.plugin.saveSettings();
            }),
        )
        .addExtraButton((b) =>
          b
            .setIcon("trash")
            .setTooltip("Remove role")
            .onClick(async () => {
              this.plugin.settings.personas.splice(index, 1);
              await this.plugin.saveSettings();
              this.renderPersonaList(list);
            }),
        );

      // Brief: a full-width textarea under the name row.
      const brief = row.controlEl.createEl("textarea");
      brief.value = persona.brief;
      brief.rows = 2;
      brief.placeholder = "What this role looks for…";
      brief.style.width = "100%";
      brief.style.marginTop = "0.4em";
      brief.style.fontSize = "0.85em";
      brief.addEventListener("change", async () => {
        persona.brief = brief.value;
        await this.plugin.saveSettings();
      });
      row.settingEl.style.display = "block";
    });
  }

  private uniquePersonaId(base: string): string {
    const taken = new Set(this.plugin.settings.personas.map((p) => p.id));
    let candidate = slugifyPersonaId(base) || "role";
    let n = 1;
    while (taken.has(candidate)) candidate = `${slugifyPersonaId(base) || "role"}-${++n}`;
    return candidate;
  }
}

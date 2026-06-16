import { App, PluginSettingTab, Setting, TextComponent } from "obsidian";
import { defaultStyleConfig, type StyleConfig } from "sheaf-server/types";
import type SheafPlugin from "./main";

export type { StyleConfig } from "sheaf-server/types";

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
  /** Run the sheaf server (backend + MCP + API) inside Obsidian itself. */
  runServer: boolean;
  personas: ReviewPersona[];
  /** Voice matching: how the agent learns to write like the user. Mirrored to
   *  the vault's `.sheaf/config.json` (the server's source of truth). */
  style: StyleConfig;
};

/**
 * Reconcile a persisted (possibly partial / older) style config against the
 * canonical defaults, returning a fresh object so the UI never mutates the
 * shared default in place.
 */
export function mergeStyle(loaded?: Partial<StyleConfig>): StyleConfig {
  const base = defaultStyleConfig();
  if (!loaded) return base;
  return {
    ...base,
    ...loaded,
    exclude_globs: loaded.exclude_globs ?? base.exclude_globs,
    prefs: { ...base.prefs, ...(loaded.prefs ?? {}) },
  };
}

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
  serverUrl: "http://localhost:31415",
  defaultAuthor: "user",
  showResolved: true,
  runServer: true,
  personas: DEFAULT_PERSONAS,
  style: defaultStyleConfig(),
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

    this.renderVoiceMatching(containerEl);
    this.renderPersonas(containerEl);
  }

  /**
   * Voice matching. The agent learns the user's writing voice from the vault
   * and writes in it. Edits here are saved to plugin data *and* pushed to the
   * server's `.sheaf/config.json` so the agent's GetStyle/StyleCheck honor them.
   */
  private renderVoiceMatching(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Voice matching").setHeading();

    const intro = containerEl.createDiv();
    intro.style.fontSize = "0.85em";
    intro.style.opacity = "0.7";
    intro.style.marginBottom = "0.75em";
    intro.setText(
      "The agent studies how you write — across your notes — and matches your voice when it drafts prose. Generate a voice guide once, then it's used automatically.",
    );

    const style = this.plugin.settings.style;
    const save = () => void this.plugin.saveAndPushStyle();

    new Setting(containerEl)
      .setName("Enable voice matching")
      .setDesc("When on, the agent consults your voice profile before writing prose.")
      .addToggle((t) =>
        t.setValue(style.enabled).onChange((v) => {
          style.enabled = v;
          save();
        }),
      );

    new Setting(containerEl)
      .setName("Generate / refresh voice guide")
      .setDesc(
        "Analyze your notes now and ask the connected agent to (re)write your voice guide. Run this after you've written a fair amount, or when your style has shifted.",
      )
      .addButton((b) =>
        b
          .setButtonText("Generate")
          .setCta()
          .onClick(() => void this.plugin.buildVoiceGuide()),
      );

    new Setting(containerEl)
      .setName("Exclude from corpus")
      .setDesc(
        "Glob patterns (one per line) for notes that are NOT your own writing — templates, clippings, daily notes. Everything else under the vault counts.",
      )
      .then((s) => {
        const ta = s.controlEl.createEl("textarea");
        ta.value = style.exclude_globs.join("\n");
        ta.rows = 4;
        ta.style.width = "100%";
        ta.style.fontSize = "0.85em";
        ta.placeholder = "**/Templates/**\n**/Clippings/**";
        ta.addEventListener("change", () => {
          style.exclude_globs = ta.value
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
          save();
        });
        s.settingEl.style.display = "block";
      });

    const pref = (
      name: string,
      desc: string,
      key: "em_dash" | "oxford_comma" | "contractions",
    ) => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addDropdown((d) =>
          d
            .addOption("either", "No preference")
            .addOption("yes", "Use")
            .addOption("no", "Avoid")
            .setValue(style.prefs[key])
            .onChange((v) => {
              style.prefs[key] = v as "yes" | "no" | "either";
              save();
            }),
        );
    };
    pref("Em-dashes", "Whether you use em-dashes (—).", "em_dash");
    pref("Oxford comma", "Serial comma before the final 'and'/'or'.", "oxford_comma");
    pref("Contractions", "Whether you write don't / it's / we're.", "contractions");

    new Setting(containerEl)
      .setName("Banned phrases")
      .setDesc(
        "Phrases the agent must avoid (one per line) — your personal list of clichés or AI tells. StyleCheck flags these.",
      )
      .then((s) => {
        const ta = s.controlEl.createEl("textarea");
        ta.value = style.prefs.banned_phrases.join("\n");
        ta.rows = 3;
        ta.style.width = "100%";
        ta.style.fontSize = "0.85em";
        ta.placeholder = "delve\ngame-changer\nleverage";
        ta.addEventListener("change", () => {
          style.prefs.banned_phrases = ta.value
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
          save();
        });
        s.settingEl.style.display = "block";
      });

    new Setting(containerEl)
      .setName("Exemplars per draft")
      .setDesc("How many of your own passages the agent sees as voice references.")
      .addSlider((sl) =>
        sl
          .setLimits(1, 4, 1)
          .setValue(Math.max(1, Math.min(4, style.exemplar_count)))
          .setDynamicTooltip()
          .onChange((v) => {
            style.exemplar_count = v;
            save();
          }),
      );
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
          // Seed id and name in sync so the id auto-follows the name until the
          // user customises either (see the name field's wasAuto check).
          const name = "New role";
          this.plugin.settings.personas.push({
            id: this.uniquePersonaId(name),
            name,
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
      const row = new Setting(list).setName(`review:${persona.id}`);

      row.addToggle((t) =>
        t.setValue(persona.enabled).onChange(async (v) => {
          persona.enabled = v;
          await this.plugin.saveSettings();
        }),
      );

      // Id field. Slugified + deduped on blur so the typed value stays editable
      // until you commit it; the row label mirrors the resulting handle.
      let idComp!: TextComponent;
      row.addText((t) => {
        idComp = t;
        t.setPlaceholder("id").setValue(persona.id);
        t.inputEl.addEventListener("blur", async () => {
          const next = this.uniquePersonaId(t.getValue(), persona);
          persona.id = next;
          t.setValue(next);
          row.setName(`review:${next}`);
          await this.plugin.saveSettings();
        });
      });

      row.addText((t) =>
        t
          .setPlaceholder("Display name")
          .setValue(persona.name)
          .onChange(async (v) => {
            // While the id still matches the slug of the old name it's
            // "auto" — keep it following the name. Once the id diverges
            // (custom id, or a deduped suffix), stop touching it.
            const wasAuto = persona.id === slugifyPersonaId(persona.name);
            persona.name = v;
            if (wasAuto) {
              const next = this.uniquePersonaId(v, persona);
              persona.id = next;
              idComp.setValue(next);
              row.setName(`review:${next}`);
            }
            await this.plugin.saveSettings();
          }),
      );

      row.addExtraButton((b) =>
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

  private uniquePersonaId(base: string, exclude?: ReviewPersona): string {
    const taken = new Set(
      this.plugin.settings.personas
        .filter((p) => p !== exclude)
        .map((p) => p.id),
    );
    let candidate = slugifyPersonaId(base) || "role";
    let n = 1;
    while (taken.has(candidate)) candidate = `${slugifyPersonaId(base) || "role"}-${++n}`;
    return candidate;
  }
}

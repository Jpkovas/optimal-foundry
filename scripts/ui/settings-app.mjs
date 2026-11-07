import { MODULE_ID, warn } from "../constants.mjs";
import { getSetting, setSetting, settingDef, PRESETS, PROFILE_KEYS, RELOAD_KEYS, matchPreset } from "../settings.mjs";
import { TEMPLATE, L } from "./common.mjs";
import { openWelcome } from "./welcome.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** What the GM sees first: the few switches that decide what the module does. */
const BASIC = ["mediaEnabled", "optimizeUploads", "backfillMode", "keepResolution", "networkProfile", "hostUploadMbps",
  "preloadEnabled", "p2pEnabled"];

/** Everything else, by topic, behind "Advanced". Client (per-device) settings live in "My connection". */
const ADVANCED = [
  { id: "files", icon: "fa-solid fa-photo-film", keys: ["imageQuality", "videoQuality", "audioBitrate", "maxImageSide", "maxVideoHeight",
    "videoStripAudio", "convertAnimatedGif", "skipMp3BelowKbps", "minSavingsPct", "includeCompendia", "protectActiveScene"] },
  { id: "network", icon: "fa-solid fa-network-wired", keys: ["maxConcurrentRequests", "preloadSharePct", "staggerJoin",
    "idleSeconds", "preloadMaxFileMB", "predecodeNext"] },
  { id: "p2p", icon: "fa-solid fa-share-nodes", keys: ["serviceWorker", "p2pMinFileKB", "p2pTimeoutSec", "iceServers"] }
];

const PRESET_ICONS = { recommended: "fa-solid fa-star", saver: "fa-solid fa-feather", quality: "fa-solid fa-gem", networkOnly: "fa-solid fa-hand" };

/**
 * GM-only window for every world setting: presets on top (they fill the form; nothing changes until Save), the
 * basic switches in plain language, and the technical options grouped under "Advanced".
 */
export class OptimalFoundrySettings extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "optimal-foundry-settings",
    classes: ["optimal-foundry", "of-settings"],
    tag: "form",
    window: { title: "OPTIMALFOUNDRY.Config.Title", icon: "fa-solid fa-sliders", resizable: true, contentClasses: ["standard-form"] },
    position: { width: 640, height: 720 },
    form: { handler: OptimalFoundrySettings.#onSubmit, closeOnSubmit: true },
    actions: { preset: OptimalFoundrySettings.#onPreset, reset: OptimalFoundrySettings.#onReset,
      welcome: OptimalFoundrySettings.#onWelcome }
  };

  static PARTS = {
    form: { template: TEMPLATE("settings"), scrollable: [""] },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  /** @override */
  _canRender(options) {
    if (!game.user.isGM) throw new Error(L("Dashboard.GMOnly"));
    return super._canRender(options);
  }

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const values = Object.fromEntries([...BASIC, ...ADVANCED.flatMap(g => g.keys)].map(k => [k, getSetting(k)]));
    const current = matchPreset(values);
    const custom = values.networkProfile === "custom";
    return Object.assign(context, {
      presets: [...Object.keys(PRESETS), "custom"].map(id => ({
        id,
        icon: PRESET_ICONS[id] ?? "fa-solid fa-pen",
        label: L(`Config.Preset.${id}.Name`),
        hint: L(`Config.Preset.${id}.Hint`),
        active: id === current,
        selectable: id !== "custom"
      })),
      basic: BASIC.map(k => field(k, values[k], custom)),
      groups: ADVANCED.map(g => ({ id: g.id, icon: g.icon, label: L(`Config.Group.${g.id}`), fields: g.keys.map(k => field(k, values[k], custom)) })),
      buttons: [
        { type: "button", action: "welcome", icon: "fa-solid fa-hand-sparkles", label: "OPTIMALFOUNDRY.Config.Welcome" },
        { type: "button", action: "reset", icon: "fa-solid fa-rotate-left", label: "OPTIMALFOUNDRY.Config.Reset" },
        { type: "submit", icon: "fa-solid fa-floppy-disk", label: "OPTIMALFOUNDRY.Config.Save" }
      ]
    });
  }

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);
    this.element.addEventListener("change", () => this.#sync());
    this.#sync();
  }

  /** Grey out the custom-profile options, the resize limits, and mark the preset the form now matches. */
  #sync() {
    const form = this.element;
    const read = k => readField(form, k);
    const profileCustom = read("networkProfile") === "custom";
    for (const k of PROFILE_KEYS) toggle(form, k, profileCustom);
    const resize = read("keepResolution") === false;
    for (const k of ["maxImageSide", "maxVideoHeight"]) toggle(form, k, resize);
    const mediaOn = read("mediaEnabled") !== false;
    for (const k of ["optimizeUploads", "backfillMode", "keepResolution"]) toggle(form, k, mediaOn);
    const values = Object.fromEntries(Object.keys(PRESETS).flatMap(id => Object.keys(PRESETS[id])).map(k => [k, read(k)]));
    const current = matchPreset(values);
    for (const card of form.querySelectorAll("[data-preset-card]")) card.classList.toggle("active", card.dataset.presetCard === current);
  }

  static #onPreset(_event, target) {
    const preset = PRESETS[target?.dataset.preset];
    if (!preset) return;
    for (const [k, v] of Object.entries(preset)) writeField(this.element, k, v);
    this.#sync();
  }

  /** The welcome screen again (it saves on its own); this window closes so the two never disagree. */
  static #onWelcome() {
    this.close();
    openWelcome();
  }

  static #onReset() {
    for (const k of [...BASIC, ...ADVANCED.flatMap(g => g.keys)]) writeField(this.element, k, settingDef(k).default);
    this.#sync();
  }

  static async #onSubmit(_event, form) {
    const changed = [];
    for (const k of [...BASIC, ...ADVANCED.flatMap(g => g.keys)]) {
      const value = readField(form, k);
      if (value === undefined || value === getSetting(k)) continue;
      try {
        await setSetting(k, value);
        changed.push(k);
      } catch (err) {
        warn(`could not save ${k}`, err);
        ui.notifications.error(L("Dashboard.Notify.ActionFailed", { error: err?.message ?? String(err) }));
      }
    }
    if (!changed.length) return;
    ui.notifications.info(L("Config.Saved", { count: changed.length }));
    if (changed.some(k => RELOAD_KEYS.includes(k))) await foundry.applications.settings.SettingsConfig.reloadConfirm({ world: true });
  }
}

/** Template context for one setting. */
function field(key, value, profileCustom) {
  const def = settingDef(key);
  const base = `OPTIMALFOUNDRY.Settings.${key}`;
  const f = { key, name: `${base}.Name`, hint: `${base}.Hint`, reload: RELOAD_KEYS.includes(key) };
  if (def.type === Boolean) return { ...f, checkbox: true, value: !!value };
  if (def.choices) {
    return { ...f, select: true, choices: Object.keys(def.choices).map(v => ({ value: v, label: `${base}.Choices.${v}`, selected: String(value) === v })) };
  }
  if (def.type === Number && def.range) return { ...f, range: true, value, ...def.range };
  if (def.type === Number) return { ...f, number: true, value };
  return { ...f, text: true, value: value ?? "" };
}

const input = (form, key) => form.querySelector(`[name="${key}"]`);

/** A field's value cast to its setting's type, or undefined when the field is not in the form. */
function readField(form, key) {
  const el = input(form, key);
  if (!el) return undefined;
  const def = settingDef(key);
  if (def.type === Boolean) return !!el.checked;
  const raw = el.value;
  if (def.type === Number) { const n = Number(raw); return Number.isFinite(n) ? n : def.default; }
  return String(raw ?? "");
}

function writeField(form, key, value) {
  const el = input(form, key);
  if (!el) return;
  if (settingDef(key).type === Boolean) el.checked = !!value;
  else el.value = el.tagName === "SELECT" ? String(value) : value;
}

function toggle(form, key, enabled) {
  const el = input(form, key);
  if (!el) return;
  el.disabled = !enabled;
  el.closest(".form-group")?.classList.toggle("of-disabled", !enabled);
}

/** Registered at init with the other menus: GM only. */
export function registerSettingsMenu() {
  game.settings.registerMenu(MODULE_ID, "config", {
    name: "OPTIMALFOUNDRY.Config.Menu.Name",
    label: "OPTIMALFOUNDRY.Config.Menu.Label",
    hint: "OPTIMALFOUNDRY.Config.Menu.Hint",
    icon: "fa-solid fa-sliders",
    type: OptimalFoundrySettings,
    restricted: true
  });
}

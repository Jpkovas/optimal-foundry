import { MODULE_ID, warn } from "../constants.mjs";
import { getSetting, setSetting, settingDef, PRESETS, RELOAD_KEYS, matchPreset } from "../settings.mjs";
import { conversionBlocker } from "../media/converter.mjs";
import { TEMPLATE, L, call, setting, blockerNote } from "./common.mjs";
import { setTrackerVisible } from "./tracker.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const PRESET_ICONS = { recommended: "fa-solid fa-star", saver: "fa-solid fa-feather", quality: "fa-solid fa-gem", networkOnly: "fa-solid fa-hand" };
const MODES = [
  { id: "review", icon: "fa-solid fa-list-check" },
  { id: "auto", icon: "fa-solid fa-wand-magic-sparkles" },
  { id: "off", icon: "fa-solid fa-ban" }
];
/** World switches the welcome screen sets on top of the chosen preset; the tracker is a per-browser setting. */
const SWITCHES = [
  { key: "optimizeUploads", icon: "fa-solid fa-upload", media: true },
  { key: "preloadEnabled", icon: "fa-solid fa-forward" },
  { key: "p2pEnabled", icon: "fa-solid fa-share-nodes" }
];

/**
 * Shown to a GM the first time they enter the world with the module on (until a GM finishes it): pick a preset,
 * how existing files are optimized (automatic, after review, or not at all) and which network features run.
 * Nothing converts the world's existing files before this is done; the network features run with their defaults.
 * Above the choices it says what this browser cannot do on a page without HTTPS.
 */
export class OptimalFoundryWelcome extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "optimal-foundry-welcome",
    classes: ["optimal-foundry", "of-settings", "of-welcome"],
    tag: "form",
    window: { title: "OPTIMALFOUNDRY.Welcome.Title", icon: "fa-solid fa-hand-sparkles", contentClasses: ["standard-form"] },
    position: { width: 620, height: "auto" },
    form: { handler: OptimalFoundryWelcome.#onSubmit, closeOnSubmit: true },
    actions: { later: OptimalFoundryWelcome.#onLater }
  };

  static PARTS = {
    form: { template: TEMPLATE("welcome"), scrollable: [""] },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  /** @override */
  _canRender(options) {
    if (!game.user.isGM) return false;
    return super._canRender(options);
  }

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    // Tuned by hand (no preset matches): nothing is preselected, and leaving it so keeps those values.
    const preset = matchPreset(Object.fromEntries(Object.values(PRESETS).flatMap(Object.keys).map(k => [k, getSetting(k)])));
    const mode = getSetting("backfillMode");
    return Object.assign(context, {
      blocker: blockerNote(await call("conversionBlocker", conversionBlocker)),
      presets: Object.keys(PRESETS).map(id => ({
        id, icon: PRESET_ICONS[id], checked: id === preset, line: L(`Welcome.Card.${id}`),
        label: L(`Config.Preset.${id}.Name`), hint: L(`Config.Preset.${id}.Hint`)
      })),
      modes: MODES.map(m => ({ ...m, checked: m.id === mode, line: L(`Welcome.Card.${m.id}`),
        label: L(`Welcome.Mode.${m.id}.Name`), hint: L(`Welcome.Mode.${m.id}.Hint`) })),
      keepCurrent: preset === "custom",
      switches: [
        ...SWITCHES.map(s => ({ ...s, checked: !!getSetting(s.key), name: `OPTIMALFOUNDRY.Settings.${s.key}.Name`,
          line: L(`Welcome.Card.${s.key}`), hint: `OPTIMALFOUNDRY.Welcome.Switch.${s.key}` })),
        { key: "tracker", icon: "fa-solid fa-gauge-high", checked: !!setting("trackerVisible", true), line: L("Welcome.Card.tracker"),
          name: "OPTIMALFOUNDRY.Welcome.TrackerName", hint: "OPTIMALFOUNDRY.Welcome.TrackerHint" }
      ],
      upload: { value: getSetting("hostUploadMbps"), ...settingDef("hostUploadMbps").range },
      buttons: [
        { type: "button", action: "later", icon: "fa-solid fa-clock", label: "OPTIMALFOUNDRY.Welcome.Later" },
        { type: "submit", icon: "fa-solid fa-check", label: "OPTIMALFOUNDRY.Welcome.Start" }
      ]
    });
  }

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);
    this.element.addEventListener("change", () => this.#sync());
    this.#sync();
  }

  /** "Network only" turns media off: how existing files are handled and upload optimization no longer apply. */
  #sync() {
    const picked = this.element.querySelector("input[name=preset]:checked")?.value;
    const mediaOn = picked ? (picked !== "networkOnly") : !!getSetting("mediaEnabled");
    for (const el of this.element.querySelectorAll("[data-of-media] input")) el.disabled = !mediaOn;
    for (const el of this.element.querySelectorAll("[data-of-media]")) el.classList.toggle("of-disabled", !mediaOn);
  }

  /** @override */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    // Another GM finished it: nothing left to choose here.
    this._hook = Hooks.on(`${MODULE_ID}.settingChanged`, (key, value) => { if ((key === "welcomeDone") && value) this.close(); });
  }

  /** @override */
  _onClose(options) {
    super._onClose(options);
    Hooks.off(`${MODULE_ID}.settingChanged`, this._hook);
  }

  static #onLater() {
    ui.notifications.info(L("Welcome.LaterNotice"));
    this.close();
  }

  static async #onSubmit(_event, form) {
    const data = new foundry.applications.ux.FormDataExtended(form).object;
    // No preset picked: keep the media values the GM tuned by hand.
    const values = { ...(PRESETS[data.preset] ?? {}) };
    if ((values.mediaEnabled ?? getSetting("mediaEnabled")) !== false) {
      values.backfillMode = settingDef("backfillMode").choices[data.backfillMode] ? data.backfillMode : "review";
      values.optimizeUploads = !!data.optimizeUploads;
    }
    values.preloadEnabled = !!data.preloadEnabled;
    values.p2pEnabled = !!data.p2pEnabled;
    const upload = Number(data.hostUploadMbps);
    if (Number.isFinite(upload) && (upload > 0)) values.hostUploadMbps = upload;
    const changed = [];
    for (const [key, value] of Object.entries(values)) {
      if (getSetting(key) === value) continue;
      try { await setSetting(key, value); changed.push(key); }
      catch (err) { warn(`welcome: could not save ${key}`, err); }
    }
    await setSetting("welcomeDone", true);
    await setTrackerVisible(!!data.tracker);
    ui.notifications.info(L("Welcome.Done"));
    if (changed.some(k => RELOAD_KEYS.includes(k))) await foundry.applications.settings.SettingsConfig.reloadConfirm({ world: true });
  }
}

/** Registered at init: open the welcome screen for a GM until one finishes it. */
export function registerWelcome() {
  Hooks.once("ready", () => {
    if (game.user.isGM && !getSetting("welcomeDone")) openWelcome();
  });
}

/** Open the welcome screen. An open one only comes to the front: rendering it again would reset what the GM picked. */
export function openWelcome() {
  const open = foundry.applications.instances.get(OptimalFoundryWelcome.DEFAULT_OPTIONS.id);
  if (!open?.rendered) return new OptimalFoundryWelcome().render({ force: true });
  if (open.minimized) open.maximize();
  open.bringToFront();
  return open;
}

import { MODULE_ID, warn } from "../constants.mjs";
import { setSetting, settingDef, effectiveNetwork } from "../settings.mjs";
import { preloadStatus } from "../net/preload.mjs";
import { cacheStatus, clearDeviceCache } from "../net/local-cache.mjs";
import { swarmStatus } from "../p2p/swarm.mjs";
import {
  TEMPLATE, L, call, setting, num, fmtBytes, fmtCount, codeLabel, describeCache, describeSwarm, describeSharing,
  warnOnce, LiveApplication
} from "./common.mjs";
import { openConnectionChoice, needsConnectionChoice } from "./first-run.mjs";

const { DialogV2 } = foundry.applications.api;

/**
 * "My connection": a small window for every user about THIS browser (local cache, sharing with the other players,
 * preloading, CDN) with the client-scope options of the module. Opened from the module settings (a non-restricted
 * menu) or from a button in the player list's performance row.
 */

/** Client settings edited here; type, bounds and choices come from their declaration in settings.mjs. */
const OPTIONS = ["p2pParticipate", "preloadScope", "cacheQuotaMB", "p2pUploadCapMbps"];
/** The two answers of the first-run card: locked here until the player has answered it. */
const CHOICES = ["p2pParticipate", "preloadScope"];
const SHARING = ["p2pParticipate", "p2pUploadCapMbps"];

export class ConnectionPanel extends LiveApplication {
  static DEFAULT_OPTIONS = {
    id: "optimal-foundry-connection",
    classes: ["optimal-foundry", "of-connection"],
    tag: "div",
    window: {
      title: "OPTIMALFOUNDRY.Connection.Title",
      icon: "fa-solid fa-wifi",
      resizable: true
    },
    position: { width: 460, height: "auto" },
    actions: {
      clearCache: ConnectionPanel.#onClearCache,
      choose: () => openConnectionChoice()
    }
  };

  static PARTS = {
    body: { template: TEMPLATE("connection") }
  };

  #clearing = false;

  /** @override */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    const watched = new Set([...OPTIONS, "cdnStatus", "connectionChoiceDone", "p2pEnabled", "preloadEnabled"]);
    this._onHook(`${MODULE_ID}.settingChanged`, key => { if (watched.has(key)) this._refreshWhenIdle(true); });
  }

  /** @override */
  _attachPartListeners(partId, htmlElement, options) {
    super._attachPartListeners(partId, htmlElement, options);
    for (const input of htmlElement.querySelectorAll("[data-of-setting]")) {
      input.addEventListener("change", event => this.#onOptionChange(event.currentTarget));
    }
  }

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const [cache, swarm, preload, eff] = await Promise.all([
      call("cacheStatus", cacheStatus), call("swarmStatus", swarmStatus), call("preloadStatus", preloadStatus),
      call("effectiveNetwork", effectiveNetwork)
    ]);
    const cdnStatus = setting("cdnStatus", {}) ?? {};
    const secure = !!window.isSecureContext;
    const preloadWorld = !!setting("preloadEnabled", true);
    const pendingChoice = needsConnectionChoice(eff);
    const world = describeSharing(eff, null, null);
    // Said elsewhere in this window: the first-run note with its button, the notice of a page without HTTPS, and
    // the reason the local cache is not active (sharing needs it).
    const saidAbove = (pendingChoice && (swarm?.reason === "notChosen")) || (swarm?.reason === "insecure")
      || ((cache?.active === false) && (swarm?.reason === "noCache"));
    const c = describeCache(cache, !secure);
    const p = describeSwarm(swarm);
    const scope = setting("preloadScope", "all");
    return Object.assign(context, {
      blocker: secure ? "" : L("Blocker.insecure"),
      cache: c,
      cacheUsage: c ? L("Connection.CacheUsage", { used: c.cachedBytes, quota: c.quota, files: c.cachedFiles }) : "",
      p2p: {
        on: !!p?.enabled,
        label: p?.enabled ? L("Connection.P2POn", { peers: p.openPeers, up: p.up, down: p.down }) : L("Dashboard.Common.Off"),
        // Why this browser stays out, in the swarm's own words; before the swarm started, the world's reason.
        reason: (p?.enabled || saidAbove) ? "" : (p?.reason || (world.on ? "" : world.reason))
      },
      preload: preload ? {
        on: !!preload.enabled,
        label: !preload.enabled ? L("Dashboard.Common.Off") : L("Connection.PreloadProgress", {
          scope: L(`Settings.preloadScope.Choices.${scope}`), done: fmtCount(num(preload.done)), total: fmtCount(num(preload.total))
        })
      } : null,
      cdn: {
        on: !!cdnStatus.cdn,
        label: cdnStatus.cdn ? L("Dashboard.Network.CdnOn") : L("Dashboard.Network.CdnOff"),
        status: codeLabel(cdnStatus.status, ["Cdn.Status"])
      },
      pendingChoice,
      options: OPTIONS.map(key => option(key, (!world.on && SHARING.includes(key)) || (!preloadWorld && (key === "preloadScope"))
        || (pendingChoice && CHOICES.includes(key)))),
      clearing: this.#clearing
    });
  }

  async #onOptionChange(input) {
    const key = input.dataset.ofSetting;
    const def = OPTIONS.includes(key) ? settingDef(key) : null;
    if (!def) return;
    let value;
    if (def.type === Boolean) value = input.checked;
    else if (def.choices) value = def.choices[input.value] ? input.value : def.default;
    else {
      const n = Number(input.value);
      const { min, max, step } = def.range;
      if (!Number.isFinite(n)) { this._refresh(true); return; }
      value = Math.min(max, Math.max(min, Math.round(n / step) * step));
    }
    try {
      await setSetting(key, value);
    } catch (err) {
      warn(`connection panel: could not save ${key}`, err);
      ui.notifications.error(L("Dashboard.Notify.ActionFailed", { error: err?.message ?? String(err) }));
    }
    this._invalidateParts(); // the input may show a value that was clamped or not saved
    this._refresh(true);
  }

  static async #onClearCache() {
    if (this.#clearing) return;
    const ok = await DialogV2.confirm({
      window: { title: "OPTIMALFOUNDRY.Connection.ClearCache", icon: "fa-solid fa-broom" },
      content: `<p>${L("Connection.ClearCacheConfirm")}</p>`,
      rejectClose: false
    });
    if (!ok) return;
    this.#clearing = true;
    this._refresh(true);
    try {
      const { freedBytes } = await clearDeviceCache();
      ui.notifications.info(L("Connection.ClearCacheDone", { size: fmtBytes(num(freedBytes)) }));
    } catch (err) {
      warn("connection panel: clearing the cache failed", err);
      ui.notifications.error(L("Dashboard.Notify.ActionFailed", { error: err?.message ?? String(err) }));
    } finally {
      this.#clearing = false;
      this._refresh(true);
    }
  }
}

/** Template context of one client setting. */
function option(key, disabled) {
  const def = settingDef(key);
  const value = setting(key, def.default);
  const base = { key, disabled, label: L(`Settings.${key}.Name`), hint: L(`Settings.${key}.Hint`) };
  if (def.type === Boolean) return { ...base, checkbox: true, value: !!value };
  if (def.choices) {
    return { ...base, select: true, choices: Object.keys(def.choices).map(v => ({ value: v, label: L(`Settings.${key}.Choices.${v}`), selected: v === value })) };
  }
  return { ...base, number: true, value, ...def.range };
}

/** A small button in the player list's performance row (next to latency/FPS) that opens the panel. */
function addPlayersButton(_app, element) {
  const stats = element.querySelector("#performance-stats");
  if (!stats || stats.querySelector(".of-connection-button")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon fa-solid fa-wifi of-connection-button";
  button.dataset.tooltip = L("Connection.Title");
  button.setAttribute("aria-label", L("Connection.Title"));
  button.addEventListener("click", () => new ConnectionPanel().render({ force: true }));
  const expand = stats.querySelector("#players-expand");
  if (expand) expand.before(button);
  else stats.append(button);
}

/** Called from registerUI at `init`. */
export function registerConnectionUI() {
  game.settings.registerMenu(MODULE_ID, "connection", {
    name: "OPTIMALFOUNDRY.Connection.Menu.Name",
    label: "OPTIMALFOUNDRY.Connection.Menu.Label",
    hint: "OPTIMALFOUNDRY.Connection.Menu.Hint",
    icon: "fa-solid fa-wifi",
    type: ConnectionPanel,
    restricted: false
  });
  Hooks.on("renderPlayers", (app, element) => {
    try { addPlayersButton(app, element); } catch (err) { warnOnce("player list button", err); }
  });
}

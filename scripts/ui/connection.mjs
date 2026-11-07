import { MODULE_ID, warn } from "../constants.mjs";
import { setSetting, effectiveNetwork } from "../settings.mjs";
import { preloadStatus } from "../net/preload.mjs";
import { swStatus, clearDeviceCache } from "../p2p/sw-client.mjs";
import { swarmStatus } from "../p2p/swarm.mjs";
import {
  TEMPLATE, L, call, setting, num, fmtBytes, fmtCount, codeLabel, describeSw, describeSwarm, warnOnce, LiveApplication
} from "./common.mjs";

const { DialogV2 } = foundry.applications.api;

/**
 * "My connection": a small window for every user about THIS browser (local cache, P2P, preloading, CDN) with the
 * client-scope options of the module. Opened from the module settings (a non-restricted menu) or from a button in
 * the player list's performance row.
 */

/** Client settings edited here, with the input bounds of their registration in settings.mjs. */
const OPTIONS = {
  p2pParticipate: { type: "checkbox" },
  preloadOnThisDevice: { type: "checkbox" },
  cacheQuotaMB: { type: "number", min: 256, max: 65536, step: 256 },
  p2pUploadCapMBps: { type: "number", min: 0.25, max: 50, step: 0.25 }
};

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
    position: { width: 440, height: "auto" },
    actions: {
      clearCache: ConnectionPanel.#onClearCache
    }
  };

  static PARTS = {
    body: { template: TEMPLATE("connection") }
  };

  #clearing = false;

  /** @override */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    const watched = new Set([...Object.keys(OPTIONS), "cdnStatus"]);
    this._onHook(`${MODULE_ID}.settingChanged`, key => { if (watched.has(key)) this._refresh(true); });
  }

  /** @override */
  _attachPartListeners(partId, htmlElement, options) {
    super._attachPartListeners(partId, htmlElement, options);
    for (const input of htmlElement.querySelectorAll("input[data-of-setting]")) {
      input.addEventListener("change", event => this.#onOptionChange(event.currentTarget));
    }
  }

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const [sw, swarm, preload] = await Promise.all([
      call("swStatus", swStatus), call("swarmStatus", swarmStatus), call("preloadStatus", preloadStatus)
    ]);
    const cdnStatus = setting("cdnStatus", {}) ?? {};
    const p2pWorld = !!(await call("effectiveNetwork", effectiveNetwork))?.p2p;
    const s = describeSw(sw);
    const p = describeSwarm(swarm);
    return Object.assign(context, {
      secure: !!window.isSecureContext,
      sw: s,
      cache: s ? L("Connection.CacheUsage", { used: s.cachedBytes, quota: s.quota, files: s.cachedFiles }) : "—",
      p2p: {
        on: !!p?.enabled,
        label: p?.enabled ? L("Connection.P2POn", { peers: p.openPeers, up: p.up, down: p.down })
          : L("Dashboard.Common.Off"),
        reason: !p2pWorld ? codeLabel("disabled", ["Reasons"]) : (p?.reason ?? "")
      },
      preload: preload ? {
        on: !!preload.enabled,
        label: !preload.enabled ? L("Dashboard.Common.Off")
          : L("Connection.PreloadProgress", { done: fmtCount(num(preload.done)), total: fmtCount(num(preload.total)) })
      } : null,
      cdn: {
        on: !!cdnStatus.cdn,
        label: cdnStatus.cdn ? L("Dashboard.Network.CdnOn") : L("Dashboard.Network.CdnOff"),
        status: codeLabel(cdnStatus.status, ["Cdn.Status"])
      },
      options: Object.entries(OPTIONS).map(([key, def]) => ({
        key,
        ...def,
        checkbox: def.type === "checkbox",
        value: setting(key, def.type === "checkbox" ? false : def.min),
        label: L(`Settings.${key}.Name`),
        hint: L(`Settings.${key}.Hint`),
        disabled: !p2pWorld && (key === "p2pParticipate" || key === "p2pUploadCapMBps")
      })),
      clearing: this.#clearing
    });
  }

  async #onOptionChange(input) {
    const key = input.dataset.ofSetting;
    const def = OPTIONS[key];
    if (!def) return;
    let value;
    if (def.type === "checkbox") value = input.checked;
    else {
      const n = Number(input.value);
      if (!Number.isFinite(n)) { this._refresh(true); return; }
      value = Math.min(def.max, Math.max(def.min, Math.round(n / def.step) * def.step));
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

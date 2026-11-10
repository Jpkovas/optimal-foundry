import { MODULE_ID, MODULE_PATH, warn } from "../constants.mjs";
import { getSetting } from "../settings.mjs";
import { recheckServiceWorker } from "../p2p/sw-client.mjs";
import { formatBytes, formatMbps, playerHealth } from "./format.mjs";

/** Shared helpers and the live-refreshing window base of the dashboard and the "My connection" panel. */

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export const TEMPLATE = name => `${MODULE_PATH}/templates/${name}.hbs`;
const REFRESH_MS = 2000;
const CALL_TIMEOUT_MS = 3000;

/* -------------------------------------------- */
/*  Formatting                                  */
/* -------------------------------------------- */

export const L = (key, data) => data
  ? game.i18n.format(`OPTIMALFOUNDRY.${key}`, data)
  : game.i18n.localize(`OPTIMALFOUNDRY.${key}`);

/** Localize `OPTIMALFOUNDRY.<key>` when it exists, otherwise return the fallback (or the raw suffix). */
export function maybeL(key, fallback) {
  const id = `OPTIMALFOUNDRY.${key}`;
  return game.i18n.has(id) ? game.i18n.localize(id) : (fallback ?? key.split(".").pop());
}

export const api = () => game.modules.get(MODULE_ID)?.api ?? {};

const warned = new Set();
export function warnOnce(tag, err) {
  if (warned.has(tag)) return;
  warned.add(tag);
  warn(`ui: ${tag} failed`, err);
}

/** Call an optional function; never throws, never hangs. Returns undefined on any problem. */
export async function call(tag, fn, ...args) {
  if (typeof fn !== "function") return undefined;
  let timer;
  try {
    const timeout = new Promise(resolve => { timer = setTimeout(resolve, CALL_TIMEOUT_MS); });
    return await Promise.race([Promise.resolve().then(() => fn(...args)), timeout]);
  } catch (err) {
    warnOnce(tag, err);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export function setting(key, fallback) {
  try { return getSetting(key) ?? fallback; } catch { return fallback; }
}

export const num = v => (Number.isFinite(v) ? v : 0);

/** A size on screen: binary units labelled KB/MB/GB, like the size settings. */
export const fmtBytes = n => formatBytes(n, game.i18n.lang);

/** A rate on screen (bytes per second in): megabits per second, like the speed settings. */
export const fmtRate = n => formatMbps(n, game.i18n.lang);

export function fmtCount(n) {
  if (n === Infinity) return "∞";
  return Number.isFinite(n) ? n.toLocaleString(game.i18n.lang) : "—";
}

export function fmtDate(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return "—";
  try { return new Date(ts).toLocaleString(game.i18n.lang); } catch { return "—"; }
}

export const basename = path => String(path ?? "").split(/[?#]/)[0].split("/").pop() || String(path ?? "");
export const yesNo = v => L(v ? "Dashboard.Common.Yes" : "Dashboard.Common.No");
/** First existing translation among `OPTIMALFOUNDRY.<prefix>.<code>`, else the raw code. */
export const codeLabel = (code, prefixes) => {
  if (!code) return "";
  const hit = prefixes.find(p => game.i18n.has(`OPTIMALFOUNDRY.${p}.${code}`));
  return hit ? game.i18n.localize(`OPTIMALFOUNDRY.${hit}.${code}`) : String(code);
};
export const reasonLabel = reason => codeLabel(reason, ["Reasons", "Media.Reason"]);
/** Why this browser cannot convert anything (`conversionBlocker()` of the converter), in plain words; "" when it can. */
export const blockerNote = blocker => (blocker ? maybeL(`Blocker.${blocker}`, "") : "");

/** Local cache (Service Worker) block shared by the dashboard and the player panel. */
export function describeSw(sw) {
  if (!sw) return null;
  return {
    supported: yesNo(sw.supported),
    registered: yesNo(sw.registered),
    controlling: yesNo(sw.controlling),
    isControlling: !!sw.controlling,
    version: sw.version || "—",
    outdated: !!sw.outdated,
    persisted: sw.persisted === null || sw.persisted === undefined ? "—" : yesNo(sw.persisted),
    cachedFiles: fmtCount(num(sw.cachedFiles)),
    cachedBytes: fmtBytes(num(sw.cachedBytes)),
    quota: fmtBytes(setting("cacheQuotaMB", 0) * 1_048_576),
    needsSetup: !!sw.needsSetup,
    // While the setup step is pending, that step is the reason: the GM gets instructions, a player a plain note.
    reason: sw.needsSetup ? "" : codeLabel(sw.reason, ["P2P.SwReason", "Reasons"])
  };
}

/** Usual place of Foundry's Data folder on each operating system (the defaults in Foundry's documentation). */
const DATA_FOLDERS = [
  { os: "Windows", path: "%localappdata%\\FoundryVTT\\Data" },
  { os: "macOS", path: "~/Library/Application Support/FoundryVTT/Data" },
  { os: "Linux", path: "~/.local/share/FoundryVTT/Data" }
];

/**
 * The "finish setup" step of the local cache, for a game master whose browser found no usable bridge file in the
 * Data folder: what is missing in one sentence and where the Data folder usually is. Null when there is nothing
 * to do, and always for players (the step is the game master's; a page without HTTPS has its own notice).
 * @param {object} [sw]  `swStatus()`
 */
export function describeSetup(sw) {
  if (!game.user.isGM || !sw?.needsSetup || !window.isSecureContext) return null;
  const stale = sw.dataRootCopy === "stale";
  return { stale, missing: L(stale ? "Setup.Stale" : "Setup.Missing"), folders: DATA_FOLDERS };
}

/**
 * "Check again" of the setup step: run the Service Worker registration again and say what it found.
 * @param {HTMLButtonElement} [button]  The clicked button, disabled while the check runs
 * @returns {Promise<object|undefined>} The new `swStatus()`
 */
export async function recheckSetup(button) {
  if (button) button.disabled = true;
  let sw;
  try {
    sw = await recheckServiceWorker();
  } catch (err) {
    warn("ui: checking the local cache again failed", err);
  } finally {
    if (button) button.disabled = false;
  }
  if (sw?.needsSetup) ui.notifications.warn(L(sw.dataRootCopy === "stale" ? "Setup.StillStale" : "Setup.StillMissing"));
  else if (sw?.registered) ui.notifications.info(L("Setup.Done"));
  else ui.notifications.warn(codeLabel(sw?.reason, ["P2P.SwReason", "Reasons"]) || L("Dashboard.Notify.Unavailable"));
  return sw;
}

/**
 * "Convert now": start the heavy conversions that were waiting for the players to leave (coordinating session
 * only). Not awaited by the caller: the run can last as long as the files are large.
 */
export function convertHeavyNow() {
  const fn = api().backfill?.runHeavyNow;
  if (typeof fn !== "function") return ui.notifications.warn(L("Dashboard.Notify.Unavailable"));
  // null: this session does not coordinate the optimization.
  Promise.resolve().then(() => fn()).then(n => { if (n === null) ui.notifications.warn(L("Dashboard.Notify.Unavailable")); }).catch(err => {
    warn("ui: converting the waiting files failed", err);
    ui.notifications.error(L("Dashboard.Notify.ActionFailed", { error: err?.message ?? String(err) }));
  });
}

/** This browser's own sharing (P2P swarm) block, shared by the dashboard and the player panel. */
export function describeSwarm(swarm) {
  if (!swarm) return null;
  const f = swarm.lastFailure;
  return {
    enabled: !!swarm.enabled,
    stateLabel: swarm.enabled ? L("Dashboard.Common.On") : L("Dashboard.Common.Off"),
    reason: swarm.enabled ? "" : codeLabel(swarm.reason, ["P2P.SwarmReason", "Reasons"]),
    openPeers: (Array.isArray(swarm.peers) ? swarm.peers : []).filter(p => p?.state === "open").length,
    up: fmtBytes(num(swarm.up)),
    down: fmtBytes(num(swarm.down)),
    servedFiles: fmtCount(num(swarm.servedFiles)),
    fetchedFiles: fmtCount(num(swarm.fetchedFiles)),
    failures: fmtCount(num(swarm.failures)),
    lastFailure: f ? L("P2P.LastFailure", { name: f.name ?? f.userId ?? "—", reason: codeLabel(f.reason, ["P2P.FailReason"]) || "—" }) : "",
    // The connection routes the browsers tried, for whoever debugs a strict network: kept out of the sentence.
    lastFailureDetail: f ? [fmtDate(f.at), L("P2P.LastFailureRoutes", { local: f.local ?? "-", remote: f.remote ?? "-" })].join(" · ") : ""
  };
}

/**
 * A player's browser as the coordinator sees it (HTTPS, local cache, can share), with what blocks sharing in words.
 * A blocker that only concerns sharing is left out when the world does not share at all.
 * @param {object} client     One entry of `networkStatus().clients`
 * @param {boolean} sharingOn `effectiveNetwork().p2p`
 */
export function describeHealth(client, sharingOn) {
  const h = playerHealth(client);
  const relevant = h.blocker && (sharingOn || (h.blocker === "https") || (h.blocker === "cache"));
  return {
    ...h,
    blockerLabel: relevant ? L(`Health.Blocker.${h.blocker}`) : "",
    tip: !h.known ? "" : [
      L(h.secure ? "Health.SecureYes" : "Health.SecureNo"),
      L(h.cache ? "Health.CacheYes" : "Health.CacheNo"),
      !sharingOn ? "" : (h.share ? L("Health.ShareYes") : L("Health.ShareNo", { reason: L(`Health.Blocker.${h.blocker}`) }))
    ].filter(Boolean).join(" · ")
  };
}

/** Blockers in the order they are worth fixing first when nobody shares. */
const BLOCKER_ORDER = ["https", "cache", "choice", "local"];

/**
 * Sharing between players as the coordinating session sees it: how many browsers share, how much moved, and, when
 * nobody shares, the reason in plain words (off in the settings, not used behind a CDN, or what holds the players).
 * @param {object|null} eff       `effectiveNetwork()`
 * @param {object|null} overview  `swarmOverview()`: `{sharing, links, upBytes, downBytes}`
 * @param {object} [clients]      `networkStatus().clients`
 */
export function describeSharing(eff, overview, clients) {
  if (!eff?.p2p) {
    const reason = !setting("p2pEnabled", true) ? L("Sharing.OffSetting") : ((eff?.profile === "cdn") ? L("Sharing.OffCdn") : "");
    return { on: false, cls: "off", label: L("Sharing.Off"), short: "", reason };
  }
  const sharing = num(overview?.sharing);
  const links = num(overview?.links);
  const moved = { up: fmtBytes(num(overview?.upBytes)), down: fmtBytes(num(overview?.downBytes)) };
  if (sharing > 0) {
    return { on: true, cls: links ? "ok" : "idle", label: L("Sharing.Count", { sharing: fmtCount(sharing), links: fmtCount(links) }),
      short: fmtCount(sharing), reason: "", ...moved };
  }
  const players = Object.entries(clients ?? {}).filter(([id, c]) => !c?.stale && !game.users.get(id)?.isGM).map(([, c]) => playerHealth(c));
  const blockers = new Set(players.map(h => h.blocker).filter(Boolean));
  const blocker = BLOCKER_ORDER.find(b => blockers.has(b));
  return { on: true, cls: "idle", label: L("Sharing.Nobody"), short: "0", ...moved,
    reason: !players.length ? L("Sharing.NoPlayers") : (blocker ? L(`Sharing.Why.${blocker}`) : "") };
}

/* -------------------------------------------- */
/*  Live window                                 */
/* -------------------------------------------- */

/**
 * A single-instance Handlebars window that refreshes itself every 2 s without getting in the way:
 * - no re-render while a pointer button is held inside it (a click would land on a replaced node and be lost)
 *   or while a text field or select has focus; that holds for the timer and for refreshes asked by hooks
 *   (`_refreshWhenIdle`), which wait and run once when the user is done;
 * - a part whose rendered HTML did not change keeps its DOM node (tooltips and focus survive).
 * Subclasses choose the parts of a periodic refresh with `_refreshParts(force)`.
 */
export class LiveApplication extends HandlebarsApplicationMixin(ApplicationV2) {
  #timer = null;
  #hooks = [];
  #pointerDown = false;
  #pointerUp = null;
  #lastHtml = {};
  #refreshing = false;
  #pending = null;
  /** A hook-driven refresh held back while the user was editing: null, or its `force` flag. */
  #queued = null;

  /** One window only: a second instance (settings menu, API, button) forwards to the open one. */
  render(options, _options) {
    const existing = foundry.applications.instances.get(this.id);
    if (existing && existing !== this && existing.rendered) return existing.render(options, _options);
    return super.render(options, _options);
  }

  /** @override */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    this.element.addEventListener("pointerdown", () => { this.#pointerDown = true; });
    // Editing ended (after the focus settled, so moving to the next field keeps waiting): run what was held back.
    this.element.addEventListener("focusout", () => setTimeout(() => { if (this.#queued !== null) this.#tick(); }, 0));
    this.#pointerUp = () => { this.#pointerDown = false; };
    window.addEventListener("pointerup", this.#pointerUp, true);
    window.addEventListener("pointercancel", this.#pointerUp, true);
    this.#timer = setInterval(() => this.#tick(), REFRESH_MS);
  }

  /** @override */
  _onClose(options) {
    super._onClose(options);
    clearInterval(this.#timer);
    this.#timer = null;
    window.removeEventListener("pointerup", this.#pointerUp, true);
    window.removeEventListener("pointercancel", this.#pointerUp, true);
    for (const [hook, id] of this.#hooks) Hooks.off(hook, id);
    this.#hooks = [];
    this.#lastHtml = {};
    this.#queued = null;
  }

  /** @override */
  _replaceHTML(result, content, options) {
    for (const [partId, el] of Object.entries(result)) {
      const html = el.outerHTML;
      if ((this.#lastHtml[partId] === html) && content.querySelector(`[data-application-part="${partId}"]`)) delete result[partId];
      else this.#lastHtml[partId] = html;
    }
    return super._replaceHTML(result, content, options);
  }

  /** Make the next render replace every part, e.g. after an input showed a value that was then corrected. */
  _invalidateParts() {
    this.#lastHtml = {};
  }

  /** Register a hook removed when the window closes. */
  _onHook(hook, fn) {
    this.#hooks.push([hook, Hooks.on(hook, fn)]);
  }

  /** Parts re-rendered by `_refresh(force)`; all by default. */
  _refreshParts(_force) {
    return Object.keys(this.constructor.PARTS);
  }

  /** A focused select or text field means the user is typing or choosing: do not replace it under them. */
  _isEditing() {
    const active = document.activeElement;
    return !!active && !!this.element?.contains(active)
      && active.matches("input:not([type=checkbox], [type=radio], [type=button]), select, textarea");
  }

  /** Re-rendering now would take a control away from the user. */
  #inUse() {
    return this.#pointerDown || this._isEditing();
  }

  #tick() {
    if (!this.rendered || this.minimized || document.hidden || this.#inUse()) return;
    const force = !!this.#queued;
    this.#queued = null;
    this._refresh(force);
  }

  /**
   * A refresh asked by a hook (a setting or the world changed) rather than by the user's own click. While the user
   * is typing, choosing in a select or holding a pointer button it waits, and one refresh runs when they are done
   * (on blur, or at the next tick).
   */
  _refreshWhenIdle(force) {
    if (!this.rendered) return;
    if (this.#inUse()) this.#queued = !!(this.#queued || force);
    else this._refresh(force);
  }

  /** Re-render `_refreshParts(force)`, coalescing calls that arrive while a render runs. */
  async _refresh(force) {
    if (!this.rendered) return;
    if (this.#refreshing) {
      this.#pending = !!(this.#pending || force);
      return;
    }
    this.#refreshing = true;
    try {
      await this.render({ parts: this._refreshParts(force) });
    } catch (err) {
      warnOnce("render", err);
    } finally {
      this.#refreshing = false;
      if (this.#pending !== null) {
        const again = this.#pending;
        this.#pending = null;
        this._refresh(again);
      }
    }
  }
}

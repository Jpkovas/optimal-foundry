import { MODULE_ID, MODULE_PATH, warn } from "../constants.mjs";
import { getSetting } from "../settings.mjs";

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

export function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return `${n.toLocaleString(game.i18n.lang, { maximumFractionDigits: i === 0 ? 0 : 1 })} ${units[i]}`;
}

export function fmtRate(n) {
  if (n === Infinity) return "∞";
  return Number.isFinite(n) ? `${fmtBytes(n)}/s` : "—";
}

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

/** Service Worker block shared by the dashboard and the player panel. */
export function describeSw(sw) {
  if (!sw) return null;
  return {
    supported: yesNo(sw.supported),
    registered: yesNo(sw.registered),
    controlling: yesNo(sw.controlling),
    isControlling: !!sw.controlling,
    scope: sw.scope || "—",
    version: sw.version || "—",
    outdated: !!sw.outdated,
    persisted: sw.persisted === null || sw.persisted === undefined ? "—" : yesNo(sw.persisted),
    cachedFiles: fmtCount(num(sw.cachedFiles)),
    cachedBytes: fmtBytes(num(sw.cachedBytes)),
    quota: fmtBytes(setting("cacheQuotaMB", 0) * 1_048_576),
    reason: codeLabel(sw.reason, ["P2P.SwReason", "Reasons"])
  };
}

/** P2P swarm block shared by the dashboard and the player panel. */
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
    lastFailure: f ? L("P2P.LastFailure", { name: f.name ?? f.userId ?? "—", reason: f.reason ?? "—",
      local: f.local ?? "-", remote: f.remote ?? "-" }) : "",
    lastFailureAt: f ? fmtDate(f.at) : ""
  };
}

/* -------------------------------------------- */
/*  Live window                                 */
/* -------------------------------------------- */

/**
 * A single-instance Handlebars window that refreshes itself every 2 s without getting in the way:
 * - no re-render while a pointer button is held inside it (a click would land on a replaced node and be lost)
 *   or while a text field or select has focus;
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

  #tick() {
    if (!this.rendered || this.minimized || document.hidden || this.#pointerDown || this._isEditing()) return;
    this._refresh(false);
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

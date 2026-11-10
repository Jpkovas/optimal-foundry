/**
 * Pure helpers of the UI: units and the small decisions the panels share. No Foundry globals, so `node --test`
 * runs them (test/ui.test.mjs); common.mjs binds the formatters to the game's language.
 */

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

/**
 * A size in binary units, labelled KB/MB/GB (1 MB = 1,048,576 bytes): the unit of every size setting, so a
 * 4096 MB quota reads "4 GB" and a 100 MB limit reads "100 MB".
 * @param {number} n     Bytes
 * @param {string} [lang] BCP 47 language for the number format
 */
export function formatBytes(n, lang) {
  if (!Number.isFinite(n) || n < 0) return "—";
  let i = 0;
  // Compare what will be printed (one decimal), so 1023.97 KB reads "1 MB" and never "1,024 KB".
  while ((Math.round(n * 10) / 10 >= 1024) && (i < BYTE_UNITS.length - 1)) { n /= 1024; i++; }
  return `${n.toLocaleString(lang, { maximumFractionDigits: i === 0 ? 0 : 1 })} ${BYTE_UNITS[i]}`;
}

/**
 * A transfer rate in megabits per second, the unit of the speed settings (1 Mbps = 125,000 bytes/s).
 * @param {number} bytesPerSec
 * @param {string} [lang]
 */
export function formatMbps(bytesPerSec, lang) {
  if (bytesPerSec === Infinity) return "∞";
  if (!Number.isFinite(bytesPerSec) || bytesPerSec < 0) return "—";
  const mbps = bytesPerSec / 125_000;
  const digits = mbps >= 10 ? 0 : (mbps >= 1 ? 1 : 2);
  return `${mbps.toLocaleString(lang, { maximumFractionDigits: digits })} Mbps`;
}

/**
 * What a player's browser can do, from the status it sends the coordinator (`secure`, `cache`, `p2p` in
 * `networkStatus().clients`). A status that does not carry them yet is "not known" rather than "no".
 * `blocker` is the first thing that keeps that browser from sharing, in the order someone would fix it:
 * the page is not on HTTPS, the local cache is not active, the browser is on the server's own network (kept out on
 * purpose), or sharing is off there (turned off by the player, or not chosen yet).
 * @param {{secure?: boolean, cache?: boolean, p2p?: boolean, local?: boolean}} [client]
 * @returns {{known: boolean, secure: boolean, cache: boolean, share: boolean, blocker: null|"https"|"cache"|"local"|"choice"}}
 */
export function playerHealth(client) {
  const known = typeof client?.secure === "boolean";
  const secure = known && client.secure;
  const cache = client?.cache === true;
  const share = client?.p2p === true;
  const blocker = !known || share ? null : (!secure ? "https" : (!cache ? "cache" : (client.local ? "local" : "choice")));
  return { known, secure, cache, share, blocker };
}

/** Plan reasons of scenes that are already on someone's screen: they are not "what comes next". */
const IN_VIEW = new Set(["playerViewing", "active"]);

/**
 * The scene the "everyone is ready" cue names: the first scene of the preload plan that is not on screen yet
 * (a marked scene, the one the GM is preparing, else the active scene's neighbour).
 * @param {{type: string, id: string|null, name: string, tier: number, reason: string}[]} [plan]  `preloadPlan().plan`
 * @returns {{id: string, name: string}|null}
 */
export function upcomingScene(plan) {
  const entry = (plan ?? []).find(e => (e.type === "scene") && e.id && (e.tier <= 1) && !IN_VIEW.has(e.reason));
  return entry ? { id: entry.id, name: entry.name } : null;
}

/**
 * The "everyone is ready" cue: the scene to announce now, or null. Every connected player must hold everything
 * that comes next, and a scene is announced once per session (`announced` remembers it), so a queue that rebuilds
 * and fills again never repeats the notice.
 * @param {{ready: boolean}[]} players          The tracker's rows, connected players only
 * @param {{id: string, name: string}|null} scene  `upcomingScene()`
 * @param {Set<string>} announced               Scene ids already announced (mutated)
 * @returns {{id: string, name: string}|null}
 */
export function readyCue(players, scene, announced) {
  if (!scene || !players.length || !players.every(p => p.ready) || announced.has(scene.id)) return null;
  announced.add(scene.id);
  return scene;
}

import crypto from "node:crypto";

/**
 * A browser and a Foundry server small enough for node, for the tests of the background optimizer. The module's own
 * converter (page side), library and backfill run for real against:
 * - a converter worker that answers at once with a 10-byte "optimized" file (the page side names it and builds the File);
 * - an in-memory Data folder behind `fetch` (HEAD only: sizes and ETags) and `FilePicker.upload`;
 * - `FilePicker.browse` with `wildcard`: `*` and `?` in the file name over the folder's files (`server.patterns` gives the
 *   answer of a pattern that is not evaluated here, braces and the like);
 * - `ui.notifications`, which only records what was said.
 * Call it after `globalThis.foundry` exists (it adds `foundry.applications`) and before the first conversion.
 * @returns {{files: Map<string, number>, uploads: string[], heads: string[], notices: {level: string, text: string}[],
 *   server: {truncate?: boolean, convert?: (job: object, path: string) => object, patterns?: Record<string, string[]>}}}
 */
export function fakeBrowser() {
  const files = new Map();   // Data-relative decoded path -> size in bytes
  const uploads = [];        // paths stored by an upload, in order
  const heads = [];          // paths asked with HEAD, in order
  const notices = [];
  const server = {};         // per-test behaviour: truncate (uploads are stored cut short), convert (the worker's answer)

  const pathOf = url => decodeURIComponent(new URL(String(url), "http://localhost:30000").pathname).replace(/^\//, "");

  globalThis.location = { href: "http://localhost:30000/game", origin: "http://localhost:30000", hostname: "localhost" };
  globalThis.isSecureContext = true;
  globalThis.OffscreenCanvas = class {};
  globalThis.ui = { notifications: Object.fromEntries(["info", "warn", "error"].map(level =>
    [level, text => { notices.push({ level, text }); }])) };

  globalThis.fetch = async (url, { method = "GET" } = {}) => {
    const path = pathOf(url);
    if (method === "HEAD") heads.push(path);
    const size = files.get(path);
    if (size === undefined) return new Response(null, { status: 404 });
    return new Response(null, { status: 200, headers: { "content-length": String(size), etag: `W/"${size.toString(16)}-1"` } });
  };

  foundry.applications = { apps: { FilePicker: { implementation: {
    async upload(_source, target, file) {
      const path = `${decodeURIComponent(target)}/${file.name}`;
      uploads.push(path);
      files.set(path, server.truncate ? Math.floor(file.size / 2) : file.size);
      return { path };
    },
    async createDirectory() { return {}; },
    async browse(_source, target) {
      if (server.patterns?.[target]) return { files: server.patterns[target] };
      const pattern = decodeURIComponent(target);
      const cut = pattern.lastIndexOf("/");
      const dir = pattern.slice(0, cut);
      const name = new RegExp(`^${pattern.slice(cut + 1).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
      return { files: [...files.keys()].filter(f => f.slice(0, f.lastIndexOf("/")) === dir && name.test(f.slice(f.lastIndexOf("/") + 1))) };
    }
  } } } };

  /** What converter-worker.mjs answers: its capabilities to "probe", a result to "convert". */
  const answer = message => {
    if (message.type === "probe") return { image: true, video: true, audio: true };
    const { job } = message;
    const path = pathOf(job.url);
    if (server.convert) return server.convert(job, path);
    return { status: "done", kind: job.kind, sha256: crypto.createHash("sha256").update(path).digest("hex"),
      bytes: 10, originalBytes: files.get(path) ?? 0, buffer: new ArrayBuffer(10) };
  };
  globalThis.Worker = class {
    #listeners = new Set();
    constructor(_url, options) { void options?.type; } // reading `type` is how the converter detects module workers
    addEventListener(type, fn) { if (type === "message") this.#listeners.add(fn); }
    removeEventListener(_type, fn) { this.#listeners.delete(fn); }
    terminate() {}
    postMessage(message) {
      Promise.resolve().then(() => {
        const result = answer(message);
        for (const fn of [...this.#listeners]) fn({ data: { type: "result", result } });
      });
    }
  };

  return { files, uploads, heads, notices, server };
}

/** Wait until `fn()` is truthy (the worker runs on timers of its own); throws after `ms`. */
export async function until(fn, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${fn}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

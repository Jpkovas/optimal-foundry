import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Checks on the files themselves, free of Foundry: what a release would ship broken without anyone running it.
 * Lang files in step, every key the code names present, the two Service Worker versions equal, the manifest's paths
 * on disk, the bridge file in place, and everything the module loads at runtime inside the release zip.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = rel => fs.existsSync(path.join(ROOT, rel));

/** Every file under `dir` (relative to the repository) whose name ends with one of `exts`. */
function walk(dir, exts) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(e => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return walk(rel, exts);
    return exts.some(x => e.name.endsWith(x)) ? [rel] : [];
  });
}

/** `{ "A.B": "text" }` for every string of a lang file. */
function flatten(node, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(node)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

const LANGS = ["en", "pt-BR"];
const lang = Object.fromEntries(LANGS.map(l => [l, JSON.parse(read(`lang/${l}.json`))]));
const flat = Object.fromEntries(LANGS.map(l => [l, flatten(lang[l])]));
const placeholders = text => [...String(text).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();

/** The node a dotted key names in the English file: a string, an object (a group of keys) or undefined. */
function lookup(key) {
  return key.split(".").reduce((node, part) => (node && typeof node === "object" ? node[part] : undefined), lang.en);
}

const SOURCES = [...walk("scripts", [".mjs"]), ...walk("templates", [".hbs"]), "sw.js"];

test("lang: both files have the same keys", () => {
  const [en, pt] = LANGS.map(l => Object.keys(flat[l]).sort());
  assert.deepEqual(en.filter(k => !(k in flat["pt-BR"])), [], "keys missing from pt-BR.json");
  assert.deepEqual(pt.filter(k => !(k in flat.en)), [], "keys missing from en.json");
});

test("lang: every text is a non-empty string with the same {placeholders} in both files", () => {
  for (const [key, text] of Object.entries(flat.en)) {
    assert.equal(typeof text, "string", key);
    assert.ok(text.trim() && String(flat["pt-BR"][key] ?? "").trim(), `${key} is empty`);
    assert.deepEqual(placeholders(flat["pt-BR"][key]), placeholders(text), `placeholders of ${key}`);
  }
});

test("lang: every OPTIMALFOUNDRY key named in scripts and templates exists", () => {
  const missing = [];
  for (const file of SOURCES) {
    const text = read(file);
    // A name that goes on with a dot (".${…}", ".<…>", or a closing quote after it) is the prefix of keys built
    // at runtime and must be a group; any other must exist (a text, or a group handed over as a label prefix).
    for (const m of text.matchAll(/OPTIMALFOUNDRY\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)(\.?)/g)) {
      const node = lookup(`OPTIMALFOUNDRY.${m[1]}`);
      const ok = m[2] ? (node && typeof node === "object") : (node !== undefined);
      if (!ok) missing.push(`${file}: OPTIMALFOUNDRY.${m[1]}${m[2]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("lang: every key the UI localizes through L() exists", () => {
  const missing = [];
  for (const file of walk("scripts/ui", [".mjs"])) {
    const text = read(file);
    for (const m of text.matchAll(/\bL\(\s*"([A-Za-z0-9_.]+)"/g)) {
      if (typeof lookup(`OPTIMALFOUNDRY.${m[1]}`) !== "string") missing.push(`${file}: ${m[1]}`);
    }
    // L(`Group.${code}`) and L(cond ? "A" : "B") style calls: the group, and each quoted alternative.
    for (const m of text.matchAll(/\bL\(\s*`([A-Za-z0-9_.]+)\.\$\{/g)) {
      const node = lookup(`OPTIMALFOUNDRY.${m[1]}`);
      if (!node || typeof node !== "object") missing.push(`${file}: ${m[1]}.*`);
    }
    for (const m of text.matchAll(/\bL\(\s*[^"`),]+\?\s*"([A-Za-z0-9_.]+)"\s*:\s*"([A-Za-z0-9_.]+)"/g)) {
      for (const key of [m[1], m[2]]) if (typeof lookup(`OPTIMALFOUNDRY.${key}`) !== "string") missing.push(`${file}: ${key}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("lang: every setting the UI shows has a name, a hint and its choices", async () => {
  // settings.mjs only touches `game` inside functions, so it loads here.
  const { settingDef } = await import("../scripts/settings.mjs");
  const shown = new Set();
  for (const file of ["scripts/ui/settings-app.mjs", "scripts/ui/connection.mjs", "scripts/ui/welcome.mjs", "scripts/ui/first-run.mjs"]) {
    for (const m of read(file).matchAll(/"([A-Za-z0-9]+)"/g)) {
      const def = settingDef(m[1]);
      if (def && (typeof def === "object") && ("scope" in def)) shown.add(m[1]);
    }
  }
  assert.ok(shown.has("preloadScope") && shown.has("p2pUploadCapMbps") && shown.has("hostUploadMbps"), "the scan found the settings");
  for (const key of shown) {
    const def = settingDef(key);
    if (def.group === undefined) continue; // internal state (welcomeDone, trackerVisible…) has no label
    for (const part of ["Name", "Hint"]) assert.equal(typeof lookup(`OPTIMALFOUNDRY.Settings.${key}.${part}`), "string", `${key}.${part}`);
    for (const choice of Object.keys(def.choices ?? {})) {
      assert.equal(typeof lookup(`OPTIMALFOUNDRY.Settings.${key}.Choices.${choice}`), "string", `${key}.Choices.${choice}`);
    }
  }
});

test("service worker: sw.js and its page side carry the same version", () => {
  const worker = read("sw.js").match(/^const VERSION = "([^"]+)";/m)?.[1];
  const page = read("scripts/p2p/sw-client.mjs").match(/^const SW_VERSION = "([^"]+)";/m)?.[1];
  assert.ok(worker, "VERSION not found in sw.js");
  assert.equal(page, worker);
});

test("service worker: the bridge file exists and loads the module's worker", () => {
  assert.ok(exists("optimal-foundry-sw.js"), "optimal-foundry-sw.js is missing from the module root");
  const bridge = read("optimal-foundry-sw.js");
  assert.match(bridge, /importScripts\(/);
  assert.match(bridge, /modules\/optimal-foundry\/sw\.js/);
});

const manifest = JSON.parse(read("module.json"));
const manifestPaths = [...manifest.esmodules, ...manifest.styles, ...manifest.languages.map(l => l.path), manifest.license];

test("manifest: every path exists, and version, download and changelog agree", () => {
  for (const p of manifestPaths) assert.ok(exists(p), `${p} (module.json) does not exist`);
  assert.equal(manifest.download, `${manifest.url}/releases/download/v${manifest.version}/module.zip`);
  assert.ok(exists("CHANGELOG.md") && manifest.changelog.endsWith("/CHANGELOG.md"), "changelog");
  assert.match(read("CHANGELOG.md"), new RegExp(`^## ${manifest.version.replaceAll(".", "\\.")}\\b`, "m"), "CHANGELOG.md has no entry for this version");
});

test("release: the zip holds every top-level path the module loads at runtime", () => {
  const top = p => p.split("/")[0];
  const needed = new Set(manifestPaths.map(top));
  // The Service Worker and its bridge are loaded by URL, never imported.
  needed.add("sw.js").add("optimal-foundry-sw.js");
  for (const file of walk("scripts", [".mjs"])) {
    const text = read(file);
    // Paths built on the module's folder: templates, the worker script…
    for (const m of text.matchAll(/\$\{MODULE_PATH\}\/([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)/g)) needed.add(m[1]);
    // Imports that leave scripts/ (the vendored bundle).
    for (const m of text.matchAll(/(?:from\s+|import\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
      const rel = path.relative(ROOT, path.resolve(ROOT, path.dirname(file), m[1]));
      assert.ok(exists(rel), `${file} imports ${m[1]}, which does not exist`);
      needed.add(top(rel));
    }
  }

  const line = read(".github/workflows/release.yml").split("\n").find(l => /\bzip\b.*\bmodule\.zip\b/.test(l));
  assert.ok(line, "zip line not found in release.yml");
  const [included, excluded = ""] = line.split(/\s-x\s/);
  const zipped = new Set(included.trim().split(/\s+/).slice(included.trim().split(/\s+/).indexOf("module.zip") + 1));
  for (const p of needed) {
    assert.ok(exists(p), `${p} is loaded at runtime but does not exist`);
    assert.ok(zipped.has(p), `${p} is loaded at runtime but is not in the release zip`);
  }
  assert.match(excluded, /vendor\/\*\.d\.ts/, "type declarations are left out of the zip");
  assert.ok(!zipped.has("test") && !zipped.has("node_modules"), "tests and dependencies are not shipped");
});

test("templates: every partial a template includes exists and is preloaded by a window", () => {
  const ui = walk("scripts/ui", [".mjs"]).map(read).join("\n");
  for (const file of walk("templates", [".hbs"])) {
    for (const m of read(file).matchAll(/\{\{>\s*"modules\/optimal-foundry\/templates\/([a-z-]+)\.hbs"/g)) {
      assert.ok(exists(`templates/${m[1]}.hbs`), `${file} includes ${m[1]}.hbs, which does not exist`);
      assert.match(ui, new RegExp(`templates:\\s*\\[[^\\]]*TEMPLATE\\("${m[1]}"\\)`), `no window preloads the partial ${m[1]}.hbs`);
    }
  }
});

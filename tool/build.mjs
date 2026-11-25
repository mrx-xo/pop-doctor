#!/usr/bin/env node
// build.mjs: the two downloads out of this folder, checked against the store's and the game's rules.
//
//   node tool/build.mjs
//
// mod/ is the plugin exactly as the game loads it and as the store gets it: nothing is generated, it is checked,
// copied and zipped. The relay is a download of its own: the game refuses a plugin folder that holds a program.
//
//   dist/<name>/                  a copy of mod/
//   dist/<name>-<version>.zip     the same, zipped for Thunderstore (the store's files at the top)
//   dist/<name>_Relay/            relay/: the relay, the .cmd that starts it, README.txt
//   dist/<name>_Relay-<version>.zip
//
// The name, version, description and website are mod/manifest.json; the permissions are mod/reskate-plugin.json.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOD = path.join(ROOT, "mod");
const RELAY_SRC = path.join(ROOT, "relay");
const DIST = path.join(ROOT, "dist");
const warnings = [];
const fail = (why) => { console.error("build: " + why); process.exit(1); };
const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const json = (p) => { try { return JSON.parse(read(p)); } catch (e) { fail(`${path.relative(ROOT, p)}: ${e.message}`); } };

const manifest = json(path.join(MOD, "manifest.json"));
const plugin = json(path.join(MOD, "reskate-plugin.json"));
const NAME = manifest.name, VERSION = manifest.version_number;
const TITLE = String(NAME).replace(/_/g, " ");
const PKG = path.join(DIST, NAME);
const RELAY = path.join(DIST, NAME + "_Relay");

// ---- the store's rules (docs.reskate.dev/mods/thunderstore) ---------------------------------------------------
if (!/^[A-Za-z0-9_]+$/.test(NAME ?? "")) fail("manifest.json name: letters, digits and _ only");
if (!/^\d+\.\d+\.\d+$/.test(VERSION ?? "")) fail("manifest.json version_number: three numbers, such as 1.0.0");
if (typeof manifest.description !== "string" || manifest.description.length > 250) fail(`manifest.json description: ${manifest.description?.length} characters; the store takes 250`);
if (manifest.website_url && !/^https:\/\//.test(manifest.website_url)) fail("manifest.json website_url: an https:// link or empty");
if (!Array.isArray(manifest.dependencies)) fail("manifest.json dependencies: a list, empty when there are none");
if (plugin.entry !== "plugin/main.lua") fail("reskate-plugin.json entry: plugin/main.lua");
if (!Array.isArray(plugin.permissions)) fail("reskate-plugin.json permissions: a list");

// ---- main.lua: every call is covered by a permission asked for, every permission asked for is used -----------------
const lua = read(path.join(MOD, "plugin", "main.lua"));
if (Buffer.byteLength(lua) > 1024 * 1024) fail("plugin/main.lua is over 1 MB");
const BASE = new Set(["log", "time", "on", "json", "package", "id", "api_version"]);
const AREA = { files: "files", animation: "skater.animation", menu: "menu" };
// reading the skater and the physics is skater.read; these change them and need skater.control (api_skater.md)
const CONTROL = {
  skater: new Set(["noclip", "boost", "freeze", "wipeout", "shape_launch", "hide", "push", "push_wait", "push_reset", "hold", "set_velocity", "cruise", "flip_speed", "select_rail_target"]),
  physics: new Set(["tune", "competition", "stock_ready", "prepare"]),
};
const EVENT = { trick_started: "events.tricks", trick_landed: "events.tricks", launch: "events.skater", board_landed: "events.skater", bail: "events.skater", draw: "overlay" };
const used = new Set();
const lineOf = (i) => lua.slice(0, i).split("\n").length;
for (const m of lua.matchAll(/reskate\.([a-z_]+)(?:\.([a-z_]+))?/g)) {
  const [, area, fn] = m;
  if (BASE.has(area)) continue;
  const need = CONTROL[area] ? (CONTROL[area].has(fn) ? "skater.control" : "skater.read") : AREA[area];
  if (!need) fail(`main.lua:${lineOf(m.index)} calls reskate.${area}: no permission is known for it here (tool/build.mjs)`);
  if (!plugin.permissions.includes(need)) fail(`main.lua:${lineOf(m.index)} calls ${m[0]} but reskate-plugin.json does not ask for ${need}`);
  used.add(need);
}
for (const m of lua.matchAll(/reskate\.on\("([a-z_]+)"/g)) {
  const need = EVENT[m[1]];
  if (!need) continue; // tick, unload and the like need none
  if (!plugin.permissions.includes(need)) fail(`main.lua:${lineOf(m.index)} listens to ${m[1]} but reskate-plugin.json does not ask for ${need}`);
  used.add(need);
}
for (const p of plugin.permissions) if (!used.has(p)) fail(`reskate-plugin.json asks for ${p} and main.lua uses nothing of it: a player would be asked for no reason`);

// ---- the fonts: each one listed is there, with the licence of the font its sheets were drawn from -----------------
const FONT_LICENCES = { anton: "Anton-LICENSE.txt", barlow_bold: "Barlow-LICENSE.txt", montserrat_extrabold: "Montserrat-LICENSE.txt", montserrat_semibold: "Montserrat-LICENSE.txt", permanent_marker: "PermanentMarker-LICENSE.txt" };
const fonts = json(path.join(MOD, "text", "fonts.json"));
for (const f of fonts) {
  const sheets = json(path.join(MOD, "text", f.folder, "manifest.json")).sheets ?? [];
  if (sheets.length === 0) fail(`font ${f.name}: its manifest lists no sheets`);
  for (const s of sheets) if (!fs.existsSync(path.join(MOD, s))) fail(`font ${f.name}: ${s} is missing`); // paths from the package's top
  const licence = FONT_LICENCES[f.folder];
  if (!licence) fail(`font ${f.name}: no licence is known for it here. Ship a font only when its licence lets you (tool/build.mjs, FONT_LICENCES).`);
  if (!fs.existsSync(path.join(MOD, "text", "licences", licence))) fail(`font ${f.name}: mod/text/licences/${licence} is missing`);
}
for (const d of fs.readdirSync(path.join(MOD, "text"), { withFileTypes: true })) {
  if (d.isDirectory() && d.name !== "licences" && !fonts.some((f) => f.folder === d.name)) fail(`mod/text/${d.name} is not in fonts.json`);
}

// ---- the texts and the icon -------------------------------------------------------------------------------------
const readme = read(path.join(MOD, "README.md"));
if (readme.split("\n").length > 400) fail("README.md is over the store's 400 lines");
if (readme.includes("RELAY LINK MISSING")) warnings.push("README.md has no download link for the relay yet (the RELAY LINK MISSING line). NOT READY TO UPLOAD.");
if (!manifest.website_url) warnings.push("manifest.json website_url is empty: the launcher shows no Website button.");
if (!read(path.join(MOD, "CHANGELOG.md")).includes(`## ${VERSION}`)) fail(`CHANGELOG.md has no entry for ${VERSION}`);
const relayReadme = read(path.join(RELAY_SRC, "README.txt"));
if (!relayReadme.startsWith(`${TITLE} relay ${VERSION}\n`)) fail(`relay/README.txt must begin with "${TITLE} relay ${VERSION}"`);
const icon = fs.readFileSync(path.join(MOD, "icon.png"));
if (icon.readUInt32BE(16) !== 256 || icon.readUInt32BE(20) !== 256) fail("mod/icon.png must be 256 x 256");

// ---- the plugin folder: a copy of mod/. The game's own check: it never holds a program ("Packages that are refused")
fs.rmSync(PKG, { recursive: true, force: true });
fs.rmSync(RELAY, { recursive: true, force: true });
fs.cpSync(MOD, PKG, { recursive: true });
const REFUSED = new Set([".exe", ".dll", ".sys", ".scr", ".com", ".cpl", ".msi", ".msp", ".bat", ".cmd", ".ps1", ".psm1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh", ".hta", ".lnk", ".pif", ".reg"]);
let files = 0, bytes = 0;
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    files += 1;
    const data = fs.readFileSync(p);
    bytes += data.length;
    if (REFUSED.has(path.extname(e.name).toLowerCase()) || (data.length >= 2 && data[0] === 0x4d && data[1] === 0x5a)) fail(`the game would refuse the package: ${path.relative(ROOT, p)} is a program`);
  }
})(PKG);

// ---- the relay, a download of its own. Its text files get Windows line ends: a .cmd is read by cmd.exe. ------------
fs.mkdirSync(RELAY, { recursive: true });
const relayFiles = fs.readdirSync(RELAY_SRC);
if (!relayFiles.some((f) => f.endsWith(".mjs")) || !relayFiles.some((f) => f.endsWith(".cmd"))) fail("relay/ needs the .mjs and the .cmd that starts it");
for (const f of relayFiles) {
  if (/\.(cmd|txt)$/i.test(f)) fs.writeFileSync(path.join(RELAY, f), read(path.join(RELAY_SRC, f)).replace(/\n/g, "\r\n"));
  else if (/\.sh$/i.test(f)) fs.writeFileSync(path.join(RELAY, f), read(path.join(RELAY_SRC, f))); // a shell wants plain line ends
  else fs.copyFileSync(path.join(RELAY_SRC, f), path.join(RELAY, f));
}
const sh = relayFiles.find((f) => f.endsWith(".sh"));
if (!sh || !read(path.join(RELAY_SRC, sh)).includes(relayFiles.find((f) => f.endsWith(".mjs")))) fail("relay/ needs a .sh that starts the relay, for Linux and macOS");
if (fs.readFileSync(path.join(RELAY, sh), "utf8").includes("\r")) fail(`${sh} went out with Windows line ends`);
const started = read(path.join(RELAY_SRC, relayFiles.find((f) => f.endsWith(".cmd"))));
const relayName = relayFiles.find((f) => f.endsWith(".mjs"));
if (!started.includes(relayName)) fail(`the relay's .cmd does not start ${relayName}`);
if (spawnSync(process.execPath, ["--check", path.join(RELAY, relayName)]).status !== 0) fail(`${relayName} does not parse`);

// ---- zips: entries with / between folders, the store's files at the top ----------------------------------------------
// Written here, with Node's own deflate, so the build runs the same on Windows, macOS and Linux (it once called
// Windows' tar.exe). Files only, / between folders, sorted, one fixed date: the same files and the same Node give
// the same zip (another Node's deflate may pack the same files into other bytes).
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function filesUnder(dir, rel = "") {
  const out = [];
  for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const r = rel ? rel + "/" + d.name : d.name;
    if (d.isDirectory()) out.push(...filesUnder(dir, r)); else out.push(r);
  }
  return out;
}
function zip(dir, out) {
  fs.rmSync(out, { force: true });
  const names = filesUnder(dir);
  const DOS_TIME = 0, DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01 00:00
  const parts = [], central = [];
  let at = 0;
  for (const name of names) {
    const raw = fs.readFileSync(path.join(dir, name));
    const packed = zlib.deflateRawSync(raw, { level: 9 });
    const stored = packed.length >= raw.length;
    const data = stored ? raw : packed;
    const nameBuf = Buffer.from(name, "utf8");
    const mode = name.endsWith(".sh") ? 0o100755 : 0o100644; // a .sh keeps its run bit for unzip on Linux and macOS
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(stored ? 0 : 8, 8);
    head.writeUInt16LE(DOS_TIME, 10); head.writeUInt16LE(DOS_DATE, 12); head.writeUInt32LE(crc32(raw), 14);
    head.writeUInt32LE(data.length, 18); head.writeUInt32LE(raw.length, 22); head.writeUInt16LE(nameBuf.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE((3 << 8) | 20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(stored ? 0 : 8, 10); cen.writeUInt16LE(DOS_TIME, 12); cen.writeUInt16LE(DOS_DATE, 14); cen.writeUInt32LE(crc32(raw), 16);
    cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(raw.length, 24); cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE((mode << 16) >>> 0, 38); cen.writeUInt32LE(at, 42);
    parts.push(head, nameBuf, data);
    central.push(cen, nameBuf);
    at += head.length + nameBuf.length + data.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(names.length, 8); end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(cenBuf.length, 12); end.writeUInt32LE(at, 16);
  fs.writeFileSync(out, Buffer.concat([...parts, cenBuf, end]));
  return names;
}
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const pkgZip = path.join(DIST, `${NAME}-${VERSION}.zip`);
const relayZip = path.join(DIST, `${NAME}_Relay-${VERSION}.zip`);
const entries = zip(PKG, pkgZip);
for (const top of ["manifest.json", "icon.png", "README.md", "reskate-plugin.json"]) if (!entries.includes(top)) fail(`${pkgZip} lacks ${top} at its top`);
if (entries.some((e) => e.includes("\\"))) fail("the zip has \\ in its entry names");
zip(RELAY, relayZip);

// ---- the smoke test: load the built package in a Luau VM with a stand-in game ------------------------------------
const smoke = spawnSync(process.execPath, [path.join(ROOT, "tool", "smoke.mjs"), PKG], { encoding: "utf8" });
const smokeOut = (smoke.stdout + smoke.stderr).trim();

console.log(`plugin  ${path.relative(ROOT, PKG)}  ${files} files, ${(bytes / 1024).toFixed(0)} KB, ${lua.split("\n").length} lines of Luau`);
console.log(`        permissions: ${plugin.permissions.join(", ")}`);
console.log(`        fonts: ${fonts.map((f) => f.name).join(", ")}`);
console.log(`zip     ${path.relative(ROOT, pkgZip)}  ${(fs.statSync(pkgZip).size / 1024).toFixed(0)} KB, ${entries.length} entries, sha256 ${sha(pkgZip)}`);
console.log(`relay   ${path.relative(ROOT, relayZip)}  ${(fs.statSync(relayZip).size / 1024).toFixed(0)} KB, sha256 ${sha(relayZip)}`);
console.log(smoke.status === 0 ? `smoke   passed\n${smokeOut.split("\n").map((l) => "        " + l).join("\n")}` : `smoke   FAILED\n${smokeOut}`);
for (const w of warnings) console.log("WARNING " + w);
if (smoke.status !== 0) process.exit(1);

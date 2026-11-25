#!/usr/bin/env node
// pop-doctor-relay.mjs: tail ReSkate.log for Animation Studio lines and the trainer's options, and write them into the plugin's
// data folder as studio.json, which the plugin's overlay shows (the plugin cannot read outside its data folder).
//
//   node pop-doctor-relay.mjs                       keep running; ctrl-c stops it
//   node pop-doctor-relay.mjs --game "D:\ReSkate"   the game's folder: use this one and no other
//   node pop-doctor-relay.mjs --id <mod folder>     write for this one plugin folder only
//   RESKATE_GAME=... POP_DOCTOR_ID=...              the same two, from the environment
//   RESKATE_DATA=...                                ReSkate's own data folder (the one holding trainer), when not found
//
// The game's folder: --game / RESKATE_GAME, else the game that is running, the folder remembered from last time, the
// folders above this file, then the usual folder (C:\Games\ReSkate, ~/Games/ReSkate). It says which one it took and
// why. With none it asks for the folder and goes on by itself when the game starts. Unless the folder was told, it
// keeps looking for a running game and moves over when one runs from another folder: started before the game on a
// machine with two installs, it once sat on the wrong one for good.
// Windows, Linux (Proton) and macOS (Wine): the game's folder is found the same way everywhere. ReSkate's own data
// folder is %LOCALAPPDATA%\ReSkate, which off Windows is inside the Wine prefix the game runs in; the Steam,
// CrossOver and default prefixes are searched for it. Only the trainer's options come from there.
// The plugin: every folder in Mods whose manifest.json is named one of PLUGIN_NAMES (the store installs the release
// as <Owner>-Pop_Doctor; a hand copy can have any folder name), so a store install and a hand copy are both fed.
// Needs nothing but Node 18 or newer: no packages.
//
// studio.json: {played, trick, grade, graded_by, native, inferred, sel, pack, stance, lets_go, missing, line_at,
//               trainer: {gravity, ...}, written}
//   sel        which choice of the Studio this is: the log time (ms) of the line that showed it. It moves on only
//              when the Studio chooses for a new pop, so the plugin dates a choice by when sel changed.
//   graded_by  "game" (the game's own pop grade) or "air" (the Studio's guess from the air time).
//   native     true when the Studio said it plays nothing of yours for this pop (the game's own animation).
//   inferred   true when the choice's own line was swallowed by the log and it was told from the clip's other lines.
//
//   node pop-doctor-relay.mjs --replay <ReSkate.log>   read a whole log and print each choice it tells; writes nothing

import { promises as fs, statSync, existsSync, openSync, readSync, closeSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const PLUGIN_NAMES = ["Pop_Doctor"];
const argv = process.argv.slice(2);
function arg(name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }
if (argv.includes("--help") || argv.includes("-h")) {
  console.log('Pop Doctor relay: tells the Pop Doctor overlay what Animator Studio played.\n\n  node ' + path.basename(fileURLToPath(import.meta.url)) + ' [--game "<ReSkate folder>"] [--id <mod folder>]\n\nLeave it running while you play. Ctrl-C stops it.');
  process.exit(0);
}

const WIN = process.platform === "win32";
const HOME = os.homedir();
// Where the relay remembers the game's folder. On Windows beside ReSkate's own data, as it always was.
const REMEMBER = WIN
  ? path.join(process.env.LOCALAPPDATA ?? HOME, "ReSkate", "pop-doctor-relay.json")
  : path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, ".config"), "pop-doctor", "relay.json");
const USUAL = WIN ? "C:\\Games\\ReSkate" : path.join(HOME, "Games", "ReSkate");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripBom = (t) => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);
const run = (cmd, args) => new Promise((res) => {
  try { execFile(cmd, args, { encoding: "utf8", timeout: 10000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, out) => res(err ? "" : String(out))); }
  catch { res(""); }
});
const samePath = (a, b) => { const x = path.resolve(a), y = path.resolve(b); return WIN ? x.toLowerCase() === y.toLowerCase() : x === y; };
function subdirs(dir) {
  try { return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => path.join(dir, d.name)); }
  catch { return []; }
}

// A ReSkate folder has Mods beside Skate.exe (or beside logs, once it has run).
function isGame(dir) {
  try {
    return !!dir && statSync(path.join(dir, "Mods")).isDirectory()
      && (existsSync(path.join(dir, "Skate.exe")) || existsSync(path.join(dir, "logs")));
  } catch { return false; }
}

// The folder of the Skate.exe in a process's command line. Under Wine the path is a Windows one, Z:\home\you\... (Z:
// is the whole disk), or a plain one; a path may hold spaces, so every place a path could begin is tried.
function gameFromArgs(args) {
  for (let at = args.indexOf("Skate.exe"); at >= 0; at = args.indexOf("Skate.exe", at + 1)) {
    const head = args.slice(0, at + "Skate.exe".length);
    const tries = [];
    for (const m of head.matchAll(/[Zz]:[\\/]/g)) tries.push("/" + head.slice(m.index + 3).replace(/\\/g, "/"));
    for (let i = 0; i < head.length; i++) if (head[i] === "/" && (i === 0 || /[\s"'=]/.test(head[i - 1]))) tries.push(head.slice(i));
    for (const t of tries) { const dir = path.dirname(t); if (isGame(dir)) return dir; }
  }
  return undefined;
}
// The folder of the game that is running now, or undefined. Asked every few seconds, so it is cheap: on Windows
// tasklist says whether a Skate.exe runs, and PowerShell is asked for its path once per game process.
let seenPid = null, seenDir;
async function runningGame() {
  if (WIN) {
    const m = /^"Skate\.exe","(\d+)"/im.exec(await run("tasklist", ["/FI", "IMAGENAME eq Skate.exe", "/FO", "CSV", "/NH"]));
    if (!m) { seenPid = null; return undefined; }
    if (m[1] !== seenPid) {
      const out = (await run("powershell", ["-NoProfile", "-NonInteractive", "-Command",
        `(Get-Process -Id ${m[1]} -ErrorAction SilentlyContinue).Path`])).trim();
      if (!out) return undefined;
      seenPid = m[1];
      seenDir = path.dirname(out);
    }
    return seenDir;
  }
  if (process.platform === "linux") {
    let pids = [];
    try { pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n)); } catch { /* no /proc */ }
    for (const pid of pids) {
      let line;
      try { line = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " "); } catch { continue; }
      if (!line.includes("Skate.exe")) continue;
      const dir = gameFromArgs(line.trim());
      if (dir) return dir;
    }
    return undefined;
  }
  for (const line of (await run("ps", ["-A", "-ww", "-o", "args="])).split("\n")) {
    if (!line.includes("Skate.exe")) continue;
    const dir = gameFromArgs(line.trim());
    if (dir) return dir;
  }
  return undefined;
}
function remembered() {
  try { return JSON.parse(readFileSync(REMEMBER, "utf8")).game; } catch { return undefined; }
}
function above() {
  const out = [];
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) { out.push(dir); const up = path.dirname(dir); if (up === dir) break; dir = up; }
  return out;
}

// ReSkate's own data folder, for the trainer's options. Off Windows it is inside a Wine prefix: every Steam library's
// compatdata, the CrossOver bottles and the default prefix are looked through, and the one whose trainer.json was
// written last wins.
function winePrefixes() {
  const out = [];
  if (process.env.WINEPREFIX) out.push(process.env.WINEPREFIX);
  const libs = new Set();
  for (const s of [".steam/steam", ".steam/root", ".local/share/Steam", ".var/app/com.valvesoftware.Steam/.local/share/Steam",
    "snap/steam/common/.local/share/Steam", "Library/Application Support/Steam"]) {
    const steam = path.join(HOME, s);
    libs.add(steam);
    try {
      for (const m of readFileSync(path.join(steam, "steamapps", "libraryfolders.vdf"), "utf8").matchAll(/"path"\s+"([^"]+)"/g)) libs.add(m[1].replace(/\\\\/g, "\\"));
    } catch { /* no Steam here */ }
  }
  for (const lib of libs) for (const c of subdirs(path.join(lib, "steamapps", "compatdata"))) out.push(path.join(c, "pfx"));
  for (const b of ["Library/Application Support/CrossOver/Bottles", ".cxoffice"]) out.push(...subdirs(path.join(HOME, b)));
  out.push(path.join(HOME, ".wine"));
  return out;
}
function dataDir() {
  if (process.env.RESKATE_DATA) return process.env.RESKATE_DATA;
  if (WIN) return path.join(process.env.LOCALAPPDATA ?? HOME, "ReSkate");
  let best, bestAt = -1;
  for (const p of winePrefixes()) for (const u of subdirs(path.join(p, "drive_c", "users"))) {
    const d = path.join(u, "AppData", "Local", "ReSkate");
    let at = -1;
    try { at = statSync(path.join(d, "trainer", "trainer.json")).mtimeMs; }
    catch { try { if (statSync(d).isDirectory()) at = 0; } catch { /* not here */ } }
    if (at > bestAt) { best = d; bestAt = at; }
  }
  return best;
}

// What was typed or dropped at the question: quotes off, ~ for home, a shell's "\ " for a space; the file Skate.exe
// stands for its folder.
function typedFolder(line) {
  let p = line.trim().replace(/^["']|["']$/g, "");
  if (!p) return undefined;
  if (!WIN) p = p.replace(/\\ /g, " ");
  if (p === "~" || p.startsWith("~/")) p = path.join(HOME, p.slice(1));
  if (isGame(p)) return p;
  if (isGame(path.dirname(p))) return path.dirname(p);
  console.log(`relay: "${p}" is not a ReSkate folder: it has no Mods folder beside Skate.exe. Try again.`);
  return undefined;
}
// [folder, why], or undefined when wait is false and there is none.
const TOLD = arg("--game") ?? process.env.RESKATE_GAME;
async function findGame(wait) {
  if (TOLD) {
    if (isGame(TOLD)) return [TOLD, "the folder it was told"];
    console.error(`relay: "${TOLD}" is not a ReSkate folder (it has no Mods folder beside Skate.exe).`);
    process.exit(1);
  }
  let rl = null, typed;
  try {
    for (;;) {
      if (typed) return [typed, "the folder you gave"];
      const places = [[await runningGame(), "the game that is running"], [remembered(), "remembered from last time"],
        ...above().map((d) => [d, "the folder this relay is in"]), [USUAL, "the usual folder; it moves over if the game runs from another"]];
      for (const [dir, why] of places) if (isGame(dir)) return [dir, why];
      if (!wait) return undefined;
      if (!rl) {
        if (process.stdin.isTTY) {
          console.log("relay: the ReSkate folder was not found.\n       Start the game and this goes on by itself.\n       Or paste the folder that holds Skate.exe here and press Enter:");
          rl = readline.createInterface({ input: process.stdin });
          rl.on("line", (line) => { typed = typedFolder(line) ?? typed; });
          rl.on("SIGINT", () => process.exit(0));
        } else {
          rl = {};
          console.log('relay: the ReSkate folder was not found. Start the game and this goes on by itself,\n       or close this and run it with  --game "<your ReSkate folder>".');
        }
      }
      await sleep(2000);
    }
  } finally { rl?.close?.(); }
}

// The game the relay serves, and everything read from its folder. useGame (further down, after what it resets)
// points the relay at a folder and forgets what the last one said; generation lets a read that was under way when
// the folder changed drop its answer.
let GAME, MODS, LOG, TRICKS, PRESETS;
let generation = 0;
const FORCED_ID = arg("--id") ?? process.env.POP_DOCTOR_ID;
const POLL_MS = 250;
const TRAINER_MS = 2000;
const PACKS_MS = 5000;
const TARGETS_MS = 30000;
const FOLLOW_MS = 5000;

const state = { played: null, trick: null, grade: null, graded_by: null, native: false, inferred: false, sel: 0, pack: null, stance: null, lets_go: null, missing: null, line_at: null, trainer: null };
let dirty = false;

// Where studio.json goes: the data folder of every installed copy of the plugin. Looked for again every 30 s, so
// the relay can be started before the plugin is installed or switched on.
let targets = [];
let targetsKey = null;
async function findTargets() {
  const gen = generation;
  const ids = [];
  if (FORCED_ID) ids.push(FORCED_ID);
  else {
    let names = [];
    try { names = await fs.readdir(MODS); } catch { /* no Mods yet */ }
    for (const n of names) {
      if (n.startsWith(".")) continue;
      try {
        const m = JSON.parse(stripBom(await fs.readFile(path.join(MODS, n, "manifest.json"), "utf8")));
        if (PLUGIN_NAMES.includes(m.name) && existsSync(path.join(MODS, n, "reskate-plugin.json"))) ids.push(n);
      } catch { /* not a mod with a manifest */ }
    }
  }
  if (gen !== generation) return;
  const key = ids.join("|");
  if (key === targetsKey) return;
  targetsKey = key;
  targets = ids.map((id) => path.join(MODS, ".reskate_plugin_data", id));
  dirty = true;
  if (ids.length) console.log(`plugin: ${ids.join(", ")}`);
  else console.log(`plugin: Pop Doctor is not in ${MODS} yet. Install it and turn it on; the relay keeps looking.`);
}

// Which pack an animation belongs to: the playlist that is on says first (its entries carry a pack), then the first
// pack (presets/<pack>.json, slots: "trick|pop" -> [animations]) that lists it. "" is a trick outside every pack.
let packOf = new Map();
const trickOfClip = new Map(); // animation -> the game's trick id, from the pack slots and the trick files
let packStamp = "";
async function readPacks() {
  if (!GAME) return;
  const gen = generation;
  let names;
  try { names = await fs.readdir(PRESETS); } catch { return; }
  const files = names.filter((n) => n.endsWith(".json"));
  const stamps = [];
  for (const n of files) { try { stamps.push(n + ":" + (await fs.stat(path.join(PRESETS, n))).mtimeMs); } catch {} }
  const stamp = stamps.join("|");
  if (gen !== generation || stamp === packStamp) return;
  packStamp = stamp;
  const next = new Map();
  const tricks = new Map();
  for (const n of files) {
    if (n === "playlists.json") continue;
    try {
      const t = JSON.parse(await fs.readFile(path.join(PRESETS, n), "utf8"));
      if (!t.slots || typeof t.slots !== "object") continue;
      const pack = t.name ?? n.replace(/\.json$/, "");
      for (const [slot, list] of Object.entries(t.slots)) if (Array.isArray(list)) for (const a of list) {
        if (!next.has(a)) next.set(a, pack);
        if (!tricks.has(a)) tricks.set(a, slot.split("|")[0]);
      }
    } catch {}
  }
  try {
    const p = JSON.parse(await fs.readFile(path.join(PRESETS, "playlists.json"), "utf8"));
    const on = (p.playlists ?? []).find((pl) => pl.name === p.on);
    for (const e of on?.entries ?? []) if (e.animation) next.set(e.animation, e.pack ?? "");
  } catch {}
  if (gen !== generation) return;
  packOf = next;
  for (const [a, t] of tricks) if (!trickOfClip.has(a)) trickOfClip.set(a, t);
  state.packs = [...new Set(next.values())].filter((p) => p).sort((a, b) => a.localeCompare(b)); // every pack name, for the per-pack colour card
  if (state.played) { state.pack = packOf.get(state.played) ?? null; }
  dirty = true;
  console.log(`packs: ${files.length - 1} files, ${packOf.size} animations`);
  await readNames();
}

// The game's trick ids as the Studio names them: each trick file has trick ("360flip"), pop ("high") and name
// ("360 Flip high"); the name minus its pop word is the display name. Read once per set of trick folders.
let namesStamp = -1;
async function readNames() {
  const gen = generation;
  let folders;
  try { folders = (await fs.readdir(TRICKS, { withFileTypes: true })).filter((d) => d.isDirectory() && d.name !== "presets" && d.name !== "diagnostics"); } catch { return; }
  if (gen !== generation || folders.length === namesStamp) return;
  namesStamp = folders.length;
  // A trick id takes the display name most of its files agree on, not the first file's: one own copy named
  // "Ninja Nollie Kick - Kickflip" sorted ahead of 152 files named "Nollie Kickflip ..." and titled every n_kickflip.
  const votes = new Map(); // trick id -> Map(display -> files)
  for (const d of folders) {
    try {
      const t = JSON.parse(await fs.readFile(path.join(TRICKS, d.name, d.name + ".json"), "utf8"));
      if (t.trick) { trickOfClip.set(d.name, t.trick); if (t.name) trickOfClip.set(String(t.name), t.trick); }
      if (!t.trick || !t.name) continue;
      // "Pop Shuv-it high 3 2" -> "Pop Shuv-it": cut from the pop word on, whatever the file's own pop says (a trick
      // saved with pop ANY still carries the word in its name)
      let display = String(t.name).replace(/\s+(low|mid|high)\b.*$/i, "");
      if (t.pop && !/^(low|mid|high)$/i.test(t.pop)) display = display.replace(new RegExp(`\\s+${t.pop}\\b.*$`, "i"), "");
      display = display.charAt(0).toUpperCase() + display.slice(1);
      if (!votes.has(t.trick)) votes.set(t.trick, new Map());
      const v = votes.get(t.trick);
      v.set(display, (v.get(display) ?? 0) + 1);
    } catch {}
  }
  if (gen !== generation) return;
  const names = {};
  for (const [trick, v] of votes) names[trick] = [...v.entries()].reduce((best, e) => (e[1] > best[1] ? e : best))[0];
  state.names = names;
  dirty = true;
  console.log(`names: ${Object.keys(names).length} trick ids`);
}

// "[2026-11-08 18:29:43.159] ... Animation Studio: <rest>". The game's log swallows a line that is the same as one it
// wrote in the last 5 s and writes "Repeated N more times: <line>" later, when 5 s have passed and something else is
// logged (logger.cpp). So a "Repeated" line is OLD news that arrives late, and a pop of the same trick, pop and clip
// within 5 s has no choice line of its own. About a quarter of the pops of a session are like that.
const STUDIO = /^\[([^\]]+)\].*?(Repeated \d+ more times: )?Animation Studio: (Repeated \d+ more times: )?(.*)$/;
// "the game does a TRICK (GRADE pop by the game's grade|air time, ...), playing your CLIP as made for the low pop (...)"
// or "... playing your CLIP (authored edits ...)" or just "... CLIP."
const RE_DOES = /^the game does a (\S+) \((\w+) pop(?: by (the game's grade|air time))?[^)]*\), playing your (.+?)(?: as made\b| \(|\.?$)/;
const RE_PLAYS = /^(.+?) \(made leading with the (\w+) foot(?:, fakie)?\) plays - (.+?) - (as made|mirrored)/;
const RE_LETS_GO = /^(.+?) lets go at ([\d.]+) s: (.+?)\.?$/;
// The clip's other lines, each with the clip's own time: "CLIP follows the game's clip (its own) at 0.21 s (...)",
// "CLIP follows the game's mirrored clip 2 at 0.2 s", "CLIP moved onto the game's clip 2 at 0.4 s",
// "CLIP goes on at its own pace from 1.36 s, ...". Their numbers differ pop to pop, so the log rarely swallows them.
const RE_CLOCK = /^(.+?) (?:follows the game's (?:mirrored )?clip|moved onto the game's clip|goes on at its own pace)\b.*? (?:at|from) ([\d.]+) s\b/;
// "TRICK uses native animation; no saved trick for POP pop leading with ...": nothing of yours plays for this pop.
const RE_NATIVE = /^(\S+) uses native animation; no saved trick for (\w*) ?pop\b/;
const RE_MISSING = /no saved trick/;
const RE_GRIND_STARTS = /^doing a (.+?); (.+?) starts\.?$/;
const RE_GRIND_PLAYING = /^the game is playing \S+(?:, mirrored)? \([\d.]+ s in\); playing your (.+?)\.?$/;
const RE_GRIND_LETS_GO = /^grinding; (.+?) lets go: (.+?)\.?$/;

// One choice of the Studio and the lines that follow it are an episode: which clip, and when it started on the
// log's clock. A clip's line belongs to the episode when the clip is the same and its own time puts its start
// within SAME_MS of the episode's; otherwise the Studio chose again and that choice's own lines were swallowed.
const SAME_MS = 900;
const PAIR_MS = 600; // "plays" and "the game does a" of one choice come together; a regrade in the air a moment later
let episode = null; // {clip, start}
const lastDoes = new Map();   // clip -> {trick, grade, by}: what its last choice line said
const lastStance = new Map(); // clip -> the stance text of its last "plays" line
const lastGrind = new Map();  // grind clip -> the grind's name, from its last "starts" line
const GRADES = new Set(["low", "mid", "high"]);
const logMs = (at) => { const t = Date.parse(at.replace(" ", "T")); return Number.isFinite(t) ? t : Date.now(); };
const saidBy = (r) => ({ trick: r[1], grade: GRADES.has(r[2]) ? r[2] : null, by: r[3] === "the game's grade" ? "game" : r[3] ? "air" : null });

// The Studio chose CLIP at t (log ms). Until its own choice line says otherwise, the trick and grade are what that
// clip's last choice line said (a swallowed line had the same text), else the trick the clip is filed under.
function choose(clip, t, start) {
  episode = { clip, start: start ?? t };
  state.sel = t;
  state.played = clip;
  state.pack = packOf.get(clip) ?? null;
  state.native = false;
  state.missing = null;
  state.lets_go = null;
  state.stance = lastStance.get(clip) ?? null;
  const said = lastDoes.get(clip);
  state.trick = said?.trick ?? trickOfClip.get(clip) ?? null;
  state.grade = said?.grade ?? null;
  state.graded_by = said?.by ?? null;
  state.inferred = true;
}
function sameEpisode(clip, start, within) {
  return episode !== null && episode.clip === clip && Math.abs(start - episode.start) < within;
}

function takeLine(line) {
  const m = STUDIO.exec(line);
  if (!m) return;
  const at = m[1], rest = m[4];
  const repeated = !!(m[2] || m[3]);
  const t = logMs(at);
  let r;
  if (repeated) {
    // Old news, never a new choice. Its one use: it confirms the trick and grade of a choice told from the clip alone.
    if ((r = RE_DOES.exec(rest))) {
      const said = saidBy(r);
      if (!lastDoes.has(r[4])) lastDoes.set(r[4], said);
      if (episode && episode.clip === r[4] && state.inferred && state.played === r[4]) {
        state.trick = said.trick; state.grade = said.grade; state.graded_by = said.by; state.inferred = false;
        dirty = true;
      }
    }
    else if ((r = RE_GRIND_STARTS.exec(rest)) && !lastGrind.has(r[2])) lastGrind.set(r[2], r[1]);
    return;
  }
  if ((r = RE_DOES.exec(rest))) {
    const clip = r[4];
    const said = saidBy(r);
    lastDoes.set(clip, said);
    if (!sameEpisode(clip, t, PAIR_MS)) choose(clip, t);
    state.trick = said.trick;
    state.grade = said.grade;
    state.graded_by = said.by;
    state.inferred = false;
  } else if ((r = RE_PLAYS.exec(rest))) {
    const clip = r[1];
    lastStance.set(clip, `${r[3]}, ${r[4]} (made ${r[2]} foot)`);
    if (!sameEpisode(clip, t, PAIR_MS)) choose(clip, t);
    state.stance = lastStance.get(clip);
  } else if ((r = RE_LETS_GO.exec(rest))) {
    const start = t - Number(r[2]) * 1000;
    if (!sameEpisode(r[1], start, SAME_MS)) choose(r[1], t, start);
    state.lets_go = `at ${r[2]} s: ${r[3]}`;
  } else if ((r = RE_CLOCK.exec(rest))) {
    const start = t - Number(r[2]) * 1000;
    if (sameEpisode(r[1], start, SAME_MS)) return; // a clock line of a choice already told: nothing new
    choose(r[1], t, start);
  } else if ((r = RE_NATIVE.exec(rest))) {
    episode = null;
    state.sel = t;
    state.played = null;
    state.pack = null;
    state.native = true;
    state.inferred = false;
    state.trick = r[1];
    state.grade = GRADES.has(r[2]) ? r[2] : null;
    state.graded_by = null;
    state.stance = null;
    state.lets_go = null;
    state.missing = rest.slice(0, 120);
  } else if ((r = RE_GRIND_STARTS.exec(rest))) {
    // "doing a FS Nosegrind; Grind FS BS Nosegrind Rail Loop 2 starts."
    episode = null;
    lastGrind.set(r[2], r[1]);
    state.sel = t;
    state.trick = r[1];
    state.grade = "grind";
    state.graded_by = null;
    state.native = false;
    state.inferred = false;
    state.played = r[2];
    state.pack = packOf.get(r[2]) ?? null;
    state.missing = null;
    state.stance = null;
    state.lets_go = null;
  } else if ((r = RE_GRIND_PLAYING.exec(rest))) {
    // "the game is playing animation/.../x_loop (0.3 s in); playing your Grind FS BS Nosegrind Rail Loop 2."
    // Its "starts" line comes first and names the grind. When the log swallowed that line (the same grind within
    // 5 s), this is the only news of it: name it from the clip's last "starts" line, never from the flip before.
    episode = null;
    const same = state.grade === "grind" && state.played === r[1];
    state.sel = t;
    state.played = r[1];
    state.pack = packOf.get(r[1]) ?? null;
    if (!same) {
      state.trick = lastGrind.get(r[1]) ?? trickOfClip.get(r[1]) ?? null;
      state.graded_by = null;
      state.missing = null;
      state.stance = null;
      state.lets_go = null;
    }
    state.grade = "grind";
    state.native = false;
    state.inferred = false;
  } else if ((r = RE_GRIND_LETS_GO.exec(rest))) {
    state.lets_go = `${r[2]}`;
  } else if (RE_MISSING.test(rest)) {
    state.missing = rest.slice(0, 120);
  } else {
    return;
  }
  state.line_at = at;
  dirty = true;
}

// Follow the log from its current end: only new lines count. A shorter file (rotated) starts over, and so does
// another file in its place, told by the file's number on the disk: one of the same size went unread before.
let offset = 0;
let carry = "";
let logFile = null;
function readNew() {
  let st;
  try { st = statSync(LOG); } catch { return; }
  const file = st.ino ? `${st.dev}:${st.ino}` : null;
  if (st.size < offset || (file && logFile && file !== logFile)) { offset = 0; carry = ""; }
  logFile = file;
  if (st.size === offset) return;
  const fd = openSync(LOG, "r");
  try {
    const buf = Buffer.alloc(st.size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    offset = st.size;
    const text = carry + buf.toString("utf8");
    const lines = text.split(/\r?\n/);
    carry = lines.pop() ?? "";
    for (const line of lines) takeLine(line);
  } finally { closeSync(fd); }
}

const TRAINER_KEYS = ["gravity", "gravity_landing", "gravity_landing_own", "gravity_animation_timing", "flip_speed", "flip_landing_limit", "flip_pop"];
let trainerText = null;
let TRAINER = null;
let trainerLooked = 0;
async function readTrainer() {
  if ((!TRAINER || !existsSync(TRAINER)) && Date.now() - trainerLooked > 30000) {
    trainerLooked = Date.now();
    const d = dataDir();
    TRAINER = d ? path.join(d, "trainer", "trainer.json") : null;
  }
  if (!TRAINER) return;
  let text;
  try { text = await fs.readFile(TRAINER, "utf8"); } catch { return; }
  if (text === trainerText) return;
  trainerText = text;
  try {
    const t = JSON.parse(text);
    const out = { active: t.active ?? [] };
    for (const k of TRAINER_KEYS) if (t.options && k in t.options) out[k] = t.options[k];
    state.trainer = out;
    dirty = true;
  } catch { /* half-written: next time */ }
}

let writeFailed = null;
async function write() {
  if (!dirty || targets.length === 0) return;
  dirty = false;
  const body = JSON.stringify({ ...state, written: new Date().toISOString() });
  try {
    for (const dir of targets) {
      const out = path.join(dir, "studio.json");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(out + ".tmp", body, "utf8");
      await fs.rename(out + ".tmp", out);
    }
  } catch (e) {
    dirty = true; // not written: the next round tries again (the plugin may have had the file open)
    if (writeFailed !== e.message) { writeFailed = e.message; console.error("relay write:", e.message, "(trying again)"); }
    return;
  }
  if (writeFailed) { writeFailed = null; console.log("relay write: working again"); }
  const stamp = new Date().toTimeString().slice(0, 8);
  console.log(`${stamp}  ${state.played ?? "-"}${state.grade ? ` (${state.grade} pop)` : ""}${state.lets_go ? `  lets go ${state.lets_go}` : ""}`);
}

// Point the relay at a game folder and forget what the last one said.
const fresh = JSON.stringify(state);
function useGame(dir) {
  generation += 1;
  GAME = dir;
  MODS = path.join(GAME, "Mods");
  LOG = path.join(GAME, "logs", "ReSkate.log");
  TRICKS = path.join(GAME, "ReSkate.Tricks");
  PRESETS = path.join(TRICKS, "presets");
  const trainer = state.trainer;
  for (const k of Object.keys(state)) delete state[k];
  Object.assign(state, JSON.parse(fresh), { trainer });
  targets = []; targetsKey = null;
  packOf = new Map(); packStamp = ""; namesStamp = -1;
  trickOfClip.clear(); lastDoes.clear(); lastStance.clear(); lastGrind.clear();
  episode = null;
  offset = 0; carry = ""; logFile = null;
}
function remember() {
  try { mkdirSync(path.dirname(REMEMBER), { recursive: true }); writeFileSync(REMEMBER, JSON.stringify({ game: GAME })); } catch { /* found again next time */ }
}
// Start at the end of the log, but seed from the last lines so the panel is not empty at first.
function seedLog() {
  try {
    const st = statSync(LOG);
    offset = Math.max(0, st.size - 200_000);
    readNew();
  } catch { /* no log yet */ }
}
async function serve(dir, why) {
  useGame(dir);
  remember();
  console.log(`game: ${GAME}  (${why})`);
  seedLog();
  await findTargets();
  await readPacks();
  await write();
}

// --replay <log>: every choice a whole log tells, one a line, and how many were told without their own line.
if (arg("--replay")) {
  const found = await findGame(false); // the packs and trick names of a game make the telling better; none is fine
  if (found) useGame(found[0]);
  await readPacks();
  let last = null, told = 0, inferred = 0, native = 0;
  const show = () => {
    if (last === null) return;
    told += 1; inferred += last.inferred ? 1 : 0; native += last.native ? 1 : 0;
    console.log(`${last.at}  ${(last.trick ?? "?").padEnd(18)} ${(last.grade ?? "-").padEnd(5)} ${last.native ? "(the game's own animation)" : last.played}${last.inferred ? "   [told from the clip's other lines]" : ""}`);
  };
  for (const line of readFileSync(arg("--replay"), "utf8").split(/\r?\n/)) {
    const before = state.sel;
    takeLine(line);
    if (state.sel !== before) { show(); last = null; }
    if (state.sel) last = { at: new Date(state.sel).toTimeString().slice(0, 8) + "." + String(state.sel % 1000).padStart(3, "0"), trick: state.trick, grade: state.grade, played: state.played, inferred: state.inferred, native: state.native };
  }
  show();
  console.log(`${told} choices: ${told - inferred - native} with their own line, ${inferred} told from the clip's other lines, ${native} the game's own animation`);
  process.exit(0);
}

{
  const [dir, why] = await findGame(true);
  await serve(dir, why);
}
await readTrainer();
await write();
console.log(`relay: ${LOG} -> studio.json in ${targets.length} plugin folder${targets.length === 1 ? "" : "s"}. Leave this running while you play.`);

setInterval(() => { readNew(); write(); }, POLL_MS);
setInterval(() => { readTrainer().catch(() => {}); }, TRAINER_MS);
setInterval(() => { readPacks().catch(() => {}); }, PACKS_MS);
setInterval(() => { findTargets().catch(() => {}); }, TARGETS_MS);
// The game may run from another folder than the one taken at the start (two installs, or the relay started first).
if (!TOLD) {
  let looking = false;
  setInterval(async () => {
    if (looking) return;
    looking = true;
    try {
      const dir = await runningGame();
      if (dir && isGame(dir) && !samePath(dir, GAME)) await serve(dir, "the game that is running now; it was on another folder");
    } catch (e) { console.error("relay:", e.message); }
    finally { looking = false; }
  }, FOLLOW_MS);
}

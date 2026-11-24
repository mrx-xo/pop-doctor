#!/usr/bin/env node
// pop-grader-relay.mjs: tail ReSkate.log for Animation Studio lines and the trainer's options, and write them into the plugin's
// data folder as studio.json, which the plugin's overlay shows (the plugin cannot read outside its data folder).
//
//   node pop-grader-relay.mjs                       keep running; ctrl-c stops it
//   node pop-grader-relay.mjs --game "D:\ReSkate"   the game's folder, when it is not found by itself
//   node pop-grader-relay.mjs --id <mod folder>     write for this one plugin folder only
//   RESKATE_GAME=... POP_GRADER_ID=...              the same two, from the environment
//
// The game's folder: --game / RESKATE_GAME, else the running Skate.exe, the folder remembered from last time, the
// folders above this file, then C:\Games\ReSkate. With none, it waits for the game to start.
// The plugin: every folder in Mods whose manifest.json is named one of PLUGIN_NAMES (the store installs the release
// as <Owner>-Pop_Grader; a hand copy can have any folder name), so a store install and a hand copy are both fed.
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
//   node pop-grader-relay.mjs --replay <ReSkate.log>   read a whole log and print each choice it tells; writes nothing

import { promises as fs, statSync, existsSync, openSync, readSync, closeSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PLUGIN_NAMES = ["Pop_Grader"];
const argv = process.argv.slice(2);
function arg(name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }
if (argv.includes("--help") || argv.includes("-h")) {
  console.log('Pop Grader relay: tells the Pop Grader overlay what Animator Studio played.\n\n  node ' + path.basename(fileURLToPath(import.meta.url)) + ' [--game "<ReSkate folder>"] [--id <mod folder>]\n\nLeave it running while you play. Ctrl-C stops it.');
  process.exit(0);
}

const LOCAL = path.join(process.env.LOCALAPPDATA ?? "", "ReSkate");
const REMEMBER = path.join(LOCAL, "pop-grader-relay.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripBom = (t) => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);

// A ReSkate folder has Mods beside Skate.exe (or beside logs, once it has run).
function isGame(dir) {
  try {
    return !!dir && statSync(path.join(dir, "Mods")).isDirectory()
      && (existsSync(path.join(dir, "Skate.exe")) || existsSync(path.join(dir, "logs")));
  } catch { return false; }
}
function runningGame() {
  if (process.platform !== "win32") return undefined;
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      "(Get-Process Skate -ErrorAction SilentlyContinue | Select-Object -First 1).Path"],
      { encoding: "utf8", timeout: 10000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out ? path.dirname(out) : undefined;
  } catch { return undefined; }
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
async function findGame() {
  const told = arg("--game") ?? process.env.RESKATE_GAME;
  if (told) {
    if (isGame(told)) return told;
    console.error(`relay: "${told}" is not a ReSkate folder (it has no Mods folder beside Skate.exe).`);
    process.exit(1);
  }
  let said = false;
  for (;;) {
    for (const dir of [runningGame(), remembered(), ...above(), "C:\\Games\\ReSkate"]) if (isGame(dir)) return dir;
    if (!said) {
      said = true;
      console.log('relay: the ReSkate folder was not found. Start the game and this goes on by itself,\n       or close this and run it with  --game "<your ReSkate folder>".');
    }
    await sleep(5000);
  }
}

const GAME = await findGame();
try { mkdirSync(LOCAL, { recursive: true }); writeFileSync(REMEMBER, JSON.stringify({ game: GAME })); } catch { /* found again next time */ }
const MODS = path.join(GAME, "Mods");
const FORCED_ID = arg("--id") ?? process.env.POP_GRADER_ID;
const LOG = path.join(GAME, "logs", "ReSkate.log");
const TRAINER = path.join(LOCAL, "trainer", "trainer.json");
const POLL_MS = 250;
const TRAINER_MS = 2000;

const TRICKS = path.join(GAME, "ReSkate.Tricks");
const PRESETS = path.join(TRICKS, "presets");
const PACKS_MS = 5000;
const TARGETS_MS = 30000;

const state = { played: null, trick: null, grade: null, graded_by: null, native: false, inferred: false, sel: 0, pack: null, stance: null, lets_go: null, missing: null, line_at: null, trainer: null };
let dirty = false;

// Where studio.json goes: the data folder of every installed copy of the plugin. Looked for again every 30 s, so
// the relay can be started before the plugin is installed or switched on.
let targets = [];
let targetsKey = null;
async function findTargets() {
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
  const key = ids.join("|");
  if (key === targetsKey) return;
  targetsKey = key;
  targets = ids.map((id) => path.join(MODS, ".reskate_plugin_data", id));
  dirty = true;
  if (ids.length) console.log(`plugin: ${ids.join(", ")}`);
  else console.log(`plugin: Pop Grader is not in ${MODS} yet. Install it and turn it on; the relay keeps looking.`);
}

// Which pack an animation belongs to: the playlist that is on says first (its entries carry a pack), then the first
// pack (presets/<pack>.json, slots: "trick|pop" -> [animations]) that lists it. "" is a trick outside every pack.
let packOf = new Map();
const trickOfClip = new Map(); // animation -> the game's trick id, from the pack slots and the trick files
let packStamp = "";
async function readPacks() {
  let names;
  try { names = await fs.readdir(PRESETS); } catch { return; }
  const files = names.filter((n) => n.endsWith(".json"));
  const stamps = [];
  for (const n of files) { try { stamps.push(n + ":" + (await fs.stat(path.join(PRESETS, n))).mtimeMs); } catch {} }
  const stamp = stamps.join("|");
  if (stamp === packStamp) return;
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
  let folders;
  try { folders = (await fs.readdir(TRICKS, { withFileTypes: true })).filter((d) => d.isDirectory() && d.name !== "presets" && d.name !== "diagnostics"); } catch { return; }
  if (folders.length === namesStamp) return;
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
    episode = null;
    state.sel = t;
    state.played = r[1];
    state.pack = packOf.get(r[1]) ?? null;
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

// Follow the log from its current end: only new lines count. A shorter file (rotated) starts over.
let offset = 0;
let carry = "";
function readNew() {
  let st;
  try { st = statSync(LOG); } catch { return; }
  if (st.size < offset) { offset = 0; carry = ""; }
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
async function readTrainer() {
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

async function write() {
  if (!dirty || targets.length === 0) return;
  dirty = false;
  const body = JSON.stringify({ ...state, written: new Date().toISOString() });
  for (const dir of targets) {
    const out = path.join(dir, "studio.json");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(out + ".tmp", body, "utf8");
    await fs.rename(out + ".tmp", out);
  }
  const stamp = new Date().toTimeString().slice(0, 8);
  console.log(`${stamp}  ${state.played ?? "-"}${state.grade ? ` (${state.grade} pop)` : ""}${state.lets_go ? `  lets go ${state.lets_go}` : ""}`);
}

// --replay <log>: every choice a whole log tells, one a line, and how many were told without their own line.
if (arg("--replay")) {
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

// Start at the end of the log, but seed from the last lines so the panel is not empty at first.
try {
  const st = statSync(LOG);
  const tailFrom = Math.max(0, st.size - 200_000);
  offset = tailFrom;
  readNew();
} catch { /* no log yet */ }
await findTargets();
await readPacks();
await readTrainer();
await write();
console.log(`relay: ${LOG} -> studio.json in ${targets.length} plugin folder${targets.length === 1 ? "" : "s"}. Leave this running while you play.`);

setInterval(() => { readNew(); write().catch((e) => console.error("relay write:", e.message)); }, POLL_MS);
setInterval(() => { readTrainer().catch(() => {}); }, TRAINER_MS);
setInterval(() => { readPacks().catch(() => {}); }, PACKS_MS);
setInterval(() => { findTargets().catch(() => {}); }, TARGETS_MS);

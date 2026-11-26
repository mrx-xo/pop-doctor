#!/usr/bin/env node
// relay-choices-test.mjs [relay file]: which pop the relay tells, and with what grade and pack, when the game's log
// does not say it outright. relay-test.sh covers where the relay finds the game; this covers what it makes of the log.
//
//   node tool/relay-choices-test.mjs                          relay/pop-doctor-relay.mjs
//
// Part 1 writes logs the way the game does and reads them back with --replay. The game's logger swallows a line it
// wrote less than 5 s ago and writes "Repeated N more times: <line>" later (Engine/Core/Log/logger.cpp); the copy of
// that rule below makes the stand-in logs, so a pop's lines are swallowed here exactly when the game would.
//   1a. four pops of one clip inside 5 s, low high low high: the late "Repeated ... low" line is not about the last one
//   1b. the same clip, the repeat written before the next pop: it still corrects the pop it is about (as on 2026-11-08)
//   1c. two pops of one clip 0.8 s apart, the second with no choice line: two choices, not one
//   1d. a clip that starts on the game's clip of the pop before ("at 1.06 s", then "(its own) at 0.17 s"): one choice
// Part 2 runs the relay beside a stand-in game folder (about 15 s): a playlist switched on after a jump does not move
// that jump to the new playlist's pack; the next jump has the new pack.
// Nothing outside a temp folder is read or written: the relay is told the stand-in folder and its own files go there.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELAY = path.resolve(process.argv[2] ?? path.join(ROOT, "relay", "pop-doctor-relay.mjs"));
const T = fs.mkdtempSync(path.join(os.tmpdir(), "pop-doctor-relay-"));
const GAME = path.join(T, "game");
const PRESETS = path.join(GAME, "ReSkate.Tricks", "presets");
const PLUGIN = "builders-Pop_Doctor";
for (const d of [path.join(GAME, "Mods", PLUGIN), path.join(GAME, "logs"), PRESETS]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(GAME, "Skate.exe"), "");
fs.writeFileSync(path.join(GAME, "Mods", PLUGIN, "manifest.json"), JSON.stringify({ name: "Pop_Doctor" }));
fs.writeFileSync(path.join(GAME, "Mods", PLUGIN, "reskate-plugin.json"), "{}");
// the relay's own files (the folder it remembers, the trainer it looks for) stay in the temp folder
const ENV = { ...process.env, LOCALAPPDATA: path.join(T, "appdata"), XDG_CONFIG_HOME: path.join(T, "config"), RESKATE_DATA: path.join(T, "data") };
delete ENV.RESKATE_GAME; delete ENV.POP_DOCTOR_ID;

const report = [];
let failed = 0;
function check(ok, what, got) {
  if (ok) return;
  failed += 1;
  console.error("FAIL  " + what + (got === undefined ? "" : "\n      got: " + got));
}

// ---- the game's log, with its rule for repeats ------------------------------------------------
const pad = (n, w = 2) => String(n).padStart(w, "0");
const stamp = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`; };
function gameLog(base) {
  const out = [];
  const repeats = new Map(); // text -> {last: when it was last WRITTEN, suppressed}
  const emit = (t, text) => out.push(`[${stamp(base + t)}] [1:2] Native(C): [Skater] [INFO] ${text}`);
  const log = (t, text) => {
    for (const [k, r] of repeats) if (t - r.last >= 5000 && r.suppressed) { emit(t, `Repeated ${r.suppressed} more times: ${k}`); r.suppressed = 0; }
    const found = repeats.get(text);
    if (found) { if (t - found.last < 5000) { found.suppressed += 1; return; } found.last = t; }
    else repeats.set(text, { last: t, suppressed: 0 });
    emit(t, text);
  };
  let deg = 2.0;
  // One pop at t (ms): the Studio's lines as in the logs of 2026-11-07 and 11-08. ends: ms after t its "lets go" line
  // comes, and why. carried: the clip starts on the game's clip of the pop before.
  const pop = (t, clip, trick, grade, ends, why, carried) => {
    log(t, `Animation Studio: ${clip} (made leading with the left foot) plays - left foot leading - as made (front foot).`);
    log(t, `Animation Studio: the game does a ${trick} (${grade} pop by the game's grade, at the flick, before the pop), playing your ${clip} as made for the ${grade} pop (authored edits over fresh native pose).`);
    deg += 0.1;
    if (carried) {
      log(t, `Animation Studio: ${clip} follows the game's mirrored clip 14 at 1.06 s (${deg.toFixed(1)} degrees).`);
      log(t + 132, `Animation Studio: ${clip} follows the game's mirrored clip (its own) at 0.18 s (0.2 degrees).`);
    } else log(t + 130, `Animation Studio: ${clip} follows the game's clip (its own) at 0.13 s (${deg.toFixed(1)} degrees).`);
    if (ends) log(t + ends, `Animation Studio: ${clip} lets go at ${(ends / 1000).toFixed(2)} s: ${why ?? "the game's next animation"}.`);
  };
  return { pop, text: () => out.join("\n") + "\n" };
}
// What the relay tells of a log: [{trick, grade, clip, own (told with its own choice line)}]
function replay(name, text) {
  const file = path.join(T, name + ".log");
  fs.writeFileSync(file, text);
  const run = spawnSync(process.execPath, [RELAY, "--game", GAME, "--replay", file], { encoding: "utf8", env: ENV, timeout: 30000 });
  const told = [];
  for (const line of run.stdout.split(/\r?\n/)) {
    const m = /^\d\d:\d\d:\d\d\.\d{3}  (\S+)\s+(\S+)\s+(.*?)(   \[told from the clip's other lines\])?$/.exec(line);
    if (m) told.push({ trick: m[1], grade: m[2], clip: m[3], own: !m[4] });
  }
  if (run.status !== 0 || told.length === 0) check(false, `${name}: the replay ran`, (run.stdout + run.stderr).slice(-400));
  return told;
}
const show = (told) => told.map((c) => `${c.grade}${c.own ? "" : "?"}`).join(" ");
const X = "FS Pop Shuv-it mid 12", Y = "Kickflip low 3";
const BASE = Date.parse("2026-11-25T12:00:00.000");

// 1a. Four pops of X inside 5 s: low, high, low, high. The third and fourth have no choice line of their own. The
// "Repeated 1 more times: ... low ..." line is written at 5.05 s, when the fourth (high) is the one on show: it is
// about the third. Before: the fourth was told low, and as sure. The log does not say which of the two is the low
// one, so neither may be told as sure, and the fourth keeps the grade of the clip's last own line (high).
{
  const g = gameLog(BASE);
  g.pop(0, X, "fspopshuvit", "low", 1200, "the next pop");
  g.pop(1200, X, "fspopshuvit", "high", 1200, "the next pop");
  g.pop(2400, X, "fspopshuvit", "low", 1200, "the next pop");
  g.pop(3600, X, "fspopshuvit", "high", 1450);
  g.pop(12000, Y, "kickflip", "low", 1300);
  const told = replay("1a", g.text());
  check(told.length === 5, "1a: five pops are five choices", show(told));
  const fourth = told[3] ?? {};
  check(!(fourth.grade === "low" && fourth.own), "1a: a high pop is not told low and sure by the low line of two pops before", show(told));
  check(fourth.grade === "high" && fourth.own === false, "1a: the fourth pop stays high, and not sure", show(told));
  check(told[2] && told[2].own === false, "1a: the third pop is not told as sure either: the log cannot say which is which", show(told));
  report.push("four pops of one clip in 5 s, two grades: the late low line no longer regrades the high pop made since");
}
// 1b. The repeat written before the next pop is told: it corrects the pop it is about, and the next repeat the next.
{
  const g = gameLog(BASE);
  g.pop(0, X, "fspopshuvit", "low", 1400, "the next pop");
  g.pop(1400, X, "fspopshuvit", "high", 1300);
  g.pop(3620, X, "fspopshuvit", "low", 1300);          // no line of its own; told high (the last own line) until the repeat
  g.pop(5100, X, "fspopshuvit", "high", 1300);         // 5.1 s after the first: its first log call writes "Repeated ... low"
  g.pop(14000, Y, "kickflip", "low", 1300);
  const told = replay("1b", g.text());
  check(told.length === 5, "1b: five pops are five choices", show(told));
  check(told[2] && told[2].grade === "low" && told[2].own, "1b: the third pop is corrected to low by its repeat, and sure", show(told));
  check(told[3] && told[3].grade === "high" && told[3].own, "1b: the fourth pop is confirmed high by its own repeat", show(told));
  report.push("a repeat written before the next pop still corrects the pop it is about (high to low), and the next one confirms the next");
}
// 1c. Two low pops of X 0.8 s apart; the second's lines are swallowed but for its clock line. Before: one choice. The
// first's "lets go at 0.80 s: the next pop" and then "follows ... at 0.13 s": the clip's own time went back.
for (const gap of [800, 1000]) {
  const g = gameLog(BASE);
  g.pop(0, X, "fspopshuvit", "low", gap, "the next pop");
  g.pop(gap, X, "fspopshuvit", "low", 1400);
  g.pop(12000, Y, "kickflip", "low", 1300);
  const told = replay("1c-" + gap, g.text());
  check(told.length === 3 && told[0].clip === X && told[1].clip === X, `1c: two pops of one clip ${gap} ms apart are two choices`, show(told));
}
report.push("two pops of one clip 0.8 s apart, the second without its own line: two choices (and 1.0 s apart, as before)");
// 1d. A clip that starts on the game's clip of the pop before. Before: three choices for the one pop, the last two
// "told from the clip's other lines", so the pop its own line had confirmed ended as not sure.
{
  const g = gameLog(BASE);
  g.pop(0, Y, "kickflip", "low", 1100, "the next pop");
  g.pop(1100, X, "fspopshuvit", "low", 1300, undefined, true);
  g.pop(9000, Y, "kickflip", "low", 1300);
  const told = replay("1d", g.text());
  check(told.length === 3, "1d: a clip that starts on the game's clip of the pop before is one choice", show(told));
  check(told[1] && told[1].clip === X && told[1].own, "1d: and it keeps its own choice line", show(told));
  report.push("a clip that starts on the game's clip of the pop before: one choice, sure (it was three, the last not sure)");
}

// ---- 2. beside a stand-in game: the pack of a jump already done ---------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const playlists = (on) => fs.writeFileSync(path.join(PRESETS, "playlists.json"), JSON.stringify({ on, playlists: [
  { name: "One", entries: [{ animation: Y, pack: "Pack A" }] }, { name: "Two", entries: [{ animation: Y, pack: "Pack B" }] }] }));
fs.writeFileSync(path.join(PRESETS, "Pack A.json"), JSON.stringify({ name: "Pack A", slots: { "kickflip|low": [Y] } }));
fs.writeFileSync(path.join(PRESETS, "Pack B.json"), JSON.stringify({ name: "Pack B", slots: { "kickflip|low": [Y] } }));
playlists("One");
const LOG = path.join(GAME, "logs", "ReSkate.log");
fs.writeFileSync(LOG, "");
const STUDIO = path.join(GAME, "Mods", ".reskate_plugin_data", PLUGIN, "studio.json");
const studio = () => { try { return JSON.parse(fs.readFileSync(STUDIO, "utf8")); } catch { return {}; } };
let degrees = 3.0;
function popNow() { // one kickflip, written into the log with the time it is now
  const at = stamp(Date.now());
  degrees += 0.1;
  fs.appendFileSync(LOG, [
    `[${at}] [1:2] Native(C): [Skater] [INFO] Animation Studio: ${Y} (made leading with the left foot) plays - left foot leading - as made (front foot).`,
    `[${at}] [1:2] Native(C): [Skater] [INFO] Animation Studio: the game does a kickflip (low pop by the game's grade, at the flick, before the pop, ${degrees.toFixed(1)}), playing your ${Y} as made for the low pop (authored edits over fresh native pose).`,
  ].join("\n") + "\n");
}
const child = spawn(process.execPath, [RELAY, "--game", GAME], { env: ENV, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
child.stdout.on("data", (d) => { out += d; });
child.stderr.on("data", (d) => { out += d; });
const until = async (what, ms, test) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (test()) return true; await sleep(100); }
  check(false, "2: " + what, JSON.stringify({ pack: studio().pack, sel: studio().sel, played: studio().played }) + "\n" + out.slice(-500));
  return false;
};
const packReads = () => (out.match(/^packs: /gm) ?? []).length;
try {
  if (await until("the relay starts", 15000, () => out.includes("Leave this running"))) {
    popNow();
    await until("a jump under playlist One is in Pack A", 5000, () => studio().played === Y && studio().pack === "Pack A");
    const sel = studio().sel;
    await sleep(3000);
    let reads = packReads();
    playlists("Two");
    if (await until("the relay reads the packs again after the playlist is switched", 12000, () => packReads() > reads)) {
      await sleep(800);
      check(studio().pack === "Pack A" && studio().sel === sel, "2: a playlist switched on after the jump leaves that jump in its pack (it was moved to Pack B)", JSON.stringify({ pack: studio().pack, sel: studio().sel, was: sel }));
      popNow();
      await until("the next jump is in the new playlist's pack, Pack B", 5000, () => studio().sel !== sel && studio().pack === "Pack B");
      // a jump made right after a switch, before the relay has read the packs again: its pack is put right at that reading
      await sleep(2500);
      reads = packReads();
      playlists("One");
      popNow();
      if (await until("the relay reads the packs again after the second switch", 12000, () => packReads() > reads)) {
        await until("a jump made just after a switch gets the new playlist's pack once the packs are read", 3000, () => studio().pack === "Pack A");
      }
      report.push("a playlist switched on after a jump: that jump keeps its pack; the next jump, and one made right after the switch, get the new one");
    }
  }
} finally {
  child.kill();
  await sleep(200);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* the relay may still hold a file for a moment */ }
}

if (failed) { console.error(`relay choices test: ${failed} failed`); process.exitCode = 1; }
else for (const r of report) console.log(r);

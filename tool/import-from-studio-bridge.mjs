#!/usr/bin/env node
// import-from-studio-bridge.mjs: the two files that still come from the StudioBridge project.
//
//   mod/plugin/main.lua   StudioBridge's mod/plugin/main.lua with the bridge, the pop height table, Pop Butler and the
//                         recorder taken out
//   tool/smoke.mjs        StudioBridge's tool/test/release-smoke.mjs without the checks that go through the bridge
//
//   node tool/import-from-studio-bridge.mjs [studio-bridge folder]     default: ../studio-bridge
//   node tool/import-from-studio-bridge.mjs --check                    write nothing: are the two files up to date?
//
// TEMPORARY. Until the overlay is taken out of StudioBridge, StudioBridge is where the overlay and its test are worked
// on and this script carries them over. From that day on the two files here are the source: delete this script then.
//
// Every cut names its place by a text that must be there exactly once. A text that is gone stops the import: fix the
// place here, never ship a half-cut file. StudioBridge's files are only read.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const SB = path.resolve(args.find((a) => !a.startsWith("--")) ?? path.join(ROOT, "..", "studio-bridge"));
const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const manifest = JSON.parse(read(path.join(ROOT, "mod", "manifest.json")));
const NAME = manifest.name;
const TITLE = NAME.replace(/_/g, " ");
const fonts = JSON.parse(read(path.join(ROOT, "mod", "text", "fonts.json")));
const DEFAULT_FONT = "montserrat_extrabold";

// The text being worked on, and the tools that change it.
let text = "", file = "";
const fail = (why) => { console.error(`import: ${file}: ${why}`); process.exit(1); };
function at(anchor, from = 0) {
  const i = text.indexOf(anchor, from);
  if (i < 0) fail(`text not found: ${anchor.split("\n")[0]}`);
  return i;
}
function once(anchor) {
  const i = at(anchor);
  if (text.indexOf(anchor, i + 1) >= 0) fail(`text found twice: ${anchor.split("\n")[0]}`);
  return i;
}
// Everything from `start` up to (not including) `end` becomes `withText`. `end` null: to the end of the file.
function cut(start, end, withText) {
  const i = once(start);
  const j = end === null ? text.length : at(end, i + start.length);
  text = text.slice(0, i) + withText + text.slice(j);
}
function swap(from, to) {
  const i = once(from);
  text = text.slice(0, i) + to + text.slice(i + from.length);
}
// A comment's wording: changed when it is there, left alone when StudioBridge reworded it.
function reword(from, to) {
  if (text.includes(from)) text = text.split(from).join(to);
}
// Whole lines that match: all of them go; at least `least` must be there.
function dropLines(re, least, what) {
  const lines = text.split("\n");
  const kept = lines.filter((l) => !re.test(l));
  if (lines.length - kept.length < least) fail(`${what}: ${lines.length - kept.length} lines found, at least ${least} expected`);
  text = kept.join("\n");
}
function nothingLeft(checks) {
  for (const [what, re] of checks) {
    const m = re.exec(text);
    if (m) fail(`still has ${what}: line ${text.slice(0, m.index).split("\n").length}: ${text.slice(m.index, m.index + 70).split("\n")[0]}`);
  }
}
function open(p) {
  if (!fs.existsSync(p)) { file = p; fail("no such file"); }
  file = path.relative(SB, p);
  text = read(p);
  return text.split("\n").length;
}

// ==== mod/plugin/main.lua ==========================================================================================
const luaLines = open(path.join(SB, "mod", "plugin", "main.lua"));

// ---- the head: the bridge's state out ---------------------------------------------------------------------------
cut("-- StudioBridge: a file-channel bridge", "local function now()",
  `-- ${TITLE}: a small block in a corner of the screen with the trick you just did, the Animator Studio animation
-- that played, its pack and the pop grade; an F2 page (PLUGINS > ${TITLE}) holds the settings and the last jumps.
-- What the Studio played comes from the ${TITLE} relay, a small Node.js program beside the game: it writes
-- studio.json into this plugin's data folder (Mods\\.reskate_plugin_data\\<id>\\), the only place a plugin reads.

local POLL_MS = 200

`);
swap(`reskate.log("[bridge] " .. s)`, `reskate.log(s)`);
cut("local function respond(id, ok, data, why)", "-- ---- the overlay's memory", "");

// ---- the overlay's memory: nothing of the bridge, the pop height table or Pop Butler in it ------------------------
reword("-- what the Studio said it played (relayed by the tool into studio.json), and the bridge's own state.",
  "-- and what the Studio said it played (the relay writes it into studio.json).");
dropLines(/^    replaced = \{\},/, 1, "hud.replaced");
dropLines(/^        air = \{.*\}, -- Pop Butler/, 1, "the settings.air default");
dropLines(/^        trick_pop = \{.*\},/, 1, "the settings.trick_pop default");
reword("for the bridge to read back", "kept in the history");

// ---- the pop height table, Pop Butler and the recorder out. What the overlay had from them, the trick the game has
// in mind on the last tick on the ground, gets a reader of its own.
cut("-- ---- a pop height of its own for listed tricks", "-- ---- events ---",
  `-- ---- the trick the game has in mind on the ground ---------------------------------------------
-- Read on every tick the skater is on the board and on the ground (one read is 0.1 ms). A launch whose own reading of
-- the flip value comes up empty takes this one, when it is no older than a quarter of a second (the launch handler).
local ground = {seen = nil, seen_at = nil}
reskate.on("tick", function()
    local ok, t = pcall(reskate.skater.telemetry)
    local state = ok and t and t.physics_state or 0
    if state < 100 or state >= 200 then return end
    local v = read_flip()
    local name = v and v <= FLIP_GROUND and FLIP_NAMES[v]
    ground.seen, ground.seen_at = name and string.lower(name) or nil, now()
end)

`);

// ---- events: the overlay's part of each handler ---------------------------------------------------------------
cut("    local held = pop.held\n", "    hud.launch = {from = e.from", "");
swap("    if not hud.launch.flick and pop.seen and pop.seen_at and now() - pop.seen_at < 250 then set_flick(hud.launch, pop.seen) end",
  "    if not hud.launch.flick and ground.seen and ground.seen_at and now() - ground.seen_at < 250 then set_flick(hud.launch, ground.seen) end");
cut("local function as_event(e)", "-- ---- ops ---", `reskate.on("bail", function() hud.bail = {at = now()} end)\n\n`);
dropLines(/^reskate\.on\("[a-z_]+", function\(e\) push_event\(.*\) end\)$/, 1, "handlers that only keep an event");
dropLines(/^\s+push_event\(.*\)$/, 2, "push_event lines");

// ---- the ops, the pad script and the command loop out; the relay's file is still read -----------------------------
cut("-- ---- ops ----", "-- studio.json is the tool's relay of", "-- ---- the relay's file -------------------------------------------------------------------------\n");
swap("-- studio.json is the tool's relay of the Studio's log lines (tool/src/relay.mjs): what played, the pop grade, when",
  "-- studio.json is the relay's account of the Studio's log lines (relay/pop-doctor-relay.mjs): what played, the pop grade, when");
cut("local function poll()", "-- ---- the overlay ------", "reskate.time.every(POLL_MS, read_studio)\n\n");

// ---- the F2 page: four tabs, MODULES / SETTINGS / HISTORY / MISC (the LIVE tab went on 2026-11-24: the newest jump of HISTORY says the same; MISC and MODULES came on 2026-11-25) ------------------------------------------------------------------------------------
swap("HISTORY (last 10 jumps), BRIDGE (tool state).", "HISTORY (last 10 jumps).");
swap(`local TABS = {"MODULES", "SETTINGS", "POP BUTLER", "HISTORY", "MISC", "BRIDGE"}`, `local TABS = {"MODULES", "SETTINGS", "HISTORY", "MISC"}`);
cut("local function bridge_tab(ui)", `reskate.menu.page("StudioBridge"`, "");
swap(`    if tab == 1 then modules_tab(ui)
    elseif tab == 2 then settings_tab(ui)
    elseif tab == 3 then air_tab(ui)
    elseif tab == 4 then history_tab(ui)
    elseif tab == 5 then misc_tab(ui)
    else bridge_tab(ui) end`,
  `    if tab == 1 then modules_tab(ui)
    elseif tab == 2 then settings_tab(ui)
    elseif tab == 3 then history_tab(ui)
    else misc_tab(ui) end`);
cut("-- ---- console: bridge <op>", null, `log("loaded")\n`);

// ---- what a player reads ----------------------------------------------------------------------------------------
swap(`clip = "no relay"`, `clip = "relay not running"`);
swap(`ui:warn("No text pictures in the package: run  powershell -File tool/src/render-text.ps1")`,
  `ui:warn("The plugin's font pictures are missing: install the plugin again.")`);
swap(`ui:warn("No relay: run  node tool/src/relay.mjs  and leave it open.")`,
  `ui:warn("The relay is not running. Start the ${TITLE} relay and leave it open: see the README.")`);
text = text.split("tool/src/render-text.ps1").join("tool/render-text.ps1");
text = text.split("StudioBridge").join(TITLE);

// ---- the default font: one of the fonts that ship -------------------------------------------------------------
{
  const n = fonts.findIndex((f) => f.folder === DEFAULT_FONT) + 1;
  if (n < 1) fail(`mod/text/fonts.json has no ${DEFAULT_FONT}`);
  const m = /image_font = \d+,[^\n]*/.exec(text);
  if (!m) fail("no image_font default");
  text = text.replace(m[0], `image_font = ${n},        -- ${fonts[n - 1].name}`);
}

nothingLeft([
  ["the ops table", /\bops\b/], ["run()", /\brun\(/], ["respond()", /\brespond\(/], ["the recorder of clips", /\brecording\b|finish_recording/],
  ["the pad script", /\bdrive_script\b|\bfail_script\b|\bwrite_pad\b|\bscript\b/], ["the bridge's files", /cmd\.json|result\.json|status\.json|events\.json/],
  ["reskate.input", /reskate\.input/], ["reskate.console", /reskate\.console/],
  ["bridge state", /last_cmd_id|events_dirty|EVENTS_MAX|HEARTBEAT_MS|heartbeat|bridge_tab|push_event|hud\.replaced|local ticks|ticks \+= 1|tostring\(ticks\)/],
  ["clip control", /reskate\.animation\.(play|stop|seek|pause|replace|record|recorded|forget|edit|save|sample|joints|game_clips|info|time)\b/],
  ["the pop height table", /\bpop\.[a-z_]|pop_note|pop_release|pop_set|pop_tick|current_flip|POP_ID|POP_HOLD_MS|JumpMinHeight|trick_pop/],
  ["Pop Butler", /\bair_(cfg|target|height|launch|commit|tick|tab|note|ground|base)\b|settings\.air\b|\bair\.(flight|last|log|base)|AIR_SKIP|STRENGTH_VALUE|CAN_LAND_VALUE|PLAN_VALUE|Pop Butler|POP BUTLER/],
  ["the recorder of animation values", /\brec_(round|tick)\b|\brec\.|REC_PREFIX|REC_TAIL|anim_rec/],
  ["a change to the skater's physics", /reskate\.physics\.(tune|competition|prepare)/],
  ["the bridge's name", /\[bridge\]|StudioBridge|studio-bridge/],
]);
const lua = text;

// ==== tool/smoke.mjs ===============================================================================================
const smokeLines = open(path.join(SB, "tool", "test", "release-smoke.mjs"));

cut("// release-smoke.mjs [plugin folder]:", `import fs from "node:fs";`,
  `// smoke.mjs [plugin folder]: load plugin/main.lua in a Luau VM against a stand-in for the game's plugin API and walk
// it through what a session does: load, a pop with no relay, pops with the relay, the overlay drawn in every layout /
// grade style / face, every F2 tab. It catches what a compile cannot: a call to something that is not there, an API
// the manifest asks no permission for, a page over its widget or text limits, a draw error.
//
//   node tool/smoke.mjs                      mod/, the plugin as it is worked on
//   node tool/smoke.mjs dist/${NAME}      the built package (build.mjs runs this)
//
// It is a stand-in, not the game: it says nothing about how the overlay looks or how a landing went.

`);
swap(`import path from "node:path";\n`, `import path from "node:path";\nimport { fileURLToPath } from "node:url";\n`);
swap(`const pkg = path.resolve(process.argv[2] ?? "mod");`,
  `const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");\nconst pkg = path.resolve(process.argv[2] ?? path.join(ROOT, "mod"));`);

// changing the physics needs skater.control: the stand-in raises without it, as the game does
swap(`reskate.physics = area("skater.read", {find = function() return {} end})\n`,
  `reskate.physics = area("skater.read", {find = function() return {} end})
-- reading the physics is skater.read; changing it is skater.control, and raises without it as the game does
for _, name in ipairs({"tune", "competition", "prepare"}) do
    reskate.physics[name] = function()
        if not PERMS["skater.control"] then error("needs the skater.control permission (physics." .. name .. ")") end
    end
end
`);

// the page stand-in keeps what a tab shows, so the HISTORY tab can be read back without the bridge
swap(`local function make_ui(tab)
    local ui = {n = 0, tabs_n = 0}
`,
  `local OPEN_ALL = false -- every section of a page comes back open: the HISTORY tab then shows each jump's rows
local function make_ui(tab)
    local ui = {n = 0, tabs_n = 0, titles = {}, rows = {}} -- titles: each section's title; rows: each info row, "label: value"
`);
swap(`    function ui:info(label, value) w(); within(label, 60, "info label"); within(value, 200, "info value") end
    function ui:section(id, title, sub, open) w(); within(title, 60, "section title"); within(sub, 120, "section subtitle"); return open end
`,
  `    function ui:info(label, value)
        w(); within(label, 60, "info label"); within(value, 200, "info value")
        ui.rows[#ui.rows + 1] = tostring(label) .. ": " .. tostring(value)
    end
    function ui:section(id, title, sub, open)
        w(); within(title, 60, "section title"); within(sub, 120, "section subtitle")
        ui.titles[#ui.titles + 1] = tostring(title)
        return OPEN_ALL or open
    end
`);
swap(`    return most, tabs
end

local report = {}
`,
  `    return most, tabs
end
-- The HISTORY tab (tab 3) with every jump open, newest first: each jump's title, and its rows of one label.
local function history(label)
    OPEN_ALL = true
    local ui = make_ui(3)
    pages[1].build(ui)
    OPEN_ALL = false
    assert(ui.n <= 160, "the HISTORY tab with every jump open has " .. ui.n .. " widgets; a page holds 160")
    local rows = {}
    for _, r in ipairs(ui.rows) do
        local v = r:match("^" .. label .. ": (.*)$")
        if v then rows[#rows + 1] = v end
    end
    return ui.titles, rows
end

local report = {}
`);

// The checks that read the history through the bridge. The first one (which pop a late choice lands on) is made on
// the HISTORY tab instead; the others go: they read fields no page shows.
cut(`if PERMS["console"] then\n    files["cmd.json"] = encode({id = "smoke-overlay"`, "\nend\n",
  `do
    local _, clips = history("Clip")
    local _, grades = history("Pop")
    assert(clips[1] == "Heelflip low 2", "the history lacks the late choice: " .. tostring(clips[1]))
    assert(clips[2] == "360 Flip low 11" and clips[3]:find("Stock", 1, true) and grades[3]:find("mid (by up-speed)", 1, true),
        "the history of the two pops before it is wrong: " .. tostring(clips[2]) .. " / " .. tostring(clips[3]) .. " / " .. tostring(grades[3]))`);
for (let n = 0; ; n++) {
  const i = text.indexOf(`\nif PERMS["console"] then\n`);
  if (i < 0) break;
  if (n > 10) fail("the bridge-only checks do not end");
  text = text.slice(0, i) + text.slice(at("\nend\n", i) + "\nend".length);
}
reword("-- 5. what it wrote: its settings and nothing of the bridge, unless it is the dev plugin", "-- 5. what it wrote: its settings and nothing else");
swap(`if not PERMS["console"] then
    for _, name in ipairs(wrote) do assert(name == "settings.json", "the release wrote " .. name) end
end
`, `for _, name in ipairs(wrote) do assert(name == "settings.json", "the plugin wrote " .. name) end
`);
nothingLeft([["a check through the bridge", /PERMS\["console"\]|cmd\.json|result\.json/], ["the old name", /release-smoke|Trick_Pop|build-release/]]);
const smoke = text;

// ==== write, or compare ============================================================================================
const outs = [[path.join(ROOT, "mod", "plugin", "main.lua"), lua, luaLines], [path.join(ROOT, "tool", "smoke.mjs"), smoke, smokeLines]];
if (CHECK) {
  let stale = 0;
  for (const [p, body] of outs) {
    const same = fs.existsSync(p) && read(p) === body;
    if (!same) stale += 1;
    console.log(`${path.relative(ROOT, p)}: ${same ? "up to date with StudioBridge" : "DIFFERS from what StudioBridge gives now: run the import"}`);
  }
  process.exit(stale ? 1 : 0);
}
for (const [p, body, from] of outs) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  console.log(`import: ${path.relative(ROOT, p)} written, ${body.split("\n").length} lines (StudioBridge: ${from})`);
}

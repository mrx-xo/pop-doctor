#!/usr/bin/env node
// smoke.mjs [plugin folder]: load plugin/main.lua in a Luau VM against a stand-in for the game's plugin API and walk
// it through what a session does: load, a pop with no relay, pops with the relay, the overlay drawn in every layout /
// grade style / face, every F2 tab. It catches what a compile cannot: a call to something that is not there, an API
// the manifest asks no permission for, a page over its widget or text limits, a draw error.
//
//   node tool/smoke.mjs                      mod/, the plugin as it is worked on
//   node tool/smoke.mjs dist/Pop_Grader      the built package (build.mjs runs this)
//
// It is a stand-in, not the game: it says nothing about how the overlay looks or how a landing went.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LuauState } from "luau-web";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = path.resolve(process.argv[2] ?? path.join(ROOT, "mod"));
const source = fs.readFileSync(path.join(pkg, "plugin", "main.lua"), "utf8").replace(/\r\n/g, "\n");
const manifest = JSON.parse(fs.readFileSync(path.join(pkg, "reskate-plugin.json"), "utf8"));

function toLua(v) {
  if (v === null || v === undefined) return "nil";
  if (typeof v === "string") return JSON.stringify(v).replace(/\\u([0-9a-fA-F]{4})/g, "\\u{$1}");
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return "{" + v.map(toLua).join(", ") + "}";
  return "{" + Object.entries(v).map(([k, x]) => `[${JSON.stringify(k)}] = ${toLua(x)}`).join(", ") + "}";
}

// the package files the plugin reads with reskate.package.read_json: the real ones
const packageFiles = {};
const fontsFile = path.join(pkg, "text", "fonts.json");
if (fs.existsSync(fontsFile)) {
  const fonts = JSON.parse(fs.readFileSync(fontsFile, "utf8"));
  packageFiles["text/fonts.json"] = fonts;
  for (const f of fonts) packageFiles[`text/${f.folder}/manifest.json`] = JSON.parse(fs.readFileSync(path.join(pkg, "text", f.folder, "manifest.json"), "utf8"));
}

const prelude = `
local PERMS = {}
for _, p in ipairs(${toLua(manifest.permissions)}) do PERMS[p] = true end
local PACKAGE = ${toLua(packageFiles)}
local handlers, timers, pages, files, LOGS, clock = {}, {}, {}, {}, {}, 1000
local TELEMETRY, AIR_TRICK = nil, nil
local FLIP = nil -- the game's flip value (EnumGS.Anim.CurrentFlipTrick): a number, nil while it is None
local BACKWARDS = false -- Bool.Anim.BoardBackwards: the board end for end under the rider
local UPRIGHT = true -- Bool.Physics.IsBoardUpright: the board on its wheels
local DRAWN = {texts = {}, images = 0, rects = 0}
local IMAGES = {}

local function deep(t)
    if type(t) ~= "table" then return t end
    local out = {}
    for k, v in pairs(t) do out[k] = deep(v) end
    return out
end
-- "JSON": a text that names a table. encode is stable (sorted keys), decode gives back a copy of what was encoded.
local registry = {}
local function serial(v)
    if type(v) == "table" then
        local keys = {}
        for k in pairs(v) do keys[#keys + 1] = tostring(k) end
        table.sort(keys)
        local parts = {}
        for _, k in ipairs(keys) do
            local x = v[k]
            if x == nil then x = v[tonumber(k)] end
            parts[#parts + 1] = k .. "=" .. serial(x)
        end
        return "{" .. table.concat(parts, ",") .. "}"
    end
    return tostring(v)
end
local function encode(t)
    local text = serial(t)
    registry[text] = deep(t)
    return text
end
local function decode(text)
    local t = registry[text]
    if t == nil then error("not JSON: " .. tostring(text)) end
    return deep(t)
end

-- An area of the API: with its permission, the functions given (anything else is a quiet no-op); without it,
-- every call raises, as the game does.
local function area(perm, impl)
    if perm == nil or PERMS[perm] then
        return setmetatable(impl, {__index = function() return function() return nil end end})
    end
    return setmetatable({}, {__index = function(_, name)
        return function() error("needs the " .. perm .. " permission (" .. tostring(name) .. ")") end
    end})
end
local EVENT_PERMISSION = {trick_started = "events.tricks", trick_landed = "events.tricks", launch = "events.skater",
    board_landed = "events.skater", bail = "events.skater", draw = "overlay", trick_notes = "events.tricks"}

local reskate = {
    id = "smoke", api_version = 1,
    log = function(s) LOGS[#LOGS + 1] = tostring(s) end,
    on = function(name, f)
        local need = EVENT_PERMISSION[name]
        if need and not PERMS[need] then error("the " .. name .. " event needs the " .. need .. " permission") end
        handlers[name] = handlers[name] or {}
        table.insert(handlers[name], f)
    end,
    time = {now = function() return clock end, every = function(ms, f) timers[#timers + 1] = f end},
    json = {encode = encode, decode = decode},
    package = {read_json = function(p)
        local v = PACKAGE[p]
        if v == nil then error("no such file in the package: " .. tostring(p)) end
        return deep(v)
    end},
    level = {current = function() return {name = "smoke"} end},
}
reskate.files = area("files", {
    read = function(p) return files[p] end,
    write = function(p, text) files[p] = text; return true end,
})
reskate.skater = area("skater.read", {telemetry = function() return TELEMETRY end, frame = function() return {} end,
    animation_values = function()
        local t = {["Animation/Dingo/Bool.Anim.BoardBackwards"] = {value = BACKWARDS, output = false},
            ["Animation/Dingo/Bool.Physics.IsBoardUpright"] = {value = UPRIGHT, output = true}}
        if FLIP then t["Animation/Dingo/EnumGS.Anim.CurrentFlipTrick"] = {value = FLIP, output = false} end
        return t
    end})
reskate.physics = area("skater.read", {find = function() return {} end})
-- reading the physics is skater.read; changing it is skater.control, and raises without it as the game does
for _, name in ipairs({"tune", "competition", "prepare"}) do
    reskate.physics[name] = function()
        if not PERMS["skater.control"] then error("needs the skater.control permission (physics." .. name .. ")") end
    end
end
reskate.animation = area("skater.animation", {trick = function() return AIR_TRICK end, playing = function() return false end})
reskate.menu = area("menu", {page = function(name, f) pages[#pages + 1] = {name = name, build = f} end})
reskate.console = area("console", {command = function() end, print = function() end})
reskate.input = area("input", {})
reskate.tricks = area("events.tricks", {feed = function() end})
reskate.score = area("events.tricks", {current = function() return {in_trick = false, trick = "", detail = "Kickflip", manual = false, line = 0} end})

local D = {}
function D:size() return vector.create(2560, 1440, 0) end
function D:measure(text) return vector.create(#tostring(text) * 9, 20, 0) end
function D:text(pos, text) assert(type(text) == "string", "d:text wants a string"); DRAWN.texts[#DRAWN.texts + 1] = text end
function D:rect() DRAWN.rects += 1 end
function D:circle() DRAWN.rects += 1 end
function D:image(file) assert(type(file) == "string", "d:image wants a file"); DRAWN.images += 1; IMAGES[file] = true end

-- The page's widgets, with the limits the notes record: 160 widgets a page, an info label 60 and value 200
-- characters, a section's title 60 and subtitle 120.
local OPEN_ALL = false -- every section of a page comes back open: the HISTORY tab then shows each jump's rows
local function make_ui(tab)
    local ui = {n = 0, tabs_n = 0, titles = {}, rows = {}} -- titles: each section's title; rows: each info row, "label: value"
    local function w() ui.n += 1 end
    local function within(text, most, what) assert(#tostring(text) <= most, what .. " over " .. most .. ": " .. tostring(text)) end
    function ui:tabs(id, names, cur) w(); ui.tabs_n = #names; return tab end
    function ui:card() w() end
    function ui:toggle(id, label, value) w(); assert(type(value) == "boolean", "toggle " .. id .. " is not a boolean"); return value end
    function ui:buttons(id, names, cur) w(); assert(type(names) == "table" and #names > 0, "buttons " .. id); return cur end
    function ui:label() w() end
    function ui:note() w() end
    function ui:warn(text) w(); assert(type(text) == "string") end
    function ui:slider(id, label, value) w(); assert(type(value) == "number", "slider " .. id .. " is not a number"); return value end
    function ui:colour(id, label, value) w(); within(label, 60, "colour label"); assert(type(value) == "table" and value.r, "colour " .. id); return value end
    function ui:button() w(); return false end
    function ui:info(label, value)
        w(); within(label, 60, "info label"); within(value, 200, "info value")
        ui.rows[#ui.rows + 1] = tostring(label) .. ": " .. tostring(value)
    end
    function ui:section(id, title, sub, open)
        w(); within(title, 60, "section title"); within(sub, 120, "section subtitle")
        ui.titles[#ui.titles + 1] = tostring(title)
        return OPEN_ALL or open
    end
    function ui:bar() w() end
    function ui:heading() w() end
    return ui
end

local function fire(name, e) for _, f in ipairs(handlers[name] or {}) do f(e) end end
local function run_timers() for _, f in ipairs(timers) do f() end end
local function reset()
    handlers, timers, pages, files, LOGS, clock = {}, {}, {}, {}, {}, 1000
    TELEMETRY, AIR_TRICK, FLIP, BACKWARDS, UPRIGHT = {airborne = false, last = {serial = 0}}, nil, nil, false, true
end
local function draw()
    DRAWN = {texts = {}, images = 0, rects = 0}
    fire("draw", D)
    for _, line in ipairs(LOGS) do assert(not line:find("failed", 1, true), line) end
end
local function drew(text)
    for _, t in ipairs(DRAWN.texts) do if t:find(text, 1, true) then return true end end
    return false
end
`;

const scenario = `
local serial_n = 0
-- One pop, as the game reports it: the flick, the air (the game names the trick), the Studio's line through the
-- relay, the landing.
local function pop(trick, studio)
    serial_n += 1
    TELEMETRY = {airborne = false, last = {serial = serial_n - 1, air_time = 0.5, height = 0.6, takeoff_speed = 4}}
    run_timers()
    fire("launch", {from = "ground", velocity = vector.create(0, 3, 0), travel_speed = 5, game = {}, shaped = false})
    TELEMETRY.airborne, AIR_TRICK = true, trick
    clock += 100; run_timers()
    if studio then files["studio.json"] = encode(studio) end
    clock += 300; run_timers()
    fire("board_landed", {down_speed = 3.2, speed = 5.1, onto = "ground"})
    TELEMETRY = {airborne = false, last = {serial = serial_n, air_time = 0.52, height = 0.61, takeoff_speed = 4.2,
        takeoff_angle = 40, distance = 2.6, drop = 0.1, landing_speed = 5.2, spin = 0, spin_rate = 0, flip = 360, board_turn = 700}}
    AIR_TRICK = nil
    clock += 100; run_timers()
end
local function studio_line(trick, clip, pack, grade)
    return {played = clip, trick = trick, grade = grade, pack = pack, stance = "left foot leading, as made (made left foot)",
        lets_go = "at 0.61 s: its catch", line_at = "2026-11-13 22:05:37.000",
        names = {kickflip = "Kickflip", nollie_fs360popshuvit = "Nollie FS 360 Pop Shuv-it"},
        packs = {"SESSIONING PACK", "smonkpack", "A pack with a very long name that goes on and on and on past sixty characters"},
        trainer = {gravity = 1.48, gravity_landing = 1.5, gravity_landing_own = true, gravity_animation_timing = 1, flip_speed = 1, active = {"nauti"}}}
end
local function all_pages()
    assert(#pages == 1, "expected one F2 page, got " .. #pages)
    local most, tabs = 0, 1
    local t = 1
    while t <= tabs do
        local ui = make_ui(t)
        pages[1].build(ui)
        tabs = math.max(tabs, ui.tabs_n)
        most = math.max(most, ui.n)
        assert(ui.n <= 160, "tab " .. t .. " has " .. ui.n .. " widgets; a page holds 160")
        t += 1
    end
    return most, tabs
end
-- The HISTORY tab (the last tab) with every jump open, newest first: each jump's title, and its rows of one label.
local function history(label)
    OPEN_ALL = true
    local ui = make_ui(1)
    pages[1].build(ui)       -- the first tab says how many tabs there are
    ui = make_ui(ui.tabs_n)
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
-- 1. a fresh install: no settings file, no relay
reset()
PLUGIN()
assert(handlers.draw and #handlers.draw == 1, "no draw handler")
draw()
report[#report + 1] = "loads with no settings and no relay; F2 page: " .. pages[1].name
pop("kickflip", nil)
draw()
local no_relay = table.concat(DRAWN.texts, " | ")
local most, tabs = all_pages()
report[#report + 1] = "a pop with no relay draws: " .. no_relay

-- 2. the relay running: the clip and its pack are on screen, the jump is in the history
pop("kickflip", studio_line("kickflip", "Kickflip low 4", "SESSIONING PACK", "low"))
draw()
assert(drew("Kickflip low 4"), "the clip is not drawn: " .. table.concat(DRAWN.texts, " | "))
assert(drew("SESSIONING PACK"), "the pack is not drawn: " .. table.concat(DRAWN.texts, " | "))
report[#report + 1] = "a pop with the relay draws: " .. table.concat(DRAWN.texts, " | ") .. "  (+ " .. DRAWN.images .. " glyph pictures)"
most = math.max(most, (all_pages()))

-- 3. every layout x grade style x face, the corners and pack styles in turn, each grade, a long name, ten jumps
local grades = {"low", "mid", "high", "grind"}
local runs = 0
for layout = 1, 3 do
    for grade_style = 1, 6 do
        for face = 1, 4 do
            runs += 1
            reset()
            files["settings.json"] = encode({on = true, layout = layout, grade_style = grade_style, title_face = face,
                corner = runs % 4 + 1, pack_style = runs % 4 + 1, packs_all = runs % 2 == 0, image_font = runs % 3 + 1,
                scale = 0.5 + (runs % 4) * 0.5, show_grinds = runs % 3 ~= 0, backing = runs % 2 == 0, fade_s = 0})
            PLUGIN()
            local grade = grades[runs % 4 + 1]
            for i = 1, 11 do
                local long = i % 2 == 0
                pop(long and "nollie_fs360popshuvit" or "kickflip",
                    studio_line(long and "nollie_fs360popshuvit" or "kickflip",
                        long and "Nollie FS 360 Pop Shuv-it high 3 with a clip name that is far longer than sixty characters" or "Kickflip low 4",
                        long and "A pack with a very long name that goes on and on and on past sixty characters" or "", grade))
                draw()
            end
            most = math.max(most, (all_pages()))
        end
    end
end
report[#report + 1] = runs .. " setting combinations x 11 pops: no draw error, every tab within its limits"
local pictures = 0
for _ in pairs(IMAGES) do pictures += 1 end
assert(pictures <= 32, "the plugin drew " .. pictures .. " different pictures; its life allows 32")
report[#report + 1] = tabs .. " tabs, at most " .. most .. " widgets (160 allowed), " .. pictures .. " different pictures (32 allowed)"

-- 4. which pop a choice of the Studio is about (the relay numbers each choice: sel), "Stock" as a finding, and the
-- pop grade from the launch's up-speed. Text faces, so the lines are d:text and can be read back.
reset()
files["settings.json"] = encode({on = true, layout = 1, grade_style = 4, title_face = 1, pack_style = 4, fade_s = 0})
PLUGIN()
local sel_n = 100
local function choice(trick, clip, grade, more)
    sel_n += 1
    local t = studio_line(trick, clip, "", grade)
    t.sel, t.graded_by = sel_n, "game"
    for k, v in pairs(more or {}) do t[k] = v end
    return t
end
local function lines() return table.concat(DRAWN.texts, " | ") end
-- o: trick, up, from; flick / air / late = what the relay writes at the flick (0.2 s before the launch), in the
-- air, 0.1 s after the landing; at_flick() runs between the flick and the launch.
local function pop2(o)
    serial_n += 1
    TELEMETRY = {airborne = false, last = {serial = serial_n - 1, air_time = 0.5, height = 0.6, takeoff_speed = 4}}
    run_timers()
    if o.flick then files["studio.json"] = encode(o.flick) end
    clock += 200; run_timers()
    if o.at_flick then o.at_flick() end
    fire("launch", {from = o.from or "ollie", velocity = vector.create(0, o.up or 3, 0), travel_speed = 5, game = {}, shaped = false})
    TELEMETRY.airborne, AIR_TRICK = true, o.trick
    clock += 100; run_timers()
    if o.air then files["studio.json"] = encode(o.air) end
    clock += 300; run_timers()
    fire("board_landed", {down_speed = 3.2, speed = 5.1, onto = "ground"})
    TELEMETRY = {airborne = false, last = {serial = serial_n, air_time = 0.42, height = 0.61, takeoff_speed = 4.2}}
    AIR_TRICK = nil
    clock += 100; run_timers()
    if o.late then files["studio.json"] = encode(o.late) end
    clock += 100; run_timers()
    clock += 500; run_timers()
    draw()
end
-- a choice that was in studio.json before the plugin loaded is about no pop of ours
files["studio.json"] = encode(choice("hardflip", "An old clip", "high"))
run_timers()
pop2({trick = "hardflip", up = 3.3})
assert(drew("Stock") and drew("MEDIUM") and not drew("An old clip"), "a stock pop after an old choice draws: " .. lines())
-- the Studio's choice at the flick
pop2({trick = "kickflip", up = 2.9, flick = choice("kickflip", "Kickflip low 4", "low")})
assert(drew("Kickflip low 4") and drew("LOW") and not drew("Stock"), "a pop the Studio played draws: " .. lines())
-- the same trick again: its own line swallowed by the log, the relay tells the choice from the clip's other lines
pop2({trick = "kickflip", up = 2.9, flick = choice("kickflip", "Kickflip low 4", "low", {inferred = true})})
assert(drew("Kickflip low 4") and not drew("Stock"), "the same trick again draws: " .. lines())
-- the same trick, the Studio silent: a later line of the old choice (same sel) does not make it this pop's
local same = choice("kickflip", "Kickflip low 4", "low", {lets_go = "at 0.80 s: its end"})
sel_n -= 1; same.sel = sel_n
pop2({trick = "kickflip", up = 3.3, air = same})
assert(drew("Stock") and drew("MEDIUM") and not drew("Kickflip low 4"), "a silent pop of the same trick draws: " .. lines())
-- the next pop's choice arrives at its flick: the lines stay on the last pop until the launch
pop2({trick = "360flip", up = 2.9, flick = choice("360flip", "360 Flip low 11", "low"), at_flick = function()
    draw()
    assert(drew("Stock") and not drew("360 Flip low 11"), "between the flick and the launch: " .. lines())
end})
assert(drew("360 Flip low 11") and not drew("Stock"), "after the launch: " .. lines())
-- a choice that arrives just after the landing still belongs to the jump, on screen and in the history
pop2({trick = "heelflip", up = 2.9, late = choice("heelflip", "Heelflip low 2", "low")})
assert(drew("Heelflip low 2") and not drew("Stock"), "a late choice draws: " .. lines())
do
    local _, clips = history("Clip")
    local _, grades = history("Pop")
    assert(clips[1] == "Heelflip low 2", "the history lacks the late choice: " .. tostring(clips[1]))
    assert(clips[2] == "360 Flip low 11" and clips[3]:find("Stock", 1, true) and grades[3]:find("mid (by up-speed)", 1, true),
        "the history of the two pops before it is wrong: " .. tostring(clips[2]) .. " / " .. tostring(clips[3]) .. " / " .. tostring(grades[3]))
end
-- pops the game graded teach the cutoffs: 8 each at 2.0 / 2.6 / 3.0 m/s, then a stock pop at 2.9 is high (3.135 said low)
for i = 1, 8 do
    pop2({trick = "kickflip", up = 2.0, flick = choice("kickflip", "Kickflip low 4", "low")})
    pop2({trick = "kickflip", up = 2.6, flick = choice("kickflip", "Kickflip mid 9", "mid")})
    pop2({trick = "kickflip", up = 3.0, flick = choice("kickflip", "Kickflip high 2", "high")})
end
pop2({trick = "hardflip", up = 2.9})
assert(drew("Stock") and drew("HIGH"), "a stock pop after 24 graded pops draws: " .. lines())
pop2({trick = "hardflip", up = 2.9, from = "grind"})
assert(drew("Stock") and not drew("HIGH") and not drew("LOW") and not drew("MEDIUM"), "a stock pop out of a grind draws: " .. lines())
most = math.max(most, (all_pages()))
report[#report + 1] = "choices by sel: old, swallowed, silent, at the flick and late ones land on the right pop; stock pops graded by up-speed, cutoffs learned"

-- 4b. the game's own flip value (EnumGS.Anim.CurrentFlipTrick) names the pop where the game's name in the air is
-- another trick, and with the board's turn it tells a hospital flip. As measured on 2026-11-23: through an impossible
-- the value is Impossible (36) and the name in the air "popshuvit" (front foot: 37 and "fspopshuvit"), which is the
-- name the Studio goes by; through a hospital flip the value stays Kickflip (2), the name in the air "kickflip", and
-- Bool.Anim.BoardBackwards changes once, late in the air, from whatever it was at the launch.
-- o: flip (the value at the launch), air_flip (the value from a moment of the air on), turns (the board ends end for
-- end; twice = and back again), trick (the game's name in the air), flick / air (what the relay writes at the flick
-- and in the air).
local NAMES = {kickflip = "Kickflip", popshuvit = "Pop Shuv-it", fspopshuvit = "FS Pop Shuv-it", bsimpossible = "BF Impossible",
    fsimpossible = "FF Impossible"}
local function title(text) -- the trick line alone is this text
    for _, t in ipairs(DRAWN.texts) do if t == text then return true end end
    return false
end
local function pop3(o)
    serial_n += 1
    TELEMETRY = {airborne = false, last = {serial = serial_n - 1, air_time = 0.5, height = 0.6, takeoff_speed = 4}}
    FLIP = nil
    run_timers()
    if o.flick then files["studio.json"] = encode(o.flick) end
    clock += 200; run_timers()
    FLIP = o.flip
    local launched = clock
    fire("launch", {from = "ollie", velocity = vector.create(0, o.up or 2.9, 0), travel_speed = 5, game = {}, shaped = false})
    fire("tick", 16)
    if o.at_launch then draw(); o.at_launch() end
    TELEMETRY.airborne, AIR_TRICK = true, o.trick
    clock += 100; fire("tick", 16); run_timers()
    -- the board off its wheels and back onto them, over[i] ms after the launch (a plain flip: once, at 340)
    for _, at in ipairs(o.over or {}) do
        UPRIGHT = false; fire("tick", 16)
        clock = math.max(clock, launched + at); UPRIGHT = true; fire("tick", 16)
    end
    if o.air then files["studio.json"] = encode(o.air) end
    if o.air_flip then FLIP = o.air_flip end
    clock += 100; fire("tick", 16)
    if o.turns then BACKWARDS = not BACKWARDS end
    clock += 100; fire("tick", 16)
    if o.turns == "twice" then BACKWARDS = not BACKWARDS end
    clock += 100; fire("tick", 16); run_timers()
    fire("board_landed", {down_speed = 3.2, speed = 5.1, onto = "ground"})
    FLIP = nil
    TELEMETRY = {airborne = false, last = {serial = serial_n, air_time = (clock - launched) / 1000, height = 0.61, takeoff_speed = 4.2}}
    AIR_TRICK = nil
    clock += 100; fire("tick", 16); run_timers()
    clock += 600; run_timers()
    draw()
end
-- an impossible the Studio played a Pop Shuv-it for: the clip and the grade are that pop's, the name is the game's
pop3({flip = 36, trick = "popshuvit", flick = choice("popshuvit", "Pop Shuv-it low 15", "low", {names = NAMES}), at_launch = function()
    assert(title("BF Impossible") and not title("Pop Shuv-it"), "an impossible at its launch, before the air names it: " .. lines())
end})
assert(title("BF Impossible") and not title("Pop Shuv-it") and drew("Pop Shuv-it low 15") and drew("LOW") and not drew("Stock"),
    "an impossible the Studio played a pop shuv-it for draws: " .. lines())
-- the same with nothing of the player's for it ("popshuvit uses native animation"): the live case of 17:53
pop3({flip = 36, trick = "popshuvit", flick = choice("popshuvit", nil, "mid", {names = NAMES, native = true})})
assert(title("BF Impossible") and not title("Pop Shuv-it") and drew("Stock") and drew("MEDIUM"), "an impossible the Studio left to the game draws: " .. lines())
-- and with the Studio silent
pop3({flip = 36, trick = "popshuvit"})
assert(title("BF Impossible") and not title("Pop Shuv-it") and drew("Stock"), "a stock impossible draws: " .. lines())
-- a front foot impossible: "fspopshuvit" in the air
pop3({flip = 37, trick = "fspopshuvit", flick = choice("fspopshuvit", "FS Pop Shuv-it low 8", "low", {names = NAMES})})
assert(title("FF Impossible") and not title("FS Pop Shuv-it") and drew("FS Pop Shuv-it low 8"), "a front foot impossible draws: " .. lines())
-- a pop shuv-it is still a pop shuv-it
pop3({flip = 4, trick = "popshuvit", flick = choice("popshuvit", "Pop Shuv-it low 15", "low", {names = NAMES})})
assert(title("Pop Shuv-it") and drew("Pop Shuv-it low 15"), "a pop shuv-it draws: " .. lines())
-- a trick the game changes in the air and keeps changed (a late flip): the name it had before this rule, the Studio's
pop3({flip = 7, air_flip = 2, trick = "kickflip", flick = choice("fspopshuvit", "FS Pop Shuv-it low 8", "low", {names = NAMES}),
    air = choice("kickflip", "Kickflip mid 24", "mid", {names = NAMES})})
assert(title("Kickflip") and drew("Kickflip mid 24"), "a pop shuv-it the game turned into a kickflip draws: " .. lines())
-- a hospital flip: a kickflip to the Studio, to the game's name in the air and to the flip value; the board ends end for end
pop3({flip = 2, turns = true, trick = "kickflip", flick = choice("kickflip", "Kickflip mid 24", "mid", {names = NAMES})})
assert(title("Hospital Flip") and drew("Kickflip mid 24") and not drew("Stock"), "a hospital flip the Studio played a kickflip for draws: " .. lines())
-- the next one starts with the board the other way round (as the second of the three recorded did): the change counts
pop3({flip = 2, turns = true, trick = "kickflip"})
assert(title("Hospital Flip") and drew("Stock") and not drew("Kickflip mid 24"), "a stock hospital flip draws: " .. lines())
-- a kickflip, the board as it sat: a kickflip, whichever way round the board was to begin with
pop3({flip = 2, trick = "kickflip"})
assert(title("Kickflip") and not title("Hospital Flip"), "a kickflip on a board that sat backwards draws: " .. lines())
-- a board that turns and turns back is where it was
pop3({flip = 2, turns = "twice", trick = "kickflip"})
assert(title("Kickflip") and not title("Hospital Flip"), "a kickflip whose board turned and turned back draws: " .. lines())
-- an underflip (recorded 18:17 and 18:25): a kickflip to everything that names it; its board is back on its wheels
-- early (183 to 235 ms after the takeoff, where a plain flip's is at 317) and then a second time
pop3({flip = 2, over = {250, 350}, trick = "kickflip", flick = choice("kickflip", "Kickflip mid 24", "mid", {names = NAMES})})
assert(title("Kickflip Underflip") and drew("Kickflip mid 24"), "a kickflip underflip the Studio played a kickflip for draws: " .. lines())
pop3({flip = 2, over = {340}, trick = "kickflip"})
assert(title("Kickflip") and not title("Kickflip Underflip"), "a kickflip, once onto its wheels, draws: " .. lines())
-- a double kickflip (recorded 18:25): back on its wheels at the plain flip's time, then round again at its own pace
pop3({flip = 2, over = {340, 575}, trick = "kickflip"})
assert(title("Double Kickflip") and not drew("Underflip"), "a double kickflip draws: " .. lines())
pop3({flip = 2, over = {340, 575, 810}, trick = "kickflip"})
assert(title("Triple Kickflip"), "a triple kickflip draws: " .. lines())
-- a board that rocks off its wheels for a moment after its flip did not go round again
pop3({flip = 2, over = {340, 380}, trick = "kickflip"})
assert(title("Kickflip") and not drew("Double") and not drew("Underflip"), "a kickflip whose board rocked after the flip draws: " .. lines())
-- a 360 flip comes back onto its wheels twice by itself: no underflip, no double
pop3({flip = 11, over = {100, 340}, trick = "360flip"})
assert(title("360flip") or title("360 Flip"), "a 360 flip draws: " .. lines())
assert(not drew("Underflip") and not drew("Double"), "a 360 flip is no underflip: " .. lines())
-- a hospital flip that also came onto its wheels twice is a hospital flip; a flip the game changed in the air is neither
pop3({flip = 2, over = {250, 350}, turns = true, trick = "kickflip"})
assert(title("Hospital Flip"), "a hospital flip, twice onto its wheels, draws: " .. lines())
pop3({flip = 2, air_flip = 3, over = {250, 350}, trick = "heelflip"})
assert(not drew("Underflip") and not drew("Hospital") and not drew("Double"), "a flip the game changed in the air draws: " .. lines())
pop3({flip = 3, over = {200, 290}, trick = "heelflip"})
assert(title("Heelflip Underflip"), "a heelflip underflip draws: " .. lines())
-- the plain flip's time is the player's own: three plain heelflips at a slower flip (600 ms) move it, and an
-- underflip at 420 ms, which would be a double flip by the first number, is an underflip by theirs
for _ = 1, 6 do pop3({flip = 3, over = {600}, trick = "heelflip"}) end
pop3({flip = 3, over = {420, 600}, trick = "heelflip"})
assert(title("Heelflip Underflip"), "an underflip of a player whose flips are slower draws: " .. lines())
pop3({flip = 3, over = {600, 1020}, trick = "heelflip"})
assert(title("Double Heelflip"), "a double heelflip of that player draws: " .. lines())
-- the heelflip's (by the game's clip names, not measured), and a trick with no hospital flip of its own
pop3({flip = 3, turns = true, trick = "heelflip"})
assert(title("Hospital Heelflip"), "a hospital heelflip draws: " .. lines())
pop3({flip = 4, turns = true, trick = "popshuvit", flick = choice("popshuvit", "Pop Shuv-it low 15", "low", {names = NAMES})})
assert(title("Pop Shuv-it") and drew("Pop Shuv-it low 15"), "a pop shuv-it, whose board turns as the trick, draws: " .. lines())
pop3({flip = 36, turns = true, trick = "popshuvit"})
assert(title("BF Impossible"), "an impossible whose board ends end for end draws: " .. lines())
-- a pop the air never named: the trick it launched with
pop3({flip = 2})
assert(title("Kickflip") and drew("Stock") and not drew("no trick"), "a pop the air never named draws: " .. lines())
report[#report + 1] = "the game's flip value: an impossible is a BF Impossible whatever the Studio and the air call it; a kickflip whose board ends end for end is a Hospital Flip; a pop shuv-it and a late flip keep their names"

-- 5. what it wrote: its settings and nothing else
local wrote = {}
for name in pairs(files) do if name ~= "studio.json" then wrote[#wrote + 1] = name end end
table.sort(wrote)
for _, name in ipairs(wrote) do assert(name == "settings.json", "the plugin wrote " .. name) end
report[#report + 1] = "files written: " .. (#wrote > 0 and table.concat(wrote, ", ") or "none")
return table.concat(report, "\\n")
`;

// require(name): the plugin's other files beside main.lua (plugin/butler.lua ...), each run once, as the game does it
const moduleFiles = fs.readdirSync(path.join(pkg, "plugin")).filter((n) => /\.luau?$/.test(n) && n !== "main.lua").sort();
const moduleAt = []; // where each module's text sits in the chunk: [file, first line, lines]
let head = prelude + "\nlocal MODULES, LOADED = {}, {}\n";
for (const n of moduleFiles) {
  const text = fs.readFileSync(path.join(pkg, "plugin", n), "utf8").replace(/\r\n/g, "\n");
  head += `MODULES[${JSON.stringify(n.replace(/\.luau?$/, ""))}] = function()\n`;
  moduleAt.push([n, head.split("\n").length, text.split("\n").length]);
  head += text + "\nend\n";
}
head += `local function require(name)
    name = tostring(name):gsub("^%./", ""):gsub("%.luau?$", "")
    if LOADED[name] == nil then
        local m = MODULES[name]
        if not m then error("require: no module " .. name .. " beside main.lua") end
        local v = m()
        LOADED[name] = v == nil and true or v
    end
    return LOADED[name]
end
`;
const chunk = head + "\nlocal function PLUGIN()\n" + source + "\nend\n" + scenario;
const offset = head.split("\n").length; // a reported line minus this is the line in main.lua
const vm = await LuauState.createAsync({ print: console.log });
try {
  const out = await vm.loadstring(chunk, "smoke", true)();
  console.log(Array.isArray(out) ? out[0] : out);
} catch (e) {
  const text = String(e?.message ?? e).replace(/\[string "smoke"\]:(\d+)/g, (m, n) => {
    const line = Number(n) - offset;
    for (const [file, first, count] of moduleAt) if (Number(n) >= first && Number(n) < first + count) return `${file}:${Number(n) - first + 1}`;
    return line >= 1 && line <= source.split("\n").length ? `main.lua:${line}` : `smoke:${n}`;
  });
  console.error("smoke test failed: " + text);
  process.exitCode = 1;
} finally {
  vm.destroy();
}

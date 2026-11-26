#!/usr/bin/env node
// butler-test.mjs [plugin folder]: load plugin/butler.lua alone in a Luau VM and walk Pop Butler through pops.
// The smoke test cannot do this: main.lua calls Pop Butler inside pcall and the smoke stand-in has no physics to tune,
// so a broken Pop Butler passes there. Here the "game" is a few lines: a flip value, a pop strength, the takeoff law,
// an air of N ticks with the game's CanLandTrick flag, a landing. Each pop is followed to what Pop Butler learnt.
//
//   node tool/test/butler-test.mjs            mod/
//
// It pins down the two-sided rule (2026-11-24): the search, what is not learnt from, the FS shuv case of that morning
// (one let go costs 0.04 m/s and is paid back in 20 clean pops; the rule before it left the aim 0.08 lower for good),
// an aim that sits far too low climbing back, a noisy limit (about one let go in 20 pops), entries learnt before the rule.
// And that what is held over the player's value is always let go (2026-11-25): its module switched off under it, the
// trick on the ground no longer the one it was set for, a let go that fails.
// It is a stand-in, not the game: it says nothing about how a landing looks.

import fs from "node:fs";
import path from "node:path";
import { LuauState } from "luau-web";

const pkg = path.resolve(process.argv[2] ?? "mod");
const source = fs.readFileSync(path.join(pkg, "plugin", "butler.lua"), "utf8").replace(/\r\n/g, "\n");

const head = `
local clock = 5000
local STATE, VERTICAL, GROUND_Y = 100, 0, 2.0     -- physics state, vertical speed, height of the rider's frame
local FLIP, STRENGTH, CAN, PLAN = nil, 0, nil, nil -- what the game's animation values say
local BASE = 1.5                                   -- the player's own Ollie height (min)
local HELD = nil                                   -- what a plugin holds over it
local TUNES, SAVES = {}, 0
local FAIL_LET_GO = 0                              -- so many let gos fail, as the game would say no
local UNREADABLE = false                           -- the animation values cannot be read
local OTHER = nil                                  -- what another plugin holds over the player's value
local A, B = 2.686, 14.907                         -- the game's takeoff law (the module starts from the same numbers)
local SETTINGS = {air = {on = true, cap = false, tricks = {}}, trick_pop = {}}
local FLIP_NAMES = {"Ollie", "Kickflip", "Heelflip", "PopShuvit", "VarialKickflip", "Hardflip"}

reskate = {
    skater = {
        telemetry = function() return {physics_state = STATE, vertical = VERTICAL} end,
        frame = function() return {position = {y = GROUND_Y}} end,
        animation_values = function()
            return {["Animation/Dingo/Bool.Anim.CanLandTrick"] = CAN ~= nil and {value = CAN} or nil,
                ["Animation/Dingo/Float.Physics.TotalTrajectoryTime"] = PLAN and {value = PLAN} or nil}
        end,
    },
    physics = {
        tune = function(id, v)
            assert(id == "PhysicsMode.JumpMinHeight", "tuned " .. tostring(id))
            if v == nil and FAIL_LET_GO > 0 then
                FAIL_LET_GO -= 1
                return false, "the game said no"
            end
            HELD = v
            TUNES[#TUNES + 1] = v == nil and "let go" or string.format("%.3f", v)
            return true
        end,
        -- as the game: the value in force, and the plugin that holds one over the player's own
        tuning = function(id) return {value = OTHER or HELD or BASE, tuner = OTHER and "Another_Plugin" or (HELD and "Pop_Doctor" or nil)} end,
    },
}
local env = {
    now = function() return clock end,
    settings = function() return SETTINGS end,
    save_settings = function() SAVES += 1 end,
    read_flip = function()
        if UNREADABLE then return nil, "no values", nil end
        return FLIP, nil, {["Animation/Dingo/Float.Intent.JumpStrength"] = {value = STRENGTH}}
    end,
    FLIP_GROUND = 39, FLIP_NAMES = FLIP_NAMES,
}
local function MODULE()
`;

const scenario = `
end
local butler = MODULE()(env)
local pop, air = butler.pop, butler.air
local report = {}
local function near(a, b) return type(a) == "number" and type(b) == "number" and math.abs(a - b) < 0.0021 end
local function tick(n)
    for _ = 1, (n or 1) do
        clock += 1000 / 60
        butler.pop_tick()
        butler.tick()
    end
end
-- One pop as the game plays it. flip: the game's flip value; s: pop strength; air_ticks: ticks in the air;
-- on_at / off_at: the air ticks CanLandTrick turns on and off at (off_at nil: it stays on); lower: metres the landing
-- is below the takeoff. edge: instead of air_ticks, a function of the takeoff that says "let go" (true) or not.
-- Gives back the takeoff, up, and what was aimed.
local function do_pop(flip, s, air_ticks, on_at, off_at, lower, edge)
    STATE, FLIP, CAN, PLAN = 100, nil, nil, nil
    tick(3)                                -- the trick is not named yet: a launch's block is let go
    clock += 1600                          -- the player's own value is read again between pops
    tick(1)
    FLIP, STRENGTH = flip, s
    tick(2)                                -- named on the ground: the value for this pop is set here
    local aimed = pop.held and pop.held.target or nil
    local min = HELD or BASE
    local up = math.sqrt(A * min * (1 - s) + B * s)
    if edge then
        if edge(up) then air_ticks, on_at, off_at = 26, 21, 25 else air_ticks, on_at, off_at = 24, 21, nil end
    end
    -- the launch, as main.lua's handler does it
    local held = pop.held
    if pop.held then butler.release("launch", up) end
    pop.block = pop.seen
    butler.launch({from = "ollie", velocity = {y = up}}, held)
    STATE, FLIP = 201, nil
    for k = 1, air_ticks do
        CAN = k >= on_at and (off_at == nil or k < off_at)
        PLAN = 0.4
        VERTICAL = up - 14.7 * k / 60
        tick(1)
    end
    STATE, GROUND_Y = 100, 2.0 - (lower or 0)
    tick(20)                               -- the landing settles, then the pop is learnt from
    GROUND_Y = 2.0
    return up, aimed
end
local function entry(k) return SETTINGS.air.tricks[k] or {} end
local function aim_of(k) return butler.target(butler.cfg(), k) end
local OLLIE, KICK, HEEL, SHUV, VARIAL, HARD = 1, 2, 3, 4, 5, 6

-- 1. the search: steps of 0.08 up to the first let go, then down 0.04 and fine steps of 0.002
local up, aimed = do_pop(KICK, 0.10, 24, 21)
assert(near(aimed, 2.70) and near(up, 2.70), "first pop: aimed " .. tostring(aimed) .. ", left at " .. tostring(up))
assert(TUNES[1] == "2.399" and TUNES[2] == "let go", "first pop set " .. tostring(TUNES[1]) .. " then " .. tostring(TUNES[2]))
assert(HELD == nil, "the player's own value is back after the launch")
assert(near(entry("kickflip").aim, 2.78) and entry("kickflip").ok == 1 and entry("kickflip").go == 0, "after one clean pop: aim " .. tostring(entry("kickflip").aim))
assert(air.last and air.last.verdict == "landed itself" and air.last.ticks == 24 and air.last.on_at == 21, "the last pop: " .. tostring(air.last and air.last.verdict))
up, aimed = do_pop(KICK, 0.10, 24, 21)
assert(near(aimed, 2.78) and near(entry("kickflip").aim, 2.86), "searching: 0.08 a clean pop, got " .. tostring(entry("kickflip").aim))
up, aimed = do_pop(KICK, 0.10, 26, 21, 25)
assert(near(aimed, 2.86) and near(entry("kickflip").aim, 2.82) and entry("kickflip").ok == 0 and entry("kickflip").go == 1, "a let go: 0.04 down, got " .. tostring(entry("kickflip").aim))
assert(air.last.verdict == "let go: the game's own landing", "verdict of a let go: " .. air.last.verdict)
up, aimed = do_pop(KICK, 0.10, 24, 21)
assert(near(aimed, 2.82) and near(entry("kickflip").aim, 2.822), "past the search: 0.002 a clean pop, got " .. tostring(entry("kickflip").aim))
assert(near(entry("kickflip").lo, 2.82) and near(entry("kickflip").hi, 2.86), "the last clean landing and the last let go are kept for the page")
report[#report + 1] = "the search: 2.70, 2.78, 2.86 (let go), then 2.82 and 0.002 up with every clean pop"

-- 2. what is not learnt from, and pops that are not at the aim
local before = entry("kickflip").n
do_pop(KICK, 0.10, 24, 21, nil, 0.10)
assert(entry("kickflip").n == before and air.last.flat == false, "a landing 10 cm lower was learnt from")
do_pop(KICK, 0.10, 24, 21, nil, 0.02)
assert(entry("kickflip").n == before and air.last.flat == false, "a landing 2 cm lower was learnt from (flat is 1 cm now)")
local tunes = #TUNES
do_pop(OLLIE, 0.10, 24, 21)
assert(#TUNES == tunes and SETTINGS.air.tricks.ollie == nil, "an ollie was lifted or learnt")
do_pop(KICK, 0.50, 30, 21)
assert(#TUNES == tunes and entry("kickflip:mid").n == 1 and entry("kickflip").n == before, "a mid pop goes higher than the aim by itself: left alone, and learnt apart as kickflip:mid")
assert(near(entry("kickflip:mid").aim, 2.78), "a clean landing well over the aim: a search step at most, got " .. tostring(entry("kickflip:mid").aim))
local kick_aim = entry("kickflip").aim
do_pop(KICK, 0.50, 30, 21, 25)             -- the player's own bigger pop, let go, keyed kickflip:mid
assert(entry("kickflip").aim == kick_aim, "a let go of a mid pop moved the low pop's aim")
SETTINGS.air.tricks.popshuvit = {aim = 2.60, go = 1, n = 5, ok = 3}
do_pop(SHUV, 0.32, 26, 21, 25)             -- its own pop leaves at 2.74, far over the aim of 2.60: let go
assert(near(entry("popshuvit").aim, 2.60) and entry("popshuvit").ok == 3, "a let go far over the aim moved it: " .. tostring(entry("popshuvit").aim))
report[#report + 1] = "not learnt from: a landing 2 cm lower, an ollie. A mid pop is learnt apart. A let go far over the aim leaves it alone"

-- 3. the FS shuv of 2026-11-24: a limit of 2.548 to 2.573 learnt by the rule before, one let go at the aim
SETTINGS.air.tricks.heelflip = {lo = 2.548, hi = 2.573, n = 198, ok = 2, conf = 1}
assert(near(aim_of("heelflip"), 2.533), "an entry of the rule before starts where that rule aimed: " .. tostring(aim_of("heelflip")))
up, aimed = do_pop(HEEL, 0.10, 24, 21)
assert(near(aimed, 2.533) and near(entry("heelflip").aim, 2.535) and entry("heelflip").go == 1, "a settled trick: 0.002 up, got " .. tostring(entry("heelflip").aim))
up, aimed = do_pop(HEEL, 0.10, 25, 21, 25)
assert(near(entry("heelflip").aim, 2.495) and entry("heelflip").ok == 0, "one let go at 2.535: the aim is " .. tostring(entry("heelflip").aim) .. " (the rule before: 2.453, for good)")
for _ = 1, 20 do do_pop(HEEL, 0.10, 24, 21) end
assert(near(entry("heelflip").aim, 2.535), "20 clean pops pay one let go back: " .. tostring(entry("heelflip").aim))
report[#report + 1] = "the FS shuv case: aim 2.535, one let go, 2.495; 20 clean pops later 2.535 again (the rule before: 2.453 and stuck)"

-- 4. an aim that sits far too low (a limit dragged down by the rule before) climbs back: the steps double
SETTINGS.air.tricks.varialkickflip = {hi = 2.533, n = 201, ok = 0, conf = 1}
assert(near(aim_of("varialkickflip"), 2.493), "a let go and nothing else known: 0.04 under it, got " .. tostring(aim_of("varialkickflip")))
local pops = 0
while entry("varialkickflip").aim == nil or entry("varialkickflip").aim < 2.80 do
    do_pop(VARIAL, 0.10, 24, 21)
    pops += 1
    assert(pops < 200, "the aim does not climb: " .. tostring(entry("varialkickflip").aim) .. " after 200 clean pops")
end
assert(pops >= 40 and pops <= 60, "from 2.49 to 2.80 in " .. pops .. " clean pops (expected 40 to 60)")
report[#report + 1] = "a dragged-down aim climbs back: 2.49 to 2.80 in " .. pops .. " clean pops"

-- 5. a noisy limit: this trick is let go above 2.80 m/s, give or take 0.03 from pop to pop
local seed = 12345
local function noise() seed = (seed * 1103515245 + 12345) % 2147483648; return (seed / 2147483648 - 0.5) * 0.06 end
SETTINGS.air.tricks.hardflip = nil
local goes, sum, counted = 0, 0, 0
for i = 1, 500 do
    local u = do_pop(HARD, 0.10, nil, nil, nil, nil, function(v) return v > 2.80 + noise() end)
    if i > 200 then
        counted += 1
        sum += u
        if air.last.verdict == "let go: the game's own landing" then goes += 1 end
    end
end
local rate, mean = goes / counted, sum / counted
assert(rate > 0.02 and rate < 0.09, string.format("a noisy limit: %.1f %% of the pops were let go (expected 2 to 9)", rate * 100))
assert(mean > 2.70 and mean < 2.80, string.format("a noisy limit at 2.80: the pops left at %.3f on average", mean))
report[#report + 1] = string.format("a noisy limit at 2.80 +- 0.03: pops leave at %.3f on average, %d of %d let go (1 in %.0f)", mean, goes, counted, counted / math.max(1, goes))

-- 6. the switches
SETTINGS.air.on = false
tunes = #TUNES
do_pop(KICK, 0.10, 24, 21)
assert(#TUNES == tunes, "switched off, and a pop was lifted")
SETTINGS.air.on = true
SETTINGS = {air = SETTINGS.air, trick_pop = {}}   -- "Back to the defaults" makes a new settings table: the module must follow it
SETTINGS.air.ceiling = 2.75
up, aimed = do_pop(KICK, 0.10, 24, 21)
assert(near(aimed, 2.75), "the ceiling of 2.75 holds the aim: " .. tostring(aimed))
local held_aim = entry("kickflip").aim
do_pop(KICK, 0.10, 24, 21)
assert(entry("kickflip").aim == held_aim, "clean pops under a ceiling pushed the aim up: " .. tostring(entry("kickflip").aim))
report[#report + 1] = "switched off: nothing lifted. The ceiling holds the aim. A new settings table is followed"

-- 7. the tab draws
local rows = {}
local ui = {}
function ui:card() end
function ui:note() end
function ui:warn() end
function ui:toggle(id, label, v) return v end
function ui:slider(id, label, v) return v end
function ui:button() return false end
butler.tab(ui, {info = function(u, label, value) rows[#rows + 1] = tostring(label) .. ": " .. tostring(value) end,
    fmt = function(n, places) return n == nil and "-" or string.format("%." .. (places or 1) .. "f", n) end,
    title_case = function(s) return s and (s:sub(1, 1):upper() .. s:sub(2)) or nil end})
local found = false
for _, r in ipairs(rows) do if r:find("^Heelflip: aim 2%.5%d m/s | last landed itself 2%.5%d, last let go 2%.5%d %(220 pops%)$") then found = true end end
assert(found, "the LEARNT row of the heelflip: " .. table.concat(rows, " | "))
report[#report + 1] = "the POP BUTLER tab draws " .. #rows .. " rows"

-- 8. what is held is always let go (the review of 2026-11-25). Before: a new settings table with Pop Butler off in it (the
-- "Back to the defaults" of that day) left a lifted pop lifted for good, an armed kickflip that became an ollie kept the
-- kickflip's height, and a let go that failed was forgotten.
local function arm(flip, s) -- the game names a trick on the ground; no launch follows
    STATE, FLIP = 100, nil
    tick(3)
    clock += 1600
    tick(1)
    FLIP, STRENGTH = flip, s
    tick(2)
end
-- 8a. its module is switched off under it
local learnt = SETTINGS
arm(KICK, 0.10)
assert(HELD ~= nil and pop.held and pop.held.air, "a weak kickflip was not lifted")
SETTINGS = {air = {on = false, cap = false, tricks = {}}, trick_pop = {}} -- a new settings table, Pop Butler off in it
tick(1)
assert(HELD == nil and pop.held == nil, "a new settings table with Pop Butler off, a pop lifted: the lift stayed, " .. tostring(HELD))
SETTINGS.trick_pop = {kickflip = 2.4}
arm(KICK, 0.10)
assert(HELD == 2.4 and pop.held and not pop.held.air, "the table did not set its height: " .. tostring(HELD))
SETTINGS.trick_pop = {}
tick(1)
assert(HELD == nil and pop.held == nil, "the table was emptied while it held a height: the height stayed, " .. tostring(HELD))
SETTINGS.trick_pop = {kickflip = 2.4}
arm(KICK, 0.10)
SETTINGS.air.on = true
tick(1)
assert(pop.held and pop.held.air and HELD ~= 2.4, "Pop Butler switched on over a height of the table: the table's stayed, " .. tostring(HELD))
assert(butler.release("the test") == true and HELD == nil, "a let go that works says so")
SETTINGS = learnt
report[#report + 1] = "held and its module goes: a new settings table with it off, the table emptied, Pop Butler switched on over the table: let go on the next tick"

-- 8b. the trick on the ground is no longer the one it was set for
arm(KICK, 0.10)
assert(HELD ~= nil, "a weak kickflip was not lifted")
FLIP = OLLIE
tick(1)
assert(HELD == nil and pop.held == nil, "an armed kickflip became an ollie and kept the kickflip's lift: " .. tostring(HELD))
arm(KICK, 0.10)
FLIP = nil
tick(1)
assert(HELD == nil and pop.held == nil, "the game dropped the trick and the lift stayed: " .. tostring(HELD))
arm(KICK, 0.10)
local kick_min = HELD
FLIP = HEEL
tick(1)
assert(pop.held and pop.held.trick == "heelflip" and HELD ~= kick_min and near(pop.held.target, aim_of("heelflip")),
    "a kickflip became a heelflip: the lift is not the heelflip's, " .. tostring(HELD))
UNREADABLE = true
tick(3)
assert(pop.held and pop.held.trick == "heelflip" and HELD ~= nil, "ticks the values could not be read on let the lift go")
UNREADABLE = false
tick(1)
assert(pop.held and HELD ~= nil, "the values read again, the same trick: the lift was let go")
clock += 700
tick(1)
assert(HELD == nil and pop.held == nil, "no launch came for 700 ms and the lift stayed")
SETTINGS.air.on = false
SETTINGS.trick_pop = {kickflip = 2.4, heelflip = 1.9}
arm(KICK, 0.10)
assert(HELD == 2.4, "the table did not set the kickflip's height: " .. tostring(HELD))
FLIP = HEEL
tick(1)
assert(HELD == 1.9 and pop.held.trick == "heelflip", "the table, a kickflip that became a heelflip: the height is " .. tostring(HELD) .. ", the heelflip's is 1.9")
FLIP = OLLIE
tick(1)
assert(HELD == nil and pop.held == nil, "the table, a listed trick that became an ollie: the height stayed, " .. tostring(HELD))
SETTINGS.trick_pop = {}
SETTINGS.air.on = true
report[#report + 1] = "held and the trick changes: an ollie or no trick lets it go at once, another flip gets its own, unreadable ticks keep it"

-- 8c. a let go that fails is tried again on every tick, and until then nothing else is set or read
arm(KICK, 0.10)
local lifted = HELD
FAIL_LET_GO = 3
assert(butler.release("launch", 2.75) == false and HELD == lifted and pop.held and pop.held.letting == "launch", "a let go that failed forgot what is held")
STATE, FLIP = 201, nil
tick(2)
assert(HELD == lifted and pop.held and pop.held.tries == 3, "a failed let go is tried once a tick: " .. tostring(pop.held and pop.held.tries))
tick(1)
assert(HELD == nil and pop.held == nil, "the fourth try works, yet the lift stayed: " .. tostring(HELD))
assert(pop.log[#pop.log].note:find("%(launch%), left at 2.75 m/s up, at try 4"), "the note of a late let go: " .. pop.log[#pop.log].note)
arm(KICK, 0.10)
lifted = HELD
FAIL_LET_GO = 100000
butler.release("launch", 2.75)
FLIP = nil
clock += 2000
tick(5)
assert(HELD == lifted and near(air.base, BASE), "a lift that cannot be let go was read as the player's own value: " .. tostring(air.base))
local sets = pop.sets
FLIP = KICK
tick(2)
assert(pop.sets == sets and HELD == lifted, "a new value was set while the old one could not be let go")
FLIP, FAIL_LET_GO = nil, 0
tick(1)
assert(HELD == nil and pop.held == nil, "the game takes the let go again, yet the lift stayed: " .. tostring(HELD))
OTHER = 3.3
clock += 1600
tick(1)
assert(near(air.base, BASE), "what another plugin holds was read as the player's own value: " .. tostring(air.base))
OTHER = nil
report[#report + 1] = "a let go that fails: kept, tried again every tick, nothing set or read meanwhile. Another plugin's value is not read as the player's"
assert(SAVES > 0, "nothing was saved")
return table.concat(report, "\\n")
`;

const chunk = head + source + scenario;
const offset = head.split("\n").length - 1;
const vm = await LuauState.createAsync({ print: console.log });
try {
  const out = await vm.loadstring(chunk, "butler", true)();
  console.log(Array.isArray(out) ? out[0] : out);
} catch (e) {
  const lines = source.split("\n").length;
  const text = String(e?.message ?? e).replace(/\[string "butler"\]:(\d+)/g, (m, n) => {
    const line = Number(n) - offset;
    return line >= 1 && line <= lines ? `butler.lua:${line}` : `test:${Number(n) - offset - lines}`;
  });
  console.error("butler test failed: " + text);
  process.exitCode = 1;
} finally {
  vm.destroy();
}

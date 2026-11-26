-- butler.lua: the Pop Butler module (and the pop height table it is built on). Loaded once by main.lua:
-- require("butler")(env). Written in the StudioBridge project until 2026-11-25, moved here as it was; the measurements
-- its comments point at are in that project's notes (studio-bridge.org).
--   env.now()            the game's clock, ms
--   env.settings()       main.lua's settings table AS IT IS NOW ("Back to the defaults" makes a new one: never keep it)
--   env.save_settings()  writes settings.json
--   env.read_flip()      the game's flip value now, why it could not be read, every animation value
--   env.FLIP_GROUND, env.FLIP_NAMES   the flip values a pop starts with, and their names
-- What it gives back is the table at the end of this file. The body is not indented: it is the moved text.
return function(env)
local now, save_settings, read_flip, FLIP_GROUND, FLIP_NAMES = env.now, env.save_settings, env.read_flip, env.FLIP_GROUND, env.FLIP_NAMES
local function settings() return env.settings() end

-- ---- a pop height of its own for listed tricks ------------------------------------------------
-- settings.trick_pop: game trick id -> the trainer's "Ollie height (min, light pop)" (PhysicsMode.JumpMinHeight) for that
-- trick alone. When the game names a listed trick while the skater is still on the ground, the value is set over the
-- player's own (reskate.physics.tune) and let go at the launch, or after POP_HOLD_MS when no launch comes. The player's
-- own value and the trainer's file are never written. Needs the skater.control permission.
-- What is held (pop.held) is for one trick and one module, and is let go as soon as either is gone (pop_tick): the trick on
-- the ground became another one or none (a kickflip that turns into an ollie must not keep the kickflip's height), Pop
-- Butler was switched off, the table was emptied, a new settings table has its module off.
local POP_ID = "PhysicsMode.JumpMinHeight"
local POP_HOLD_MS = 700
local pop = {held = nil, seen = nil, log = {}, sets = 0, late = 0}
local function pop_note(s)
    pop.log[#pop.log + 1] = {at = now(), note = s}
    if #pop.log > 30 then table.remove(pop.log, 1) end
end
-- Lets the held value go: true once the game has the player's own value back. pop.held is forgotten only then. A let go
-- that fails keeps it (with .letting, why it was to go), and pop_tick tries again on every tick: until it is through
-- nothing else is set, and the value in force is not read as the player's own (air_base).
local function pop_release(why, up)
    local h = pop.held
    if not h then return true end
    local ok, done, w = pcall(reskate.physics.tune, POP_ID, nil)
    if ok and done ~= false then
        pop.held = nil
        up = up or h.up
        pop_note(string.format("%s let go after %.0f ms (%s)%s%s", h.trick, now() - h.since, h.letting or why, up and string.format(", left at %.2f m/s up", up) or "",
            h.tries and string.format(", at try %d", h.tries + 1) or ""))
        return true
    end
    h.tries = (h.tries or 0) + 1
    if not h.letting then
        h.letting, h.up = why, up
        pop_note(string.format("%s LET GO FAILED after %.0f ms (%s): %s. Tried again on every tick", h.trick, now() - h.since, why, tostring(ok and w or done)))
    end
    return false
end
-- The trick the game has in mind at the flick, for the pop's height: the value read above, and only the tricks a pop
-- starts with, not what one becomes in the air.
local function current_flip()
    local v, why, values = read_flip()
    local name = v and v <= FLIP_GROUND and FLIP_NAMES[v]
    return name and string.lower(name) or nil, why, values
end

-- ---- Pop Butler: every pop of a flip trick gets the air its animation can land from -----------
-- The name since 2026-11-22. It was "air time" before, and the saved settings (settings.air), the bridge op (air) and the
-- names in this file keep that word: only what a player reads was renamed.
-- What the game does (measured 2026-11-21, studio-bridge.org): when a flip ends in the air the game keeps the trick's own
-- landing only if the ground is close enough by then (Bool.Anim.CanLandTrick stays on); with more air than that it lets
-- the trick go and plays its own catch and landing, the deep crouch. With less air than the flip needs it hurries the
-- trick, the snap. So each trick has a longest air it lands itself from, and the best pop is just inside it.
-- The takeoff is known before it happens: up^2 = a * min * (1 - s) + b * s, with s the game's pop strength
-- (Float.Intent.JumpStrength, set at the flick) and min the trainer's "Ollie height (min, light pop)"
-- (PhysicsMode.JumpMinHeight). So, once the game names a flip trick on the ground, the min that gives the wanted takeoff is
-- set over the player's own (reskate.physics.tune) and let go at the launch. A pop that would already go as high is left
-- alone (settings.air.cap = true also holds a bigger pop down to the limit).
-- No pop is lifted past settings.air.ceiling: some tricks land themselves from far more air than they need.
-- The aim is learnt per trick from the player's own pops: every flat pop is followed to its landing and moves the aim a
-- little, down after a let go, up after a clean landing (the two-sided rule, air_commit). It rests just under the limit.
local STRENGTH_VALUE = "Animation/Dingo/Float.Intent.JumpStrength"
local CAN_LAND_VALUE = "Animation/Dingo/Bool.Anim.CanLandTrick"
local PLAN_VALUE = "Animation/Dingo/Float.Physics.TotalTrajectoryTime"
local AIR_SKIP = {ollie = true, nollie = true, olliepop = true, n_olliepop = true, wallie = true, fswallie = true, bswallie = true} -- no flip to fit
local air = {flight = nil, base = nil, base_at = 0, log = {}, last = nil}
local function air_note(s)
    air.log[#air.log + 1] = {at = now(), note = s}
    if #air.log > 40 then table.remove(air.log, 1) end
end
local function air_cfg() -- settings.air with every field there
    local a = settings().air
    if type(a) ~= "table" then
        a = {}
        settings().air = a
    end
    if type(a.on) ~= "boolean" then a.on = false end -- a module: off until the player switches it on
    if type(a.cap) ~= "boolean" then a.cap = false end
    if type(a.start) ~= "number" then a.start = 2.70 end   -- the first aim for a trick nothing is known about, m/s up
    if type(a.step) ~= "number" then a.step = 0.08 end     -- how far the aim moves while only one side of the limit is known
    if type(a.tight) ~= "number" then a.tight = 0.03 end   -- only for entries learnt before the two-sided rule (air_aim)
    if type(a.margin) ~= "number" then a.margin = 0.015 end -- the same
    if type(a.down) ~= "number" then a.down = 0.04 end     -- a let go at the aim: the aim comes down this far, m/s
    if type(a.fine) ~= "number" then a.fine = 0.002 end    -- a clean landing at the aim: it goes up this far. down / fine = pops to a let go
    if type(a.near) ~= "number" then a.near = 0.02 end     -- a takeoff this close to the aim is a pop "at the aim"
    if type(a.flat) ~= "number" then a.flat = 0.01 end     -- a landing this close to the takeoff's height is learnt from, m (was 0.03)
    if type(a.a) ~= "number" then a.a = 2.686 end          -- the takeoff law, kept up to date from every flat pop
    if type(a.b) ~= "number" then a.b = 14.907 end
    if type(a.ceiling) ~= "number" then a.ceiling = 2.95 end -- no pop is lifted past this takeoff, m/s up: for tricks that land themselves from far more air than they need (a 360 flip does up to 3.4)
    if type(a.tricks) ~= "table" then a.tricks = {} end
    return a
end
local function air_ground() -- the height of the rider's frame (at the board, not the body: the body moves with the crouch)
    local ok, fr = pcall(reskate.skater.frame)
    if ok and type(fr) == "table" and fr.position then return fr.position.y end
    return nil
end
local function air_base() -- the player's own Ollie height (min): read while nothing of ours, or of another plugin, is set over it
    if not pop.held and now() - air.base_at > 1500 then
        local ok, v = pcall(reskate.physics.tuning, POP_ID)
        -- v.tuner: the plugin that holds a value over the player's own just now (the game names it). Then v.value is that plugin's.
        local tuned = ok and type(v) == "table" and type(v.tuner) == "string" and v.tuner ~= ""
        if ok and type(v) == "table" and type(v.value) == "number" and not tuned then air.base = v.value end
        air.base_at = now()
    end
    return air.base
end
-- The aim of a trick, m/s up. An entry learnt before the two-sided rule (2026-11-24) has lo and hi and no aim: it starts
-- from where the old rule aimed, and a trick that has been let go before is past its search.
local function air_aim(cfg, e)
    if type(e) ~= "table" then return cfg.start end
    if type(e.aim) ~= "number" then
        local lo, hi = e.lo, e.hi
        if type(lo) == "number" and type(hi) == "number" and hi > lo then
            e.aim = hi - lo > cfg.tight and lo + math.min(cfg.step, (hi - lo) / 2) or lo - cfg.margin
        elseif type(hi) == "number" then e.aim = hi - cfg.down
        elseif type(lo) == "number" then e.aim = lo + cfg.step
        else e.aim = cfg.start end
        e.go = type(hi) == "number" and 1 or 0
    end
    return e.aim
end
local function air_target(cfg, trick)
    return math.clamp(math.min(air_aim(cfg, cfg.tricks[trick]), cfg.ceiling), 1.6, 4.5)
end
local function air_height(cfg, up, s) -- the Ollie height (min) that leaves at up for a pop of strength s
    return math.clamp((up * up - cfg.b * s) / (cfg.a * (1 - s)), 0.3, 8)
end
local function pop_set(trick, want, state, extra)
    local ok, done, w = pcall(reskate.physics.tune, POP_ID, want)
    if ok and done ~= false then
        local first = not pop.held
        pop.held = {trick = trick, since = pop.held and pop.held.since or now(), value = want}
        if extra then for k, v in pairs(extra) do pop.held[k] = v end end
        if first then pop.sets += 1 end
        return true, first
    end
    pop_note(string.format("%s named in state %.0f: not set: %s", trick, state, tostring(ok and w or done)))
    return false, false
end
local function pop_tick()
    local cfg = air_cfg()
    local table_on = type(settings().trick_pop) == "table" and next(settings().trick_pop) ~= nil
    -- What is held comes first, before the "both off" return below (that return used to skip every let go: a pop lifted
    -- while a new settings table switched Pop Butler off stayed lifted). A let go that failed is tried again. A value whose own
    -- module is off by now goes: Pop Butler's are the ones with .air, the table's act only while Pop Butler is off.
    local h = pop.held
    if h then
        local off = h.air and not cfg.on and "Pop Butler switched off"
            or (not h.air and (cfg.on and "Pop Butler switched on" or (not table_on and "the table of pop heights is empty")))
        if h.letting or off then pop_release(h.letting or off) end
        if pop.held and pop.held.letting then return end -- still not let go: nothing else until it is
    end
    if not cfg.on and not table_on then return end
    local t = reskate.skater.telemetry()
    local state = t and t.physics_state or 0
    if state >= 100 and state < 200 then -- on the ground and on the board: the only time the value is read
        local started = now()
        local flip, why, values = current_flip()
        pop.reads = (pop.reads or 0) + 1
        pop.read_ms = (pop.read_ms or 0) + (now() - started)
        if why and why ~= pop.why then
            pop.why = why
            pop_note("cannot read the game's flip trick: " .. why)
        end
        local changed = flip ~= pop.seen
        pop.seen, pop.seen_at = flip, started
        if pop.block and flip ~= pop.block then pop.block = nil end
        if pop.block then
            -- launched with this trick a moment ago: the launch is told a tick or two before the air state shows
        elseif cfg.on then
            local base = air_base()
            local sv = flip and values and values[STRENGTH_VALUE]
            local s = type(sv) == "table" and type(sv.value) == "number" and sv.value or nil
            if flip and not AIR_SKIP[flip] and s and s >= 0.97 then
                pop.plan = {trick = flip, key = flip .. ":high", s = s, base = base, at = now(), y = air_ground()} -- nothing to aim: followed and learnt from
                if pop.held then pop_release("this pop goes high enough by itself") end
            elseif flip and not AIR_SKIP[flip] and s and s >= 0 and base then
                -- the game plays another clip for a mid and for a high pop (strength from a third and from two thirds, measured:
                -- low at 0.301, mid at 0.363), each with a limit of its own: they are learnt apart, as "kickflip:mid"
                local key = flip .. (s < 1 / 3 and "" or (s < 2 / 3 and ":mid" or ":high"))
                local target = air_target(cfg, key)
                local natural = math.sqrt(math.max(0, cfg.a * base * (1 - s) + cfg.b * s))
                pop.plan = {trick = flip, key = key, s = s, target = target, natural = natural, base = base, at = now(), y = air_ground()}
                local want = nil
                if natural < target - 0.004 or (cfg.cap and natural > target + 0.004) then want = air_height(cfg, target, s) end
                if want then
                    if not pop.held or pop.held.trick ~= flip or math.abs(pop.held.value - want) > 0.004 then
                        local ok, first = pop_set(flip, want, state, {target = target, s = s, air = true})
                        if ok and first then pop_note(string.format("%s, strength %.3f: would leave at %.2f, aimed at %.2f m/s: %s = %.2f", flip, s, natural, target, POP_ID, want)) end
                    end
                elseif pop.held then
                    pop_release("this pop goes high enough by itself")
                end
            else
                -- An ollie, a nollie, a wallie (no flip to fit), no trick at all, or a flip whose strength is not read yet.
                if flip and changed then pop.plan = {trick = flip, s = s, base = base, at = now(), y = air_ground()} end
                -- What is held was set for another trick than this one: it goes now, not at the launch of a pop it was
                -- not meant for. A tick the values could not be read on (why) says nothing about the trick, and the same
                -- flip without its strength keeps what it has: both end at the launch or after POP_HOLD_MS.
                if pop.held and pop.held.trick ~= flip and not why then
                    pop_release(flip and ("the trick on the ground became " .. flip) or "the game dropped the trick")
                end
            end
        else -- Pop Butler is off: the table
            local want = flip and settings().trick_pop[flip] or nil
            if type(want) ~= "number" or want <= 0 then want = nil end
            if changed and want then
                if not pop.held or pop.held.trick ~= flip then -- another listed trick takes the value over: its own height, not the first one's
                    local ok = pop_set(flip, want, state, nil)
                    if ok then pop_note(string.format("%s named in state %.0f: %s = %.2f", flip, state, POP_ID, want)) end
                end
            elseif pop.held and pop.held.trick ~= flip and not why then
                pop_release(flip and ("the trick on the ground became " .. flip) or "the game dropped the trick")
            end
        end
    end
    if pop.held and now() - pop.held.since > POP_HOLD_MS then pop_release("no launch came") end
end
-- A launch: what was aimed, what it left with. The flight is then followed to its landing (air_tick).
local function air_launch(e, held)
    local cfg = air_cfg()
    if not cfg.on or e.from ~= "ollie" or not e.velocity then return end
    local p = pop.plan
    if not p or not p.trick or now() - p.at > 700 or AIR_SKIP[p.trick] then return end
    air.flight = {trick = p.key or p.trick, s = p.s, y = p.y, min = held and held.value or p.base, target = held and held.air and held.target or nil, natural = p.natural,
        up = e.velocity.y, at = now(), k = 0, wait = 0}
end
local function air_commit(fl, t)
    local cfg = air_cfg()
    local y = air_ground()
    local drop = (fl.y and y) and (fl.y - y) or nil -- metres the landing is below the takeoff
    local flat = drop ~= nil and math.abs(drop) < cfg.flat
    local let_go = fl.was_on and fl.can == false
    local verdict = let_go and "let go: the game's own landing" or (fl.was_on and "landed itself" or "landed before the flip was over")
    local g = (fl.v1 and fl.v2 and fl.t2 > fl.t1 + 80) and (fl.v1 - fl.v2) / ((fl.t2 - fl.t1) / 1000) or nil
    local e = cfg.tricks[fl.trick]
    if flat and fl.can ~= nil and fl.up > 1.2 and fl.up < 6 then
        if type(e) ~= "table" then e = {n = 0} end
        local up = math.floor(fl.up * 1000 + 0.5) / 1000
        -- The two-sided rule (2026-11-24). Every flat pop moves the aim a little, both ways: a let go at the aim brings it
        -- down by cfg.down, a clean landing at the aim takes it up by cfg.fine. So it rests where about one pop in
        -- down / fine (20) is let go, and a fluke landing is paid back in as many clean pops. Until a trick's first let
        -- go the steps up are cfg.step (the search); after 20 clean pops in a row they double every 10, so an aim that
        -- sits far too low climbs back. Before: lo / hi were the best and the worst landing EVER seen, and one let go
        -- pulled the limit down for good (the FS shuv of 2026-11-24). lo / hi are now the last of each, for the page.
        local aim = air_aim(cfg, e)
        if let_go then
            if up <= aim + cfg.near then -- at the aim, or under it: too fast for this trick
                aim = math.min(aim, up) - cfg.down
                e.go = (type(e.go) == "number" and e.go or 0) + 1
                e.ok = 0
            end -- a let go far over the aim (a bigger pop of the player's own) says nothing about the aim
            e.hi = up
        else
            local run = type(e.ok) == "number" and e.ok or 0
            if math.abs(up - aim) <= cfg.near then
                local searching = (type(e.go) == "number" and e.go or 0) == 0
                aim += searching and cfg.step or math.min(cfg.fine * 2 ^ math.max(0, math.floor(run / 10) - 1), cfg.down)
            elseif up > aim then -- landed itself from well over the aim: half the way there, a search step at most
                aim += math.min((up - aim) / 2, cfg.step)
            end -- a clean landing well under the aim says nothing
            e.lo = up
            e.ok = run + 1
        end
        e.aim = math.clamp(math.min(aim, math.max(cfg.ceiling, up)), 1.6, 4.5)
        e.conf = nil -- the old rule's count of limits that held
        e.n = (type(e.n) == "number" and e.n or 0) + 1
        cfg.tricks[fl.trick] = e
        -- the takeoff law, a little closer to this pop (normalised least mean squares on a and b)
        if fl.s and fl.min then
            local x1, x2 = fl.min * (1 - fl.s), fl.s
            local err = fl.up * fl.up - (cfg.a * x1 + cfg.b * x2)
            local n = x1 * x1 + x2 * x2
            if n > 0.01 and math.abs(err) < 3 then
                cfg.a = math.clamp(cfg.a + 0.3 * err * x1 / n, 1.5, 4.5)
                cfg.b = math.clamp(cfg.b + 0.3 * err * x2 / n, 6, 30)
            end
        end
        save_settings()
    end
    air.last = {trick = fl.trick, up = fl.up, target = fl.target, natural = fl.natural, s = fl.s, plan = fl.plan, ticks = fl.k, on_at = fl.on_at, verdict = verdict, flat = flat, drop = drop,
        lo = e and e.lo, hi = e and e.hi, aim = e and e.aim, at = now()}
    air_note(string.format("%s: left at %.3f m/s%s, strength %s, planned air %s s, %d ticks, flip over at tick %s: %s%s | limit %s to %s", fl.trick, fl.up,
        fl.target and string.format(" (aimed %.3f)", fl.target) or " (its own pop)", fl.s and string.format("%.3f", fl.s) or "?",
        fl.plan and string.format("%.3f", fl.plan) or "?", fl.k, fl.on_at and tostring(fl.on_at) or "?", verdict, flat and "" or string.format(" (not flat, %s m lower: not learnt from)", drop and string.format("%.2f", drop) or "?"),
        e and type(e.lo) == "number" and string.format("%.3f", e.lo) or "?", e and type(e.hi) == "number" and string.format("%.3f", e.hi) or "?"))
end
local function air_tick()
    local fl = air.flight
    if not fl then return end
    local t = reskate.skater.telemetry()
    local state = t and t.physics_state or 0
    if not fl.landed then
        if state == 200 or state == 201 then
            fl.k += 1
            local ok, values = pcall(reskate.skater.animation_values)
            if ok and type(values) == "table" then
                local c = values[CAN_LAND_VALUE]
                if type(c) == "table" and type(c.value) == "boolean" then
                    fl.can = c.value
                    if c.value and not fl.was_on then fl.was_on, fl.on_at = true, fl.k end
                end
                local p = values[PLAN_VALUE]
                if type(p) == "table" and type(p.value) == "number" and p.value > (fl.plan or 0) then fl.plan = p.value end
            end
            if t and type(t.vertical) == "number" then
                if fl.k == 3 then fl.v1, fl.t1 = t.vertical, now() end
                if fl.k > 3 then fl.v2, fl.t2 = t.vertical, now() end
            end
            if fl.k > 600 then air.flight = nil end
        elseif state >= 300 or state < 100 then
            air.flight = nil -- bailed, or off the board
        elseif fl.k > 0 then
            fl.landed = now()
            fl.settle = 0
        else
            fl.wait += 1 -- the launch is told a tick or two before the air state shows
            if fl.wait > 15 then air.flight = nil end
        end
    else
        if state >= 300 or state < 100 then
            air.flight = nil
            return
        end
        fl.settle += 1
        if fl.settle >= 18 or state >= 200 then
            air_commit(fl, t)
            air.flight = nil
        end
    end
end

-- POP BUTLER: the switch, the ceiling, the last pop and what was learnt (settings.air; see "Pop Butler" above).
local function air_tab(ui, h) -- h: main.lua's page helpers (info, fmt, title_case)
    local info, fmt, title_case = h.info, h.fmt, h.title_case
    local cfg = air_cfg()
    local before = tostring(cfg.on) .. tostring(cfg.cap) .. string.format("%.3f", cfg.ceiling)
    local forget = false
    ui:card("POP BUTLER", "Flip tricks get the air they can land from")
    cfg.on = ui:toggle("air_on", "Fit flip tricks to their landing", cfg.on,
        "When the game names a flip trick, a pop that would fall short is lifted so the trick lands itself: no flip cut short, no deep crouch. Your Ollie height (min) is not changed.")
    cfg.ceiling = ui:slider("air_ceiling", "Never lift a pop past (takeoff, up)", cfg.ceiling, 2.2, 3.6, "%.2f m/s")
    cfg.cap = ui:toggle("air_cap", "Hold bigger pops down to the limit too", cfg.cap,
        "Off: a pop that goes past the limit of its trick by itself is left alone and lands in the crouch of the game. On: every pop of a flip trick lands itself, and none goes higher than its limit.")
    ui:note("Each trick has a longest air it can land itself from. It is learnt from your own flat ground pops: the first few pops of a trick search for it, then every pop goes just under it.")
    ui:card("LAST POP")
    local l = air.last
    if l then
        info(ui, title_case(l.trick) or tostring(l.trick), string.format("left at %s m/s%s, %s ticks of air: %s%s", fmt(l.up, 2),
            l.target and string.format(" (aimed %s, its own pop %s)", fmt(l.target, 2), fmt(l.natural, 2)) or " (its own pop)", tostring(l.ticks or "?"), l.verdict or "?",
            l.flat and "" or " (not on flat ground: not learnt from)"))
    else
        info(ui, "Last pop", "no flip trick yet")
    end
    ui:card("LEARNT", "Each trick's aim, its last clean landing and its last let go")
    local names = {}
    for k in pairs(cfg.tricks) do names[#names + 1] = k end
    table.sort(names)
    for i, k in ipairs(names) do
        if i > 60 then ui:note("... and more") break end
        local e = cfg.tricks[k]
        local aim = air_target(cfg, k)
        info(ui, title_case(k) or k, string.format("aim %s m/s | last landed itself %s, last let go %s (%d pops)", fmt(aim, 2),
            type(e.lo) == "number" and fmt(e.lo, 2) or "?", type(e.hi) == "number" and fmt(e.hi, 2) or "not seen", type(e.n) == "number" and e.n or 0))
    end
    if #names == 0 then ui:note("Nothing learnt yet: pop a flip trick on flat ground.") end
    if #names > 0 and ui:button("air_forget", "Forget what was learnt") then forget = true end
    if forget then cfg.tricks = {} end
    if forget or tostring(cfg.on) .. tostring(cfg.cap) .. string.format("%.3f", cfg.ceiling) ~= before then
        if not cfg.on and pop.held and pop.held.air then pop_release("Pop Butler switched off") end
        save_settings()
    end
end

return {
    pop = pop,              -- what is held over the player's Ollie height (min) now, the trick read on the ground, the log
    air = air,              -- the flight being followed, the last pop, the log
    release = pop_release,  -- (why, up): let the held value go
    pop_tick = pop_tick,    -- every tick: read the trick on the ground, set the value for this pop
    cfg = air_cfg,          -- settings.air with every field there
    target = air_target,    -- (cfg, trick): the takeoff to aim for
    launch = air_launch,    -- (launch event, what was held): start following the flight
    tick = air_tick,        -- every tick: follow the flight to its landing, then learn from it
    tab = air_tab,          -- (ui, helpers): the POP BUTLER tab of the F2 page
}
end

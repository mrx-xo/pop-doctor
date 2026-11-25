-- Pop Doctor: a small block in a corner of the screen with the trick you just did, the Animator Studio animation
-- that played, its pack and the pop grade; an F2 page (PLUGINS > Pop Doctor) holds the settings and the last jumps.
-- What the Studio played comes from the Pop Doctor relay, a small Node.js program beside the game: it writes
-- studio.json into this plugin's data folder (Mods\.reskate_plugin_data\<id>\), the only place a plugin reads.

local POLL_MS = 200

local function now() return reskate.time.now() end
local function log(s) reskate.log(s) end

local function scalars(t)
    -- JSON-safe copy: numbers, booleans, strings, and vectors as {x,y,z}.
    if type(t) == "vector" then return {x = t.x, y = t.y, z = t.z} end
    if type(t) ~= "table" then return t end
    local out = {}
    for k, v in pairs(t) do
        local kind = type(v)
        if kind == "number" or kind == "boolean" or kind == "string" then out[k] = v
        elseif kind == "vector" then out[k] = {x = v.x, y = v.y, z = v.z}
        elseif kind == "table" then out[k] = scalars(v) end
    end
    return out
end

local function write_json(path, t)
    local ok, why = reskate.files.write(path, reskate.json.encode(t))
    if not ok then log("write " .. path .. " failed: " .. tostring(why)) end
    return ok
end

-- ---- the overlay's memory -------------------------------------------------------------------
-- What the overlay shows: the last trick, launch and landing the game reported, the last 10 jumps as a strip,
-- and what the Studio said it played (the relay writes it into studio.json).
local STRIP_MAX = 10
local hud = {
    on = true,
    trick = nil,     -- {name, ms, points, multiplier, at}
    launch = nil,    -- {from, up, along, at, after (the landing before it), landed, resolved ("studio" / "stock"), sampled}
    shown = nil,     -- the lines on screen: {name, clip, pack, grade, launch_at}; set when a pop is settled (resolve)
    sel = nil,       -- the relay's sel read last; sel_at: when it moved on, on our clock (nil: before we were loaded)
    sel_at = nil,
    sel_seen = false,
    landing = nil,   -- {down, along, onto, at}
    bail = nil,      -- {at}
    strip = {},      -- newest last: {name, clip, pack, grade, grade_est, launch_at, air, height, takeoff, down, along, at}
    serial = nil,    -- telemetry.last.serial seen last
    studio = nil,    -- the relay's studio.json, decoded, plus seen_at
    studio_text = nil,
    air_trick = nil, -- the game's name for the trick, read during the air
}
-- settings.json in the data folder: where the overlay sits and whether it shows.
local CORNERS = {"bottom-left", "bottom-right", "top-left", "top-right"}
local LAYOUTS = {"three lines", "two lines", "one line"}
local GRADE_STYLES = {"dot", "letter", "short", "word", "pop", "badge"}
local PACK_STYLES = {"auto colour", "one colour", "per pack", "off"}
-- The game bakes its fonts once: bold and body at 17 px, heading at 22 px, the brush title face at 44 px. Text drawn
-- larger than its baked size is a stretched bitmap (soft), so every size here is locked to a baked size x scale.
-- "image": the trick name as a picture pre-rendered by tool/render-text.ps1 (Montserrat ExtraBold, white on
-- transparent, mod/text/*.png + manifest.json): any size, no stretching of a font bitmap. Its TITLE_PX is in 1080p
-- pixels (it scales with the window), the others are baked sizes in window pixels.
local TITLE_FACES = {"clean", "brush", "brush large", "image"} -- heading 22 px, title 44 px, title_large 44 x 30/17 = 77.6 px
local TITLE_PX = {22, 44, 44 * 30 / 17, 40}
local TITLE_FONT = {"heading", "title", "title_large", "heading"}
local TEXT_FONTS = {}   -- text/fonts.json: {{name, folder}, ...}; the "image" face's font choices
local TEXT_IMAGES = {}  -- folder -> manifest (text -> {file, w, h, em}); loaded at start, empty without the pictures
-- The user's saved overlay setup, shared by first load and the reset button.
local function default_settings()
    return {
        corner = 1,            -- index into CORNERS
        layout = 2,            -- index into LAYOUTS: two lines
        backing = true,        -- a dark box behind the text
        backing_alpha = 0.4191640615463257, -- 0..1
        scale = 1.0,           -- text and box size, 0.5..2
        margin = 0,            -- pixels at 1080p from the screen's edge
        show_trick = true, show_anim = true, show_pack = true, show_grade = true,
        show_grinds = true,    -- a grind gets a grade mark too (G / GRIND / Grind / dot in the grind colour)
        pack_style = 2,        -- one colour
        pack_colour = {r = 0.4768815040588379, g = 0.010944285430014133, b = 0.010944285430014133},
        pack_colours = {},     -- pack name -> {r, g, b}: the player's own picks under "per pack"; none to start with
        packs_all = false,     -- the per-pack card lists every pack the relay knows, not only the ones seen this session
        grade_style = 2,       -- letter: L / M / H / G
        title_face = 4,        -- index into TITLE_FACES: clean (heading 22 px), brush (title 44 px), brush large (77.6 px), image
        image_font = 1,        -- Montserrat ExtraBold
        fade_s = 0,            -- hide the block this many seconds after a landing; 0 = never
        pop_cut_mid = 3.135,   -- a pop's up-speed (m/s) from which it is graded mid, when the Studio gives no grade
        pop_cut_high = 3.52,   -- ... and from which it is graded high (launch_grade; they follow the game's grades)
        pop_cut_mid_own = false,  -- the game has graded enough pops on both sides of the cutoff: it is this player's, not the default
        pop_cut_high_own = false,
        colour_low = {r = 0.7760000228881836, g = 0.7703412771224976, b = 0.047000009566545486},
        colour_mid = {r = 0.03863988071680069, g = 0.9308133721351624, b = 0.10608749836683273},
        colour_high = {r = 0.8430644273757935, g = 0.012234804220497608, b = 0.012234804220497608},
        colour_grind = {r = 0.3799999952316284, g = 0.8389999866485596, b = 0.8389999866485596},
    }
end
local settings = default_settings()
local function load_settings()
    local text = reskate.files.read("settings.json")
    if not text then return end
    local ok, t = pcall(reskate.json.decode, text)
    if not ok or type(t) ~= "table" then return end
    for k, v in pairs(settings) do
        if t[k] ~= nil and type(t[k]) == type(v) then settings[k] = t[k] end
    end
    if settings.corner < 1 or settings.corner > #CORNERS then settings.corner = 1 end
    if settings.layout < 1 or settings.layout > #LAYOUTS then settings.layout = 1 end
    if settings.grade_style < 1 or settings.grade_style > #GRADE_STYLES then settings.grade_style = 4 end
    if settings.pack_style < 1 or settings.pack_style > #PACK_STYLES then settings.pack_style = 1 end
    if settings.title_face < 1 or settings.title_face > #TITLE_FACES then settings.title_face = 4 end
    if t.badge == false then settings.pack_style = 4 end -- the older on/off switch
    if not (settings.pop_cut_mid > 0 and settings.pop_cut_mid < settings.pop_cut_high) then
        settings.pop_cut_mid, settings.pop_cut_high = 3.135, 3.52
    end
    if t.on ~= nil then hud.on = t.on and true or false end
end
local function save_settings()
    local out = {on = hud.on}
    for k, v in pairs(settings) do out[k] = v end
    write_json("settings.json", out)
end

local function strip_push(entry)
    hud.strip[#hud.strip + 1] = entry
    if #hud.strip > STRIP_MAX then table.remove(hud.strip, 1) end
end

-- The pop's grade from the launch itself, for a pop the Studio gives no grade for (a stock trick, no relay). The
-- up-speed of an ordinary pop sorts the game's low / mid / high: on 2026-11-15, 77 of 86 pops the game had graded
-- came out right at 3.135 / 3.52 m/s (air time at the Studio's 0.45 / 0.65 s: 40 of 86). The misses are pops off
-- a slope, where the ground adds to the up-speed. The cutoffs follow the game: every pop the Studio reports with
-- the game's own grade is a sample, and with enough of them the cutoffs move to where they split the samples best
-- (the trainer's ollie strength moves the speeds). Only the cutoffs are kept (settings.json), not the samples.
local CAL_KEEP, CAL_NEED = 40, 8
local cal = {low = {}, mid = {}, high = {}}
local function best_cut(lower, upper, fallback)
    if #lower < CAL_NEED or #upper < CAL_NEED then return fallback end
    local function median(t)
        local s = {}
        for i, v in ipairs(t) do s[i] = v end
        table.sort(s)
        return s[math.ceil(#s / 2)]
    end
    local all = {}
    for _, v in ipairs(lower) do all[#all + 1] = v end
    for _, v in ipairs(upper) do all[#all + 1] = v end
    table.sort(all)
    local middle = (median(lower) + median(upper)) / 2
    local best, best_err, best_far = fallback, math.huge, math.huge
    for i = 1, #all - 1 do
        if all[i + 1] > all[i] then
            local c = (all[i] + all[i + 1]) / 2
            local err = 0
            for _, v in ipairs(lower) do if v >= c then err += 1 end end
            for _, v in ipairs(upper) do if v < c then err += 1 end end
            local far = math.abs(c - middle)
            if err < best_err or (err == best_err and far < best_far) then best, best_err, best_far = c, err, far end
        end
    end
    return best
end
local function cal_sample(grade, up)
    local t = cal[grade]
    if not t or type(up) ~= "number" then return end
    t[#t + 1] = up
    if #t > CAL_KEEP then table.remove(t, 1) end
    local own = false
    if #cal.low >= CAL_NEED and #cal.mid >= CAL_NEED and not settings.pop_cut_mid_own then settings.pop_cut_mid_own, own = true, true end
    if #cal.mid >= CAL_NEED and #cal.high >= CAL_NEED and not settings.pop_cut_high_own then settings.pop_cut_high_own, own = true, true end
    if own then save_settings() end
    local a = best_cut(cal.low, cal.mid, settings.pop_cut_mid)
    local b = best_cut(cal.mid, cal.high, settings.pop_cut_high)
    if a < b and (math.abs(a - settings.pop_cut_mid) > 0.01 or math.abs(b - settings.pop_cut_high) > 0.01) then
        settings.pop_cut_mid, settings.pop_cut_high = a, b
        save_settings()
    end
end
local function launch_grade(l)
    if not l or l.from ~= "ollie" or type(l.up) ~= "number" then return nil end
    return l.up < settings.pop_cut_mid and "low" or l.up < settings.pop_cut_high and "mid" or "high"
end

-- The Studio writes "n_varialheelflip" for a nollie, the game may name the base trick with the stance apart:
-- compare without stance prefixes, and let one id contain the other.
local function same_trick(a, b)
    if not a or not b then return true end -- nothing to compare: trust the timing
    local function key(s)
        s = tostring(s):lower():gsub("[^%w]", "")
        s = s:gsub("^n_?", ""):gsub("^nollie", ""):gsub("^fakie", ""):gsub("^switch", "")
        return s
    end
    local ka, kb = key(a), key(b)
    return ka == kb or ka:find(kb, 1, true) ~= nil or kb:find(ka, 1, true) ~= nil
end
-- ---- the trick as the game itself names it ---------------------------------------------------
-- EnumGS.Anim.CurrentFlipTrick is the trick the game has in mind: set at the flick (about 10 ticks before the pop),
-- still changing while the stick moves, kept through the air, where it changes again when the trick becomes another
-- one, and back to None at the landing. The overlay takes two things from it that nothing else tells:
-- - the trick of the pop (launch.flick), where the game's name in the air is another one. Measured 2026-11-23, three
--   impossibles and a front foot impossible: reskate.animation.trick() said "popshuvit" ("fspopshuvit" for the front
--   foot one) from the takeoff to the landing, Animator Studio reads the same name and so chose (and played) a
--   Pop Shuv-it or logged "popshuvit uses native animation", and this value said Impossible / FrontFoot_Impossible
--   at the launch and through the whole air. The Studio's choice is still that pop's: only the name is wrong (pop_id).
-- - that a flip was a hospital flip (launch.variant), with the board's own turn. Nothing names one: through six
--   hospital flips that day reskate.animation.trick() said "kickflip" from the takeoff to the landing, so did the
--   Studio, and this value stayed at Kickflip (its HospitalFlip, 51, and its underflips were never set; the Trainer's
--   source says the same of an underflip, and the game's Is.Underflip values are not among the 158 a plugin is given).
--   Recorded 18:03 (reports/2026-11-23-hospital-flip): in 3 of 3 hospital flips Bool.Anim.BoardBackwards changed 4 to
--   10 ticks before the landing and the board's yaw ended 176 to 184 degrees from where it began, under a rider whose
--   own yaw (MountYaw) did not move; in 2 of 2 plain kickflips neither did (6 degrees). The game has hospital clips
--   of four tricks (*_hospital_flip_*, *_hospital_heelflip_*, o_ and n_): the kickflip's and the heelflip's are measured.
-- - that a flip had an underflip, the same way. Recorded 18:17 (the same report, underflip/): in 3 of 3 kickflip
--   underflips Bool.Physics.IsBoardUpright came on twice in the air (for one tick at air tick 13 or 14, then from 20
--   or 21) and the board did not end turned; in 37 of 37 plain kickflips, 3 of 3 hospital flips and a varial kickflip
--   it came on once. A 360 flip comes on twice by itself (2 of 2, 2026-11-20), so this names only the four tricks
--   below. A flip held into a double one comes on twice too, with the flip value still at Kickflip (1 of 1, 18:25):
--   what tells the two is when the board is first back on its wheels. From the takeoff: 316 to 318 ms in 34 plain
--   kickflips and a heelflip, 317 ms in the double kickflip (for 3 ticks, then 11 ticks round again), 183 to 235 ms
--   in 6 underflips (for 1 tick, then 5 or 6 ticks back). So: earlier than the trick's plain pop = an underflip; at
--   its own time and round again = a double flip. The plain time is the player's own, kept from each plain pop.
--   NOT measured: the nollies'; a triple flip; the underflips of the shuv-its and the impossibles, which are not named.
-- The names are the game's own, in the order of its values from 1 (0 is None): trainer_gamestate.cpp, game_trick_names.
local FLIP_VALUE = "Animation/Dingo/EnumGS.Anim.CurrentFlipTrick"
local FLIP_NAMES = {"Ollie", "Kickflip", "Heelflip", "PopShuvit", "VarialKickflip", "InwardHeelflip", "FSPopShuvit", "VarialHeelflip", "Hardflip",
    "360PopShuvit", "360Flip", "360InwardHeelflip", "FS360PopShuvit", "Laserflip", "360Hardflip", "Nollie", "N_Kickflip", "N_Heelflip",
    "N_PopShuvit", "N_Hardflip", "N_VarialHeelflip", "N_FSPopShuvit", "N_VarialKickflip", "N_InwardHeelflip", "N_FS360PopShuvit",
    "N_360Hardflip", "N_Laserflip", "N_360PopShuvit", "N_360Flip", "N_360InwardHeelflip", "OlliePop", "N_OlliePop", "Wallie", "FSWallie",
    "BSWallie", "Impossible", "FrontFoot_Impossible", "N_Impossible", "N_BackFoot_Impossible", "LateFlipTrick", "HeldFlipTrick", "BonedOllie",
    "KickflipUnderflip", "HeelflipUnderflip", "BSPopShuvitUnderflip", "FSPopShuvitUnderflip", "NollieKickflipUnderflip",
    "NollieHeelflipUnderflip", "NollieBSPopShuvitUnderflip", "NollieFSPopShuvitUnderflip", "HospitalFlip", "FlowerFlip", "NollieHospitalFlip",
    "NollieFlowerFlip", "ImpossibleUnderflip", "FrontFootImpossibleUnderflip", "NollieImpossibleUnderflip", "NollieBackFootImpossibleUnderflip"}
local FLIP_GROUND = 39 -- up to N_BackFoot_Impossible: the tricks a pop starts with. The later values were never seen set.
local BACK_VALUE = "Animation/Dingo/Bool.Anim.BoardBackwards"
local UPRIGHT_VALUE = "Animation/Dingo/Bool.Physics.IsBoardUpright"
-- What a flip the game keeps in mind is called, by the trick it started as: first when the board ends turned end for
-- end under the rider, then when it comes back onto its wheels twice.
local AIR_NAMES = {kickflip = {"Hospital Flip", "Kickflip Underflip", "Double Kickflip", "Triple Kickflip"},
    heelflip = {"Hospital Heelflip", "Heelflip Underflip", "Double Heelflip", "Triple Heelflip"},
    n_kickflip = {"Nollie Hospital Flip", "Nollie Kickflip Underflip", "Nollie Double Kickflip", "Nollie Triple Kickflip"},
    n_heelflip = {"Nollie Hospital Heelflip", "Nollie Heelflip Underflip", "Nollie Double Heelflip", "Nollie Triple Heelflip"}}
-- When a plain flip's board is first back on its wheels, in ms from the launch (which is told a tick or two before the
-- air): 340 until the player's own plain pops of that trick say (plain_ms, this session; note_jump keeps it).
local PLAIN_MS = 340
local plain_ms = {}
-- A trick a pop starts with (lower case), as the Studio and the game in the air spell it, where that differs. The
-- impossibles are named by the foot there, the ollie's being the back foot's and the nollie's the front foot's
-- (anim_runtime_rules.h, flip_trick_key); a quick pop is an ollie in the air.
local FLICK_ID = {impossible = "bsimpossible", frontfoot_impossible = "fsimpossible", n_impossible = "n_fsimpossible",
    n_backfoot_impossible = "n_bsimpossible", olliepop = "ollie", n_olliepop = "nollie"}
local function read_flip() -- the value now (nil while it is None), why it could not be read, every animation value
    local ok, values = pcall(reskate.skater.animation_values)
    if not ok or type(values) ~= "table" then return nil, "no values", nil end
    local v = values[FLIP_VALUE]
    if type(v) ~= "table" or type(v.value) ~= "number" then return nil, nil, values end -- not listed while it is None
    return v.value, nil, values
end
local function set_flick(l, name) -- the trick a launch (hud.launch) started with: the game's name and the Studio's id
    l.flick = name
    l.flick_id = not name:find("wallie", 1, true) and (FLICK_ID[name] or name) or nil -- a wallie is no trick of the Studio's
end
-- One reading for a launch: at the launch itself, then every tick of its air (one read is 0.1 ms).
local function flip_sample(l)
    local v, _, values = read_flip()
    -- the board against the way it sat at the launch: turned end for end under the rider, or not
    local back = values and values[BACK_VALUE]
    if type(back) == "table" and type(back.value) == "boolean" then
        if l.back0 == nil then l.back0 = back.value end
        l.turned = back.value ~= l.back0
    end
    -- the board back on its wheels, each time it comes there from off them
    local up = values and values[UPRIGHT_VALUE]
    if type(up) == "table" and type(up.value) == "boolean" then
        if up.value and l.up_last == false then
            l.overs = (l.overs or 0) + 1
            if l.overs == 1 then l.over_ms = now() - l.at elseif l.overs == 2 then l.over2_ms = now() - l.at end
        end
        l.up_last = up.value
    end
    if v then
        local name = FLIP_NAMES[v] and string.lower(FLIP_NAMES[v]) or tostring(v)
        if v <= FLIP_GROUND and not l.flick then set_flick(l, name) end
        l.flick_held = name == l.flick -- still the trick it started with, at the last reading
        -- every value in the order it came (at most 8): what the game said through this pop, kept in the history
        l.flips = l.flips or {}
        if l.flips[#l.flips] ~= name and #l.flips < 8 then l.flips[#l.flips + 1] = name end
    end
    local names = l.flick_held and AIR_NAMES[l.flick]
    local variant = nil
    if names and l.turned then
        variant = names[1]
    elseif names and (l.overs or 0) >= 2 and l.over_ms and l.over2_ms then
        if l.over_ms < 0.85 * (plain_ms[l.flick] or PLAIN_MS) then variant = names[2] -- back early: turned back, an underflip
        elseif l.over2_ms - l.over_ms >= 0.4 * l.over_ms then variant = names[l.overs >= 3 and 4 or 3] end -- round again at its own pace
    end
    l.variant = variant
end
-- The id a pop is named by, given the id something else names it by (the Studio's trick, the game's name in the air):
-- the flip value's own trick when the other id is missing, or is another trick while the game kept its own from the
-- launch to the last reading. A trick the game changed in the air (a late flip) keeps the name it had before this rule.
local function pop_id(l, id)
    if not l or not l.flick_id then return id end
    if not id or id == "(no trick)" then return l.flick_id end
    if l.flick_held and not same_trick(id, l.flick_id) then return l.flick_id end
    return id
end

-- Is the Studio's choice about the last pop? The relay numbers each choice (sel) and sel_at is when that number
-- moved on, so the choice's later lines, the trainer and the packs do not make an old choice look new. The Studio
-- chooses at the flick, about 0.2 s before the launch, and the relay is up to 0.5 s behind: the choice is this
-- pop's when it came no more than 1.5 s before the launch, after the landing before it, and not after this pop
-- landed (that one is for the next pop).
local function studio_fresh()
    local s, l = hud.studio, hud.launch
    if not s or not l or not s.sel_at or not (s.played or s.native) then return false end
    if s.sel_at < l.at - 1500 then return false end
    if l.after and s.sel_at < l.after then return false end
    if s.grade == "grind" then return true end -- a grind follows the pop onto the rail: timing is all we have
    if l.landed and s.sel_at > l.landed + 250 then return false end
    -- the Studio names the game's trick id; a different id than the one seen in this air is another pop's choice
    local seen = hud.air_trick
    if not seen and hud.trick and hud.trick.at >= l.at then seen = hud.trick.name end
    return same_trick(s.trick, seen)
end

-- A jump counts once telemetry.last.serial moves on; board_landed can come before or after that, so each attaches
-- to the other when it is less than a second old.
local pending_landing = nil
local history_id = 0
local function note_jump(last)
    history_id += 1
    local entry = {id = history_id, serial = last.serial, air = last.air_time, height = last.height,
        takeoff = last.takeoff_speed, at = now(), name = hud.air_trick, telemetry = scalars(last)}
    -- Keep each jump's context: browsing history must not show today's live settings on an older pop.
    if hud.launch and math.abs(entry.at - hud.launch.at - (last.air_time or 0) * 1000) < 1000 then
        entry.launch = scalars(hud.launch)
        entry.launch_at = hud.launch.at -- a choice of the Studio that arrives late still finds its jump (resolve)
        -- the game's own flip value through this pop: at the launch, what it became in the air, every value in order
        entry.flick, entry.variant, entry.turned, entry.overs = hud.launch.flick, hud.launch.variant, hud.launch.turned, hud.launch.overs
        entry.over_ms = hud.launch.over_ms and math.floor(hud.launch.over_ms + 0.5) or nil
        -- a plain pop of a trick (once onto its wheels, the board as it sat) says when that trick's flip is over
        local hl = hud.launch
        if hl.flick and hl.flick_held and hl.overs == 1 and not hl.turned and hl.over_ms then
            plain_ms[hl.flick] = plain_ms[hl.flick] and (0.7 * plain_ms[hl.flick] + 0.3 * hl.over_ms) or hl.over_ms
        end
        entry.flips = hud.launch.flips and table.concat(hud.launch.flips, " > ") or nil
        local named = pop_id(hud.launch, entry.name)
        if named ~= entry.name then entry.named = named end -- titled by the flip value's trick: name stays the game's name in the air
        entry.grade_est = launch_grade(hud.launch)
        hud.launch.landed = hud.launch.landed or entry.at
    end
    if hud.studio then entry.trainer = scalars(hud.studio.trainer) end
    if studio_fresh() then
        entry.clip, entry.pack, entry.grade = hud.studio.played, hud.studio.pack, hud.studio.grade
        entry.stance = hud.studio.stance
        entry.lets_go = hud.studio.lets_go
    end
    if pending_landing and now() - pending_landing.at < 1000 then
        entry.down, entry.along, entry.onto = pending_landing.down, pending_landing.along, pending_landing.onto
        pending_landing = nil
    end
    strip_push(entry)
end

local function note_landing(e)
    local l = {down = e.down_speed, along = e.speed, onto = e.onto, at = now()}
    hud.landing = l
    local newest = hud.strip[#hud.strip]
    if newest and newest.down == nil and now() - newest.at < 1000 then
        newest.down, newest.along, newest.onto = l.down, l.along, l.onto
    else
        pending_landing = l
    end
end

-- ---- the trick the game has in mind on the ground ---------------------------------------------
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

-- ---- events -------------------------------------------------------------------------------
reskate.on("trick_landed", function(e)
    hud.trick = {name = e.name, ms = e.ms, points = e.points, multiplier = e.multiplier, at = now()}
end)
reskate.on("launch", function(e)
    hud.launch = {from = e.from, up = e.velocity.y, along = e.travel_speed, at = now(), after = hud.landing and hud.landing.at}
    -- the trick the game has in mind as it leaves the ground; else what the last tick on the ground read of it
    pcall(flip_sample, hud.launch)
    if not hud.launch.flick and ground.seen and ground.seen_at and now() - ground.seen_at < 250 then set_flick(hud.launch, ground.seen) end
end)
reskate.on("board_landed", function(e)
    if hud.launch and not hud.launch.landed then hud.launch.landed = now() end
    note_landing(e)
end)
reskate.on("bail", function() hud.bail = {at = now()} end)

-- ---- the relay's file -------------------------------------------------------------------------
-- studio.json is the relay's account of the Studio's log lines (relay/pop-doctor-relay.mjs): what played, the pop grade, when
-- it let go, and the trainer's options. Re-decoded only when the text changes; seen_at dates it on the game's clock.
local function read_studio()
    local text = reskate.files.read("studio.json")
    if text == hud.studio_text then return end
    hud.studio_text = text
    if not text then hud.studio = nil; return end
    local ok, t = pcall(reskate.json.decode, text)
    if ok and type(t) == "table" then
        t.seen_at = now()
        if t.sel == nil then
            hud.sel, hud.sel_at = nil, t.seen_at -- a relay from before sel: every write counts as news, as it did
        elseif t.sel ~= hud.sel then
            -- the first choice read is from before we were loaded: it is about no pop of ours
            hud.sel_at = hud.sel_seen and t.seen_at or nil
            hud.sel, hud.sel_seen = t.sel, true
        end
        t.sel_at = hud.sel_at
        hud.studio = t
    end
end

reskate.time.every(POLL_MS, read_studio)

-- ---- the overlay ----------------------------------------------------------------------------
-- A small block in a corner (settings.corner), up to three lines: the trick, the animation and its pack, the pop
-- grade. Which lines, how big, where, the colours and a fade are settings (F2 page). Redrawn every tick.
local function fmt(n, places) return n == nil and "-" or string.format("%." .. (places or 1) .. "f", n) end
local function age_s(at) return at and string.format("%.0f s", (now() - at) / 1000) or "" end
local function hex(c, alpha)
    local function b(x) return math.clamp(math.floor((x or 0) * 255 + 0.5), 0, 255) end
    local s = string.format("#%02x%02x%02x", b(c.r), b(c.g), b(c.b))
    if alpha then s ..= string.format("%02x", b(alpha)) end
    return s
end
local function grade_colour(grade)
    local c = settings["colour_" .. tostring(grade)]
    return c and hex(c) or "#767676" -- no grade: the CLI's DarkGray
end

-- The game's trick id ("fspopshuvit") as the Studio names it ("FS Pop Shuv-it"): the relay sends a names map
-- built from the trick files. The relay only knows the tricks that have a Studio trick installed, so a player
-- with one small pack gets few names from it: TRICK_NAMES holds the game's flip tricks and stands in. An id
-- neither knows is shown with a capital.
local TRICK_NAMES = {
    ollie = "Ollie", olliepop = "Ollie", nollie = "Nollie", n_olliepop = "Nollie",
    kickflip = "Kickflip", heelflip = "Heelflip", popshuvit = "Pop Shuv-it", fspopshuvit = "FS Pop Shuv-it",
    varialkickflip = "Varial Kickflip", varialheelflip = "Varial Heelflip", hardflip = "Hardflip",
    inwardheelflip = "Inward Heelflip", laserflip = "Laser Flip",
    ["360flip"] = "360 Flip", ["360popshuvit"] = "360 Pop Shuv-it", fs360popshuvit = "FS 360 Pop Shuv-it",
    ["360hardflip"] = "360 Hardflip", ["360inwardheelflip"] = "360 Inward Heelflip",
    bsimpossible = "BF Impossible", fsimpossible = "FF Impossible",
    impossible = "BF Impossible", frontfoot_impossible = "FF Impossible",
    n_kickflip = "Nollie Kickflip", n_heelflip = "Nollie Heelflip", n_popshuvit = "Nollie Pop Shuv-it",
    n_fspopshuvit = "Nollie FS Pop Shuv-it", n_varialkickflip = "Nollie Varial Kickflip",
    n_varialheelflip = "Nollie Varial Heelflip", n_hardflip = "Nollie Hardflip",
    n_inwardheelflip = "Nollie Inward Heelflip", n_laserflip = "Nollie Laser Flip",
    n_360flip = "Nollie 360 Flip", n_360popshuvit = "Nollie 360 Pop Shuv-it",
    n_fs360popshuvit = "Nollie FS 360 Pop Shuv-it", n_360hardflip = "Nollie 360 Hardflip",
    n_360inwardheelflip = "Nollie 360 Inward Heelflip",
    n_bsimpossible = "Nollie BF Impossible", n_fsimpossible = "Nollie FF Impossible",
    n_backfoot_impossible = "Nollie BF Impossible", n_impossible = "Nollie FF Impossible",
    wallie = "Wallie", fswallie = "FS Wallie", bswallie = "BS Wallie",
}
local function title_case(s)
    if not s or s == "" then return nil end
    local names = hud.studio and hud.studio.names
    if type(names) == "table" and names[s] then return names[s] end
    local known = TRICK_NAMES[string.lower(s)]
    if known then return known end
    return (s:gsub("^%l", string.upper))
end

-- The animation line of a pop the Studio played nothing for.
local function stock_clip()
    local clip = "Stock"
    if not hud.studio then clip = "relay not running" end
    return clip
end
-- Settles what the last pop was, once: the Studio's choice for it as soon as that is known (and again while it is
-- this pop's, so a regrade in the air shows), or "Stock" when the pop has landed and the Studio stayed silent for
-- all of it. Until one of the two is true the lines on screen stay as they were: "Stock" is a finding, not the
-- absence of news. A pop settled as stock still turns into the Studio's when its choice arrives late.
local STOCK_AFTER_MS = 700 -- the relay is up to 0.5 s behind the flick, which is before the launch
local function resolve()
    local l = hud.launch
    if not l then return end
    local s = hud.studio
    if studio_fresh() then
        local seen = hud.air_trick
        if not seen and hud.trick and hud.trick.at >= l.at then seen = hud.trick.name end
        local name
        -- the Studio's choice is tied to the flick it answered: its trick id names the line, not our in-air read
        if s.grade == "grind" and s.trick then name = s.trick
        else name = l.variant or title_case(pop_id(l, s.trick or seen)) or (hud.shown and hud.shown.name) or "?" end -- what it became in the air, else the trick the game popped
        l.resolved = "studio"
        hud.shown = {name = name, clip = s.native and stock_clip() or s.played, pack = s.pack,
            grade = s.grade or launch_grade(l), launch_at = l.at}
        -- the jump is in the history already when the choice came after its landing
        local e = hud.strip[#hud.strip]
        if e and e.launch_at == l.at then
            if s.native then e.grade = e.grade or s.grade
            elseif s.played then
                e.clip, e.pack, e.grade, e.stance = s.played, s.pack, s.grade, s.stance
                e.lets_go = s.lets_go or e.lets_go
            end
        end
        -- a pop the game itself graded teaches the launch-speed cutoffs (once, at its landing: a regrade is in by then)
        if l.landed and not l.sampled then
            l.sampled = true
            if s.graded_by == "game" and not s.inferred and not s.native and l.from == "ollie" then cal_sample(s.grade, l.up) end
        end
    elseif not l.resolved and l.landed and hud.trick and hud.trick.at >= l.at and now() - l.at > STOCK_AFTER_MS then
        l.resolved = "stock"
        hud.shown = {name = l.variant or title_case(pop_id(l, hud.trick.name)) or "?", clip = stock_clip(), grade = launch_grade(l), launch_at = l.at}
    end
end

-- What the three lines say right now.
local function overlay_lines()
    resolve()
    local sh = hud.shown
    if sh then
        local pack = sh.pack
        if pack == "" then pack = "no pack" end
        return sh.name, sh.clip, pack, sh.grade
    end
    -- no pop settled yet
    local tr = hud.trick
    return tr and title_case(tr.name) or "no trick yet", (not hud.studio) and stock_clip() or nil, nil, nil
end

-- Text cannot be measured (no API), so anything drawn after a text run sits where an estimate puts it. One average
-- per character failed both ways ("Kickflip" is narrow, "BS Boardslide" wide), so each glyph has a class, as a share
-- of the text height. Calibrated 2026-11-09 on: "Kickflip" bold 45 px = 145 px; "BS Boardslide" bold 45 px = 250 px;
-- "Kickflip low · low pop" body 24 px = 215 px; a 48-char body line at 24 px = 490 px. All within ~5 %.
local GLYPH = {narrow = 0.30, caps = 0.55, wide = 0.85, digit = 0.55, lower = 0.48, r = 0.35, s = 0.45}
local function text_width(text, px)
    local w = 0
    for _, c in utf8.codes(text) do
        local ch = utf8.char(c)
        if ch:match("[iljtfI'.,:;| ·%-]") then w += GLYPH.narrow
        elseif ch:match("[mwMW]") then w += GLYPH.wide
        elseif ch == "r" then w += GLYPH.r
        elseif ch == "s" then w += GLYPH.s
        elseif ch:match("%u") then w += GLYPH.caps
        elseif ch:match("%d") then w += GLYPH.digit
        else w += GLYPH.lower end
    end
    return w * px
end
-- The pop grade's label per style (GRADE_STYLES); "dot" draws no text, "badge" uses the short label.
local GRADE_LABELS = {
    letter = {low = "L", mid = "M", high = "H", grind = "G"},
    short = {low = "Low", mid = "Med", high = "High", grind = "Grind"},
    word = {low = "LOW", mid = "MEDIUM", high = "HIGH", grind = "GRIND"},
    pop = {low = "low pop", mid = "mid pop", high = "high pop", grind = "grind"},
}
GRADE_LABELS.badge = GRADE_LABELS.short

-- A pack's badge: a small rounded box in a colour of its own (from a hash of its name), the name in white on it.
-- The "auto" colour of a pack: a hue from a hash of its name (saturation 0.55, lightness 0.38), as {r, g, b}.
local function pack_auto_rgb(pack)
    local h = 0
    for i = 1, #pack do h = (h * 31 + pack:byte(i)) % 360 end
    local s, l = 0.55, 0.38
    local c = (1 - math.abs(2 * l - 1)) * s
    local x = c * (1 - math.abs((h / 60) % 2 - 1))
    local m = l - c / 2
    local r, g, b
    if h < 60 then r, g, b = c, x, 0 elseif h < 120 then r, g, b = x, c, 0 elseif h < 180 then r, g, b = 0, c, x
    elseif h < 240 then r, g, b = 0, x, c elseif h < 300 then r, g, b = x, 0, c else r, g, b = c, 0, x end
    return {r = r + m, g = g + m, b = b + m}
end
-- The badge's colour under the pack style: one colour for all, the pack's own pick, or the auto colour.
local function pack_rgb(pack)
    local style = PACK_STYLES[settings.pack_style]
    if style == "one colour" then return settings.pack_colour end
    if style == "per pack" and settings.pack_colours[pack] then return settings.pack_colours[pack] end
    return pack_auto_rgb(pack)
end
local function pack_colour(pack)
    if not pack or pack == "" or pack == "no pack" then return "#4a5058" end
    return hex(pack_rgb(pack))
end
-- Draws the badge with its near edge at x (its left edge when right is false, its right edge when true), its top at
-- y; returns its width. px is the badge text's height in window pixels.
local function badge_width(d, pack, px, k)
    local ok, size = pcall(d.measure, d, pack, {size = px / (d:size().y / 1080)})
    local w = (ok and type(size) == "vector" and size.x > 0) and size.x or text_width(pack, px)
    return w + 16 * k
end
local function draw_badge(d, x, y, pack, px, k, right)
    local w, h = badge_width(d, pack, px, k), px * 1.5
    local x0 = right and (x - w) or x
    d:rect(vector.create(x0, y, 0), vector.create(x0 + w, y + h, 0), {colour = pack_colour(pack), fill = true, rounding = 5 * k})
    d:text(vector.create(x0 + w / 2, y + px * 0.2, 0), pack, {size = px / (d:size().y / 1080), colour = "#ffffff", align = "centre", shadow = false})
    return w
end

local function draw_overlay(d)
    if not hud.on then return end
    if settings.fade_s > 0 then
        local last = hud.landing and hud.landing.at or (hud.trick and hud.trick.at)
        local okt, t = pcall(reskate.skater.telemetry)
        local airborne = okt and t and t.airborne
        if not airborne and (not last or now() - last > settings.fade_s * 1000) then return end
    end
    local screen = d:size()
    local k = screen.y / 1080 * settings.scale
    local u = screen.y / 1080 -- window pixels per 1080p pixel, before the size setting
    -- baked sizes, in window pixels (x the size setting; above 1 the bitmaps stretch and soften)
    local tf = TITLE_FONT[settings.title_face]
    local TPX = TITLE_PX[settings.title_face] * settings.scale -- the trick line
    local BPX = 17 * settings.scale                           -- the body line (clip)
    local GPX = 22 * settings.scale                           -- heading: the grade text, the one-line title
    local font_choice = TEXT_FONTS[settings.image_font] or TEXT_FONTS[1]
    local imgs = font_choice and TEXT_IMAGES[font_choice.folder] or nil
    local as_image = TITLE_FACES[settings.title_face] == "image" and imgs ~= nil and type(imgs.glyphs) == "table"
    if as_image then TPX = TITLE_PX[settings.title_face] * u * settings.scale end -- a picture: scales with the window
    -- Declared before glyph_text, which reads right: declared after it, the name was a global there and always nil.
    local corner = CORNERS[settings.corner]
    local right = corner:find("right") ~= nil
    -- Text from the bitmap font (tool/render-text.ps1): each glyph is a cell of a 512 px sheet, drawn through
    -- d:image's uv window and tinted; the pen moves by the glyph's advance. px is the em in window pixels; the
    -- near edge is at x, the em box's top at y. Returns the width. A character the sheet lacks takes a space.
    local function glyph_text(text, x, y, px, colour, draw)
        local f = imgs
        local scale = px / f.em
        local cellw = f.cell * scale
        local w = 0
        for _, c in utf8.codes(text) do
            local g = f.glyphs[tostring(c)] or f.glyphs["32"]
            if g then w += g.adv * scale end
        end
        if draw then
            local pen = right and (x - w) or x
            for _, c in utf8.codes(text) do
                local g = f.glyphs[tostring(c)] or f.glyphs["32"]
                if g then
                    local x0 = pen - f.pad * scale
                    d:image(f.sheets[g.s + 1], vector.create(x0, y, 0), vector.create(x0 + cellw, y + cellw, 0),
                        {colour = colour or "#ffffff", uv = {g.x / f.size, g.y / f.size, (g.x + g.w) / f.size, (g.y + f.cell) / f.size}})
                    pen += g.adv * scale
                end
            end
        end
        return w
    end
    local name, clip, pack, grade = overlay_lines()

    local gstyle = GRADE_STYLES[settings.grade_style]
    local labels = GRADE_LABELS[gstyle]
    -- No label when the Studio has no grade; the dot style has no text either.
    local word = nil
    if labels and grade then word = labels[grade] or grade end
    local bottom = corner:find("bottom") ~= nil
    local margin = settings.margin * u
    local sign = right and -1 or 1
    local align = right and "right" or "left"
    local backing = {colour = hex({r = 0, g = 0, b = 0}, settings.backing_alpha), fill = true, rounding = 8}
    -- the pack: inline text, or a badge drawn after the line it belongs to
    local show_pack = settings.show_pack and pack ~= nil
    local as_badge = show_pack and PACK_STYLES[settings.pack_style] ~= "off"
    local bpx = math.min(14 * settings.scale * u, BPX) -- the badge text's height, never above the body's baked size
    local bw = as_badge and badge_width(d, pack, bpx, k) or 0
    local GAP = 10 * k
    -- d:measure gives the drawn width exactly (the game's own font atlas); the glyph table is the fallback for a
    -- build without it, or before the overlay's first frame when measure guesses.
    local function est(text, px, font)
        local ok, size = pcall(d.measure, d, text, {size = px / u, font = font})
        if ok and type(size) == "vector" and size.x > 0 then return size.x end
        return text_width(text, px)
    end

    -- The trick's name, px tall, its near edge at x: the pre-rendered picture when the face is "image" and one exists
    -- for the name, else text in the face. Returns the width.
    local function draw_name(x, y, px, font, draw)
        if as_image then return glyph_text(name, x, y, px * 0.85, "#ffffff", draw) end -- em 0.85 x the line: caps fill it
        if draw then d:text(vector.create(x, y, 0), name, {size = px / u, colour = "#ffffff", align = align, font = font}) end
        return est(name, px, font)
    end

    -- Every layout uses the two-line title's grade size. The row height only controls alignment.
    local grade_text_px = as_image and TPX * 0.5 or math.min(TPX * 0.6, GPX)
    local grade_badge_px = as_image and TPX * 0.42 or math.min(TPX * 0.62, BPX)
    local grade_dot_r = TPX * 0.22
    local grade_height = gstyle == "dot" and grade_dot_r * 2
        or (gstyle == "badge" and grade_badge_px * 1.45)
        or (as_image and grade_text_px * imgs.cell / imgs.em or grade_text_px)
    local grade_visible = settings.show_grade and grade and grade ~= "" and (grade ~= "grind" or settings.show_grinds)
    local grade_row_px = math.max(GPX, grade_visible and grade_height or 0)

    -- The grade mark in the chosen style, its near edge at x and its line's top at y, for a line of text px tall.
    -- Draws when draw is true; returns the width it takes either way.
    local function grade_mark(x, y, px, draw)
        if not grade or grade == "" then return 0 end
        if grade == "grind" and not settings.show_grinds then return 0 end -- grinds: no mark unless asked
        local colour = grade_colour(grade)
        if gstyle == "dot" then
            local r = grade_dot_r
            if draw then d:circle(vector.create(x + sign * r, y + px * 0.55, 0), r, {colour = colour, fill = true}) end
            return r * 2
        end
        if gstyle == "badge" then
            local bpx = grade_badge_px
            local tw = as_image and glyph_text(word, 0, 0, bpx, nil, false) or est(word, bpx)
            local w, h = tw + 12 * k, bpx * 1.45
            if draw then
                local x0 = right and (x - w) or x
                local y0 = y + (px * 1.1 - h) / 2
                d:rect(vector.create(x0, y0, 0), vector.create(x0 + w, y0 + h, 0), {colour = grade and colour or "#4a5058", fill = true, rounding = 4 * k})
                if as_image then
                    local save = right; right = false -- the word runs left to right from its centred start
                    glyph_text(word, x0 + (w - tw) / 2, y0 + (h - bpx * 1.25) / 2, bpx, "#ffffff", true)
                    right = save
                else
                    d:text(vector.create(x0 + w / 2, y0 + bpx * 0.2, 0), word, {size = bpx / u, colour = "#ffffff", align = "centre", shadow = false})
                end
            end
            return w
        end
        -- text styles: a little smaller than the line, on its baseline
        if as_image then
            local gpx = grade_text_px -- the em; capitals come out about 0.7 of it
            return glyph_text(word, x, y + (px - gpx) * 0.55, gpx, colour, draw)
        end
        local gpx = grade_text_px -- the heading face, never above its baked size
        if draw then d:text(vector.create(x, y + (px - gpx) * 0.78, 0), word, {size = gpx / u, colour = colour, align = align, font = "heading"}) end
        return est(word, gpx, "heading")
    end

    -- "360 Flip  LOW": the trick, then the grade word in its colour, a little smaller, on the same baseline.
    -- Returns the width used.
    local function draw_title(x, y, px, font)
        local w = 0
        if settings.show_trick then w = draw_name(x, y, px, font or tf, true) end
        if settings.show_grade and grade_mark(0, 0, px, false) > 0 then
            local gap = w > 0 and GAP * 1.2 or 0
            w += gap + grade_mark(x + sign * (w + gap), y, px, true)
        end
        return w
    end
    local function title_width(px, font)
        local w = settings.show_trick and draw_name(0, 0, px, font or tf, false) or 0
        local gw = settings.show_grade and grade_mark(0, 0, px, false) or 0
        if gw > 0 then w += (w > 0 and GAP * 1.2 or 0) + gw end
        return w
    end
    -- "Kickflip low 4" then the pack badge (or the pack as text). Returns the width used.
    local function draw_detail(x, y, px)
        local parts = {}
        if settings.show_anim and clip then parts[#parts + 1] = clip end
        if show_pack and not as_badge then parts[#parts + 1] = pack end
        local text = table.concat(parts, "  ·  ")
        local w = 0
        if text ~= "" then
            d:text(vector.create(x, y, 0), text, {size = px / u, colour = "#c9ced4", font = "body", align = align})
            w = est(text, px, "body")
        end
        if as_badge then
            local bx = x + sign * (w + (w > 0 and GAP or 0))
            draw_badge(d, bx, y + (px * 1.1 - bpx * 1.5) / 2, pack, bpx, k, right)
            w += (w > 0 and GAP or 0) + bw
        end
        return w
    end
    local function detail_width(px)
        local parts = {}
        if settings.show_anim and clip then parts[#parts + 1] = clip end
        if show_pack and not as_badge then parts[#parts + 1] = pack end
        local text = table.concat(parts, "  ·  ")
        local w = text ~= "" and est(text, px, "body") or 0
        if as_badge then w += (w > 0 and GAP or 0) + bw end
        return w
    end

    local layout = LAYOUTS[settings.layout]
    local PAD = 16 * k

    if layout == "one line" then
        -- "360 Flip  LOW  ·  Kickflip low 4  [PACK]"
        local px = GPX -- the heading face at its baked size
        local tw, dw = title_width(px, "heading"), detail_width(BPX)
        if tw == 0 and dw == 0 then return end
        local sep = (tw > 0 and dw > 0) and GAP * 2 or 0
        local W = math.min(PAD * 2 + tw + sep + dw, screen.x - margin * 2)
        local row_px = math.max(px, grade_row_px)
        local H = row_px + 20 * k
        local x0 = right and (screen.x - margin - W) or margin
        local y0 = bottom and (screen.y - margin - H) or margin
        if settings.backing then d:rect(vector.create(x0, y0, 0), vector.create(x0 + W, y0 + H, 0), backing) end
        local x = right and (x0 + W - PAD) or (x0 + PAD)
        local title_y = y0 + 10 * k + (row_px - px) / 2
        local used = draw_title(x, title_y, px, "heading")
        draw_detail(x + sign * (used + sep), title_y + (px - BPX) * 0.7, BPX)
        return
    end

    if layout == "two lines" then
        -- "360 Flip  LOW" over "Kickflip low 4  [PACK]"
        local px1, px2 = TPX, BPX
        local tw, dw = title_width(px1), detail_width(px2)
        if tw == 0 and dw == 0 then return end
        local W = math.min(PAD * 2 + math.max(tw, dw), screen.x - margin * 2)
        local H = PAD * 2 + (tw > 0 and px1 * 1.15 or 0) + (dw > 0 and px2 * 1.3 or 0)
        local x0 = right and (screen.x - margin - W) or margin
        local y0 = bottom and (screen.y - margin - H) or margin
        if settings.backing then d:rect(vector.create(x0, y0, 0), vector.create(x0 + W, y0 + H, 0), backing) end
        local x = right and (x0 + W - PAD) or (x0 + PAD)
        local y = y0 + PAD
        if tw > 0 then draw_title(x, y, px1); y += px1 * 1.15 end
        if dw > 0 then draw_detail(x, y, px2) end
        return
    end

    -- three lines: the trick; the clip and the pack; the grade word in its colour on its own line
    local px1, px2, px3 = TPX, BPX, grade_row_px
    local tw = settings.show_trick and draw_name(0, 0, px1, tf, false) or 0
    local dw = detail_width(px2)
    local gw = settings.show_grade and grade_mark(0, 0, px3, false) or 0
    if tw == 0 and dw == 0 and gw == 0 then return end
    local W = math.min(PAD * 2 + math.max(tw, dw, gw, 240 * k), screen.x - margin * 2)
    local H = PAD * 2 + (tw > 0 and px1 * 1.15 or 0) + (dw > 0 and px2 * 1.4 or 0) + (gw > 0 and px3 * 1.2 or 0)
    local x0 = right and (screen.x - margin - W) or margin
    local y0 = bottom and (screen.y - margin - H) or margin
    if settings.backing then d:rect(vector.create(x0, y0, 0), vector.create(x0 + W, y0 + H, 0), backing) end
    local x = right and (x0 + W - PAD) or (x0 + PAD)
    local y = y0 + PAD
    if tw > 0 then
        draw_name(x, y, px1, tf, true)
        y += px1 * 1.15
    end
    if dw > 0 then draw_detail(x, y, px2); y += px2 * 1.4 end
    if gw > 0 then grade_mark(x, y, px3, true) end
end

-- The draw handler runs every tick: an error in it repeats every tick, and 5 errors in 10 s stop the plugin (which
-- happened twice on 2026-11-09). So it runs under xpcall, and a failure is logged with its traceback at most once
-- every 5 s while the rest of the plugin goes on.
local draw_failed_at = -1e9
reskate.on("draw", function(d)
    local ok, err = xpcall(draw_overlay, debug.traceback, d)
    if not ok and now() - draw_failed_at > 5000 then
        draw_failed_at = now()
        log("overlay draw failed: " .. tostring(err))
    end
end)

-- The strip takes a jump when telemetry.last.serial moves on. trick_landed only fires when the score HUD shows the
-- points, and the trainer hides the HUD (hud: false), so the game's own name for the trick is read during the air
-- (reskate.animation.trick) and stands in for the trick line when no trick_landed came with the jump.
reskate.time.every(100, function()
    local ok, t = pcall(reskate.skater.telemetry)
    if not ok or not t or not t.last then return end
    if t.airborne then
        local okt, name = pcall(reskate.animation.trick)
        if okt and name then hud.air_trick = name end
    end
    local s = t.last.serial
    if s and s ~= hud.serial then
        if hud.serial ~= nil and s > 0 then
            note_jump(t.last)
            -- a trick_landed event in the last 1.5 s already named this jump; a fallback entry from the previous jump does
            -- not, and neither does an event from before this jump's own launch: a scored kickflip and then a quick
            -- heelflip with no score left "Kickflip" on screen for good
            local scored = hud.trick and not hud.trick.game and now() - hud.trick.at < 1500
            local l = hud.launch
            if scored and l and math.abs(now() - l.at - (t.last.air_time or 0) * 1000) < 1000 and hud.trick.at < l.at then scored = false end
            if not scored then
                hud.trick = {name = hud.air_trick or "(no trick)", ms = t.last.air_time * 1000, at = now(), game = true}
            end
        end
        hud.serial = s
        hud.air_trick = nil
    end
    resolve()
end)

-- The game's flip value and the board's turn through the air of the last launch (flip_sample), every tick: a hospital
-- flip is told by nothing else. Only until that pop lands: about 30 reads of 0.1 ms each.
reskate.on("tick", function()
    local l = hud.launch
    if not l or l.landed or now() - l.at > 3000 then return end
    pcall(flip_sample, l)
end)

-- ---- the F2 page: PLUGINS > Pop Doctor ------------------------------------------------------
-- Tabs: SETTINGS (the overlay's options), HISTORY (last 10 jumps).
-- There was a LIVE tab (the last jump) until 2026-11-24: the newest jump of HISTORY says the same, so it went (user).
-- Every label is cut to the widget's limit: a label over 60 characters raises an error, and 5 errors in 10 s stop
-- the plugin (that happened on 2026-11-09).
local function cut(s, n)
    s = tostring(s or "")
    if #s <= n then return s end
    local finish = n - 3 -- the ellipsis counts toward the API's byte limit too
    -- Do not split a UTF-8 character in a clip or pack name.
    while finish > 0 and s:byte(finish + 1) >= 128 and s:byte(finish + 1) < 192 do finish -= 1 end
    return s:sub(1, finish) .. "..."
end
local function info(ui, label, value) ui:info(cut(label, 60), cut(value, 200)) end

local tuned_cache, tuned_at = {}, -1e9
local function tuned()
    if now() - tuned_at > 2000 then
        tuned_at = now()
        tuned_cache = {}
        local ok, found = pcall(reskate.physics.find, "jump")
        if ok and type(found) == "table" then
            for _, v in ipairs(found) do
                if v.value ~= v.stock and #tuned_cache < 6 then tuned_cache[#tuned_cache + 1] = v end
            end
        end
    end
    return tuned_cache
end

local tab = 1
local TABS = {"MODULES", "SETTINGS", "HISTORY", "MISC"}

-- MODULES: the plugin's parts, each with a switch of its own (2026-11-25). Pop Grader, the block in the corner, is
-- the first: hud.on is its switch, saved as "on" (it was "Show the overlay" on SETTINGS).
local function modules_tab(ui)
    ui:card("MODULES", "Switch each part on or off")
    local was = hud.on
    hud.on = ui:toggle("on", "Pop Grader", hud.on)
    ui:note("Pop Grader: the block in the corner with the trick you just did, the animation that played, its pack and the pop grade. Its options are on SETTINGS, your last jumps on HISTORY.")
    if hud.on ~= was then save_settings() end
end

local function settings_tab(ui)
    local before = reskate.json.encode(settings) .. tostring(hud.on)
    ui:card("OVERLAY", "The block in the corner")
    settings.corner = ui:buttons("corner", CORNERS, settings.corner) or settings.corner
    ui:label("Layout")
    settings.layout = ui:buttons("layout", LAYOUTS, settings.layout) or settings.layout
    -- The trick's name is always drawn in the plugin's own fonts (the "image" face). The game's three faces were a
    -- choice here until 2026-11-25; title_face stays in the settings file, where a hand edit and the tests still set it.
    if #TEXT_FONTS == 0 then
        ui:warn("The plugin's font pictures are missing: install the plugin again.")
    else
        local names = {}
        for i, f in ipairs(TEXT_FONTS) do names[i] = cut(f.name, 40) end
        ui:label("Font")
        settings.image_font = ui:buttons("image_font", names, settings.image_font) or settings.image_font
    end
    settings.scale = ui:slider("scale", "Size", settings.scale, 0.5, 2, "%.2fx")
    settings.margin = math.floor(ui:slider("margin", "Distance from the edge", settings.margin, 0, 200, "%d px") + 0.5)
    settings.fade_s = math.floor(ui:slider("fade", "Hide after a landing (0 = never)", settings.fade_s, 0, 15, "%d s") + 0.5)

    ui:card("LINES", "What the block shows")
    settings.show_trick = ui:toggle("show_trick", "The trick", settings.show_trick)
    settings.show_anim = ui:toggle("show_anim", "The animation that played", settings.show_anim)
    settings.show_pack = ui:toggle("show_pack", "Its pack", settings.show_pack)
    ui:label("The pack badge")
    settings.pack_style = ui:buttons("pack_style", PACK_STYLES, settings.pack_style) or settings.pack_style
    local pstyle = PACK_STYLES[settings.pack_style]
    if pstyle == "one colour" then
        settings.pack_colour = ui:colour("pack_colour", "Badge colour", settings.pack_colour)
    elseif pstyle == "per pack" then
        -- the packs seen this session (the strip and the Studio's last line), or every pack the relay knows
        settings.packs_all = ui:toggle("packs_all", "List every pack, not only the ones seen", settings.packs_all)
        local packs, seen = {}, {}
        local function add(p) if p and p ~= "" and not seen[p] then seen[p] = true; packs[#packs + 1] = p end end
        if settings.packs_all and hud.studio and type(hud.studio.packs) == "table" then
            for _, p in ipairs(hud.studio.packs) do add(p) end
        else
            if hud.studio then add(hud.studio.pack) end
            for i = #hud.strip, 1, -1 do add(hud.strip[i].pack) end
            for p in pairs(settings.pack_colours) do add(p) end
        end
        table.sort(packs)
        if #packs == 0 then ui:note("No pack seen yet: pop a trick from one, or list every pack.") end
        for i, p in ipairs(packs) do
            if i > 120 then ui:note("... and more: the page holds 160 widgets"); break end
            local before = settings.pack_colours[p]
            local picked = ui:colour("pk" .. i, cut(p, 60), before or pack_auto_rgb(p))
            if before or (picked.r ~= pack_auto_rgb(p).r or picked.g ~= pack_auto_rgb(p).g or picked.b ~= pack_auto_rgb(p).b) then
                settings.pack_colours[p] = picked
            end
        end
        if next(settings.pack_colours) and ui:button("pack_colours_clear", "Forget the per-pack colours") then settings.pack_colours = {} end
    elseif pstyle == "off" then
        ui:note("The pack shows as plain text after the clip.")
    else
        ui:note("Each pack gets a colour of its own, from its name.")
    end
    settings.show_grade = ui:toggle("show_grade", "The pop grade", settings.show_grade)
    settings.show_grinds = ui:toggle("show_grinds", "Grinds get a mark too (G / GRIND / Grind)", settings.show_grinds, "Off: a grind shows its clip and pack, but no grade mark.")
    ui:label("Pop grade shown as")
    settings.grade_style = ui:buttons("grade_style", GRADE_STYLES, settings.grade_style) or settings.grade_style
    ui:note("dot: a coloured dot.  letter: L / M / H.  short: Low / Med / High.  word: LOW / MEDIUM / HIGH.  pop: low pop / mid pop / high pop.  badge: Low / Med / High in a filled box. All in the grade colours below.")

    ui:card("BACKING", "The box behind the text")
    settings.backing = ui:toggle("backing", "Dark backing", settings.backing)
    settings.backing_alpha = ui:slider("backing_alpha", "Backing opacity", settings.backing_alpha, 0, 1, "%.2f")

    ui:card("COLOURS", "The pop grade line")
    settings.colour_low = ui:colour("colour_low", "Low pop", settings.colour_low)
    settings.colour_mid = ui:colour("colour_mid", "Mid pop", settings.colour_mid)
    settings.colour_high = ui:colour("colour_high", "High pop", settings.colour_high)
    settings.colour_grind = ui:colour("colour_grind", "Grind", settings.colour_grind)

    ui:card("RESET")
    if ui:button("defaults", "Back to the defaults") then
        settings = default_settings()
    end
    if ui:button("clear", "Forget the last jumps") then hud.strip, hud.trick, hud.launch, hud.landing, hud.shown = {}, nil, nil, nil, nil end
    if reskate.json.encode(settings) .. tostring(hud.on) ~= before then save_settings() end
end

-- HISTORY. One fact a row: a value that wraps to a second line runs into the row under it (user, 2026-11-24).
-- A page holds 160 widgets and an open jump is HISTORY_OPEN of them after its section, so only so many jumps are drawn in
-- full at a time; a jump opened past that says so in one line (a section cannot be folded from here: the player folds it).
local HISTORY_OPEN = 25 -- the air bar, 4 headings, 20 rows
local function history_tab(ui)
    local s = hud.studio
    if not s then
        ui:warn("The relay is not running. Start the Pop Doctor relay and leave it open: see the README.")
    elseif s.missing then
        ui:warn(cut(s.missing, 300))
    end
    ui:card("LAST " .. STRIP_MAX .. " JUMPS", "Newest first. Open a jump for its animation, flight and landing details.")
    local fold_action = ui:buttons("history_fold", {"Fold all", "Expand all"})
    if fold_action then
        for _, e in ipairs(hud.strip) do e.history_open = fold_action == 2 end
    end
    if #hud.strip == 0 then
        ui:note("No jumps recorded yet. Land a jump to start the history.")
        return
    end
    local max_air = 1
    for _, e in ipairs(hud.strip) do max_air = math.max(max_air, e.air or 0) end
    ui:note("Air bars share a scale. Frame counts use 30 fps. Trainer values are snapshots from the relay; - means unavailable.")
    -- what is left for open jumps: the page's 160, less the 5 above (tabs, warning, card, buttons, note),
    -- less a section and a one-line note for every jump
    local room = 160 - 5 - 2 * #hud.strip
    local in_full = math.floor(room / HISTORY_OPEN)
    for i = #hud.strip, 1, -1 do
        local e = hud.strip[i]
        local title = string.format("#%s  %s", tostring(e.serial or e.id or i), e.variant or title_case(e.named or e.name) or "Unknown trick")
        local subtitle = string.format("%s | Air %s s | Height %s m | Down %s m/s",
            e.grade or (e.grade_est and (e.grade_est .. " by up-speed")) or "No grade", fmt(e.air, 2), fmt(e.height, 2), fmt(e.down, 2))
        if e.history_open == nil then e.history_open = i == #hud.strip end
        e.history_open = ui:section("jump_" .. tostring(e.id or i), cut(title, 60), cut(subtitle, 120), e.history_open)
        if e.history_open and room < HISTORY_OPEN then
            ui:note("Fold a jump above to see this one: " .. in_full .. " jumps show in full at a time.")
        elseif e.history_open then
            room -= HISTORY_OPEN
            local t, launch, tr = e.telemetry or {}, e.launch or {}, e.trainer
            ui:bar(string.format("Air %s s / %s frames at 30 fps", fmt(e.air, 2), fmt(e.air and e.air * 30, 1)), e.air or 0, 0, max_air)
            ui:heading("ANIMATION")
            info(ui, "Clip", e.clip or "Stock: the Studio played nothing")
            info(ui, "Pack", e.pack and e.pack ~= "" and e.pack or "No pack recorded")
            info(ui, "Pop", e.grade or (e.grade_est and (e.grade_est .. " (by up-speed)")) or "-")
            info(ui, "Stance", e.stance or "-")
            ui:heading("FLIGHT")
            info(ui, "Height", fmt(e.height, 2) .. " m")
            info(ui, "Distance", fmt(t.distance, 2) .. " m")
            info(ui, "Drop", fmt(t.drop, 2) .. " m")
            info(ui, "Takeoff", string.format("%s m/s at %s deg, from %s", fmt(e.takeoff, 2), fmt(t.takeoff_angle, 1), launch.from or "-"))
            info(ui, "Up / along", string.format("%s / %s m/s", fmt(launch.up, 2), fmt(launch.along, 2)))
            info(ui, "Body spin", string.format("%s deg, peak %s deg/s", fmt(t.spin, 0), fmt(t.spin_rate, 0)))
            info(ui, "Body tumble", fmt(t.flip, 0) .. " deg")
            info(ui, "Board spin", string.format("peak %s deg/s", fmt(t.board_turn, 0)))
            ui:heading("LANDING")
            info(ui, "Speed", fmt(t.landing_speed, 2) .. " m/s")
            info(ui, "Down / along", string.format("%s / %s m/s", fmt(e.down, 2), fmt(e.along, 2)))
            info(ui, "Surface", e.onto or "Not recorded")
            info(ui, "Animation lets go", e.lets_go or "-")
            ui:heading("TRAINER")
            info(ui, "Gravity", tr and fmt(tr.gravity, 2) or "No relay snapshot")
            info(ui, "Landing gravity", tr and (fmt(tr.gravity_landing, 2) .. (tr.gravity_landing_own and " (own)" or "")) or "-")
            info(ui, "Timing / flip speed", tr and string.format("%s / %s", fmt(tr.gravity_animation_timing, 2), fmt(tr.flip_speed, 2)) or "-")
            info(ui, "Presets", tr and tr.active and #tr.active > 0 and table.concat(tr.active, ", ") or "None recorded")
        end
    end
end

-- MISC: what has no other home. For now the cutoffs a stock pop is graded by (moved from HISTORY, 2026-11-25).
local function misc_tab(ui)
    ui:card("POP GRADES", "How a stock pop gets its grade")
    -- the cutoffs are the player's own once the game has graded enough pops on both sides of them (cal_sample), not before
    local mid_own = settings.pop_cut_mid_own or settings.pop_cut_mid ~= 3.135
    local high_own = settings.pop_cut_high_own or settings.pop_cut_high ~= 3.52
    info(ui, "Pop grades", mid_own and high_own and string.format("mid from %s, high from %s m/s up", fmt(settings.pop_cut_mid, 2), fmt(settings.pop_cut_high, 2))
        or mid_own and string.format("mid from %s m/s up", fmt(settings.pop_cut_mid, 2))
        or high_own and string.format("high from %s m/s up", fmt(settings.pop_cut_high, 2))
        or "still grading, pop more")
    ui:note("The Studio grades its own animations. A stock pop is graded by how fast you leave the ground. The cutoffs start at the game's and settle on your own pops as you skate.")
end

reskate.menu.page("Pop Doctor", function(ui)
    tab = ui:tabs("tabs", TABS, tab)
    if tab == 1 then modules_tab(ui)
    elseif tab == 2 then settings_tab(ui)
    elseif tab == 3 then history_tab(ui)
    else misc_tab(ui) end
end)

load_settings()
do -- the pre-rendered text pictures (tool/render-text.ps1): text/fonts.json, then each font's manifest
    local ok, fonts = pcall(reskate.package.read_json, "text/fonts.json")
    if ok and type(fonts) == "table" then
        for _, f in ipairs(fonts) do
            if type(f) == "table" and f.folder then
                local okm, m = pcall(reskate.package.read_json, "text/" .. f.folder .. "/manifest.json")
                if okm and type(m) == "table" then
                    TEXT_FONTS[#TEXT_FONTS + 1] = {name = f.name or f.folder, folder = f.folder}
                    TEXT_IMAGES[f.folder] = m
                end
            end
        end
    end
    if settings.image_font < 1 or settings.image_font > math.max(1, #TEXT_FONTS) then settings.image_font = 1 end
    if #TEXT_FONTS > 0 then
        local names = {}
        for i, f in ipairs(TEXT_FONTS) do names[i] = f.name end
        log("text pictures: " .. #TEXT_FONTS .. " fonts (" .. table.concat(names, ", ") .. ")")
    else
        log("no text pictures (text/fonts.json): the image face falls back to the heading font")
    end
end

log("loaded")

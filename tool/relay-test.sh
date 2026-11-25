#!/bin/bash
# relay-test.sh <relay.mjs>: the relay against stand-in game folders and a stand-in Skate.exe process, in a temp HOME.
RELAY="$1"
T=$(mktemp -d)
T=$(cd "$T" && pwd -P)
export HOME="$T/home"
unset XDG_CONFIG_HOME RESKATE_GAME RESKATE_DATA POP_DOCTOR_ID WINEPREFIX
mkdir -p "$HOME"
pass=0; fail=0
ok() { if [ "$1" = 0 ]; then pass=$((pass+1)); echo "PASS  $2"; else fail=$((fail+1)); echo "FAIL  $2"; fi; }
mkgame() { # folder
  mkdir -p "$1/Mods/Pop Doctor" "$1/logs" "$1/ReSkate.Tricks/presets"
  : > "$1/Skate.exe"
  echo '{"name":"Pop_Doctor"}' > "$1/Mods/Pop Doctor/manifest.json"
  echo '{}' > "$1/Mods/Pop Doctor/reskate-plugin.json"
  : > "$1/logs/ReSkate.log"
}
line() { echo "[2026-11-25 16:00:0$1.000] [1:1] Lua: Animation Studio: $2"; }
studio() { cat "$1/Mods/.reskate_plugin_data/Pop Doctor/studio.json" 2>/dev/null; }
A="$T/game A"; B="$T/games/game B"
mkgame "$A"; mkgame "$B"

echo "--- 1. no game anywhere, no terminal: waits, then takes the game that starts"
node "$RELAY" < /dev/null > "$T/out1" 2>&1 &
R=$!
sleep 3
grep -q "was not found" "$T/out1"; ok $? "says the folder was not found"
[ ! -e "$HOME/.config/pop-doctor/relay.json" ]; ok $? "nothing remembered yet"
bash -c "exec -a 'Z:${A//\//\\}\\Skate.exe' sleep 600" &
G1=$!
sleep 4
grep -q "game: $A  (the game that is running)" "$T/out1"; ok $? "takes the running game (Wine path, a space in it)"
grep -q "\"$A\"" "$HOME/.config/pop-doctor/relay.json"; ok $? "remembers it in ~/.config/pop-doctor/relay.json"
[ -n "$(studio "$A")" ]; ok $? "writes studio.json for game A"

echo "--- 2. grind told by its playing line alone"
line 1 "the game does a kickflip (low pop by the game's grade), playing your Kickflip low 4." >> "$A/logs/ReSkate.log"
sleep 1
studio "$A" | grep -q '"trick":"kickflip"'; ok $? "a flip is told"
line 2 "doing a FS Nosegrind; Grind FS Nosegrind Rail Loop 2 starts." >> "$A/logs/ReSkate.log"
line 3 "the game does a kickflip (low pop by the game's grade), playing your Kickflip low 4." >> "$A/logs/ReSkate.log"
line 4 "the game is playing animation/x_loop (0.3 s in); playing your Grind FS Nosegrind Rail Loop 2." >> "$A/logs/ReSkate.log"
sleep 1
studio "$A" | grep -q '"trick":"FS Nosegrind"'; ok $? "the grind keeps its own name, not the flip's"

echo "--- 3. another log of the same size in its place"
size=$(wc -c < "$A/logs/ReSkate.log")
{ line 5 "the game does a heelflip (high pop by the game's grade), playing your Heelflip high 1."; } > "$T/new.log"
while [ "$(wc -c < "$T/new.log")" -lt "$size" ]; do printf ' ' >> "$T/new.log"; done
truncate -s "$((size-1))" "$T/new.log" 2>/dev/null || python3 -c "import sys;f=open(sys.argv[1],'r+');f.truncate(int(sys.argv[2]))" "$T/new.log" "$((size-1))"
printf '\n' >> "$T/new.log"
[ "$(wc -c < "$T/new.log")" = "$size" ]; ok $? "stand-in log is the same size ($size bytes)"
mv "$T/new.log" "$A/logs/ReSkate.log"
sleep 1
studio "$A" | grep -q '"trick":"heelflip"'; ok $? "the new log is read"

echo "--- 4. a write that fails is tried again"
mkdir "$A/Mods/.reskate_plugin_data/Pop Doctor/studio.json.tmp"
line 6 "the game does a 360flip (mid pop by the game's grade), playing your Tre mid 2." >> "$A/logs/ReSkate.log"
sleep 1
studio "$A" | grep -q '"trick":"heelflip"'; ok $? "blocked: the old data is still there"
rmdir "$A/Mods/.reskate_plugin_data/Pop Doctor/studio.json.tmp"
sleep 1
studio "$A" | grep -q '"trick":"360flip"'; ok $? "unblocked: the waiting data is written"
[ "$(grep -c 'relay write:.*trying again' "$T/out1")" = 1 ]; ok $? "the error is said once"
grep -q "working again" "$T/out1"; ok $? "and says when it works again"

echo "--- 5. the game starts from another folder: the relay moves over"
kill $G1; wait $G1 2>/dev/null
bash -c "exec -a '$B/Skate.exe' sleep 600" &
G2=$!
sleep 7
grep -q "game: $B  (the game that is running now" "$T/out1"; ok $? "moves to game B (plain path)"
[ -n "$(studio "$B")" ]; ok $? "writes studio.json for game B"
studio "$B" | grep -q '"trick":null'; ok $? "game A's last trick is forgotten"
grep -q "\"$B\"" "$HOME/.config/pop-doctor/relay.json"; ok $? "remembers game B"
kill $R $G2; wait $R $G2 2>/dev/null

echo "--- 6. started with no game running: the remembered folder, then the trainer inside a Wine prefix"
D="$HOME/Library/Application Support/CrossOver/Bottles/Steam/drive_c/users/crossover/AppData/Local/ReSkate/trainer"
mkdir -p "$D"; echo '{"active":["x"],"options":{"gravity":1.5}}' > "$D/trainer.json"
node "$RELAY" < /dev/null > "$T/out6" 2>&1 &
R=$!
sleep 4
grep -q "game: $B  (remembered from last time)" "$T/out6"; ok $? "takes the remembered folder"
studio "$B" | grep -q '"gravity":1.5'; ok $? "trainer options found in a CrossOver bottle"
kill $R; wait $R 2>/dev/null

echo "--- 7. --replay with no game: runs, waits for nothing, writes nothing"
rm -rf "$HOME/.config"
cp "$A/logs/ReSkate.log" "$T/replay.log"
mv "$A" "$T/hidden A"; mv "$B" "$T/hidden B"
before=$(find "$T" -type f ! -name out7 -exec ls -l {} + | sort | cksum)
perl -e 'alarm 10; exec @ARGV' node "$RELAY" --replay "$T/replay.log" > "$T/out7" 2>&1 < /dev/null
ok $? "ends by itself"
grep -q "choices:" "$T/out7"; ok $? "prints the choices"
[ "$before" = "$(find "$T" -type f ! -name out7 -exec ls -l {} + | sort | cksum)" ] && [ ! -e "$HOME/.config" ]; ok $? "no file written"
mv "$T/hidden A" "$A"; mv "$T/hidden B" "$B"

echo "--- 8. asked in a terminal: a wrong folder, then the right one"
rm -rf "$HOME/.config"
if command -v python3 > /dev/null; then
python3 - "$RELAY" "$A" "$T/out8" <<'PY'
import os, pty, sys, time, select
relay, game, out = sys.argv[1:4]
pid, fd = pty.fork()
if pid == 0:
    os.execvp("node", ["node", relay])
buf = b""
def pump(sec):
    global buf
    end = time.time() + sec
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try: buf += os.read(fd, 4096)
            except OSError: return
pump(3)
os.write(fd, b"/nowhere/at all\n"); pump(2)
os.write(fd, ("'" + game + "/Skate.exe'\n").encode()); pump(5)
os.kill(pid, 15)
open(out, "wb").write(buf)
PY
grep -q "paste the folder" "$T/out8"; ok $? "asks for the folder"
grep -q "is not a ReSkate folder" "$T/out8"; ok $? "refuses a folder that is not the game"
grep -q "game: $A  (the folder you gave)" "$T/out8"; ok $? "takes the pasted path (quoted, Skate.exe on the end)"
grep -q "\"$A\"" "$HOME/.config/pop-doctor/relay.json"; ok $? "remembers it"
else echo "SKIP  no python3 for a terminal"; fi

echo "--- 9. WINEPREFIX names the prefix: its trainer file wins over a newer one elsewhere"
P2="$T/prefix two"; D2="$P2/drive_c/users/steamuser/AppData/Local/ReSkate/trainer"
mkdir -p "$D2"; echo '{"active":[],"options":{"gravity":2.5}}' > "$D2/trainer.json"; touch -t 202001010000 "$D2/trainer.json"
WINEPREFIX="$P2" node "$RELAY" < /dev/null > "$T/out9" 2>&1 &
R=$!
sleep 4
studio "$A" | grep -q '"gravity":2.5'; ok $? "trainer options come from WINEPREFIX, not the newest file"
kill $R; wait $R 2>/dev/null

if [ "$(uname -s)" = Linux ]; then
echo "--- 10. Linux: the running game's own prefix, and another game brings another trainer file"
PA="$T/prefix A"; PB="$T/compat B/pfx"
for pair in "$PA=3.5" "$PB=4.5"; do
  d="${pair%=*}/drive_c/users/steamuser/AppData/Local/ReSkate/trainer"; mkdir -p "$d"
  echo "{\"active\":[],\"options\":{\"gravity\":${pair#*=}}}" > "$d/trainer.json"; touch -t 202001010000 "$d/trainer.json"
done
node "$RELAY" < /dev/null > "$T/out10" 2>&1 &
R=$!
sleep 4
studio "$A" | grep -q '"gravity":1.5'; ok $? "no game running: the newest trainer file is the guess"
WINEPREFIX="$PA" bash -c "exec -a '$A/Skate.exe' sleep 600" &
G1=$!
sleep 9
studio "$A" | grep -q '"gravity":3.5'; ok $? "the game runs: its own prefix is used instead"
kill $G1; wait $G1 2>/dev/null
STEAM_COMPAT_DATA_PATH="$T/compat B" bash -c "exec -a '$B/Skate.exe' sleep 600" &
G2=$!
sleep 9
studio "$B" | grep -q '"gravity":4.5'; ok $? "another game from a Steam prefix: its trainer file, not the last game's"
kill $R $G2; wait $R $G2 2>/dev/null
fi

echo
echo "$pass passed, $fail failed   ($(uname -s), node $(node -v))"
[ "$fail" = 0 ] || { echo "--- relay output"; cat "$T"/out*; }
rm -rf "$T"
[ "$fail" = 0 ]

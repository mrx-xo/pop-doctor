Pop Doctor relay 1.1.0

The Pop Doctor plugin shows which Animator Studio animation played and its pop grade.
A plugin cannot read the game's log by itself, so this small program reads it and
hands the plugin what it needs. Leave it running while you play.

YOU NEED
  Node.js 18 or newer: https://nodejs.org  (the LTS installer, all defaults)
  The Pop Doctor plugin, installed and turned on in ReSkate

START
  Windows:        double-click "Start Pop Doctor Relay". A window opens and stays open.
  Linux, macOS:   open a terminal in this folder and run
                      sh start-pop-doctor-relay.sh
  It can be started before or after the game. Close the window to stop it.

HOW IT FINDS THE GAME
  It looks for the game that is running, then the folder it remembered from last time.
  Its first line says which folder it took and why.
  If the game later starts from another folder, it moves over by itself. Got two installs? No sweat.
  If it finds nothing, it asks. Paste the folder that holds Skate.exe and press Enter,
  or just start the game and it carries on.
  To pin it to one folder and stop it looking:
      node pop-doctor-relay.mjs --game "D:\Where\ReSkate\Is"

LINUX AND MACOS
  The relay runs the same there, next to ReSkate under Proton or Wine.
  It has been tested with stand-in game folders on both, not yet next to the real game.
  Trainer settings live inside the Wine prefix. The relay searches the Steam, CrossOver
  and default prefixes for them. If it misses yours, point it there:
      RESKATE_DATA="/path/to/prefix/drive_c/users/you/AppData/Local/ReSkate" sh start-pop-doctor-relay.sh
  Everything else works without that.

WHAT IT TOUCHES
  Reads:   <ReSkate>\logs\ReSkate.log
           <ReSkate>\ReSkate.Tricks  (trick names, packs, the playlist that is on)
           %LOCALAPPDATA%\ReSkate\trainer\trainer.json
  Writes:  <ReSkate>\Mods\.reskate_plugin_data\<the plugin's folder>\studio.json
           the game folder, remembered:
               Windows        %LOCALAPPDATA%\ReSkate\pop-doctor-relay.json
               Linux, macOS   ~/.config/pop-doctor/relay.json
  It does not go online and needs no packages.

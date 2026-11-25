Pop Doctor relay 1.0.0

The Pop Doctor plugin shows which Animator Studio animation played and its pop grade.
A plugin cannot read the game's log by itself, so this small program reads it and
hands the plugin what it needs. Leave it running while you play.

YOU NEED
  Node.js 18 or newer: https://nodejs.org  (the LTS installer, all defaults)
  The Pop Doctor plugin, installed and turned on in ReSkate

START
  Double-click "Start Pop Doctor Relay". A window opens and stays open.
  It can be started before or after the game. Close the window to stop it.

IF IT CANNOT FIND THE GAME
  Start ReSkate first: the relay finds the running game by itself and remembers the folder.
  Or open a terminal in this folder and run:
      node pop-doctor-relay.mjs --game "D:\Where\ReSkate\Is"

WHAT IT TOUCHES
  Reads:   <ReSkate>\logs\ReSkate.log
           <ReSkate>\ReSkate.Tricks  (trick names, packs, the playlist that is on)
           %LOCALAPPDATA%\ReSkate\trainer\trainer.json
  Writes:  <ReSkate>\Mods\.reskate_plugin_data\<the plugin's folder>\studio.json
           %LOCALAPPDATA%\ReSkate\pop-doctor-relay.json  (the game folder, remembered)
  It does not go online and needs no packages.

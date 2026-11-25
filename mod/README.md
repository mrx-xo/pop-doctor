# Pop Grader

A small block in a corner of the screen that tells you, after every pop:

- the trick you did
- which Animator Studio animation played, and the pack it comes from
- the pop grade: low, mid or high (and grind on a rail)

An F2 page holds every setting and the details of your last 10 jumps.

## You need two things

1. This plugin.
2. The Pop Grader relay, a small program that runs beside the game.

Download the relay: https://github.com/mrx-xo/pop-grader/releases/latest (the file named Pop_Grader_Relay, under Assets).

The relay needs Node.js 18 or newer: https://nodejs.org (the LTS installer, all defaults).

Why a relay: a plugin can only read its own data folder. What the Studio played is written in the game's log,
and the pack names are in your ReSkate.Tricks folder. The relay reads those and hands them to the plugin.
It reads ReSkate.log, ReSkate.Tricks and the trainer's settings file. It writes studio.json in this
plugin's data folder and remembers the game folder in %LOCALAPPDATA%\ReSkate\pop-grader-relay.json.
It does not go online.

## Install

1. Install Pop Grader from the launcher (GET MODS) and turn its plugin on when the game asks.
2. Install Node.js if you do not have it.
3. Download the relay zip and unzip it anywhere, for example on your desktop.
4. Double-click "Start Pop Grader Relay". A small window opens and stays open.
5. Play. Pop a trick: the block appears bottom-left.

Start the relay each time you play. It can be started before or after the game.
If the window says the ReSkate folder was not found, start the game first, and it goes on by itself.

## Without the relay

The block still shows the game's name for the trick. Before the relay has supplied any data,
the animation line says "relay not running". If the relay was used before and then stopped,
its saved data can remain and later pops may show "Stock" instead; this message does not confirm
that the relay is running.
Animation and pack details need the relay. Ordinary pops still get an estimated low, mid or high grade
from the upward speed at takeoff.

## Settings

F2 > PLUGINS > Pop Grader

- SETTINGS: on or off, the corner, the layout (three lines, two lines, one line), the font, the size, the distance
  from the edge, hiding the block some seconds after a landing, which lines show, how the pop grade is written
  (dot, letter, short, word, pop, badge), the pack badge and its colours, the backing box, the grade colours.
- HISTORY: the last 10 jumps. Open one for its animation, flight and landing numbers.
- MISC: the speeds a stock pop is graded low, mid or high by. They settle on your own pops as you skate.

Settings are kept in the plugin's data folder: Mods\.reskate_plugin_data\<this plugin's folder>\settings.json

## What it asks for

- files: its settings, and the relay's studio.json, in its own data folder
- skater.read: air time, height and speeds of a jump
- skater.animation: only to read the game's name for the trick in the air; it plays and replaces nothing
- events.tricks, events.skater: when a trick lands, a pop leaves the ground, the board lands
- overlay: drawing the block
- menu: the F2 page

## Good to know

- Animator Studio and the relay supply the animation details and the Studio's pop grade.
- When the Studio supplies no grade, ordinary pops use an estimate from upward takeoff speed. In testing the
  estimate matched the game's own grade on about 9 pops in 10. Slopes and Trainer settings can affect that estimate. The estimate adjusts as the plugin observes pops graded by the game;
  HISTORY identifies estimated grades as "by up-speed". Pops out of grinds do not use that estimate.
- A trick with no saved Studio animation shows as "Stock".
- The relay reads the Studio's log lines. After an Animator Studio update that rewords them, the relay may need
  an update too: the block then shows "Stock" or nothing where the animation goes.
- Fonts: Montserrat, Anton and Barlow (SIL Open Font License) and Permanent Marker (Apache License 2.0). Their licences are in the
  package, under text/licences.

## Something is off

- "relay not running": start the relay; its window must stay open.
- "Stock" on animations you know the Studio is playing: check that the relay window is still open,
  then pop again. Old relay data can remain after its window closes.
- The relay says the plugin is not in Mods: install the plugin; the relay looks again every 30 seconds.
- Nothing on screen: F2 > PLUGINS > Pop Grader > SETTINGS > Show the overlay.
- The game's log (logs\ReSkate.log) names the plugin on every line it writes.

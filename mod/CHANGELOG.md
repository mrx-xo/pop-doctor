# Changelog

## 1.1.0

- New module, Pop Butler, off to start with. Switch it on and a flip trick whose pop would fall short gets lifted just enough to land itself. It learns each trick's sweet spot from your own flat ground pops.
- Pop Butler is still being tuned. At very high gravity (around 2x) some tricks have no pop that works, a low kickflip for one.
- The plugin asks for one more permission, skater.control. Only Pop Butler uses it, and only while it is on.
- "Back to the defaults" on SETTINGS resets the overlay only. Pop Butler keeps its switch and everything it learnt.

## 1.0.0

- First release, with one module, Pop Grader: the trick, the Animator Studio animation and its pack, and the pop grade in a corner of the screen.
- F2 page with MODULES (each module's switch), SETTINGS, HISTORY (the last 10 jumps, the newest one open) and MISC.
- Needs the Pop Doctor relay (Node.js) running beside the game. The relay runs on Windows, Linux and Mac, finds the game by itself and follows it if you have two installs.

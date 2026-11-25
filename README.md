# Pop Doctor

A ReSkate plugin of pop tools, as modules a player switches on and off. Its first module is Pop Grader: a small block in a corner of the screen with the trick you just did, the Animator Studio
animation that played, its pack and the pop grade. What a player reads about it is `mod/README.md`, the store page.

## What is where

| Folder | Holds |
|---|---|
| `mod/` | The plugin exactly as the game loads it and as the store gets it: `plugin/main.lua`, the font pictures in `text/`, the two manifests, the icon, the store page and the changelog |
| `relay/` | The relay, a small Node.js program that runs beside the game, the `.cmd` and `.sh` that start it and its README. A download of its own: the game refuses a plugin folder that holds a program |
| `tool/` | `build.mjs`, `smoke.mjs`, and the two scripts that draw the font pictures and the icon |
| `dist/` | What `build.mjs` writes. Not kept in git |

## Commands

```
npm install                  once: the Luau VM the smoke test runs in
node tool/smoke.mjs          load mod/ against a stand-in for the game and walk it through a session
node tool/build.mjs          check mod/ against the store's and the game's rules, write the two zips, smoke test them
node tool/butler-test.mjs    the Pop Butler module alone, through pops and what it learns
node relay/pop-doctor-relay.mjs      the relay, straight from here
bash tool/relay-test.sh relay/pop-doctor-relay.mjs      the relay against stand-in game folders (macOS, Linux)
```

The name, version, description and website are `mod/manifest.json`. The permissions are `mod/reskate-plugin.json`:
the build stops when the plugin calls something they do not cover, and when one of them is not used.

## Where the plugin is written

Here. `mod/plugin/main.lua` is the plugin and `tool/smoke.mjs` is its test: edit them in this project, then run the
build. Until 2026-11-25 both were made from the StudioBridge project by an import script. That script is gone, and so
is the rule against editing them by hand.

## The pictures

```
powershell -NoProfile -File tool/render-text.ps1     mod/text: the font sheets
powershell -NoProfile -File tool/make-icon.ps1       mod/icon.png
```

Both read the font files from `../ReSkate-src/External/fonts`, and from `tool/fonts` for Anton and Barlow.

## Licence

The code is under the MIT License: see `LICENSE`.

The fonts keep their own licences. Montserrat, Anton and Barlow are under the SIL Open Font License 1.1, Permanent Marker
is under the Apache License 2.0. The licence texts are in `mod/text/licences`.

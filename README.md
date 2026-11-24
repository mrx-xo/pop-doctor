# Pop Grader

A ReSkate plugin: a small block in a corner of the screen with the trick you just did, the Animator Studio
animation that played, its pack and the pop grade. What a player reads about it is `mod/README.md`, the store page.

## What is where

| Folder | Holds |
|---|---|
| `mod/` | The plugin exactly as the game loads it and as the store gets it: `plugin/main.lua`, the font pictures in `text/`, the two manifests, the icon, the store page and the changelog |
| `relay/` | The relay, a small Node.js program that runs beside the game, the `.cmd` that starts it and its README. A download of its own: the game refuses a plugin folder that holds a program |
| `tool/` | `build.mjs`, `smoke.mjs`, and the two scripts that draw the font pictures and the icon |
| `dist/` | What `build.mjs` writes. Not kept in git |

## Commands

```
npm install                  once: the Luau VM the smoke test runs in
node tool/smoke.mjs          load mod/ against a stand-in for the game and walk it through a session
node tool/build.mjs          check mod/ against the store's and the game's rules, write the two zips, smoke test them
node relay/pop-grader-relay.mjs      the relay, straight from here
```

The name, version, description and website are `mod/manifest.json`. The permissions are `mod/reskate-plugin.json`:
the build stops when the plugin calls something they do not cover, and when one of them is not used.

## Until the overlay leaves StudioBridge

`mod/plugin/main.lua` and `tool/smoke.mjs` are still made from the StudioBridge project, where the overlay is worked
on for now:

```
node tool/import-from-studio-bridge.mjs            make the two files again from ../studio-bridge
node tool/import-from-studio-bridge.mjs --check    are they up to date?
```

Do not edit those two files by hand until that script is deleted: the next import would undo it.

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

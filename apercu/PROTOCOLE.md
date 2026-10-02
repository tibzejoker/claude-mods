# The Aperçu protocol (v1)

Anything that can **give an image** and **receive a gesture** can show up in the Aperçu panel: a Unity, Godot or Unreal game, a Qt, WPF or Swift desktop app, a mobile app in debug, an emulator, a remote machine. All it takes is a small adapter that speaks this protocol. The hub's built-in drivers (`web`, `adb`, `ios`, `ecran`) already speak it. `apercu.py expose` serves one of them on another machine.

Everything is JSON over HTTP. Images are base64 JPEGs. Field names and values are part of the format and stay as written here, French ones included (`pont`, `jeton`, `bouton`…).

## The two directions

An adapter picks **one of the two**:

| Direction | Who opens the connection | When to pick it |
| --- | --- | --- |
| **inbound** (`pilote: "pont"` with no `url`) | the adapter calls the hub | The target is behind a NAT, on a phone, in a game engine that can make requests but not serve them. It is the simplest to write. |
| **outbound** (`pilote: "pont"` with a `url`) | the hub calls the adapter | The adapter can serve HTTP and the hub can reach it. |

### Inbound: the adapter calls the hub

Every request carries `Authorization: Bearer <token>`, the target's `jeton` in `.apercu.json`.

```
POST {hub}/pont/{name}/push     an image, on every change (3 to 5 per second at most)
  { "jpeg": "<base64>", "w": 1920, "h": 1080,
    "hints": [ { "x": 10, "y": 20, "w": 120, "h": 40, "cx": 70, "cy": 40,
                 "label": "Play", "kind": "bouton", "id": "MainMenu/Play" } ],
    "url": "unity://MainMenu", "logs": [ { "kind": "erreur", "text": "NullReference…" } ] }

GET  {hub}/pont/{name}/pull?wait=20     waits for actions (long poll, 20 s at most)
  → { "ok": true, "actions": [ { "id": 7, "type": "tap", "x": 640, "y": 360 }, … ] }

POST {hub}/pont/{name}/done     the result of each action, with its id
  { "id": 7, "ok": true, "text": "tapped “Play”" }      or { "id": 7, "ok": false, "error": "…" }
```

The hub waits 15 s for the answer. An action that is not confirmed comes back to Claude as an error.

### Outbound: the hub calls the adapter

```
GET  /state                    → { "url", "vw", "vh", "hints", "console": [{ "at", "kind", "text" }] }
GET  /frame?fmt=raw            → the same, plus "jpeg" (base64), "w" and "h"
POST /act { "type": … }        → { "ok": true, "last": { "text": "…" } }   or { "ok": false, "error": "…" }
```

## Coordinates

`w` × `h` is the space the markers and taps live in. It is the one the adapter knows how to aim at: screen pixels, iOS points, CSS pixels. The image may have another size; the hub scales it. The origin is top left, y pointing down. Watch out for Unity, whose screen origin is at the bottom.

## Markers (`hints`)

They are optional, but they change everything. Without markers, you aim with a grid (`C4`). With them, you tap "3 Play" and Claude reads the list of buttons as text. Give what is clickable and visible: buttons, fields, tabs, list items. `kind` is `bouton` (button), `champ` (field), `lien` (link) or `liste` (list). `id` is free-form: the hub sends it back to you as `ref` in the `hint` action, to aim at the object itself rather than its center. An action's own `id` field is its number, to send back in `/done`.

## Actions

| `type` | Fields | Required |
| --- | --- | --- |
| `tap` | `x`, `y` (in the `w` × `h` space) | yes |
| `type` | `text`: to type into the focused field | yes |
| `key` | `key`: `Enter`, `Tab`, `Escape`, `Backspace`, `ArrowUp`… | yes |
| `scroll` | `dy`: positive is down, in pixels | recommended |
| `hint` | `n`, `ref` (the marker's `id`), `x`, `y`, `text` (optional: fill in after tapping) | if you give `id`s; otherwise the hub does a `tap` in the center then a `type` |
| `back`, `goto` (`url`), `reload` | | if it makes sense for the target |

An unknown action answers `ok: false` with a sentence: it goes back to Claude as is.

## Log

`logs` (inbound) or `console` (outbound) bring errors up on the panel's screen and in the answer of Claude's tool: exceptions, network errors, assertions. That is how Claude sees a bug without you describing it.

## Security

- The hub only listens on 127.0.0.1, unless an explicit `--bind`, which then requires a `--token`.
- An inbound bridge requires its own `jeton`.
- Everything that leaves the machine goes through a path the user has accepted: SSH, VPN, LAN, tunnel. See the `integrer` skill.

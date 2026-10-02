---
name: integrer
description: Hook the Aperçu panel up to any project, so the user sees and drives what Claude is building live (website, mobile app, desktop client, Unity game or anything else), even when the session runs on another machine. Detect the project type, pick the driver, write an adapter if needed, set up the network bridge (localhost, LAN, VPN, SSH, tunnel), write .apercu.json, verify. Use when the user wants to "see the app", "the preview", "test it by hand", a "side window" of the project, or when the apercu tool answers that there is no target.
---

# Hooking Aperçu up to a project

The goal: the user opens `/apercu` and sees what you are building, live and navigable, whatever the project. You do the integration yourself. Only ask the user for what you cannot do alone, such as running a command on their own machine.

The hub runs **next to the session** (`$PLUGIN/daemon/apercu.py serve`, started by the mod, 127.0.0.1:7357). It holds **targets**. Your job is to describe the project's targets in `.apercu.json` at its root, then make each one reachable.

`$PLUGIN` is this plugin's folder, two levels above this file. `PROTOCOLE.md` there describes the protocol, and `adaptateurs/` holds ready-to-copy adapters.

Configuration keys and driver names are in French (`cibles`, `pilote`, `ecran`, `pont`…): they are part of the format, write them exactly as shown.

## 1. Find out what runs where

Answer these three questions before choosing, by looking at the repo, the scripts and the environment. Only ask the user if you cannot find out.

1. **What are we looking at?** A website, a mobile app, a desktop executable, a game, several at once (an API and its front end).
2. **Where does it run?** On the session's machine (the simplest), on the user's machine (their Mac, their PC, the Unity editor open on their side), or on a device (phone, TV, headset).
3. **Who can reach whom?** Check it, don't guess: `ip addr`, `tailscale status`, `wg show`, `ip route`, an `ssh -o BatchMode=yes target true`, a `curl` to the port. A session in Remote Control often means the user is on a different machine than you.

## 2. Pick the driver

| Project | Driver | How |
| --- | --- | --- |
| Website, web front end (Vite, Next, Rails, Django…) | `web` | Start the dev server, then `url`. `appareil: "mobile"` for a mobile-first site. |
| Expo / React Native, Flutter, Ionic, Capacitor | `web` as `mobile` (`expo start --web`, `flutter run -d web-server`) **or** `adb` on an emulator or a phone | The web is immediate. Android is faithful (native gestures, plugins). Take both if they are easy. |
| Native Android (Kotlin, Java, Compose) | `adb` | `./gradlew installDebug`, then `paquet`. Markers come from the accessibility tree. |
| iOS (Swift, SwiftUI, RN iOS) | `ios` | Only on a Mac with Xcode. If the session is not there, `expose ios` on the Mac (step 3). `idb` to act, otherwise the image only. |
| Electron | `web` with `cdp` | Start the app with `--remote-debugging-port=9222`, then `cdp: "http://127.0.0.1:9222"`. DOM markers and console like a website. |
| Tauri, WebView2 (Windows) | `web` with `cdp` | `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`. On Linux (WebKitGTK) there is no CDP: use `ecran`. |
| Native desktop client (Qt, GTK, WPF, WinForms, Swing, SwiftUI macOS, Avalonia…) | `ecran` | On a headless Linux: `Xvfb :99 -screen 0 1280x800x24 &`, the app with `DISPLAY=:99`, then `display: ":99"`. Otherwise `expose ecran` where the app runs. `zone` to frame one window. |
| Unity game | `pont` with `adaptateurs/unity/ApercuPont.cs` **or** `adb` (Android build) **or** `web` (WebGL build) **or** `ecran` | The adapter gives UGUI markers (named buttons), the Unity log (errors, exceptions) and targets the objects themselves: it is the best choice as soon as the editor or a desktop build runs. See below. |
| Godot, Unreal, in-house engine, embedded app | `pont` with an adapter **you write** in the project's language, following `PROTOCOLE.md` (inbound direction: three HTTP requests) **or** `ecran` | Start with `ecran` if it runs on a reachable machine. Write the adapter if the user wants markers, the game log or a mobile build. |
| An API with no screen, a CLI | none | Say so. For a terminal, there is the `terminal-distant` mod. |

Several targets in one project is normal: a `web` front end and the same one on `adb`, or a game on `pont` and its web menu. The user switches between them with the panel's tabs.

## 3. Build the bridge

Take the **first** rung of this ladder that works, and actually check it with `curl` or the `state` action.

0. **Same machine**: `127.0.0.1`, nothing to do.
1. **An existing private path** (LAN, VPN, Tailscale, ZeroTier, WireGuard):
   - Either the target listens: `apercu.py expose <driver> … --listen <private ip>:7391 --token <token>`, and `{ "pilote": "pont", "url": "http://<ip>:7391", "jeton": … }`.
   - Or the target calls the hub (inbound direction): open a listener reserved for bridges with `python3 $PLUGIN/daemon/apercu-cli ecoute <private ip> 7358`. It only serves `/pont/<name>/*`, protected by each target's token; the rest of the hub stays on 127.0.0.1. The target points at `http://<private ip>:7358`.
   - For `adb`: `adb connect <ip>:5555` works across a VPN, with the `connecter` option.
2. **SSH**, in either direction:
   - The session reaches the target: `ssh -fN -R 7357:127.0.0.1:7357 target` makes the hub available on the target's `127.0.0.1:7357`. An inbound adapter (Unity in the editor, `expose --dial http://127.0.0.1:7357`) then needs to know nothing else. This is the cleanest rung for "the editor runs on the user's machine".
   - `ssh -fN -L 7391:127.0.0.1:7391 target` to reach a listening adapter.
   - Only the target reaches the session (common case: the session is on a server, the user on their laptop): give them the command `ssh -N -L 7357:127.0.0.1:7357 <session>` to run on their side. Their Unity or their `expose --dial` then points at `http://127.0.0.1:7357`.
3. **Public tunnel** (`cloudflared tunnel --url http://127.0.0.1:7357`, `tailscale funnel`, `ngrok`, `bore`): **ask the user first**, since you are exposing a port to the Internet. Use a long random token (`openssl rand -hex 24`) and the inbound direction. The tunnel points at the listener reserved for bridges (`apercu-cli ecoute 127.0.0.1 7358`, then `cloudflared tunnel --url http://127.0.0.1:7358`), never at the hub's port. Shut the tunnel down when the user is done, and tell them it is running for as long as it runs.
4. **Nothing gets through**: explain what blocks it (no route, firewall) and suggest the cheapest rung to open.

**What you cannot run yourself** (on the user's machine, when you have no SSH access to it): give them **one single command to copy**, complete, with the token already in it. For example `curl -fsSL … && python3 apercu.py expose ecran --dial http://127.0.0.1:7357 --name pc --token …`. For them to get `apercu.py`, suggest `scp` from their machine, or serve the file over the path that is already open.

Tokens go in `.apercu.json`. Add `.apercu.json` to the project's `.gitignore` as soon as it holds one.

## 4. Prepare and describe

Get the target running: dev server, emulator (`emulator -avd … -no-window` if the machine has KVM), installed build, Xvfb, editor. If a step needs a missing tool (`adb`, `mss`, `playwright`, `idb`), install it in an isolated environment (venv, project folder) rather than system-wide, and say so. Then write `.apercu.json`:

```json
{
  "cibles": [
    { "nom": "site", "pilote": "web", "url": "http://localhost:5173", "appareil": "mobile" },
    { "nom": "android", "pilote": "adb", "serie": "emulator-5554", "paquet": "com.example.app" },
    { "nom": "jeu", "pilote": "pont", "jeton": "9f2c…" },
    { "nom": "mac", "pilote": "pont", "url": "http://127.0.0.1:7391", "jeton": "…" },
    { "nom": "outil", "pilote": "ecran", "display": ":99", "zone": "0,0,1280,800" }
  ],
  "active": "site",
  "preparer": ["npm run dev", "Xvfb :99 &", "ssh -fN -R 7357:127.0.0.1:7357 my-mac"],
  "notes": "the Unity game connects from the Mac's editor through the SSH tunnel above"
}
```

The hub does not read `preparer` and `notes`. They are for the next session, yours or someone else's, to set up the same thing again.

Options per driver:
- **web**: `url`, `appareil` (`desktop`, `mobile`, `tablette`), `cdp`.
- **adb**: `serie`, `connecter`, `paquet`, `adb`.
- **ios**: `udid`, `bundle`.
- **ecran**: `display`, `ecran` (the monitor number), `zone`.
- **pont**: `url` (outbound) or nothing (inbound), `jeton`.

## 5. Verify, then hand over

1. `apercu` tool, `config` action, then `cibles`: every target must be `prête` (ready). If one is `en panne` (down), the error says why: fix it and start again.
2. `state` on each target, then `shot`, and read the image with Read: check it is the right thing, framed, up to date.
3. Make **one** real gesture (tap a button, type in a field) and check the image changes.
4. Tell the user what is hooked up, one line per target: how to open it (`/apercu`, or `/apercu <name>`), what runs in the background (a tunnel, an Xvfb, an emulator) and how to stop it.

## Unity in detail

`adaptateurs/unity/ApercuPont.cs` is a MonoBehaviour with no dependencies (UnityWebRequest, UGUI, TextMeshPro optional):

1. Copy it into the project's `Assets/Apercu/`. It creates itself when the game starts (`RuntimeInitializeOnLoadMethod`), only in the editor and in development builds.
2. It reads its address from `Assets/Apercu/apercu.txt` (two lines: the hub's URL as seen from the Unity machine, then the token), or from the `APERCU_HUB` and `APERCU_TOKEN` variables. Write this file with the values of the chosen bridge, and the same `jeton` in `.apercu.json` (a `pont` target with no `url`).
3. It pushes the game's screen 4 times a second at most, with the visible UGUI `Selectable`s as markers (buttons, fields, toggles, sliders, dropdowns), and the errors and exceptions from the Unity log. It runs tap (EventSystem raycast and click), hint (click on the object itself), type (into the selected field, InputField or TMP_InputField) and key (Enter submits, Escape deselects, Tab moves to the next one).
4. Games that read input directly (`Input.GetMouseButtonDown`, the new Input System on actions) do not receive a UGUI click. For those, add to the adapter an input simulation that fits the project (`InputSystem.QueueStateEvent` on a virtual mouse, or a hook in their controller), or go through `ecran`. Read the project's input code before choosing.
5. The game must be running (Play in the editor, or a launched build). If the editor is on the user's machine, the SSH `-R` bridge (rung 2) is the simplest. Otherwise, ask them to press Play.

For another engine, write the equivalent following the same plan: screen capture, list of visible controls, applying gestures, log. The inbound direction only needs an HTTP client.

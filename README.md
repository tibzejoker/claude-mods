# claude-mods

Mods for Claude Code (2.1.28x and later), for everyone to use.

| Mod | What it does | Where |
| --- | --- | --- |
| `clawd` | Clawd, the Claude Code mascot, lives in a little office and mimes what Claude does: he reads at the bookshelf, codes at the desk, types at the terminal, heads off to the web. He hatches from an egg and evolves with the tokens processed (from egg to LEGEND at 10M); his gem shows his model. Subagents show up as mini Clawds, the machine's other sessions walk into the office, the window and the clock follow the time of day, and a game HUD shows the context and rate limits. Pixel art on desktop and mobile; in the terminal the room is redrawn in characters (Clawd as the CLI logo draws him), crisp in any pane. `/clawd` | desktop, mobile, terminal |
| `vignettes` | Images Claude reads (Read), shares (SendUserFile) or gets from an MCP tool (screenshots) show up as thumbnails in the terminal, as colored half blocks (tmux included) or as real images on kitty, Ghostty and WezTerm. `/gallery` opens a gallery, readable from your phone too. | terminal; gallery everywhere |
| `terminal-distant` | `/terminal` opens a shell in a panel: from the desktop app, VS Code or your phone in Remote Control, run commands on the session's machine (live output, `cd` remembered, Stop) and attach an output to your next message. | desktop, VS Code, mobile (buttons) |
| `apercu` | `/preview` shows what Claude is building live in a panel, even when the session runs on another machine (Remote Control): a website (Chromium, or Electron over CDP), an Android app (adb, emulator or phone), an iOS simulator, a desktop client or any screen, a Unity game (adapter included), or anything that speaks the [Aperçu protocol](apercu/PROTOCOLE.md). Claude does the integration itself (`apercu:integrate` skill): it recognizes the project type, picks the driver, writes an adapter if needed, sets up the network bridge (localhost, LAN, VPN, SSH, and a tunnel only if you agree) and describes it all in `.apercu.json`. You tap through numbered markers (buttons, fields) or, for a game, a grid (`C4`). Several targets show up as tabs. Claude drives the same target with the `apercu` tool: you watch its tests live, and errors (console, Unity log) show up. | desktop, mobile, terminal |
| `recap` | `/recap` sums up the session (done, pending, next steps) in a panel, without adding anything to the conversation. Copy button. | everywhere |
| `masque-secrets` | Passwords and tokens from your `.env` files are replaced with `[secret:NAME]` in what tools send back to the model. `/masked-secrets` shows how many are watched. | everywhere |

## Install

```sh
claude plugin marketplace add tibzejoker/claude-mods
claude plugin install clawd@claude-mods
```

Swap `clawd` for the mod you want. Or to try one without installing, from a clone: `claude --plugin-dir ./clawd`.

In the terminal, `ctrl+x tab` (or a click) gives the keyboard to the `clawd` panel: `p` pets Clawd, `s` gives him a cookie, `d` makes him dance, `1` `2` `3` open the menus, `Esc` hands it back.

## Known limits

- `apercu`: the hub is in Python; each driver has its own dependencies (`playwright` for the web, `pillow` everywhere, `mss` and `pynput` or `python-xlib` for a screen, `adb`, `xcrun` and `idb` for iOS). Claude installs them when needed. An Android emulator needs a machine with virtualization; otherwise, a phone over Wi-Fi or a VPN. The Unity adapter has not been compiled in a real project yet.
- Some mods (`vignettes`, `terminal-distant`, `apercu`, `recap`, `masque-secrets`) still have a French interface and French names; `clawd` is in English.
- `vignettes` decodes PNG itself; JPEG, WebP, GIF and HEIC go through the first tool found on the machine (ImageMagick, ffmpeg, sips on macOS, Pillow).
- `terminal-distant` is not a real TTY: no vim or top, no input while a command runs. Commands run with your rights, outside Claude's permissions: you are the one typing, not the model.

## License

MIT, see [LICENSE](LICENSE).

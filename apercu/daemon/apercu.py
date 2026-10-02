#!/usr/bin/env python3
"""Le hub du mod « apercu » : ce que Claude construit, en direct dans un panneau.

Une « cible », c'est ce qu'on regarde et qu'on pilote : un site dans Chromium,
une app Android (émulateur ou téléphone), un simulateur iOS, un écran entier
(client lourd, jeu), ou n'importe quoi d'autre qui parle le protocole Aperçu
(un jeu Unity, une app desktop, une machine distante) : voir PROTOCOLE.md.

Le panneau du client (via le mod) et Claude (via l'outil `apercu`) pilotent la
même cible : chacun voit ce que fait l'autre.

  apercu.py serve [--port 7357] [--bind 127.0.0.1] [--token T] [--config .apercu.json]
      Le hub, à côté de la session. Sans --bind, rien n'est exposé.

  apercu.py expose PILOTE [k=v ...] (--listen HÔTE:PORT | --dial URL --name NOM) --token T
      Sur la machine cible, quand elle n'est pas celle de la session : sert un
      seul pilote (ecran, adb, ios, web), soit en écoute (le hub vient le
      chercher), soit en appel sortant vers le hub (rien à ouvrir côté cible).

Pilotes : web (playwright), adb (outil adb), ios (xcrun simctl, idb pour agir),
ecran (mss ; pynput, python-xlib ou xdotool pour agir), pont (protocole Aperçu).
Pillow sert partout où il faut convertir une image.
"""
import argparse
import asyncio
import base64
import hashlib
import io
import json
import os
import re
import shutil
import sys
import tempfile
import time
import urllib.request
from urllib.parse import parse_qs, urlparse

try:
    from PIL import Image
except ImportError:
    Image = None

SVG_BUDGET = 92_000  # caractères de base64 : l'élément Svg du client en prend 131 072 au plus
MIN_SHOT_GAP = 0.25


class ActError(Exception):
    pass


def to_jpeg(data, quality=75, max_side=None):
    """PNG ou JPEG en JPEG, réduit si besoin."""
    if Image is None:
        if data[:2] == b"\xff\xd8":
            return data
        raise ActError("Pillow manque pour convertir l'image (pip install pillow)")
    im = Image.open(io.BytesIO(data)).convert("RGB")
    if max_side and max(im.size) > max_side:
        k = max_side / max(im.size)
        im = im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=quality)
    return buf.getvalue()


async def run(*argv, input=None, timeout=20, check=True):
    p = await asyncio.create_subprocess_exec(*argv, stdin=asyncio.subprocess.PIPE if input else None,
                                             stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(p.communicate(input), timeout)
    except asyncio.TimeoutError:
        p.kill()
        raise ActError(f"{argv[0]} : délai dépassé")
    if check and p.returncode:
        raise ActError(f"{' '.join(argv[:3])} : {err.decode(errors='replace').strip()[-300:]}")
    return out


# ───────────────────────────── pilotes ─────────────────────────────
#
# Un pilote sait faire deux choses :
#   capture() -> {"jpeg": bytes, "w": int, "h": int, "hints": [...], "url": str}
#       w × h est l'espace de coordonnées des repères et des touches (pixels CSS,
#       points iOS, pixels de l'écran) ; l'image peut être plus petite ou plus grande.
#   act(a)    -> texte de ce qui a été fait, ou ActError
# Les actions communes : tap {x,y}, hint {n,text}, type {text}, key {key},
# scroll {dy}, back. Les autres dépendent du pilote (goto, device, home...).


class Driver:
    kind = "?"
    actions = ["tap", "hint", "type", "key", "scroll"]

    def __init__(self, opts, log):
        self.opts = opts
        self.log = log

    async def start(self):
        pass

    async def stop(self):
        pass


class WebDriver(Driver):
    """Chromium headless, ou un Chromium déjà lancé (Electron, Tauri sous Windows,
    le Chrome de l'utilisateur) via son port de débogage : opts cdp=http://hôte:9222."""
    kind = "web"
    actions = Driver.actions + ["goto", "back", "forward", "reload", "device"]
    IPHONE_UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 "
                 "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")
    DEVICES = {
        "mobile": dict(viewport={"width": 390, "height": 844}, device_scale_factor=2,
                       is_mobile=True, has_touch=True, user_agent=IPHONE_UA),
        "tablette": dict(viewport={"width": 820, "height": 1180}, device_scale_factor=2,
                         is_mobile=True, has_touch=True, user_agent=IPHONE_UA.replace("iPhone", "iPad")),
        "desktop": dict(viewport={"width": 1280, "height": 800}),
    }
    # Les éléments qu'on peut viser, visibles et non masqués. Flutter web dessine
    # sur un canvas : ses nœuds de sémantique (activés plus bas) portent des rôles.
    HINTS_JS = r"""
() => {
  const sel = 'a[href],button,input:not([type=hidden]),select,textarea,summary,label[for],' +
    '[role=button],[role=link],[role=tab],[role=checkbox],[role=radio],[role=switch],[role=menuitem],' +
    '[role=option],[role=textbox],[role=combobox],[role=slider],[onclick],[contenteditable=""],[contenteditable=true],' +
    '[tabindex]:not([tabindex="-1"])'
  const W = innerWidth, H = innerHeight, out = [], seen = new Set()
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.right < 0 || r.top > H || r.left > W) continue
    const cx = Math.min(Math.max(r.left + r.width / 2, 1), W - 1)
    const cy = Math.min(Math.max(r.top + r.height / 2, 1), H - 1)
    const top = document.elementFromPoint(cx, cy)
    if (top && !(el === top || el.contains(top) || top.contains(el))) continue
    const key = Math.round(cx) + ',' + Math.round(cy)
    if (seen.has(key)) continue
    seen.add(key)
    const text = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder ||
      el.title || el.alt || el.name || el.getAttribute('role') || el.tagName)
    const isField = el.matches('input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]),' +
      'textarea,[contenteditable=""],[contenteditable=true],[role=textbox],[role=combobox]')
    out.push({ x: r.left, y: r.top, w: r.width, h: r.height, cx, cy,
      label: String(text).trim().replace(/\s+/g, ' ').slice(0, 40),
      kind: isField ? 'champ' : el.tagName === 'SELECT' ? 'liste' : el.tagName === 'A' ? 'lien' : 'bouton' })
    if (out.length >= 80) break
  }
  return out
}
"""
    FLUTTER_SEMANTICS_JS = r"""
() => {
  const p = document.querySelector('flt-semantics-placeholder')
  if (p && !window.__apercuSemantics) { window.__apercuSemantics = true; p.click(); return true }
  return false
}
"""

    async def start(self):
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            raise ActError("Playwright manque : pip install playwright && playwright install chromium")
        self.pw = await async_playwright().start()
        self.device = self.opts.get("appareil", "desktop")
        self.context = None
        if self.opts.get("cdp"):
            self.browser = await self.pw.chromium.connect_over_cdp(self.opts["cdp"])
            ctx = self.browser.contexts[0] if self.browser.contexts else await self.browser.new_context()
            self.page = ctx.pages[0] if ctx.pages else await ctx.new_page()
            self.watch(self.page)
            self.device = "cdp"
        else:
            self.browser = await self.pw.chromium.launch(headless=True, args=["--disable-dev-shm-usage"])
            await self.new_context(self.opts.get("url", "about:blank"))

    async def stop(self):
        try:
            await self.browser.close()
            await self.pw.stop()
        except Exception:
            pass

    def watch(self, page):
        page.on("console", lambda m: m.type in ("error", "warning") and self.log(m.type, m.text))
        page.on("pageerror", lambda err: self.log("erreur", str(err)))
        page.on("requestfailed", lambda req: self.log("réseau", f"{req.method} {req.url} ({req.failure})"))
        page.on("response", lambda res: res.status >= 400 and self.log("réseau", f"{res.status} {res.url}"))

    async def new_context(self, url):
        if self.context:
            await self.context.close()
        self.context = await self.browser.new_context(**self.DEVICES[self.device], ignore_https_errors=True)
        self.page = await self.context.new_page()
        self.watch(self.page)
        if url and url != "about:blank":
            await self.goto(url)

    async def goto(self, url):
        if "://" not in url and not url.startswith("about:"):
            url = "http://" + url
        try:
            await self.page.goto(url, wait_until="domcontentloaded", timeout=20_000)
        except Exception as err:  # la page reste affichée avec son erreur
            self.log("erreur", f"navigation vers {url} : {err}")

    async def capture(self):
        await self.page.evaluate(self.FLUTTER_SEMANTICS_JS)
        hints = await self.page.evaluate(self.HINTS_JS)
        jpeg = await self.page.screenshot(type="jpeg", quality=70, scale="css", timeout=5000)
        vp = self.page.viewport_size or await self.page.evaluate("() => ({width: innerWidth, height: innerHeight})")
        return {"jpeg": jpeg, "w": vp["width"], "h": vp["height"], "hints": hints, "url": self.page.url}

    async def act(self, a):
        t, page = a["type"], self.page
        touch = self.device != "cdp" and self.DEVICES[self.device].get("has_touch")
        if t == "tap":
            await (page.touchscreen.tap if touch else page.mouse.click)(a["x"], a["y"])
            return f"touché ({int(a['x'])}, {int(a['y'])})"
        if t == "type":
            await page.keyboard.type(str(a["text"]), delay=10)
            return f"tapé « {a['text']} »"
        if t == "key":
            await page.keyboard.press(a["key"])
            return f"touche {a['key']}"
        if t == "scroll":
            vp = page.viewport_size or {"width": 800, "height": 600}
            await page.mouse.move(vp["width"] / 2, vp["height"] / 2)
            await page.mouse.wheel(0, int(a.get("dy", 500)))
            return "défilé " + ("vers le bas" if int(a.get("dy", 500)) > 0 else "vers le haut")
        if t == "goto":
            await self.goto(a["url"])
            return f"ouvert {a['url']}"
        if t == "back":
            await page.go_back(timeout=10_000)
            return "retour"
        if t == "forward":
            await page.go_forward(timeout=10_000)
            return "suivant"
        if t == "reload":
            await page.reload(timeout=20_000)
            return "rechargé"
        if t == "device":
            if self.device == "cdp":
                raise ActError("navigateur externe (cdp) : la taille se règle de son côté")
            name = a.get("name") or ("desktop" if self.device != "desktop" else "mobile")
            if name not in self.DEVICES:
                raise ActError(f"appareil inconnu : {name}")
            self.device = name
            await self.new_context(page.url)
            return f"passé en {name}"
        raise ActError(f"action inconnue pour web : {t}")

    async def settle(self):
        try:
            await self.page.wait_for_load_state("domcontentloaded", timeout=3000)
        except Exception:
            pass

    async def shot(self, path, full=False):
        await self.page.screenshot(path=path, full_page=full)


class AdbDriver(Driver):
    """Android : émulateur, téléphone en USB ou en Wi-Fi (adb connect), Android TV.
    Les repères viennent de l'arbre d'accessibilité (uiautomator) : boutons et
    champs des apps natives, Compose, Flutter, React Native. Un jeu (Unity,
    Godot) dessine tout lui-même : on vise alors par la grille du panneau.
    opts : serie (adb -s), connecter (hôte:port pour adb connect), paquet (lancé au départ)."""
    kind = "adb"
    actions = Driver.actions + ["back", "home", "apps", "launch"]
    KEYS = {"enter": 66, "tab": 61, "backspace": 67, "escape": 111, "delete": 112, "home": 3, "back": 4,
            "arrowup": 19, "arrowdown": 20, "arrowleft": 21, "arrowright": 22, "space": 62, "menu": 82}

    def adb(self, *args):
        base = [self.opts.get("adb", "adb")]
        if self.opts.get("serie"):
            base += ["-s", self.opts["serie"]]
        return base + list(args)

    async def start(self):
        if not shutil.which(self.opts.get("adb", "adb")):
            raise ActError("adb introuvable (Android platform-tools)")
        if self.opts.get("connecter"):
            await run(self.opts.get("adb", "adb"), "connect", self.opts["connecter"])
            self.opts.setdefault("serie", self.opts["connecter"])
        await run(*self.adb("wait-for-device"), timeout=30)
        if self.opts.get("paquet"):
            await self.launch(self.opts["paquet"])
        self.hints, self.hints_at = [], 0.0

    async def launch(self, pkg):
        await run(*self.adb("shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1"))

    async def capture(self):
        png = await run(*self.adb("exec-out", "screencap", "-p"))
        im_jpeg = to_jpeg(png, 70, 1280)
        w, h = Image.open(io.BytesIO(png)).size
        # l'arbre d'accessibilité coûte une à deux secondes : pas à chaque image
        if time.time() - self.hints_at > 2.5:
            self.hints_at = time.time()
            try:
                self.hints = await self.dump_hints()
            except ActError:
                self.hints = []
        return {"jpeg": im_jpeg, "w": w, "h": h, "hints": self.hints, "url": await self.top_activity()}

    async def top_activity(self):
        try:
            out = (await run(*self.adb("shell", "dumpsys", "activity", "activities"), timeout=5)).decode(errors="replace")
            m = re.search(r"(?:mResumedActivity|topResumedActivity)[^{]*\{[^ ]+ [^ ]+ ([^ }]+)", out)
            return "android://" + (m.group(1) if m else "?")
        except ActError:
            return "android://?"

    async def dump_hints(self):
        xml = (await run(*self.adb("exec-out", "uiautomator", "dump", "/dev/tty"), timeout=8)).decode(errors="replace")
        out = []
        for node in re.finditer(r"<node ([^>]*)", xml):
            attrs = dict(re.findall(r'([\w-]+)="([^"]*)"', node.group(1)))
            field = "EditText" in attrs.get("class", "")
            if attrs.get("clickable") != "true" and not field:
                continue
            m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", attrs.get("bounds", ""))
            if not m:
                continue
            x1, y1, x2, y2 = map(int, m.groups())
            if x2 - x1 < 8 or y2 - y1 < 8:
                continue
            label = attrs.get("text") or attrs.get("content-desc") or attrs.get("resource-id", "").split("/")[-1] \
                or attrs.get("class", "").split(".")[-1]
            out.append({"x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1, "cx": (x1 + x2) / 2, "cy": (y1 + y2) / 2,
                        "label": label[:40], "kind": "champ" if field else "bouton"})
        return out[:80]

    async def act(self, a):
        t = a["type"]
        self.hints_at = 0
        if t == "tap":
            await run(*self.adb("shell", "input", "tap", str(int(a["x"])), str(int(a["y"]))))
            return f"touché ({int(a['x'])}, {int(a['y'])})"
        if t == "type":
            text = re.sub(r"([\\'\"`$&|;<>()*?!#~ ])", lambda m: "%s" if m.group(1) == " " else "\\" + m.group(1), str(a["text"]))
            await run(*self.adb("shell", "input", "text", text))
            return f"tapé « {a['text']} »"
        if t in ("key", "back", "home", "apps"):
            name = {"back": "back", "home": "home", "apps": "menu"}.get(t) or str(a["key"]).lower()
            code = self.KEYS.get(name) or (int(name) if name.isdigit() else None)
            if code is None:
                raise ActError(f"touche inconnue : {a.get('key')}")
            await run(*self.adb("shell", "input", "keyevent", str(code)))
            return {"back": "retour", "home": "accueil"}.get(name, f"touche {name}")
        if t == "scroll":
            dy = int(a.get("dy", 500))
            sz = (await run(*self.adb("shell", "wm", "size"))).decode()
            w, h = map(int, re.findall(r"(\d+)x(\d+)", sz)[-1])
            d = max(-h // 3, min(h // 3, dy * h // 1600))
            await run(*self.adb("shell", "input", "swipe", str(w // 2), str(h // 2 + d), str(w // 2), str(h // 2 - d), "300"))
            return "défilé " + ("vers le bas" if dy > 0 else "vers le haut")
        if t == "launch":
            await self.launch(a["url"])
            return f"lancé {a['url']}"
        raise ActError(f"action inconnue pour adb : {t}")

    async def settle(self):
        await asyncio.sleep(0.4)


class IosDriver(Driver):
    """Simulateur iOS, sur un Mac : xcrun simctl pour l'image, idb (fb-idb) pour
    toucher, taper et lire l'arbre d'accessibilité. Sans idb : image seule.
    opts : udid (booted par défaut), bundle (app lancée au départ)."""
    kind = "ios"
    actions = Driver.actions + ["home", "launch", "goto"]

    async def start(self):
        if not shutil.which("xcrun"):
            raise ActError("xcrun introuvable : le pilote ios tourne sur un Mac avec Xcode")
        self.udid = self.opts.get("udid", "booted")
        self.idb = shutil.which("idb")
        if not self.idb:
            self.log("warning", "idb absent (brew install facebook/fb/idb-companion && pip install fb-idb) : image seule")
        if self.opts.get("bundle"):
            await run("xcrun", "simctl", "launch", self.udid, self.opts["bundle"])
        self.hints, self.hints_at, self.points = [], 0.0, None

    def idb_args(self, *a):
        return [self.idb, *a] + ([] if self.udid == "booted" else ["--udid", self.udid])

    async def capture(self):
        with tempfile.NamedTemporaryFile(suffix=".png") as f:
            await run("xcrun", "simctl", "io", self.udid, "screenshot", f.name)
            png = open(f.name, "rb").read()
        w, h = Image.open(io.BytesIO(png)).size
        if self.idb and time.time() - self.hints_at > 2.5:
            self.hints_at = time.time()
            try:
                self.hints = await self.dump_hints()
            except (ActError, ValueError):
                self.hints = []
        # idb parle en points : l'image est en pixels (×2 ou ×3)
        pw, ph = self.points or (w, h)
        return {"jpeg": to_jpeg(png, 70, 1280), "w": pw, "h": ph, "hints": self.hints, "url": "ios://" + self.udid}

    async def dump_hints(self):
        nodes = json.loads(await run(*self.idb_args("ui", "describe-all", "--json"), timeout=8))
        out = []
        for n in nodes:
            f = n.get("frame") or {}
            if n.get("type") == "Application":
                self.points = (f.get("width"), f.get("height"))
                continue
            if n.get("type") not in ("Button", "TextField", "SecureTextField", "Link", "Cell", "Switch", "Tab", "SearchField"):
                continue
            x, y, w, h = f.get("x", 0), f.get("y", 0), f.get("width", 0), f.get("height", 0)
            out.append({"x": x, "y": y, "w": w, "h": h, "cx": x + w / 2, "cy": y + h / 2,
                        "label": (n.get("AXLabel") or n.get("AXValue") or n.get("type"))[:40],
                        "kind": "champ" if "Field" in n.get("type", "") else "bouton"})
        return out[:80]

    async def act(self, a):
        t = a["type"]
        self.hints_at = 0
        if t in ("launch", "goto"):
            target = a["url"]
            if "://" in target:
                await run("xcrun", "simctl", "openurl", self.udid, target)
            else:
                await run("xcrun", "simctl", "launch", self.udid, target)
            return f"ouvert {target}"
        if not self.idb:
            raise ActError("idb manque pour agir sur le simulateur")
        if t == "tap":
            await run(*self.idb_args("ui", "tap", str(int(a["x"])), str(int(a["y"]))))
            return f"touché ({int(a['x'])}, {int(a['y'])})"
        if t == "type":
            await run(*self.idb_args("ui", "text", str(a["text"])))
            return f"tapé « {a['text']} »"
        if t == "key":
            codes = {"enter": "40", "tab": "43", "backspace": "42", "escape": "41"}
            await run(*self.idb_args("ui", "key", codes.get(str(a["key"]).lower(), str(a["key"]))))
            return f"touche {a['key']}"
        if t == "home":
            await run(*self.idb_args("ui", "button", "HOME"))
            return "accueil"
        if t == "scroll":
            w, h = self.points or (390, 844)
            d = max(-h // 3, min(h // 3, int(a.get("dy", 500)) * h // 1600))
            await run(*self.idb_args("ui", "swipe", str(w // 2), str(h // 2 + d), str(w // 2), str(h // 2 - d)))
            return "défilé"
        raise ActError(f"action inconnue pour ios : {t}")

    async def settle(self):
        await asyncio.sleep(0.4)


class ScreenDriver(Driver):
    """Un écran entier ou une zone : client lourd, jeu en fenêtre, émulateur
    qu'aucun autre pilote ne sait lire. Linux (X11, Xvfb compris), macOS, Windows.
    opts : ecran (n° du moniteur, 1 par défaut), zone ("x,y,l,h"), display (":99").
    Pour agir : pynput, sinon python-xlib (XTest), sinon xdotool, sinon cliclick (macOS)."""
    kind = "ecran"

    async def start(self):
        if self.opts.get("display"):
            os.environ["DISPLAY"] = self.opts["display"]
        try:
            import mss
        except ImportError:
            raise ActError("mss manque pour capturer l'écran : pip install mss")
        self.mss = getattr(mss, "MSS", None) and mss.MSS() or mss.mss()
        mon = self.mss.monitors[int(self.opts.get("ecran", 1))]
        if self.opts.get("zone"):
            x, y, w, h = map(int, str(self.opts["zone"]).split(","))
            mon = {"left": mon["left"] + x, "top": mon["top"] + y, "width": w, "height": h}
        self.mon = mon
        self.input = self.pick_input()
        if not self.input:
            self.log("warning", "aucun moyen d'agir trouvé (pynput, python-xlib, xdotool, cliclick) : image seule")

    def pick_input(self):
        try:
            from pynput import keyboard, mouse
            self.mouse, self.kb, self.Key = mouse.Controller(), keyboard.Controller(), keyboard.Key
            return "pynput"
        except Exception:
            pass
        try:
            from Xlib import X, XK, display
            from Xlib.ext import xtest
            self.X, self.XK, self.xtest, self.dpy = X, XK, xtest, display.Display()
            return "xlib"
        except Exception:
            pass
        for tool in ("xdotool", "cliclick"):
            if shutil.which(tool):
                return tool
        return None

    async def capture(self):
        shot = self.mss.grab(self.mon)
        if Image is None:
            raise ActError("Pillow manque : pip install pillow")
        im = Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")
        buf = io.BytesIO()
        if max(im.size) > 1600:
            k = 1600 / max(im.size)
            im = im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS)
        im.save(buf, "JPEG", quality=70)
        return {"jpeg": buf.getvalue(), "w": self.mon["width"], "h": self.mon["height"], "hints": [],
                "url": f"ecran://{os.environ.get('DISPLAY', '')}@{self.mon['left']},{self.mon['top']}"}

    def xkey(self, keysym, shift=False):
        code = self.dpy.keysym_to_keycode(keysym)
        if not code:
            return
        sh = self.dpy.keysym_to_keycode(self.XK.string_to_keysym("Shift_L"))
        if shift:
            self.xtest.fake_input(self.dpy, self.X.KeyPress, sh)
        self.xtest.fake_input(self.dpy, self.X.KeyPress, code)
        self.xtest.fake_input(self.dpy, self.X.KeyRelease, code)
        if shift:
            self.xtest.fake_input(self.dpy, self.X.KeyRelease, sh)
        self.dpy.sync()

    async def act(self, a):
        if not self.input:
            raise ActError("aucun moyen d'agir sur cet écran (installe pynput ou xdotool)")
        t, inp = a["type"], self.input
        if t == "tap":
            x, y = int(self.mon["left"] + a["x"]), int(self.mon["top"] + a["y"])
            if inp == "pynput":
                from pynput.mouse import Button
                self.mouse.position = (x, y)
                self.mouse.click(Button.left)
            elif inp == "xlib":
                self.xtest.fake_input(self.dpy, self.X.MotionNotify, x=x, y=y)
                self.xtest.fake_input(self.dpy, self.X.ButtonPress, 1)
                self.xtest.fake_input(self.dpy, self.X.ButtonRelease, 1)
                self.dpy.sync()
            elif inp == "xdotool":
                await run("xdotool", "mousemove", str(x), str(y), "click", "1")
            else:
                await run("cliclick", f"c:{x},{y}")
            return f"cliqué ({int(a['x'])}, {int(a['y'])})"
        if t == "type":
            text = str(a["text"])
            if inp == "pynput":
                self.kb.type(text)
            elif inp == "xlib":
                for ch in text:
                    name = {" ": "space", "\n": "Return"}.get(ch, ch)
                    sym = self.XK.string_to_keysym(name) or ord(ch)
                    self.xkey(sym, shift=ch.isupper() or ch in '!"#$%&()*+:<>?@^_{|}~')
            elif inp == "xdotool":
                await run("xdotool", "type", "--delay", "10", text)
            else:
                await run("cliclick", f"t:{text}")
            return f"tapé « {text} »"
        if t == "key":
            k = str(a["key"])
            names = {"enter": ("enter", "Return", "Return", "kp:return"), "tab": ("tab", "Tab", "Tab", "kp:tab"),
                     "escape": ("esc", "Escape", "Escape", "kp:esc"), "backspace": ("backspace", "BackSpace", "BackSpace", "kp:delete"),
                     "arrowup": ("up", "Up", "Up", "kp:arrow-up"), "arrowdown": ("down", "Down", "Down", "kp:arrow-down"),
                     "arrowleft": ("left", "Left", "Left", "kp:arrow-left"), "arrowright": ("right", "Right", "Right", "kp:arrow-right"),
                     "space": ("space", "space", "space", "kp:space")}
            n = names.get(k.lower(), (k, k, k, f"kp:{k}"))
            if inp == "pynput":
                key = getattr(self.Key, n[0], None) or k
                self.kb.press(key)
                self.kb.release(key)
            elif inp == "xlib":
                self.xkey(self.XK.string_to_keysym(n[1]))
            elif inp == "xdotool":
                await run("xdotool", "key", n[2])
            else:
                await run("cliclick", n[3])
            return f"touche {k}"
        if t == "scroll":
            dy = int(a.get("dy", 500))
            clicks = max(1, abs(dy) // 100)
            if inp == "pynput":
                self.mouse.scroll(0, -clicks if dy > 0 else clicks)
            elif inp == "xlib":
                b = 5 if dy > 0 else 4
                for _ in range(clicks):
                    self.xtest.fake_input(self.dpy, self.X.ButtonPress, b)
                    self.xtest.fake_input(self.dpy, self.X.ButtonRelease, b)
                self.dpy.sync()
            elif inp == "xdotool":
                await run("xdotool", "click", "--repeat", str(clicks), "5" if dy > 0 else "4")
            else:
                raise ActError("défilement non géré par cliclick")
            return "défilé " + ("vers le bas" if dy > 0 else "vers le haut")
        raise ActError(f"action inconnue pour ecran : {t}")

    async def settle(self):
        await asyncio.sleep(0.25)


class BridgeDriver(Driver):
    """Une cible qui parle le protocole Aperçu (PROTOCOLE.md), sur cette machine
    ou ailleurs. Deux sens :
      - sortant : opts url=http://hôte:port ; le hub va chercher les images ;
      - entrant : sans url ; l'adaptateur appelle le hub (POST /pont/<nom>/push,
        GET /pont/<nom>/pull, POST /pont/<nom>/done) : seule la machine du hub
        doit être joignable, la cible peut rester derrière un NAT.
    opts : jeton (obligatoire en entrant, envoyé en Bearer en sortant)."""
    kind = "pont"
    actions = ["tap", "hint", "type", "key", "scroll", "back", "goto", "reload"]

    async def start(self):
        self.url = (self.opts.get("url") or "").rstrip("/")
        self.frame = None
        self.queue = asyncio.Queue()
        self.waiting = {}
        self.seen_at = 0.0
        self.next_id = 0
        if self.url:
            await self.fetch("/state")

    async def fetch(self, path, body=None):
        def go():
            req = urllib.request.Request(self.url + path, data=None if body is None else json.dumps(body).encode(),
                                         headers={"Content-Type": "application/json",
                                                  "Authorization": f"Bearer {self.opts.get('jeton', '')}"})
            try:
                with urllib.request.urlopen(req, timeout=20) as r:
                    return json.load(r)
            except urllib.error.HTTPError as err:
                return json.load(err)
        try:
            return await asyncio.to_thread(go)
        except OSError as err:
            raise ActError(f"adaptateur injoignable ({self.url}) : {err}")

    async def capture(self):
        if self.url:
            f = await self.fetch("/frame?fmt=raw")
            if f.get("error"):
                raise ActError(f["error"])
        else:
            if not self.frame:
                raise ActError("en attente de l'adaptateur (il doit appeler /pont/<nom>/push)")
            if time.time() - self.seen_at > 15:
                self.log("warning", "l'adaptateur ne donne plus d'image depuis 15 s")
            f = self.frame
        if self.url:  # le journal de l'adaptateur rejoint celui de la cible
            for c in f.get("console", []):
                if c.get("at", 0) > self.seen_at:
                    self.log(c.get("kind", "info"), c.get("text", ""))
            self.seen_at = max([self.seen_at] + [c.get("at", 0) for c in f.get("console", [])])
        return {"jpeg": base64.b64decode(f["jpeg"]), "w": f.get("w") or f.get("vw"), "h": f.get("h") or f.get("vh"),
                "hints": f.get("hints", []), "url": f.get("url", "pont://" + self.opts.get("nom", "?"))}

    # côté entrant : ce que l'adaptateur pousse
    def push(self, f):
        self.frame, self.seen_at = f, time.time()
        for c in f.get("logs", []):
            self.log(c.get("kind", "info"), c.get("text", ""))

    async def pull(self, wait=25):
        self.seen_at = max(self.seen_at, time.time() - 10)
        try:
            first = await asyncio.wait_for(self.queue.get(), wait)
        except asyncio.TimeoutError:
            return []
        items = [first]
        while not self.queue.empty():
            items.append(self.queue.get_nowait())
        return items

    def done(self, r):
        fut = self.waiting.pop(r.get("id"), None)
        if fut and not fut.done():
            fut.set_result(r)

    async def act(self, a):
        if self.url:
            r = await self.fetch("/act", {**a, "by": a.get("by", "toi")})
        else:
            self.next_id += 1
            fut = asyncio.get_running_loop().create_future()
            self.waiting[self.next_id] = fut
            await self.queue.put({**a, "id": self.next_id})
            try:
                r = await asyncio.wait_for(fut, 15)
            except asyncio.TimeoutError:
                self.waiting.pop(self.next_id, None)
                raise ActError("l'adaptateur n'a pas répondu en 15 s")
        if r.get("ok") is False:
            raise ActError(r.get("error", "refusé par l'adaptateur"))
        return r.get("text") or (r.get("last") or {}).get("text") or a["type"]

    async def settle(self):
        await asyncio.sleep(0.3 if self.url else 0.6)


DRIVERS = {d.kind: d for d in (WebDriver, AdbDriver, IosDriver, ScreenDriver, BridgeDriver)}


# ───────────────────────────── cibles ─────────────────────────────


class Target:
    """Un pilote, sa dernière image et son journal : ce que le panneau lit."""

    def __init__(self, spec):
        self.spec = dict(spec)
        self.name = spec["nom"]
        self.kind = spec["pilote"]
        if self.kind not in DRIVERS:
            raise ActError(f"pilote inconnu : {self.kind} (connus : {', '.join(DRIVERS)})")
        self.driver = DRIVERS[self.kind](self.spec, self.log)
        self.lock = asyncio.Lock()
        self.seq, self.jpeg, self.digest, self.shot_at = 0, b"", "", 0.0
        self.hints, self.size, self.url = [], (0, 0), ""
        self.console, self.last_action = [], None
        self.status, self.error = "démarrage", ""

    def log(self, kind, text):
        self.console.append({"at": time.time(), "kind": kind, "text": str(text)[:500]})
        del self.console[:-40]

    async def start(self):
        try:
            await self.driver.start()
            self.status = "prête"
        except Exception as err:
            self.status, self.error = "en panne", str(err)
            self.log("erreur", f"démarrage : {err}")

    async def capture(self, force=False):
        if self.status != "prête" or (not force and time.time() - self.shot_at < MIN_SHOT_GAP):
            return
        self.shot_at = time.time()
        try:
            c = await self.driver.capture()
        except Exception as err:
            if "en attente" not in str(err):
                self.log("erreur", f"capture : {err}")
            self.error = str(err)
            return
        self.error = ""
        hints = c.get("hints") or []
        digest = hashlib.sha1(c["jpeg"] + json.dumps(hints).encode()).hexdigest()
        self.url = c.get("url", "")
        if digest != self.digest:
            self.digest, self.jpeg, self.hints = digest, c["jpeg"], hints
            self.size = (int(c["w"]), int(c["h"]))
            self.seq += 1

    def state(self):
        return {"seq": self.seq, "cible": self.name, "pilote": self.kind, "url": self.url,
                "device": getattr(self.driver, "device", self.kind), "vw": self.size[0], "vh": self.size[1],
                "hints": [dict(h, n=i + 1) for i, h in enumerate(self.hints)],
                "console": self.console[-12:], "last": self.last_action, "status": self.status,
                "error": self.error, "actions": self.driver.actions}

    def svg_jpeg(self):
        """La capture ré-encodée pour tenir dans le budget de l'élément Svg."""
        if Image is None:
            return base64.b64encode(self.jpeg).decode()
        im = Image.open(io.BytesIO(self.jpeg)).convert("RGB")
        width = min(im.width, 960)
        b64 = ""
        for quality in (72, 60, 50, 40, 32):
            for scale in (1.0, 0.8, 0.65, 0.5, 0.35):
                w = max(1, int(width * scale))
                small = im.resize((w, max(1, round(im.height * w / im.width))), Image.LANCZOS) if w != im.width else im
                buf = io.BytesIO()
                small.save(buf, "JPEG", quality=quality, optimize=True)
                b64 = base64.b64encode(buf.getvalue()).decode()
                if len(b64) <= SVG_BUDGET:
                    return b64
        return b64

    def rgb(self, w, h):
        im = Image.open(io.BytesIO(self.jpeg)).convert("RGB").resize((w, h), Image.BILINEAR)
        return base64.b64encode(im.tobytes()).decode()

    async def act(self, a):
        a = dict(a)
        t = a.get("type")
        by = a.pop("by", "toi")
        if self.status != "prête":
            raise ActError(f"cible « {self.name} » {self.status} : {self.error}")
        vw, vh = self.size
        if t == "click":  # ancien nom
            t = a["type"] = "tap"
        if t == "tap" and "fx" in a:
            a["x"], a["y"] = a["fx"] * vw, a["fy"] * vh
        if t == "hint":
            n = int(a["n"])
            if not 1 <= n <= len(self.hints):
                raise ActError(f"pas de repère {n} (1 à {len(self.hints)})")
            h = self.hints[n - 1]
            if self.kind == "pont" and "hint" in self.driver.actions:
                # l'adaptateur sait viser l'objet lui-même (id), mieux qu'un clic au centre
                done = await self.driver.act({"type": "hint", "n": n, "ref": h.get("id"), "text": a.get("text"),
                                              "x": h["cx"], "y": h["cy"]})
            else:
                await self.driver.act({"type": "tap", "x": h["cx"], "y": h["cy"]})
                done = f"touché {n} « {h['label']} »"
                if a.get("text") is not None:
                    await asyncio.sleep(0.2)
                    if self.kind == "web":
                        await self.driver.page.keyboard.press("ControlOrMeta+A")
                    await self.driver.act({"type": "type", "text": a["text"]})
                    done += f" et tapé « {a['text']} »"
        elif t == "shot":
            path = a.get("path") or os.path.join(tempfile.gettempdir(), f"apercu-{int(time.time())}.png")
            if isinstance(self.driver, WebDriver):
                await self.driver.shot(path, bool(a.get("full")))
            else:
                await self.capture(force=True)
                if Image is None:
                    path = path.rsplit(".", 1)[0] + ".jpg"
                    open(path, "wb").write(self.jpeg)
                else:
                    Image.open(io.BytesIO(self.jpeg)).save(path)
            return {"ok": True, "path": path, **self.state()}
        else:
            done = await self.driver.act(a)
        self.last_action = {"by": by, "text": done, "at": time.time()}
        await self.driver.settle()
        await self.capture(force=True)
        return {"ok": True, **self.state()}


class Hub:
    def __init__(self, token=None):
        self.targets = {}
        self.active = None
        self.token = token
        self.config_path = None
        self.extra = {}

    async def add(self, spec):
        name = spec.get("nom") or spec.get("pilote")
        spec = {**spec, "nom": name}
        old = self.targets.get(name)
        if old and old.spec == spec and old.status == "prête":
            return old
        if old:
            await old.driver.stop()
        t = Target(spec)
        self.targets[name] = t
        if not self.active or self.active not in self.targets:
            self.active = name
        await t.start()
        return t

    async def remove(self, name):
        t = self.targets.pop(name, None)
        if t:
            await t.driver.stop()
        if self.active == name:
            self.active = next(iter(self.targets), None)

    async def load(self, path):
        with open(path) as f:
            conf = json.load(f)
        self.config_path = path
        names = []
        for spec in conf.get("cibles", []):
            t = await self.add(spec)
            names.append(t.name)
        if conf.get("active") in self.targets:
            self.active = conf["active"]
        elif names and self.active not in names:
            self.active = names[0]
        return names

    def get(self, name=None):
        name = name or self.active
        if name not in self.targets:
            raise ActError(f"pas de cible « {name} »" if name else "aucune cible : ajoute-en une (.apercu.json ou /cibles)")
        return self.targets[name]

    def listing(self):
        return {"active": self.active, "config": self.config_path,
                "cibles": [{"nom": t.name, "pilote": t.kind, "status": t.status, "error": t.error, "url": t.url}
                           for t in self.targets.values()]}


# ───────────────────────────── HTTP ─────────────────────────────


async def serve_http(host, port, handler):
    async def handle(reader, writer):
        try:
            head = await reader.readuntil(b"\r\n\r\n")
            lines = head.decode("latin-1").split("\r\n")
            method, target, _ = lines[0].split(" ", 2)
            headers = {k.lower(): v.strip() for k, v in (l.split(":", 1) for l in lines[1:] if ":" in l)}
            body = await reader.readexactly(int(headers.get("content-length", "0") or 0))
            url = urlparse(target)
            q = {k: v[0] for k, v in parse_qs(url.query).items()}
            try:
                status, out = await handler(method, url.path, q, headers, json.loads(body) if body.strip() else {})
            except ActError as err:
                status, out = 400, {"ok": False, "error": str(err)}
            data = json.dumps(out, ensure_ascii=False).encode()
            writer.write(b"HTTP/1.1 %d OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n"
                         % (status, len(data)) + data)
        except Exception as err:
            data = json.dumps({"ok": False, "error": str(err)}).encode()
            writer.write(b"HTTP/1.1 500 ERR\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n" % len(data) + data)
        finally:
            try:
                await writer.drain()
                writer.close()
            except Exception:
                pass

    return await asyncio.start_server(handle, host, port)


def authorized(headers, token):
    return not token or headers.get("authorization", "") == f"Bearer {token}"


def frame_payload(t, q):
    out = t.state()
    if t.seq > int(q.get("since", "-1")) and t.jpeg:
        fmt = q.get("fmt", "jpeg")
        if fmt == "rgb" and Image is not None:
            w, h = int(q["w"]), int(q["h"])
            out.update(rgb=t.rgb(w, h), iw=w, ih=h)
        elif fmt == "raw":
            out.update(jpeg=base64.b64encode(t.jpeg).decode(), w=t.size[0], h=t.size[1])
        else:
            out.update(jpeg=t.svg_jpeg())
    return out


def make_hub_handler(hub, pont_only=False):
    async def handler(method, path, q, headers, body):
        m = re.match(r"^/pont/([^/]+)/(push|pull|done)$", path)
        if m:  # un adaptateur entrant : son propre jeton, même hub local
            t = hub.targets.get(m.group(1))
            if not t or t.kind != "pont" or t.driver.url:
                return 404, {"ok": False, "error": f"pas de pont entrant « {m.group(1)} »"}
            if not t.spec.get("jeton") or headers.get("authorization") != f"Bearer {t.spec['jeton']}":
                return 401, {"ok": False, "error": "jeton refusé"}
            if m.group(2) == "push":
                t.driver.push(body)
                return 200, {"ok": True}
            if m.group(2) == "pull":
                return 200, {"ok": True, "actions": await t.driver.pull(float(q.get("wait", 25)))}
            t.driver.done(body)
            return 200, {"ok": True}
        if pont_only:
            return 404, {"ok": False, "error": "cette écoute ne sert que /pont/<nom>/*"}
        if not authorized(headers, hub.token):
            return 401, {"ok": False, "error": "jeton refusé"}
        if path == "/cibles" and method == "GET":
            return 200, hub.listing()
        if path == "/cibles" and method == "POST":
            await hub.add(body)
            return 200, hub.listing()
        if path == "/cibles/retirer":
            await hub.remove(body.get("nom"))
            return 200, hub.listing()
        if path == "/config":
            names = await hub.load(body["chemin"])
            return 200, {**hub.listing(), "chargees": names}
        if path == "/ecoute":
            # une écoute de plus, qui ne sert que /pont/<nom>/* (jeton de chaque cible) :
            # c'est elle qu'on met sur le réseau local, le VPN ou un tunnel, jamais le hub entier
            bind, port = body.get("bind", "0.0.0.0"), int(body.get("port", 7358))
            key = f"{bind}:{port}"
            if key not in hub.extra:
                hub.extra[key] = await serve_http(bind, port, make_hub_handler(hub, pont_only=True))
            return 200, {"ok": True, "ecoutes": list(hub.extra)}
        if path == "/active":
            hub.get(body.get("nom"))
            hub.active = body["nom"]
            return 200, hub.listing()
        name = q.get("cible") or body.get("cible")
        if path == "/state":
            if not hub.targets:
                return 200, {**hub.listing(), "seq": -1}
            t = hub.get(name)
            async with t.lock:
                await t.capture()
            return 200, {**t.state(), "cibles": hub.listing()["cibles"], "active": hub.active}
        if path == "/frame":
            if not hub.targets:
                return 200, {**hub.listing(), "seq": -1}
            t = hub.get(name)
            async with t.lock:
                await t.capture()
            return 200, {**frame_payload(t, q), "cibles": hub.listing()["cibles"], "active": hub.active}
        if path == "/act" and method == "POST":
            t = hub.get(name)
            body.pop("cible", None)
            async with t.lock:
                return 200, await t.act(body)
        return 404, {"ok": False, "error": "inconnu"}
    return handler


async def cmd_serve(args):
    hub = Hub(args.token)
    if args.bind not in ("127.0.0.1", "localhost", "::1") and not args.token:
        sys.exit("apercu : --bind hors de la machine demande un --token")
    if args.config and os.path.exists(args.config):
        await hub.load(args.config)
    server = await serve_http(args.bind, args.port, make_hub_handler(hub))
    if args.pont:
        host, _, port = args.pont.rpartition(":")
        hub.extra[args.pont] = await serve_http(host or "0.0.0.0", int(port), make_hub_handler(hub, pont_only=True))
    print(f"apercu : hub prêt sur {args.bind}:{args.port}", flush=True)
    async with server:
        await server.serve_forever()


def parse_opts(pairs):
    out = {}
    for p in pairs:
        k, _, v = p.partition("=")
        out[k] = v
    return out


async def cmd_expose(args):
    """Un seul pilote, sur la machine cible, servi au hub par le protocole Aperçu."""
    spec = {"nom": args.name or args.driver, "pilote": args.driver, **parse_opts(args.opts)}
    t = Target(spec)
    await t.start()
    if t.status != "prête":
        sys.exit(f"apercu : {t.error}")
    if args.listen:
        host, _, port = args.listen.rpartition(":")
        host = host or "127.0.0.1"
        if host not in ("127.0.0.1", "localhost") and not args.token:
            sys.exit("apercu : --listen hors de la machine demande un --token")

        async def handler(method, path, q, headers, body):
            if not authorized(headers, args.token):
                return 401, {"ok": False, "error": "jeton refusé"}
            async with t.lock:
                if path == "/state":
                    await t.capture()
                    return 200, t.state()
                if path == "/frame":
                    await t.capture()
                    return 200, frame_payload(t, q)
                if path == "/act" and method == "POST":
                    return 200, await t.act(body)
            return 404, {"ok": False, "error": "inconnu"}

        server = await serve_http(host, int(port), handler)
        print(f"apercu : {args.driver} exposé sur {host}:{port}", flush=True)
        async with server:
            await server.serve_forever()
        return

    # en appel sortant : pousse les images, attend les actions
    base = f"{args.dial.rstrip('/')}/pont/{spec['nom']}"
    auth = {"Authorization": f"Bearer {args.token}", "Content-Type": "application/json"}

    def post(path, body, timeout=20):
        req = urllib.request.Request(base + path, data=json.dumps(body).encode(), headers=auth)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)

    def get(path, timeout):
        with urllib.request.urlopen(urllib.request.Request(base + path, headers=auth), timeout=timeout) as r:
            return json.load(r)

    async def pusher():
        sent, logs_at = -1, 0.0
        while True:
            try:
                async with t.lock:
                    await t.capture()
                if t.seq != sent:
                    logs = [c for c in t.console if c["at"] > logs_at]
                    logs_at = time.time()
                    await asyncio.to_thread(post, "/push", {"jpeg": base64.b64encode(t.jpeg).decode(), "w": t.size[0],
                                                            "h": t.size[1], "hints": t.hints, "url": t.url, "logs": logs})
                    sent = t.seq
                await asyncio.sleep(0.3)
            except Exception as err:
                print(f"apercu : push : {err}", file=sys.stderr, flush=True)
                await asyncio.sleep(3)

    async def puller():
        while True:
            try:
                r = await asyncio.to_thread(get, "/pull?wait=20", 30)
                for a in r.get("actions", []):
                    aid = a.pop("id", None)
                    try:
                        async with t.lock:
                            res = await t.act(a)
                        res = {"ok": True, "text": (res.get("last") or {}).get("text")}
                    except ActError as err:
                        res = {"ok": False, "error": str(err)}
                    await asyncio.to_thread(post, "/done", {"id": aid, **res})
            except Exception as err:
                print(f"apercu : pull : {err}", file=sys.stderr, flush=True)
                await asyncio.sleep(3)

    print(f"apercu : {args.driver} relié à {base}", flush=True)
    await asyncio.gather(pusher(), puller())


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd")
    s = sub.add_parser("serve")
    s.add_argument("--port", type=int, default=int(os.environ.get("APERCU_PORT", "7357")))
    s.add_argument("--bind", default="127.0.0.1")
    s.add_argument("--token", default=os.environ.get("APERCU_TOKEN"))
    s.add_argument("--config")
    s.add_argument("--pont", help="HÔTE:PORT d'une écoute de plus, réservée aux ponts entrants")
    e = sub.add_parser("expose")
    e.add_argument("driver", choices=list(DRIVERS))
    e.add_argument("opts", nargs="*", help="options du pilote, k=v")
    e.add_argument("--listen")
    e.add_argument("--dial")
    e.add_argument("--name")
    e.add_argument("--token", default=os.environ.get("APERCU_TOKEN"))
    args = ap.parse_args(sys.argv[1:] or ["serve"])
    if args.cmd == "expose" and not (args.listen or args.dial):
        ap.error("expose : --listen ou --dial")
    if args.cmd == "expose" and args.dial and not args.token:
        ap.error("expose --dial : --token (le jeton de la cible côté hub)")
    try:
        asyncio.run(cmd_serve(args) if args.cmd == "serve" else cmd_expose(args))
    except OSError as err:
        print(f"apercu : {err}", file=sys.stderr)
        sys.exit(2)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

// QG pixel art engine: a room, work stations, Clawd and a game HUD.
// Everything is drawn into pixel buffers (-1 = transparent, SHADOW = 35 %
// black), then turned into half blocks for the terminal or SVG for desktop.

import type { Mood, Station } from '../types'

export const W = 192
export const H = 108
export const FOOT = 92
export const FRAMES = 16
export const FRAME_MS = 200
export const SHADOW = 0x1000000

export const STATION_X: Record<Station, number> = {
  shelf: 27, desk: 60, center: 96, term: 136, globe: 170,
}

export type Buf = Int32Array

export const blank = (): Buf => new Int32Array(W * H).fill(-1)

export const hex = (s: string) => parseInt(s.slice(1), 16)

function mix(a: number, b: number, t: number): number {
  const r = Math.round(((a >> 16) & 255) * (1 - t) + ((b >> 16) & 255) * t)
  const g = Math.round(((a >> 8) & 255) * (1 - t) + ((b >> 8) & 255) * t)
  const bl = Math.round((a & 255) * (1 - t) + (b & 255) * t)
  return (r << 16) | (g << 8) | bl
}

function px(b: Buf, x: number, y: number, c: number) {
  if (x >= 0 && x < W && y >= 0 && y < H && c >= 0) b[y * W + x] = c
}

function rect(b: Buf, x: number, y: number, w: number, h: number, c: number) {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) px(b, i, j, c)
}

/** Mixes `c` over what is already there, opaque pixels only. */
function tint(b: Buf, x: number, y: number, w: number, h: number, c: number, a: number) {
  for (let j = y; j < y + h; j++) {
    for (let i = x; i < x + w; i++) {
      if (i < 0 || i >= W || j < 0 || j >= H) continue
      const k = j * W + i
      const v = b[k]!
      if (v >= 0 && v < SHADOW) b[k] = mix(v, c, a)
    }
  }
}

function sprite(b: Buf, rows: string[], pal: Record<string, number>, x: number, y: number, s = 1) {
  rows.forEach((row, j) => {
    for (let i = 0; i < row.length; i++) {
      const c = pal[row[i]!]
      if (c !== undefined) rect(b, x + i * s, y + j * s, s, s, c)
    }
  })
}

function disc(b: Buf, cx: number, cy: number, r: number, c: number) {
  for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r + r * 0.6) px(b, cx + x, cy + y, c)
}

function line(b: Buf, x0: number, y0: number, x1: number, y1: number, c: number) {
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1
  let err = dx + dy
  for (;;) {
    px(b, x0, y0, c)
    if (x0 === x1 && y0 === y1) break
    const e2 = 2 * err
    if (e2 >= dy) { err += dy; x0 += sx }
    if (e2 <= dx) { err += dx; y0 += sy }
  }
}

// a tiny deterministic noise, so the room looks the same on every frame
const noise = (x: number, y: number) => {
  let n = (x * 374761393 + y * 668265263) | 0
  n = (n ^ (n >>> 13)) * 1274126177
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296
}

// ---------- the room ----------

const C = {
  wallTop: hex('#1b2138'), wallBot: hex('#2c3656'), stripe: hex('#323d61'),
  molding: hex('#141829'), moldHi: hex('#3a4670'),
  wains: hex('#2f3a5c'), wainsHi: hex('#46557f'), wainsLo: hex('#222a45'),
  base: hex('#12162a'),
  floorA: hex('#8a6038'), floorB: hex('#7c5531'), floorHi: hex('#a07045'), seam: hex('#5a3c20'),
  frame: hex('#9b774f'), frameHi: hex('#c49a6c'), frameLo: hex('#6b4e30'),
  sun: hex('#ffe08a'), sunCore: hex('#fff6c8'), moon: hex('#f4f1c9'), star: hex('#ffffff'),
  cloud: hex('#f4f8ff'), cloudLo: hex('#d6e3f5'),
  wood: hex('#6a4428'), woodHi: hex('#8a5d38'), woodLo: hex('#4a2e19'), woodIn: hex('#33200f'),
  desk: hex('#9a6639'), deskHi: hex('#bb8250'), deskLo: hex('#6e4527'),
  mon: hex('#1a1d27'), monHi: hex('#3a3f52'), scr: hex('#0c2219'),
  rack: hex('#3b4252'), rackHi: hex('#56607a'), rackLo: hex('#262b37'), crt: hex('#041006'), green: hex('#5fd17a'),
  ocean: hex('#2f7fd1'), oceanHi: hex('#5aa6ef'), land: hex('#5fbf6a'), landLo: hex('#3f9a4c'), metal: hex('#5c667d'), metalHi: hex('#8a94ab'),
  rug: hex('#8c2f39'), rug2: hex('#b8434f'), rugGold: hex('#e0b25a'),
  panel: hex('#0d1122'), panelHi: hex('#4b5a8a'), ok: hex('#5fd17a'), mid: hex('#f2c14e'), hot: hex('#ef5b5b'),
  leaf: hex('#4f9e5a'), leafHi: hex('#7cc77f'), pot: hex('#b5653d'), potLo: hex('#8a4a2a'),
  clock: hex('#f1e7cf'), hand: hex('#1a1a1a'), gold: hex('#e0b25a'),
  city: hex('#3c4f72'), cityNight: hex('#121a30'), win: hex('#ffd76b'),
}

const BOOKS = ['#e06c75', '#61afef', '#e5c07b', '#98c379', '#c678dd', '#56b6c2', '#d19a66', '#f0f0e8'].map(hex)
const CODE = ['#61afef', '#c678dd', '#98c379', '#e5c07b', '#abb2bf', '#e06c75'].map(hex)

export type BgInput = { hour: number; minute: number; lights: boolean }

const SCR = { x: 51, y: 53, w: 18, h: 12 } // the desk monitor's screen
const CRT = { x: 125, y: 41, w: 22, h: 14 } // the terminal's screen

export function background({ hour, minute, lights }: BgInput): Buf {
  const b = blank()
  const isDay = hour >= 8 && hour < 19
  const isDusk = hour === 7 || hour === 19 || hour === 20

  // wall, a soft gradient with a striped wallpaper
  for (let y = 0; y < 66; y++) rect(b, 0, y, W, 1, mix(C.wallTop, C.wallBot, Math.floor(y / 11) / 5))
  for (let x = 3; x < W; x += 8) tint(b, x, 4, 1, 61, C.stripe, 0.45)
  for (let y = 10; y < 62; y += 10) for (let x = 7 + ((y / 10) % 2) * 4; x < W; x += 8) tint(b, x, y, 1, 1, C.moldHi, 0.35)
  rect(b, 0, 0, W, 3, C.molding)
  rect(b, 0, 3, W, 1, C.moldHi)

  // wainscot with panels, chair rail, baseboard
  rect(b, 0, 65, W, 1, C.wainsHi)
  rect(b, 0, 66, W, 11, C.wains)
  for (let x = 2; x < W; x += 24) {
    rect(b, x, 68, 20, 1, C.wainsLo)
    rect(b, x, 68, 1, 7, C.wainsLo)
    rect(b, x + 1, 74, 19, 1, C.wainsHi)
    rect(b, x + 20, 68, 1, 7, C.wainsHi)
  }
  rect(b, 0, 77, W, 2, C.base)

  // floor: planks, seams, light grain
  for (let y = 79; y < H; y++) {
    const row = Math.floor((y - 79) / 5)
    const c = row % 2 ? C.floorB : C.floorA
    rect(b, 0, y, W, 1, (y - 79) % 5 === 0 ? C.floorHi : c)
  }
  for (let row = 0; row < 6; row++) {
    const y = 79 + row * 5
    for (let x = (row * 37) % 29; x < W; x += 29) rect(b, x, y + 1, 1, 4, C.seam)
  }
  for (let y = 80; y < H; y++) for (let x = 0; x < W; x++) if (noise(x, y) < 0.025) tint(b, x, y, 1, 1, C.seam, 0.5)

  // daylight from the window, on the floor
  if (isDay || isDusk) {
    for (let y = 79; y < 100; y++) {
      const off = Math.round((y - 79) * 0.6)
      tint(b, 76 + off, y, 40, 1, isDay ? C.sun : C.pot, 0.13)
    }
  }

  // rug
  for (let y = -6; y <= 6; y++) {
    for (let x = -30; x <= 30; x++) {
      const d = (x * x) / 900 + (y * y) / 36
      if (d > 1) continue
      const c = d > 0.78 ? C.rug : d > 0.66 ? C.rugGold : (Math.abs(x) + Math.abs(y * 3)) % 8 === 0 ? C.rugGold : C.rug2
      px(b, 96 + x, 91 + y, c)
    }
  }

  // window, with the sky of the real hour
  rect(b, 78, 24, 36, 36, C.frame)
  rect(b, 78, 24, 36, 1, C.frameHi)
  rect(b, 78, 24, 1, 36, C.frameHi)
  rect(b, 113, 24, 1, 36, C.frameLo)
  const skyTop = isDay ? hex('#4aa8f5') : isDusk ? hex('#3a3f8f') : hex('#070b1f')
  const skyBot = isDay ? hex('#bfe6ff') : isDusk ? hex('#f39c6b') : hex('#1b2450')
  for (let y = 27; y < 57; y++) rect(b, 81, y, 30, 1, mix(skyTop, skyBot, (y - 27) / 30))
  const arc = Math.max(0, Math.min(1, ((hour + minute / 60) - (isDay ? 8 : 19)) / 11))
  const sx = 84 + Math.round(arc * 22)
  const sy = 32 + Math.round(Math.abs(arc - 0.5) * 12)
  if (isDay) {
    disc(b, sx, sy, 3, C.sun)
    disc(b, sx, sy, 1, C.sunCore)
    for (const [cx, cy] of [[88, 38], [101, 34]] as const) {
      rect(b, cx, cy, 8, 2, C.cloud)
      rect(b, cx + 2, cy - 1, 4, 1, C.cloud)
      rect(b, cx, cy + 2, 8, 1, C.cloudLo)
    }
  } else {
    disc(b, isDusk ? 104 : sx, isDusk ? 33 : sy, 2, C.moon)
    if (!isDusk) {
      for (let i = 0; i < 14; i++) {
        const x = 82 + Math.floor(noise(i, 3) * 28), y = 28 + Math.floor(noise(i, 7) * 16)
        px(b, x, y, i % 4 ? C.star : C.sun)
      }
    }
  }
  // skyline at the bottom of the glass
  for (let x = 81; x < 111;) {
    const w = 3 + Math.floor(noise(x, 1) * 4)
    const h = 4 + Math.floor(noise(x, 2) * 9)
    rect(b, x, 57 - h, w, h, isDay ? C.city : C.cityNight)
    if (!isDay) for (let j = 57 - h + 1; j < 56; j += 2) for (let i = x + 1; i < x + w - 1; i += 2) if (noise(i, j) < 0.45) px(b, i, j, C.win)
    x += w
  }
  rect(b, 95, 27, 2, 30, C.frame)
  rect(b, 81, 41, 30, 2, C.frame)
  rect(b, 76, 59, 40, 2, C.frameHi)
  rect(b, 76, 61, 40, 1, C.frameLo)
  // a little cactus on the sill
  rect(b, 106, 55, 4, 4, C.pot)
  rect(b, 107, 50, 2, 5, C.leaf)
  rect(b, 105, 52, 1, 2, C.leaf)
  rect(b, 110, 51, 1, 2, C.leafHi)

  // wall clock with the real time
  disc(b, 160, 33, 6, C.frameLo)
  disc(b, 160, 33, 5, C.clock)
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2
    px(b, 160 + Math.round(Math.sin(a) * 4), 33 - Math.round(Math.cos(a) * 4), C.frameLo)
  }
  const ha = (((hour % 12) + minute / 60) / 12) * Math.PI * 2
  const ma = (minute / 60) * Math.PI * 2
  line(b, 160, 33, 160 + Math.round(Math.sin(ha) * 2.5), 33 - Math.round(Math.cos(ha) * 2.5), C.hand)
  line(b, 160, 33, 160 + Math.round(Math.sin(ma) * 4), 33 - Math.round(Math.cos(ma) * 4), C.hot)

  // crypto chart on the wall
  rect(b, 44, 21, 30, 20, C.frameLo)
  rect(b, 45, 22, 28, 18, C.panel)
  for (let x = 47; x < 72; x += 6) rect(b, x, 23, 1, 16, hex('#18203a'))
  const pts = [36, 34, 35, 31, 32, 29, 30, 27, 28, 25]
  for (let i = 0; i < pts.length - 1; i++) line(b, 46 + i * 3, pts[i]!, 49 + i * 3, pts[i + 1]!, C.green)
  for (let i = 0; i < 5; i++) {
    const x = 48 + i * 5, top = 26 + ((i * 7) % 6)
    rect(b, x, top, 1, 8, i % 3 ? C.ok : C.hot)
    rect(b, x - 1, top + 2, 3, 4, i % 3 ? C.ok : C.hot)
  }

  // bookshelf
  tint(b, 4, 85, 46, 3, 0, 0.35)
  rect(b, 4, 22, 42, 63, C.wood)
  rect(b, 4, 22, 42, 2, C.woodHi)
  rect(b, 4, 22, 2, 63, C.woodHi)
  rect(b, 44, 22, 2, 63, C.woodLo)
  rect(b, 7, 25, 36, 57, C.woodIn)
  for (const sy of [25, 39, 53, 67]) {
    let x = 8
    let i = 0
    while (x < 42) {
      const w = 2 + Math.floor(noise(x, sy) * 3)
      const h = 8 + Math.floor(noise(sy, x) * 4)
      if (x + w > 42) break
      if (noise(x + 1, sy + 1) < 0.08) { x += w; continue } // a gap
      const c = BOOKS[(i * 3 + sy) % BOOKS.length]!
      rect(b, x, sy + 12 - h, w, h, c)
      rect(b, x, sy + 12 - h, 1, h, mix(c, 0xffffff, 0.3))
      rect(b, x, sy + 14 - h, w, 1, mix(c, 0, 0.35))
      x += w
      i++
    }
    rect(b, 7, sy + 12, 36, 2, C.wood)
    rect(b, 7, sy + 12, 36, 1, C.woodHi)
  }
  // on top of the shelf: a book stack and a trophy
  rect(b, 10, 19, 12, 3, BOOKS[1]!)
  rect(b, 11, 16, 10, 3, BOOKS[2]!)
  rect(b, 10, 19, 12, 1, mix(BOOKS[1]!, 0xffffff, 0.3))
  rect(b, 11, 16, 10, 1, mix(BOOKS[2]!, 0xffffff, 0.3))
  rect(b, 33, 20, 6, 2, C.woodLo)
  rect(b, 35, 17, 2, 3, C.gold)
  rect(b, 33, 13, 6, 4, C.gold)
  px(b, 33, 13, C.sunCore)
  px(b, 32, 14, C.gold)
  px(b, 39, 14, C.gold)

  // desk, monitor, keyboard, mug, lamp
  tint(b, 42, 87, 42, 2, 0, 0.35)
  rect(b, 42, 72, 40, 3, C.desk)
  rect(b, 42, 72, 40, 1, C.deskHi)
  rect(b, 42, 75, 40, 1, C.deskLo)
  rect(b, 44, 76, 3, 11, C.deskLo)
  rect(b, 66, 76, 15, 11, C.desk)
  rect(b, 66, 76, 15, 1, C.deskLo)
  rect(b, 67, 80, 13, 1, C.deskLo)
  rect(b, 72, 78, 3, 1, C.gold)
  rect(b, 72, 82, 3, 1, C.gold)
  rect(b, 48, 50, 24, 18, C.mon)
  rect(b, 48, 50, 24, 1, C.monHi)
  rect(b, SCR.x, SCR.y, SCR.w, SCR.h, C.scr)
  rect(b, 58, 68, 4, 3, C.mon)
  rect(b, 54, 70, 12, 2, C.monHi)
  codeLines(b, 0, false)
  rect(b, 75, 67, 4, 5, hex('#e8ecf5'))
  rect(b, 79, 68, 1, 2, hex('#e8ecf5'))
  rect(b, 75, 67, 4, 1, hex('#6b3a1e'))
  line(b, 44, 71, 47, 62, C.metal)
  rect(b, 45, 60, 5, 2, C.gold)
  tint(b, 43, 62, 9, 10, C.sun, 0.12)

  // terminal: a server rack with a CRT
  tint(b, 118, 88, 38, 2, 0, 0.35)
  rect(b, 120, 36, 32, 52, C.rack)
  rect(b, 120, 36, 32, 1, C.rackHi)
  rect(b, 120, 36, 1, 52, C.rackHi)
  rect(b, 151, 36, 1, 52, C.rackLo)
  rect(b, 123, 39, 26, 18, C.rackLo)
  rect(b, CRT.x, CRT.y, CRT.w, CRT.h, C.crt)
  rect(b, 126, 43, 4, 1, C.green)
  for (let y = 60; y < 84; y += 6) {
    rect(b, 123, y, 26, 4, C.rackLo)
    rect(b, 124, y + 1, 18, 1, hex('#1b1f29'))
    rect(b, 124, y + 3, 24, 1, C.rackHi)
  }

  // globe and antenna
  tint(b, 158, 89, 26, 2, 0, 0.35)
  rect(b, 160, 86, 20, 3, C.metal)
  rect(b, 160, 86, 20, 1, C.metalHi)
  rect(b, 169, 68, 2, 18, C.metal)
  for (let y = -8; y <= 8; y++) {
    for (let x = -8; x <= 8; x++) {
      if (x * x + y * y > 68) continue
      const n = noise(Math.floor((x + 20) / 2), Math.floor((y + 20) / 2))
      let c = n < 0.38 ? C.land : C.ocean
      if (x < -3 && y < -2) c = n < 0.38 ? C.leafHi : C.oceanHi
      else if (x > 4 && y > 2) c = n < 0.38 ? C.landLo : mix(C.ocean, 0, 0.25)
      px(b, 170 + x, 59 + y, c)
    }
  }
  for (let y = -9; y <= 9; y++) px(b, 170 + (Math.abs(y) < 8 ? 9 : 8), 59 + y, C.metalHi)
  rect(b, 169, 44, 2, 6, C.metal)
  px(b, 170, 43, C.hot)

  // corner plant
  rect(b, 181, 76, 9, 10, C.pot)
  rect(b, 181, 76, 9, 1, mix(C.pot, 0xffffff, 0.25))
  for (const [x, y, w, h] of [[178, 64, 3, 12], [183, 58, 3, 18], [187, 62, 3, 14], [180, 70, 9, 3], [176, 68, 3, 2], [189, 66, 3, 2]] as const) {
    rect(b, x, y, w, h, C.leaf)
    rect(b, x, y, 1, h, C.leafHi)
  }

  if (!lights) {
    tint(b, 0, 0, W, H, hex('#05060d'), isDay ? 0.45 : 0.72)
    rect(b, SCR.x, SCR.y, SCR.w, SCR.h, C.scr)
    codeLines(b, 0, false)
    rect(b, CRT.x, CRT.y, CRT.w, CRT.h, C.crt)
    tint(b, 40, 46, 40, 30, hex('#4aa8f5'), 0.08)
    tint(b, 118, 36, 34, 24, C.green, 0.06)
  }
  return b
}

function codeLines(b: Buf, t: number, isActive: boolean) {
  rect(b, SCR.x, SCR.y, SCR.w, SCR.h, C.scr)
  for (let j = 0; j < 6; j++) {
    const k = isActive ? j + t : j
    const indent = (k * 5) % 3 * 2
    const w = 4 + ((k * 7) % 10)
    rect(b, SCR.x + 1 + indent, SCR.y + 1 + j * 2, Math.min(w, SCR.w - 2 - indent), 1, CODE[k % CODE.length]!)
  }
  if (isActive && t % 2 === 0) rect(b, SCR.x + 1 + ((t * 3) % 12), SCR.y + 11, 2, 1, C.star)
}

// ---------- animated bits ----------

export function stationFx(b: Buf, st: Station | null, t: number, lights: boolean) {
  // always alive: the rack's LEDs and the antenna's tip
  for (let y = 60, i = 0; y < 84; y += 6, i++) {
    const on = (t + i * 3) % 5 !== 0
    px(b, 144, y + 1, on ? C.ok : C.rackLo)
    px(b, 146, y + 1, (t + i) % 3 === 0 ? C.mid : C.rackLo)
  }
  if (t % 8 < 4) px(b, 170, 43, lights ? C.hot : hex('#ff8080'))

  if (st === 'desk') codeLines(b, t, true)
  if (st === 'term') {
    rect(b, CRT.x, CRT.y, CRT.w, CRT.h, C.crt)
    for (let j = 0; j < 6; j++) {
      const k = j + t
      const w = k % 5 === 0 ? 2 : 3 + ((k * 7) % 15)
      rect(b, CRT.x + 1, CRT.y + 1 + j * 2, Math.min(w, CRT.w - 2), 1, j === 5 ? C.star : C.green)
    }
    if (t % 2 === 0) rect(b, CRT.x + 2 + ((t * 2) % 16), CRT.y + 11, 2, 1, C.star)
  }
  if (st === 'shelf') {
    const sy = [25, 39, 53, 67][(t >> 2) % 4]!
    const x = 9 + ((t * 5) % 30)
    tint(b, x, sy + 2, 3, 10, C.sun, 0.55)
    if (t % 2) px(b, x + 1, sy, C.star)
  }
  if (st === 'globe') {
    px(b, 170, 43, t % 2 ? C.ok : C.hot)
    const r = t % 4
    for (let k = 0; k <= r; k++) {
      px(b, 170 - 3 - k * 2, 40 - k * 2, C.cloudLo)
      px(b, 170 + 3 + k * 2, 40 - k * 2, C.cloudLo)
    }
  }
}

// ---------- Clawd, the Claude Code mascot ----------
// The CLI logo read quarter cell by quarter cell: 18 × 5 logical pixels, each
// twice as tall as wide (hence the doubled rows), drawn at 2 px per pixel.

const S = 2

const P = {
  b: hex('#d77757'), hi: hex('#ec9a7c'), lo: hex('#a85538'), e: hex('#141414'),
  w: hex('#e8ecf5'), y: hex('#ffd34e'), r: hex('#ff5a5a'), s: hex('#7cc4ff'), k: hex('#ff6f91'),
  ol: hex('#2a1610'), c: hex('#c8894a'), d: hex('#5a3a1a'), n: hex('#b48cff'),
}

const ROW = '...bbbbbbbbbbbb...'
const LEGS = { stand: '....b.b....b.b....', a: '...b.b.....b.b....', b: '.....b.b....b.b...' }

type Arms = 'down' | 'up' | 'wave' | 'left' | 'right' | 'dance'

function logical(b: Buf, x0: number, y0: number, lx: number, ly: number, c: number, w = 1, h = 1) {
  rect(b, x0 + lx * S, y0 + ly * S, w * S, h * S, c)
}

function body(b: Buf, x0: number, y0: number, arms: Arms, t: number, isSquish: boolean) {
  const n = isSquish ? 4 : 8
  for (let j = 0; j < n; j++) sprite(b, [ROW], { b: P.b }, x0, y0 + j * S, S)
  const armRow = isSquish ? 2 : 4
  const up = isSquish ? 0 : 1
  const left = arms === 'up' || arms === 'left' || (arms === 'wave' && t % 2 === 0) || (arms === 'dance' && (t >> 1) % 2 === 0)
  const right = arms === 'up' || arms === 'right' || (arms === 'wave' && t % 2 === 1) || (arms === 'dance' && (t >> 1) % 2 === 1)
  const h = isSquish ? 1 : 2
  logical(b, x0, y0, 1, left ? up : armRow, P.b, 2, h)
  logical(b, x0, y0, 15, right ? up : armRow, P.b, 2, h)
}

// eyes, in logical sprite coordinates (row 0 = top of the head)
function eyes(mood: Mood, t: number, look: number): Array<[number, number]> {
  const L = 5 + look, R = 12 + look
  const open: Array<[number, number]> = [[L, 2], [L, 3], [R, 2], [R, 3]]
  const shut: Array<[number, number]> = [[4, 3], [5, 3], [12, 3], [13, 3]]
  switch (mood) {
    case 'think': return [[6, 1], [6, 2], [13, 1], [13, 2]]
    case 'wait': return [[6, 3], [13, 3]]
    case 'sleep': return shut
    case 'done':
    case 'happy':
    case 'dance': return [[5, 2], [4, 3], [6, 3], [12, 2], [11, 3], [13, 3]]
    case 'eat': return t % 4 < 2 ? shut : [[5, 2], [4, 3], [6, 3], [12, 2], [11, 3], [13, 3]]
    case 'error': return [[4, 1], [5, 2], [4, 3], [13, 1], [12, 2], [13, 3]]
    case 'idle': return t === 11 || t === 12 ? shut : open
    default: return open
  }
}

const GLYPH: Record<string, string[]> = {
  q: ['yyy', '..y', '.yy', '...', '.y.'],
  bang: ['r', 'r', 'r', '.', 'r'],
  z: ['wwww', '..w.', '.w..', 'wwww'],
  heart: ['.k.k.', 'kkkkk', '.kkk.', '..k..'],
  spark: ['.y.', 'yyy', '.y.'],
  drop: ['.s', 'ss', 'ss'],
  cookie: ['.cc.', 'cdcc', 'ccdc', '.cc.'],
  note: ['.nn', '.n.', '.n.', 'nn.', 'nn.'],
}

const BOB: Partial<Record<Mood, number[]>> = {
  idle: [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1],
  walk: [0, -1],
  think: [0, -1, -1, 0],
  work: [0, -1],
  done: [0, -2, -4, -5, -4, -2, 0, 0],
  sleep: [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1],
  happy: [0, -1, -2, -1],
  dance: [0, -2, 0, -2, 0, -3, 0, -1],
  eat: [0, 0, 1, 0],
}

const ARMS: Partial<Record<Mood, Arms>> = {
  done: 'up', happy: 'wave', error: 'wave', work: 'wave', wait: 'right', think: 'left', dance: 'dance', eat: 'right',
}

/** Outlines every opaque pixel of a layer, sprite style. */
function outline(b: Buf, x0: number, y0: number, w: number, h: number, c: number) {
  const marks: number[] = []
  for (let y = Math.max(0, y0 - 1); y < Math.min(H, y0 + h + 1); y++) {
    for (let x = Math.max(0, x0 - 1); x < Math.min(W, x0 + w + 1); x++) {
      if (b[y * W + x]! !== -1) continue
      const near = (x > 0 && b[y * W + x - 1]! >= 0) || (x < W - 1 && b[y * W + x + 1]! >= 0) ||
        (y > 0 && b[(y - 1) * W + x]! >= 0) || (y < H - 1 && b[(y + 1) * W + x]! >= 0)
      if (near) marks.push(y * W + x)
    }
  }
  for (const k of marks) b[k] = c
}

/** Light from the top, shade at the bottom, on the body color only. */
function shade(b: Buf, x0: number, y0: number, w: number, h: number) {
  const marks: Array<[number, number]> = []
  for (let y = Math.max(0, y0); y < Math.min(H, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(W, x0 + w); x++) {
      if (b[y * W + x] !== P.b) continue
      const above = y > 0 ? b[(y - 1) * W + x]! : -1
      const below = y < H - 1 ? b[(y + 1) * W + x]! : -1
      if (above === -1) marks.push([y * W + x, P.hi])
      else if (below === -1 || below === P.ol) marks.push([y * W + x, P.lo])
    }
  }
  for (const [k, c] of marks) b[k] = c
}

/** Draws Clawd centered on cx, feet on FOOT, into an empty layer. */
/**
 * How strong a Clawd is: `stage` 0..7 from the tokens it has handled (-1 while
 * still an egg, `hatch` 0..1 its progress to hatching), `rank` 1..4 from its model.
 */
export type Power = { stage: number; rank: number; hatch?: number }

const EGG = { shell: hex('#f4ead2'), shellLo: hex('#d9c9a3'), spot: hex('#d77757'), crack: hex('#5a3a1a') }

/** The egg before the hatchling: it rocks (faster at work), cracks as it nears 10k tokens. */
function egg(b: Buf, cx: number, mood: Mood, t: number, hatch: number) {
  const rock = mood === 'sleep' ? 0 : mood === 'work' || mood === 'think' ? [0, 1, 0, -1][t % 4]! : t % 8 === 0 ? 1 : t % 8 === 4 ? -1 : 0
  const w = 14, h = 18, x0 = cx - w / 2 + rock, y0 = FOOT + 2 * S - h
  for (let y = 0; y < h; y++) {
    const fy = (y - h * 0.58) / (y < h * 0.58 ? h * 0.58 : h * 0.42)
    const half = Math.round((w / 2) * Math.sqrt(Math.max(0, 1 - fy * fy)))
    rect(b, x0 + w / 2 - half, y0 + y, half * 2, 1, y > h * 0.75 ? EGG.shellLo : EGG.shell)
  }
  for (const [sx, sy] of [[4, 6], [9, 9], [5, 12], [10, 4]] as const) rect(b, x0 + sx, y0 + sy, 2, 2, EGG.spot)
  if (hatch > 0.4) line(b, x0 + 3, y0 + 8, x0 + 6, y0 + 10, EGG.crack)
  if (hatch > 0.6) line(b, x0 + 6, y0 + 10, x0 + 9, y0 + 7, EGG.crack)
  if (hatch > 0.8) line(b, x0 + 9, y0 + 7, x0 + 11, y0 + 9, EGG.crack)
  outline(b, x0 - 1, y0 - 1, w + 2, h + 2, P.ol)
  if (mood === 'sleep') sprite(b, GLYPH.z!, P, x0 + w + 2, y0 - 4 - ((t % 8) >> 1), S)
  for (let x = -9; x <= 9; x++) {
    const k = (FOOT + 2 * S + 1) * W + cx + x
    if (cx + x >= 0 && cx + x < W && b[k] === -1) b[k] = SHADOW
  }
}

export function mascot(b: Buf, cx: number, mood: Mood, t: number, look: number, power?: Power) {
  if (power && power.stage < 0) return egg(b, cx, mood === 'walk' ? 'idle' : mood, t, power.hatch ?? 0)
  const bobs = BOB[mood] ?? [0]
  const dy = bobs[t % bobs.length]! * S
  const isSquish = mood === 'compact' && t % 4 < 2
  const shake = (mood === 'error' && t < 4 ? (t % 2 ? 1 : -1) : 0) + (mood === 'dance' ? ((t >> 1) % 2 ? 1 : -1) : 0)
  const x0 = cx - 9 * S + shake * S
  const height = (isSquish ? 4 : 8) * S
  const y0 = FOOT - height + dy

  body(b, x0, y0, ARMS[mood] ?? 'down', t, isSquish)
  const legs = mood === 'walk' || mood === 'dance' ? (t % 2 ? LEGS.a : LEGS.b) : LEGS.stand
  const legY = FOOT + Math.min(0, dy)
  sprite(b, [legs, legs], { b: P.b }, x0, legY, S)
  shade(b, x0, y0, 18 * S, height + 2 * S)

  if (!isSquish) for (const [x, y] of eyes(mood, t, look)) logical(b, x0, y0, x, y, P.e)
  else { logical(b, x0, y0, 5, 1, P.e); logical(b, x0, y0, 12, 1, P.e) }

  const head = y0
  const g = (name: string, x: number, y: number) => sprite(b, GLYPH[name]!, P, x, y, S)
  switch (mood) {
    case 'think': {
      const n = (t >> 1) % 4
      const dots: Array<[number, number, number]> = [[18, 0, 1], [19, -2, 1], [21, -4, 2]]
      dots.slice(0, n).forEach(([x, y, s]) => rect(b, x0 + x * S, head + y * S, s * S, s * S, P.w))
      break
    }
    case 'wait': g('q', x0 + 7 * S, head - 6 * S); break
    case 'error': if (t % 2 === 0) g('bang', x0 + 9 * S, head - 6 * S); break
    case 'sleep': {
      const k = t % 8
      g('z', x0 + (17 + (k >> 2)) * S, head - (2 + (k >> 1)) * S)
      break
    }
    case 'done':
      g('spark', x0 + (t % 4 < 2 ? -4 : 19) * S, head + ((t % 3) - 3) * S)
      g('spark', x0 + (t % 4 < 2 ? 19 : -4) * S, head + (3 - (t % 3)) * S)
      break
    case 'happy': g('heart', x0 + 7 * S, head - (5 + (t % 4)) * S); break
    case 'sad':
    case 'compact': g('drop', x0 + 17 * S, head + (1 + (t % 4)) * S); break
    case 'eat': {
      if (t < 12) g('cookie', x0 + 13 * S - (t >> 2) * S, head + 4 * S)
      for (let i = 0; i < 3; i++) px(b, x0 + 14 * S + i * 3, head + 9 * S + ((t + i * 3) % 6), P.c)
      break
    }
    case 'dance': {
      const k = t % 8
      sprite(b, GLYPH.note!, { n: t % 4 < 2 ? P.n : P.k }, x0 - 4 * S, head - k, S)
      sprite(b, GLYPH.note!, { n: t % 4 < 2 ? P.s : P.y }, x0 + 19 * S, head - ((k + 4) % 8), S)
      break
    }
  }
  if (power) gear(b, x0, y0, height, t, power)
  outline(b, x0 - 10, y0 - 16, 18 * S + 20, height + 2 * S + 18, P.ol)
  // a soft shadow on the floor
  for (let x = -14; x <= 14; x++) {
    const k = (FOOT + 2 * S + 1) * W + cx + x
    if (cx + x >= 0 && cx + x < W && b[k] === -1) b[k] = SHADOW
  }
}

// ---------- evolution: what tokens and the model put on Clawd ----------

const G = {
  leaf: hex('#6fcf5b'), stem: hex('#3f8f3a'), band: hex('#e5484d'), cape: hex('#8e1f3a'), capeHi: hex('#b8324f'),
  steel: hex('#9aa6c0'), steelHi: hex('#d9e0ef'), gold: hex('#ffd34e'), goldLo: hex('#c9962b'), gem: hex('#ff5a7a'),
  sonnet: hex('#7cc4ff'), opus: hex('#ffd34e'), fable: hex('#c58cff'), halo: hex('#fff3b0'),
}

/** Only where nothing is drawn yet: behind the body. */
function behind(b: Buf, x: number, y: number, w: number, h: number, c: number) {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) {
    if (i >= 0 && i < W && j >= 0 && j < H && b[j * W + i] === -1) b[j * W + i] = c
  }
}

/**
 * Each stage adds a piece, the ones before kept: 1 a sprout, 2 a headband,
 * 3 a cape, 4 a chest plate, 5 orbiting sparks, 6 a crown (the sprout goes),
 * 7 a golden glow. The model shows on the chest: Sonnet a blue gem, Opus a
 * gold one, Fable a violet one and a halo.
 */
function gear(b: Buf, x0: number, y0: number, height: number, t: number, { stage, rank }: Power) {
  const L = x0 + 6, R = x0 + 29 // the body's columns
  if (stage >= 3) {
    const flap = (t >> 1) % 2
    behind(b, L - 3, y0 + 3, R - L + 7, height + 2 - flap, G.cape)
    behind(b, L - 4 - flap, y0 + height - 2, 3, 4, G.capeHi)
    behind(b, R + 2 + flap, y0 + height - 2, 3, 4, G.capeHi)
  }
  if (stage >= 1 && stage < 6) {
    rect(b, x0 + 17, y0 - 4, 2, 4, G.stem)
    rect(b, x0 + 19, y0 - 6, 4, 2, G.leaf)
    rect(b, x0 + 13, y0 - 5, 4, 2, G.leaf)
  }
  if (stage >= 2) {
    rect(b, L, y0 + 1, R - L + 1, 2, G.band)
    const tail = (t >> 1) % 2
    rect(b, R + 1, y0 + 1 + tail, 4, 2, G.band)
    rect(b, R + 4, y0 + 2 - tail, 3, 2, G.band)
  }
  if (stage >= 4 && height > 8) {
    rect(b, x0 + 11, y0 + 10, 14, 5, G.steel)
    rect(b, x0 + 11, y0 + 10, 14, 1, G.steelHi)
    px(b, x0 + 12, y0 + 12, G.steelHi); px(b, x0 + 23, y0 + 12, G.steelHi)
  }
  if (rank >= 2 && height > 8) {
    const c = rank === 2 ? G.sonnet : rank === 3 ? G.opus : G.fable
    rect(b, x0 + 17, y0 + 11, 2, 3, c)
    rect(b, x0 + 16, y0 + 12, 4, 1, c)
    if (rank >= 3) px(b, x0 + 17, y0 + 11, G.halo)
  }
  if (stage >= 6) {
    rect(b, x0 + 11, y0 - 3, 14, 3, G.gold)
    rect(b, x0 + 11, y0 - 1, 14, 1, G.goldLo)
    for (const dx of [11, 17, 23]) rect(b, x0 + dx, y0 - 6, 2, 3, G.gold)
    px(b, x0 + 18, y0 - 2, G.gem)
  }
  if (rank >= 4) {
    const hy = y0 - (stage >= 6 ? 10 : 9) + ((t >> 2) % 2)
    rect(b, x0 + 12, hy, 12, 1, G.halo)
    px(b, x0 + 11, hy + 1, G.halo); px(b, x0 + 24, hy + 1, G.halo)
    rect(b, x0 + 12, hy + 2, 12, 1, G.halo)
  }
  if (stage >= 5) {
    const n = stage >= 7 ? 6 : 3
    for (let i = 0; i < n; i++) {
      const a = ((t / FRAMES) + i / n) * Math.PI * 2
      const sx = Math.round(x0 + 18 + Math.cos(a) * 17), sy = Math.round(y0 + height / 2 + Math.sin(a) * 9)
      behind(b, sx, sy, 1, 1, G.gold)
      if ((t + i) % 4 === 0) { behind(b, sx - 1, sy, 3, 1, G.halo); behind(b, sx, sy - 1, 1, 3, G.halo) }
    }
  }
  if (stage >= 7 && t % 2 === 0) {
    // a glow traced around everything drawn so far
    const marks: number[] = []
    for (let y = Math.max(1, y0 - 12); y < Math.min(H - 1, FOOT + 6); y++) {
      for (let x = Math.max(1, x0 - 6); x < Math.min(W - 1, x0 + 42); x++) {
        if (b[y * W + x] !== -1) continue
        if (b[y * W + x - 1]! >= 0 || b[y * W + x + 1]! >= 0 || b[(y - 1) * W + x]! >= 0 || b[(y + 1) * W + x]! >= 0) marks.push(y * W + x)
      }
    }
    for (const k of marks) b[k] = G.goldLo
  }
}

/** Clawd in another session's color: the body orange swapped for `tint`. */
export function mascotTinted(b: Buf, cx: number, mood: Mood, t: number, look: number, tint: number, power?: Power) {
  const m = blank()
  mascot(m, cx, mood, t, look, power)
  for (let i = 0; i < m.length; i++) {
    const v = m[i]!
    if (v === -1) continue
    if (v === SHADOW) { if (b[i] === -1) b[i] = SHADOW; continue }
    b[i] = v === P.b ? tint : v
  }
}

/** A name tag over a Clawd's head; `isMe` adds the ▼ that says "that one is you". */
export function tag(b: Buf, cx: number, label: string, c: number, isMe: boolean, t: number) {
  const y = FOOT - 44
  text(b, label, cx - Math.floor(textWidth(label) / 2), y, c)
  if (isMe) text(b, '▼', cx - 1, y - 7 + ((t >> 2) % 2), hex('#ffd34e'))
}

/** A letter on its way from one Clawd to another. */
export function envelope(b: Buf, x: number, y: number) {
  sprite(b, ['dwwwwwd', 'wdwwwdw', 'wwdwdww', 'wwwdwww', 'wwwwwww'], { w: P.w, d: P.lo }, Math.round(x) - 7, Math.round(y), 2)
  outline(b, Math.round(x) - 7, Math.round(y), 14, 10, P.ol)
}

const MINI_COLORS = ['#7aa2f7', '#9ece6a', '#bb9af7', '#e0af68', '#73daca'].map(hex)

/** Subagents: colored mini Clawds hopping at the front. */
export function minis(b: Buf, n: number, t: number) {
  for (let i = 0; i < Math.min(n, 5); i++) {
    const x = 4 + i * 20
    const dy = (t + i) % 2 ? -2 : 0
    const c = MINI_COLORS[i]!
    sprite(b, ['.bbbbbb.', '.bebbeb.', 'bbbbbbbb', '.bbbbbb.', '..b..b..'], { b: c, e: P.e }, x, 87 + dy, 2)
    outline(b, x, 87 + dy, 16, 10, P.ol)
  }
}

// ---------- the HUD: a 3×5 pixel font and game panels ----------

const FONT_SRC: Record<string, string> = {
  A: '.#. #.# ### #.# #.#', B: '##. #.# ##. #.# ##.', C: '.## #.. #.. #.. .##', D: '##. #.# #.# #.# ##.',
  E: '### #.. ##. #.. ###', F: '### #.. ##. #.. #..', G: '.## #.. #.# #.# .##', H: '#.# #.# ### #.# #.#',
  I: '### .#. .#. .#. ###', J: '..# ..# ..# #.# .#.', K: '#.# #.# ##. #.# #.#', L: '#.. #.. #.. #.. ###',
  M: '#.# ### ### #.# #.#', N: '##. #.# #.# #.# #.#', O: '.#. #.# #.# #.# .#.', P: '##. #.# ##. #.. #..',
  Q: '.#. #.# #.# ##. .##', R: '##. #.# ##. #.# #.#', S: '.## #.. .#. ..# ##.', T: '### .#. .#. .#. .#.',
  U: '#.# #.# #.# #.# ###', V: '#.# #.# #.# #.# .#.', W: '#.# #.# ### ### #.#', X: '#.# #.# .#. #.# #.#',
  Y: '#.# #.# .#. .#. .#.', Z: '### ..# .#. #.. ###',
  0: '### #.# #.# #.# ###', 1: '.#. ##. .#. .#. ###', 2: '##. ..# .#. #.. ###', 3: '##. ..# .#. ..# ##.',
  4: '#.# #.# ### ..# ..#', 5: '### #.. ##. ..# ##.', 6: '.## #.. ### #.# ###', 7: '### ..# .#. .#. .#.',
  8: '### #.# ### #.# ###', 9: '### #.# ### ..# ##.',
  '.': '... ... ... ... .#.', ',': '... ... ... .#. #..', ':': '... .#. ... .#. ...', '%': '#.# ..# .#. #.. #.#',
  '/': '..# ..# .#. #.. #..', '-': '... ... ### ... ...', '+': '... .#. ### .#. ...', '(': '.#. #.. #.. #.. .#.',
  ')': '.#. ..# ..# ..# .#.', '!': '.#. .#. .#. ... .#.', '?': '##. ..# .#. ... .#.', '$': '.## ##. .#. .## ##.',
  "'": '.#. .#. ... ... ...', '#': '#.# ### #.# ### #.#', '<': '..# .#. #.. .#. ..#', '>': '#.. .#. ..# .#. #..',
  '=': '... ### ... ### ...', '_': '... ... ... ... ###', '*': '... #.# .#. #.# ...', '·': '... ... .#. ... ...',
  '♥': '#.# ### ### .#. ...', '▼': '... ### ### .#. ...', '◆': '.#. ### ### .#. ...', '▶': '#.. ##. ### ##. #..', '↻': '### #.# #.. #.# ###',
}

const FONT: Record<string, boolean[]> = Object.fromEntries(
  Object.entries(FONT_SRC).map(([k, v]) => [k, v.replace(/ /g, '').split('').map(ch => ch === '#')]),
)

export function textWidth(s: string) {
  return s.length * 4 - 1
}

export function text(b: Buf, s: string, x: number, y: number, c: number, shadow = true) {
  const up = s.toUpperCase()
  for (let i = 0; i < up.length; i++) {
    const g = FONT[up[i]!]
    if (!g) continue
    for (let j = 0; j < 15; j++) {
      if (!g[j]) continue
      const gx = x + i * 4 + (j % 3), gy = y + Math.floor(j / 3)
      if (shadow) px(b, gx + 1, gy + 1, hex('#05060d'))
      px(b, gx, gy, c)
    }
  }
}

export const HUD_C = {
  text: hex('#e8ecf5'), dim: hex('#8b95b5'), gold: hex('#ffd34e'), accent: hex('#d77757'),
  ok: C.ok, mid: C.mid, hot: C.hot, cyan: hex('#7cc4ff'), pink: hex('#ff6f91'), violet: hex('#b48cff'),
  panel: C.panel, edge: C.panelHi,
}

export function panel(b: Buf, x: number, y: number, w: number, h: number) {
  rect(b, x + 1, y, w - 2, h, C.panel)
  rect(b, x, y + 1, w, h - 2, C.panel)
  rect(b, x + 1, y, w - 2, 1, C.panelHi)
  rect(b, x + 1, y + h - 1, w - 2, 1, hex('#2a3352'))
  rect(b, x, y + 1, 1, h - 2, C.panelHi)
  rect(b, x + w - 1, y + 1, 1, h - 2, hex('#2a3352'))
}

export function levelColor(pct: number) {
  return pct < 50 ? C.ok : pct < 80 ? C.mid : C.hot
}

/** A segmented game gauge. `pct` null draws an empty, unknown gauge. */
export function bar(b: Buf, x: number, y: number, w: number, pct: number | null, c?: number) {
  rect(b, x, y, w, 3, hex('#05060d'))
  rect(b, x, y, w, 1, hex('#1b2138'))
  if (pct === null) {
    for (let i = x + 1; i < x + w - 1; i += 3) px(b, i, y + 1, hex('#2a3352'))
    return
  }
  const fill = Math.round(Math.max(0, Math.min(1, pct / 100)) * (w - 2))
  const col = c ?? levelColor(pct)
  rect(b, x + 1, y + 1, fill, 1, col)
  rect(b, x + 1, y + 2, fill, 1, mix(col, 0, 0.3))
  for (let i = x + 4; i < x + 1 + fill; i += 4) rect(b, i, y + 1, 1, 2, mix(col, 0, 0.45))
}

/** Darkens a region, behind a menu. */
export function dim(b: Buf, x: number, y: number, w: number, h: number) {
  rect(b, x, y, w, h, SHADOW)
}

// ---------- outputs ----------

export function compose(...layers: Buf[]): Buf {
  const out = layers[0]!.slice()
  for (const over of layers.slice(1)) {
    for (let i = 0; i < out.length; i++) {
      const v = over[i]!
      if (v === SHADOW) out[i] = out[i]! >= 0 ? mix(out[i]!, 0, 0.35) : out[i]!
      else if (v >= 0) out[i] = v
    }
  }
  return out
}

export type View = { x: number; y: number; w: number; h: number }

/** Fits a view of the scene (all of it by default) into cols × rows half-block cells. */
export function toCells(b: Buf, cols: number, rows: number, view: View = { x: 0, y: 0, w: W, h: H }): string {
  return cellsOf(b, W, H, cols, rows, view)
}

/** The same for any buffer `bw` × `bh` pixels wide, such as the low resolution room. */
export function cellsOf(b: Buf, bw: number, bh: number, cols: number, rows: number, view: View = { x: 0, y: 0, w: bw, h: bh }): string {
  const words = new Uint32Array(cols * rows * 3)
  const sx = view.w / cols, sy = view.h / (rows * 2)
  // each cell takes the color that covers most of its block, never a blend:
  // averaging smears outlines and small sprites into mud. The block's edges are
  // fractional for any factor: a pixel counts for the share of it inside, so
  // the cells stay even instead of alternating 1 and 2 pixel wide boxes
  const sample = (fx: number, fy: number) => {
    const ax = view.x + fx * sx, bx = Math.min(bw, ax + Math.max(1, sx))
    const ay = view.y + fy * sy, by = Math.min(bh, ay + Math.max(1, sy))
    const count = new Map<number, number>()
    let best = 0, top = 0
    for (let y = Math.floor(ay); y < by; y++) {
      const wy = Math.min(by, y + 1) - Math.max(ay, y)
      for (let x = Math.floor(ax); x < bx; x++) {
        const v = b[y * bw + x]!
        if (v < 0 || v >= SHADOW) continue
        const n = (count.get(v) ?? 0) + wy * (Math.min(bx, x + 1) - Math.max(ax, x))
        count.set(v, n)
        if (n > top) { top = n; best = v }
      }
    }
    return best
  }
  let k = 0
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // a cell of one color is a space on that background: Terminal.app draws ▀
      // a hair short of half the cell, and the seam shows on flat areas
      const top = sample(c, 2 * r), bottom = sample(c, 2 * r + 1)
      words[k++] = top === bottom ? 0x20 : 0x2580
      words[k++] = top
      words[k++] = bottom
    }
  }
  const bytes = new Uint8Array(words.buffer)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** One SVG path per color; horizontal runs, merged down when they repeat. */
export function toPaths(b: Buf): string {
  type Run = { x: number; w: number; y: number; h: number; c: number }
  const open = new Map<string, Run>()
  const done: Run[] = []
  for (let y = 0; y < H; y++) {
    const seen = new Set<string>()
    let x = 0
    while (x < W) {
      const c = b[y * W + x]!
      let e = x + 1
      while (e < W && b[y * W + e] === c) e++
      if (c >= 0) {
        const key = `${x},${e - x},${c}`
        const run = open.get(key)
        if (run && run.y + run.h === y) run.h++
        else {
          if (run) done.push(run)
          open.set(key, { x, w: e - x, y, h: 1, c })
        }
        seen.add(key)
      }
      x = e
    }
    for (const [key, run] of open) if (!seen.has(key)) { done.push(run); open.delete(key) }
  }
  done.push(...open.values())
  const byColor = new Map<number, string[]>()
  for (const r of done) {
    const list = byColor.get(r.c) ?? []
    list.push(`M${r.x} ${r.y}h${r.w}v${r.h}h-${r.w}z`)
    byColor.set(r.c, list)
  }
  let out = ''
  for (const [c, d] of byColor) {
    out += c === SHADOW
      ? `<path fill="#000" fill-opacity=".35" d="${d.join('')}"/>`
      : `<path fill="#${c.toString(16).padStart(6, '0')}" d="${d.join('')}"/>`
  }
  return out
}

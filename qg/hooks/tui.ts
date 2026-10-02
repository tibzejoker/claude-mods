// The terminal HQ, drawn in characters rather than pixels: flat cells colored
// by their background, a few glyphs (frames, lines, the time as text), and
// Clawd as the CLI logo draws him, ▐▛███▜▌ over ▝▜█████▛▘. Nothing is
// rasterized, so the terminal never shows seams between half blocks.
// Positions come in the full room's coordinates (0..192) and map to columns.

import type { Mood, Station } from '../types'
import { FRAMES, W as FULL_W, hex } from './scene'
import type { Power } from './scene'

export const TW = 64
export const TH = 12
const DEFAULT = 0x01000000

/** A grid of cells: a code point, a foreground and a background each. */
export type Grid = { ch: Uint32Array; fg: Uint32Array; bg: Uint32Array }

export const grid = (): Grid => ({
  ch: new Uint32Array(TW * TH).fill(0x20),
  fg: new Uint32Array(TW * TH).fill(DEFAULT),
  bg: new Uint32Array(TW * TH).fill(DEFAULT),
})

export const copy = (g: Grid): Grid => ({ ch: g.ch.slice(), fg: g.fg.slice(), bg: g.bg.slice() })

/** A full room x (0..192) as a column. */
export const col = (x: number) => Math.round((x * TW) / FULL_W)

function put(g: Grid, x: number, y: number, ch: string, fg: number, bg?: number) {
  if (x < 0 || x >= TW || y < 0 || y >= TH) return
  const k = y * TW + x
  g.ch[k] = ch.codePointAt(0)!
  g.fg[k] = fg
  if (bg !== undefined) g.bg[k] = bg
}

function text(g: Grid, x: number, y: number, s: string, fg: number, bg?: number) {
  ;[...s].forEach((ch, i) => put(g, x + i, y, ch, fg, bg))
}

function fill(g: Grid, x: number, y: number, w: number, h: number, bg: number) {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) put(g, i, j, ' ', DEFAULT, bg)
}

function bgAt(g: Grid, x: number, y: number) {
  return x >= 0 && x < TW && y >= 0 && y < TH ? g.bg[y * TW + x]! : DEFAULT
}

function mix(a: number, b: number, t: number): number {
  const r = Math.round(((a >> 16) & 255) * (1 - t) + ((b >> 16) & 255) * t)
  const gg = Math.round(((a >> 8) & 255) * (1 - t) + ((b >> 8) & 255) * t)
  const bl = Math.round((a & 255) * (1 - t) + (b & 255) * t)
  return (r << 16) | (gg << 8) | bl
}

const noise = (x: number, y: number) => {
  let n = (x * 374761393 + y * 668265263) | 0
  n = (n ^ (n >>> 13)) * 1274126177
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296
}

// ---------- the room ----------

const C = {
  molding: hex('#141829'), wall: hex('#2c3656'), stripe: hex('#34406a'), wains: hex('#2f3a5c'), wainsHi: hex('#46557f'),
  floorA: hex('#8a6038'), floorB: hex('#7d5632'), seam: hex('#5a3c20'),
  frame: hex('#9b774f'), frameHi: hex('#c49a6c'),
  sun: hex('#ffe08a'), moon: hex('#f4f1c9'), star: hex('#ffffff'), cloud: hex('#f4f8ff'),
  wood: hex('#6a4428'), woodHi: hex('#8a5d38'), woodIn: hex('#2a190b'),
  desk: hex('#9a6639'), deskLo: hex('#6e4527'),
  mon: hex('#1a1d27'), monHi: hex('#3a3f52'), scr: hex('#0c2219'),
  rack: hex('#3b4252'), rackLo: hex('#262b37'), crt: hex('#041006'), green: hex('#5fd17a'),
  ocean: hex('#2f7fd1'), land: hex('#5fbf6a'), metal: hex('#8a94ab'),
  rug: hex('#8c2f39'), gold: hex('#e0b25a'),
  leaf: hex('#4f9e5a'), leafHi: hex('#7cc77f'), pot: hex('#b5653d'),
  clock: hex('#f1e7cf'), panel: hex('#0d1122'), hot: hex('#ef5b5b'), mid: hex('#f2c14e'),
  city: hex('#3c4f72'), cityNight: hex('#121a30'), win: hex('#ffd76b'), mug: hex('#e8ecf5'),
}

const BOOKS = ['#e06c75', '#61afef', '#e5c07b', '#98c379', '#c678dd', '#56b6c2', '#d19a66', '#f0f0e8'].map(hex)
const CODE = ['#61afef', '#c678dd', '#98c379', '#e5c07b', '#abb2bf', '#e06c75'].map(hex)

const SCREEN = { x: 15, y: 3, w: 8, h: 3 } // the monitor
const CRT = { x: 42, y: 3, w: 6, h: 2 } // the rack's screen

export function tuiRoom({ hour, minute, lights }: { hour: number; minute: number; lights: boolean }): Grid {
  const g = grid()
  const isDay = hour >= 8 && hour < 19
  const isDusk = hour === 7 || hour === 19 || hour === 20

  // wall with faint stripes, the rail, the floor
  fill(g, 0, 0, TW, 1, C.molding)
  fill(g, 0, 1, TW, 7, C.wall)
  for (let x = 2; x < TW; x += 4) for (let y = 1; y < 8; y++) put(g, x, y, '│', C.stripe)
  for (let x = 0; x < TW; x++) put(g, x, 8, '▀', C.wainsHi, C.wains)
  for (let y = 9; y < TH; y++) {
    fill(g, 0, y, TW, 1, y % 2 ? C.floorA : C.floorB)
    for (let x = (y * 7) % 9; x < TW; x += 9 + (y % 3)) put(g, x, y, '▏', C.seam)
  }
  // the rug, under the middle of the room
  for (let x = 20; x < 44; x++) put(g, x, 11, (x % 3) ? ' ' : '·', C.gold, C.rug)

  // bookshelf
  fill(g, 1, 1, 10, 8, C.wood)
  fill(g, 2, 2, 8, 6, C.woodIn)
  for (const [top, base] of [[2, 3], [5, 6]] as const) {
    for (let x = 2; x < 10; x++) {
      const c = BOOKS[(x * 3 + top) % BOOKS.length]!
      const n = noise(x, top)
      if (n < 0.1) continue // a gap
      put(g, x, base, '█', c)
      put(g, x, top, n < 0.45 ? '▄' : n < 0.85 ? '█' : '▗', c)
    }
  }
  fill(g, 2, 4, 8, 1, C.woodHi)
  fill(g, 2, 7, 8, 1, C.woodHi)

  // desk and monitor
  fill(g, 14, 2, 10, 5, C.mon)
  text(g, 14, 2, '▄▄▄▄▄▄▄▄▄▄', C.monHi, C.wall)
  code(g, 0, false)
  for (let x = 13; x < 26; x++) put(g, x, 7, '▄', C.desk)
  text(g, 18, 7, '▀▀', C.monHi, C.desk)
  put(g, 24, 7, '▀', C.mug, C.desk)
  put(g, 14, 8, '▌', C.deskLo)
  fill(g, 21, 8, 4, 1, C.desk)
  put(g, 22, 8, '▬', C.gold, C.desk)

  // window and the hour's sky
  fill(g, 26, 1, 12, 6, C.frame)
  const skyTop = isDay ? hex('#4aa8f5') : isDusk ? hex('#3a3f8f') : hex('#070b1f')
  const skyBot = isDay ? hex('#bfe6ff') : isDusk ? hex('#f39c6b') : hex('#1b2450')
  for (let y = 2; y < 6; y++) fill(g, 27, y, 10, 1, mix(skyTop, skyBot, (y - 2) / 3))
  const arc = Math.max(0, Math.min(1, ((hour + minute / 60) - (isDay ? 8 : 19)) / 11))
  const sx = 27 + Math.round(arc * 9)
  if (isDay) {
    put(g, sx, 2, '●', C.sun)
    text(g, sx > 31 ? 28 : 33, 3, '▂▄▂', C.cloud)
  } else {
    put(g, isDusk ? 34 : sx, 2, '●', C.moon)
    if (!isDusk) for (let i = 0; i < 5; i++) put(g, 27 + Math.floor(noise(i, 3) * 10), 2 + (i % 2), '·', C.star)
  }
  for (let x = 27; x < 37; x++) {
    const h = '▂▄▃▆▅▃▇▄▂▅'[x - 27]!
    put(g, x, 5, h, isDay ? C.city : C.cityNight)
  }
  if (!isDay) for (let x = 28; x < 37; x += 3) put(g, x, 5, '·', C.win, C.cityNight)
  for (let y = 2; y < 6; y++) put(g, 31, y, '┃', C.frame)
  for (let x = 25; x < 39; x++) put(g, x, 6, '▀', C.frameHi, C.wall)

  // the clock tells the real time
  text(g, 50, 2, ` ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} `, C.clock, C.panel)

  // server rack
  fill(g, 41, 2, 8, 7, C.rack)
  fill(g, CRT.x, CRT.y, CRT.w, CRT.h, C.crt)
  text(g, CRT.x, CRT.y, '>_', C.green, C.crt)
  for (const y of [6, 7]) text(g, 42, y, '════', C.rackLo, C.rack)

  // globe and its antenna
  put(g, 58, 2, '│', C.metal)
  text(g, 56, 3, ' ▄▄▄ ', C.ocean)
  put(g, 56, 4, '▐', C.ocean)
  fill(g, 57, 4, 3, 1, C.ocean)
  put(g, 57, 4, '▙', C.land, C.ocean)
  put(g, 59, 4, '▜', C.land, C.ocean)
  put(g, 60, 4, '▌', C.ocean)
  text(g, 56, 5, ' ▀▀▀ ', C.ocean)
  put(g, 58, 6, '│', C.metal)
  put(g, 58, 7, '│', C.metal)
  text(g, 56, 8, '▀▀▀▀▀', C.metal, C.wains)

  // corner plant
  text(g, 61, 5, '▗▟▖', C.leafHi)
  text(g, 61, 6, '▜█▛', C.leaf)
  fill(g, 61, 7, 3, 2, C.pot)

  if (!lights) {
    for (let i = 0; i < g.bg.length; i++) {
      if (g.bg[i] !== DEFAULT) g.bg[i] = mix(g.bg[i]!, 0x05060d, isDay ? 0.45 : 0.7)
      if (g.fg[i] !== DEFAULT) g.fg[i] = mix(g.fg[i]!, 0x05060d, isDay ? 0.45 : 0.7)
    }
    code(g, 0, false)
    fill(g, CRT.x, CRT.y, CRT.w, CRT.h, C.crt)
    text(g, CRT.x, CRT.y, '>_', C.green, C.crt)
  }
  return g
}

function code(g: Grid, t: number, isActive: boolean) {
  fill(g, SCREEN.x, SCREEN.y, SCREEN.w, SCREEN.h, C.scr)
  for (let j = 0; j < SCREEN.h; j++) {
    const k = isActive ? j + t : j
    const indent = (k * 5) % 3
    const w = 2 + ((k * 7) % 5)
    for (let i = 0; i < Math.min(w, SCREEN.w - indent); i++) put(g, SCREEN.x + indent + i, SCREEN.y + j, '━', CODE[(k + i) % CODE.length]!)
  }
  if (isActive && t % 2 === 0) put(g, SCREEN.x + ((t * 3) % SCREEN.w), SCREEN.y + SCREEN.h - 1, '█', C.star)
}

const CMDS = ['ls', 'git st', 'npm t', 'make', 'grep', 'cat']

export function tuiFx(g: Grid, st: Station | null, t: number, lights: boolean) {
  ;[6, 7].forEach((y, i) => {
    put(g, 46, y, '•', (t + i * 3) % 5 ? C.green : C.rackLo, C.rack)
    put(g, 47, y, '•', (t + i) % 3 === 0 ? C.mid : C.rackLo, C.rack)
  })
  put(g, 58, 1, '•', t % 8 < 4 ? (lights ? C.hot : hex('#ff8080')) : C.wall)
  if (st === 'desk') code(g, t, true)
  if (st === 'term') {
    fill(g, CRT.x, CRT.y, CRT.w, CRT.h, C.crt)
    text(g, CRT.x, CRT.y, `>${CMDS[(t >> 2) % CMDS.length]!}`.slice(0, CRT.w), C.green, C.crt)
    text(g, CRT.x, CRT.y + 1, t % 2 ? '>█' : '>', C.green, C.crt)
  }
  if (st === 'shelf') {
    const [y, x] = [[3, 6, 3, 6][(t >> 2) % 4]!, 2 + ((t * 5) % 8)]
    put(g, x, y, '█', C.sun)
  }
  if (st === 'globe') {
    const r = t % 3
    put(g, 57 - r, 1, '(', C.cloud)
    put(g, 59 + r, 1, ')', C.cloud)
  }
}

// ---------- Clawd, as the CLI draws him ----------

const P = {
  b: hex('#d77757'), lo: hex('#a85538'), e: hex('#141414'), w: hex('#e8ecf5'), y: hex('#ffd34e'),
  r: hex('#ff5a5a'), s: hex('#7cc4ff'), k: hex('#ff6f91'), c: hex('#c8894a'), n: hex('#b48cff'),
}

const G = {
  leaf: hex('#6fcf5b'), band: hex('#e5484d'), cape: hex('#8e1f3a'), steel: hex('#9aa6c0'),
  gold: hex('#ffd34e'), goldLo: hex('#6b5320'), sonnet: hex('#7cc4ff'), opus: hex('#ffd34e'), fable: hex('#c58cff'), halo: hex('#fff3b0'),
}

const HOP: Partial<Record<Mood, number[]>> = {
  done: [0, -1, -1, 0], happy: [0, 0, -1, 0], dance: [0, -1, 0, 0],
}

type Arms = 'down' | 'up' | 'left' | 'right' | 'wave' | 'dance'
const ARMS: Partial<Record<Mood, Arms>> = {
  done: 'up', happy: 'wave', error: 'wave', work: 'wave', wait: 'right', think: 'left', dance: 'dance', eat: 'right',
}

const BASE = 8 // the row of Clawd's head; his legs are on BASE + 2

const EGG = { shell: hex('#f4ead2'), spot: hex('#d77757'), crack: hex('#5a3a1a') }

/** The egg before the hatchling: ▄█▄ over ▐███▌, rocking, cracking as it nears 10k tokens. */
function tuiEgg(g: Grid, x: number, mood: Mood, t: number, hatch: number, tint?: number) {
  const rock = mood === 'sleep' ? 0 : mood === 'work' || mood === 'think' ? [0, 1, 0, -1][t % 4]! : t % 8 === 0 ? 1 : t % 8 === 4 ? -1 : 0
  const x0 = col(x) - 2 + rock, y0 = BASE
  const spot = tint ?? EGG.spot
  text(g, x0 + 1, y0, '▄█▄', EGG.shell)
  put(g, x0, y0 + 1, '▐', EGG.shell)
  fill(g, x0 + 1, y0 + 1, 3, 1, EGG.shell)
  put(g, x0 + 4, y0 + 1, '▌', EGG.shell)
  text(g, x0 + 1, y0 + 2, '▀▀▀', EGG.shell)
  put(g, x0 + 2, y0, '▄', spot, EGG.shell) // spots in the crew color, so you can tell whose egg is whose
  put(g, x0 + 1, y0 + 1, hatch > 0.5 ? '╲' : '▖', hatch > 0.5 ? EGG.crack : spot, EGG.shell)
  put(g, x0 + 2, y0 + 1, hatch > 0.75 ? '╱' : ' ', EGG.crack, EGG.shell)
  put(g, x0 + 3, y0 + 1, hatch > 0.9 ? '╲' : '▝', hatch > 0.9 ? EGG.crack : spot, EGG.shell)
  if (mood === 'sleep') put(g, x0 + 5 + ((t % 8) >> 2), y0 - 1 - ((t % 8) >> 2), (t % 8) < 4 ? 'z' : 'Z', P.w)
  if (mood === 'happy') put(g, x0 + 2, y0 - 1 - (t % 2), '♥', P.k)
}

/** Clawd centered on `x` (full room coordinates). `tint` swaps the orange for a crew color. */
export function tuiMascot(g: Grid, x: number, mood: Mood, t: number, power?: Power, tint?: number) {
  if (power && power.stage < 0) return tuiEgg(g, x, mood === 'walk' ? 'idle' : mood, t, power.hatch ?? 0, tint)
  const body = tint ?? P.b
  const dark = mix(body, 0, 0.3)
  const hops = HOP[mood] ?? [0]
  const dy = hops[t % hops.length]!
  const shake = (mood === 'error' && t < 4 ? (t % 2 ? 1 : -1) : 0) + (mood === 'dance' ? ((t >> 1) % 2 ? 1 : -1) : 0)
  const x0 = col(x) - 4 + shake
  const y0 = BASE + dy

  // the eyes are the quarter each of ▛ and ▜ leaves out, showing the cell's background
  const isShut = mood === 'sleep' || mood === 'wait' || (mood === 'idle' && (t === 11 || t === 12)) || (mood === 'eat' && t % 4 < 2)
  const isGlad = mood === 'done' || mood === 'happy' || mood === 'dance'
  const eye = isShut || isGlad ? dark : P.e
  const isSquish = mood === 'compact' && t % 4 < 2

  const arms = ARMS[mood] ?? 'down'
  const left = arms === 'up' || arms === 'left' || (arms === 'wave' && t % 2 === 0) || (arms === 'dance' && (t >> 1) % 2 === 0)
  const right = arms === 'up' || arms === 'right' || (arms === 'wave' && t % 2 === 1) || (arms === 'dance' && (t >> 1) % 2 === 1)

  if (power && power.stage >= 3) {
    // the cape: behind him, on the cells his outline leaves open
    for (const [cx, cy] of [[0, 1], [8, 1], [1, 2], [7, 2]] as const) put(g, x0 + cx, y0 + cy, ' ', DEFAULT, G.cape)
  }
  const keep = (cx: number, cy: number) => bgAt(g, x0 + cx, y0 + cy)
  if (isSquish) {
    text(g, x0 + 1, y0 + 1, '▗', body)
    for (let i = 2; i < 7; i++) put(g, x0 + i, y0 + 1, '▄', body, keep(i, 1))
    put(g, x0 + 7, y0 + 1, '▖', body)
    put(g, x0 + 3, y0 + 1, '▄', body, eye); put(g, x0 + 5, y0 + 1, '▄', body, eye)
  } else {
    put(g, x0 + 1, y0, '▐', body)
    put(g, x0 + 2, y0, '▛', body, eye)
    text(g, x0 + 3, y0, '███', body)
    put(g, x0 + 6, y0, '▜', body, eye)
    put(g, x0 + 7, y0, '▌', body)
    if (left) { put(g, x0, y0, '▗', body); put(g, x0 + 1, y0 + 1, '▐', body) } else text(g, x0, y0 + 1, '▝▜', body)
    text(g, x0 + 2, y0 + 1, '█████', body)
    if (right) { put(g, x0 + 8, y0, '▖', body); put(g, x0 + 7, y0 + 1, '▌', body) } else text(g, x0 + 7, y0 + 1, '▛▘', body)
  }
  const walking = mood === 'walk' || mood === 'dance'
  const legs = walking && t % 2 ? '▝▘ ▘▝' : '▘▘ ▝▝'
  ;[...legs].forEach((ch, i) => { if (ch !== ' ') put(g, x0 + 2 + i, BASE + 2, ch, body) })

  if (power) gear(g, x0, y0, t, power, body, isSquish)

  const above = y0 - 1
  switch (mood) {
    case 'think': text(g, x0 + 8, above, ['', '.', '.o', '.oO'][(t >> 1) % 4]!, P.w); break
    case 'wait': put(g, x0 + 4, above - 1, '?', P.y); break
    case 'error': if (t % 2 === 0) put(g, x0 + 4, above - 1, '!', P.r); break
    case 'sleep': text(g, x0 + 8 + ((t % 8) >> 2), above - ((t % 8) >> 2), (t % 8) < 4 ? 'z' : 'Z', P.w); break
    case 'done': put(g, x0 - 1, above + (t % 2), '*', P.y); put(g, x0 + 9, above + 1 - (t % 2), '*', P.y); break
    case 'happy': put(g, x0 + 4, above - 1 - (t % 2), '♥', P.k); break
    case 'sad': case 'compact': put(g, x0 + 8, y0 + (t % 2), '╻', P.s); break
    case 'eat': if (t < 12) put(g, x0 + 8, y0 + 1, '●', P.c); break
    case 'dance':
      put(g, x0 - 1, above - (t % 2), '♪', t % 4 < 2 ? P.n : P.k)
      put(g, x0 + 9, above - 1 + (t % 2), '♫', t % 4 < 2 ? P.s : P.y)
      break
  }
}

/**
 * The evolution gear: sprout, headband, cape (drawn above), chest plate with
 * the model's gem, sparks, crown, halo, and a legend's glow.
 */
function gear(g: Grid, x0: number, y0: number, t: number, { stage, rank }: Power, body: number, isSquish: boolean) {
  if (isSquish) return
  if (stage >= 2) for (let i = 3; i < 6; i++) put(g, x0 + i, y0, '▀', G.band, body)
  if (stage >= 4) for (let i = 3; i < 6; i++) put(g, x0 + i, y0 + 1, '▄', G.steel, body)
  if (rank >= 2) put(g, x0 + 4, y0 + 1, '▄', rank === 2 ? G.sonnet : rank === 3 ? G.opus : G.fable, body)
  if (stage >= 1 && stage < 6) put(g, x0 + 4, y0 - 1, '♣', G.leaf)
  if (stage >= 6) text(g, x0 + 3, y0 - 1, '▲▲▲', G.gold)
  if (rank >= 4) text(g, x0 + 3, y0 - 2 + ((t >> 2) % 2), '───', G.halo)
  if (stage >= 5) {
    const n = stage >= 7 ? 4 : 2
    for (let i = 0; i < n; i++) {
      const a = ((t / FRAMES) + i / n) * Math.PI * 2
      put(g, Math.round(x0 + 4 + Math.cos(a) * 6), Math.round(y0 + 0.5 + Math.sin(a) * 1.5), '·', (t + i) % 4 ? G.gold : G.halo)
    }
  }
  // a legend sparkles: twinkles around him on top of the orbit
  if (stage >= 7) for (const [cx, cy] of [[-1, -1], [9, -1], [-2, 1], [10, 1]] as const) if ((t + cx) % 3 === 0) put(g, x0 + cx, y0 + cy, '✦', G.halo)
}

const MINI_COLORS = ['#7aa2f7', '#9ece6a', '#bb9af7', '#e0af68', '#73daca'].map(hex)

/** Subagents: small Clawds (▐▛▜▌ over ▝▘▝▘) hopping at the front left. */
export function tuiAgents(g: Grid, n: number, t: number) {
  for (let i = 0; i < Math.min(n, 5); i++) {
    const x = 1 + i * 5, y = 9 + ((t + i) % 2 ? 0 : 1) - 1
    const c = MINI_COLORS[i]!
    put(g, x, y, '▐', c); put(g, x + 1, y, '▛', c, P.e); put(g, x + 2, y, '▜', c, P.e); put(g, x + 3, y, '▌', c)
    text(g, x + 1, y + 1, '▘▝', c)
  }
}

/** The ▼ over this session's Clawd, when others share the office. */
export function tuiMarker(g: Grid, x: number, t: number) {
  put(g, col(x), BASE - 3 + ((t >> 2) % 2 ? 0 : -1), '▼', P.y)
}

/** A letter in flight: `x` in full room coordinates, `k` 0..1 along the way. */
export function tuiEnvelope(g: Grid, x: number, k: number, isAway: boolean) {
  put(g, col(x), Math.round(BASE - 2 - Math.sin(Math.PI * k) * 3 - (isAway ? k * 5 : 0)), '■', P.w)
}

/** The grid as Raster cells, `cols` × `rows` cut from it: the middle columns, the bottom rows. */
export function tuiCells(g: Grid, cols: number, rows: number): string {
  const x0 = Math.max(0, Math.floor((TW - cols) / 2))
  const pad = Math.max(0, rows - TH) // extra rows: more wall, under the molding
  const cut = Math.max(0, TH - rows) // missing rows: the top of the wall goes
  const words = new Uint32Array(cols * rows * 3)
  let k = 0
  for (let r = 0; r < rows; r++) {
    // pad rows repeat row 1 (plain wall and what hangs on it, never furniture tops)
    const y = pad ? (r === 0 ? 0 : r <= pad ? -1 : r - pad) : r + cut
    for (let c = 0; c < cols; c++) {
      const x = x0 + c
      if (x >= TW) { words[k++] = 0x20; words[k++] = DEFAULT; words[k++] = DEFAULT; continue }
      if (y === -1) {
        words[k++] = x % 4 === 2 ? 0x2502 : 0x20; words[k++] = C.stripe; words[k++] = C.wall
        continue
      }
      const i = y * TW + x
      words[k++] = g.ch[i]!
      words[k++] = g.fg[i]!
      words[k++] = g.bg[i]!
    }
  }
  const bytes = new Uint8Array(words.buffer)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

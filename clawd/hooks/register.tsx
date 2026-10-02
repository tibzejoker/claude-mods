import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Limit, Mood, QgState, Station, Tab } from '../types'
import {
  FRAME_MS, FRAMES, H, HUD_C, STATION_X, W,
  background, bar, blank, compose, dim, levelColor, mascot, minis, panel, stationFx, text, textWidth,
  envelope, hex, mascotTinted, tag, toCells, toPaths,
} from './scene'
import type { Buf, Power } from './scene'
import { TH, TW, col, copy, tuiAgents, tuiCells, tuiEnvelope, tuiFx, tuiMarker, tuiMascot, tuiRoom } from './tui'
import type { Grid } from './tui'

const PANE = 'clawd'
const SLEEP_AFTER = 4 * 60_000
const WALK_MS = 22 // per pixel, on desktop
const WALK_STEP = 3 // pixels per frame, in the terminal
const SCALE = 4 // CSS pixels per scene pixel

const INITIAL: QgState = {
  base: 'idle', flash: null, flashUntil: 0, station: 'center', x: STATION_X.center,
  walkFrom: STATION_X.center, walkAt: 0, tool: '', agents: 0, ctx: 0, ctxTokens: 0, ctxWindow: 0, usd: 0,
  counts: { shelf: 0, desk: 0, center: 0, term: 0, globe: 0 }, lastActive: 0,
  tab: 'hud', lights: true, model: '', limits: [], tools: {}, calls: 0, errors: 0, files: [],
  agentsTotal: 0, compactions: 0, turns: 0, startedAt: 0, xp: 0, pets: 0, snacks: 0, tokens: 0,
}
const st = atom({ plugin: 'clawd', key: 's' } as const, INITIAL)

const LABEL: Record<Mood, string> = {
  idle: 'chilling', walk: 'walking', think: 'thinking', work: 'working', wait: 'waiting for you',
  sleep: 'napping', compact: 'compacting memory', done: 'done!', error: 'ouch, an error',
  happy: 'happy', sad: 'sulking', eat: 'munching', dance: 'dancing',
}
const MOOD_COLOR: Record<Mood, number> = {
  idle: HUD_C.dim, walk: HUD_C.dim, think: HUD_C.violet, work: HUD_C.cyan, wait: HUD_C.gold,
  sleep: HUD_C.dim, compact: HUD_C.violet, done: HUD_C.ok, error: HUD_C.hot, happy: HUD_C.pink,
  sad: HUD_C.cyan, eat: HUD_C.gold, dance: HUD_C.pink,
}
const STATION_NAME: Record<Station, string> = {
  shelf: 'LIBRARY', desk: 'DESK', term: 'TERMINAL', globe: 'WEB + MCP', center: 'OTHER',
}

function stationOf(tool: string): Station {
  if (/^(Read|Grep|Glob|LS|NotebookRead)$/.test(tool)) return 'shelf'
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return 'desk'
  if (/^(Bash|BashOutput|KillShell|Monitor|TaskStop)$/.test(tool)) return 'term'
  if (/^(WebSearch|WebFetch)$/.test(tool) || tool.startsWith('mcp__')) return 'globe'
  return 'center'
}

function shortTool(tool: string): string {
  return tool.startsWith('mcp__') ? tool.split('__').slice(-1)[0]! : tool
}

// ---------- formatting ----------

let timeZone: string | undefined

function localTime(now: number): { hour: number; minute: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: 'numeric', hour12: false, timeZone })
      .formatToParts(new Date(now))
    const get = (t: string) => parseInt(parts.find(p => p.type === t)?.value ?? '0', 10)
    return { hour: get('hour') % 24, minute: get('minute') }
  } catch {
    const d = new Date(now)
    return { hour: d.getHours(), minute: d.getMinutes() }
  }
}

function resetClock(iso: string | undefined): string {
  if (!iso) return '--'
  try {
    return new Intl.DateTimeFormat('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone })
      .format(new Date(iso)).replace(',', '')
  } catch {
    return '--'
  }
}

function span(ms: number): string {
  if (ms <= 0) return 'now'
  const m = Math.floor(ms / 60_000), h = Math.floor(m / 60), d = Math.floor(h / 24)
  if (d > 0) return `${d}d${String(h % 24).padStart(2, '0')}h`
  if (h > 0) return `${h}h${String(m % 60).padStart(2, '0')}m`
  return `${m}m`
}

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}K`
  return String(n)
}

function prettyModel(id: string): string {
  const big = /\[1m\]/i.test(id) ? ' 1M' : ''
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/i.exec(id)
  if (!m) return (id.replace(/\[.*\]/, '') || '?').toUpperCase().slice(0, 12) + big
  return `${m[1]!.toUpperCase()} ${m[2]}${m[3] ? '.' + m[3] : ''}${big}`
}

function level(xp: number) {
  const lv = Math.floor(Math.sqrt(xp / 20)) + 1
  const lo = 20 * (lv - 1) ** 2, hi = 20 * lv ** 2
  return { lv, next: hi, pct: ((xp - lo) / (hi - lo)) * 100 }
}

// ---------- evolution ----------
// The tokens this Claude has handled (what was sent to it, cache reads left
// out, and what it wrote, its subagents' included) raise it from an egg (the
// first 10k) through 8 stages on a log scale up to 10M; its model sets its rank.

const EVO = [0, 10_000, 50_000, 200_000, 500_000, 1_000_000, 2_500_000, 5_000_000, 10_000_000]
const EVO_NAME = ['EGG', 'HATCHLING', 'SPROUT', 'ROOKIE', 'HERO', 'KNIGHT', 'MYSTIC', 'KING', 'LEGEND']

function stageOf(tok: number) {
  let k = 0
  while (k + 1 < EVO.length && tok >= EVO[k + 1]!) k++
  return k
}

/** Progress toward the next stage, in percent; 100 at the top. */
function evoPct(tok: number) {
  const k = stageOf(tok)
  if (k === EVO.length - 1) return 100
  return ((tok - EVO[k]!) / (EVO[k + 1]! - EVO[k]!)) * 100
}

function rankOf(model: string) {
  if (/fable/i.test(model)) return 4
  if (/opus/i.test(model)) return 3
  if (/sonnet/i.test(model)) return 2
  return 1
}

/** The gear's stage counts from the hatchling (0); the egg is -1, with how close it is to hatching. */
function powerOf(s: { tokens: number; model: string }): Power {
  const k = stageOf(s.tokens)
  return k === 0 ? { stage: -1, rank: rankOf(s.model), hatch: evoPct(s.tokens) / 100 } : { stage: k - 1, rank: rankOf(s.model) }
}

type Slot = { short: string; long: string; limit: Limit | null }

/** The three windows the HUD shows: 5 h session, week, and the model's own week. */
function slots(limits: Limit[]): Slot[] {
  const find = (k: string) => limits.find(l => l.kind === k) ?? null
  const extra = limits.find(l => /fable/i.test(l.kind)) ?? limits.find(l => l.kind !== 'five_hour' && l.kind !== 'seven_day') ?? null
  const fam = extra ? (/(fable|opus|sonnet|haiku)/i.exec(extra.kind)?.[1] ?? extra.kind.replace(/_/g, ' ')) : 'fable'
  return [
    { short: '5H', long: 'SESSION 5H', limit: find('five_hour') },
    { short: 'WEEK', long: 'WEEKLY', limit: find('seven_day') },
    { short: fam.slice(0, 4).toUpperCase(), long: `${fam.toUpperCase().slice(0, 7)} WK`, limit: extra },
  ]
}

function slotLeft(l: Limit | null, now: number) {
  return l?.resetsAt ? span(Date.parse(l.resetsAt) - now) : '--'
}

/** Mood shown: a short flash, a nap, else the background mood. */
function moodOf(s: QgState, now: number): Mood {
  if (s.flash && now < s.flashUntil) return s.flash
  if (s.base === 'idle' && !s.lights) return 'sleep'
  if (s.base === 'idle' && s.lastActive > 0 && now - s.lastActive > SLEEP_AFTER) return 'sleep'
  return s.base
}

function walkMs(s: QgState) {
  return Math.abs(s.x - s.walkFrom) * WALK_MS
}

// ---------- the menus' rows, shared by the pixel HUD and the terminal ----------

type Row = { k: string; v: string; pct?: number | null; c?: number }

function menu(s: QgState, tab: Tab, now: number): { title: string; rows: Row[] } {
  if (tab === 'limits') {
    const rows: Row[] = [{
      k: 'CONTEXT', v: s.ctxWindow ? `${tokens(s.ctxTokens)}/${tokens(s.ctxWindow)} ${s.ctx}%` : `${s.ctx}%`, pct: s.ctx,
    }]
    for (const sl of slots(s.limits)) {
      const l = sl.limit
      rows.push({ k: sl.long, v: l ? `${Math.round(l.pct)}% ${slotLeft(l, now)}` : 'NO DATA', pct: l ? l.pct : null })
      rows.push({ k: '  RESETS', v: resetClock(l?.resetsAt), c: HUD_C.dim })
    }
    return { title: 'LIMITS', rows }
  }
  if (tab === 'tools') {
    const top = Object.entries(s.tools).sort((a, b) => b[1] - a[1])[0]
    const max = Math.max(1, ...Object.values(s.counts))
    const order: Station[] = ['shelf', 'desk', 'term', 'globe', 'center']
    return {
      title: top ? `TOOLS · TOP ${top[0].slice(0, 10)} ${top[1]}` : 'TOOLS',
      rows: [
        { k: 'CALLS', v: `${s.calls} · ${s.errors} ERR`, c: s.errors ? HUD_C.hot : undefined },
        { k: 'FILES EDITED', v: String(s.files.length) },
        ...order.map(k => ({ k: STATION_NAME[k], v: String(s.counts[k]), pct: (s.counts[k] / max) * 100, c: HUD_C.cyan })),
      ],
    }
  }
  const lv = level(s.xp)
  return {
    title: 'SESSION',
    rows: [
      { k: 'MODEL', v: prettyModel(s.model), c: HUD_C.gold },
      { k: 'UPTIME', v: s.startedAt ? span(now - s.startedAt) : '--' },
      { k: 'TURNS', v: String(s.turns) },
      { k: 'COST', v: `$${s.usd.toFixed(2)}` },
      { k: 'SUBAGENTS', v: `${s.agentsTotal} · ${s.compactions} COMPACT` },
      { k: `LEVEL ${lv.lv}`, v: `${s.xp}/${lv.next} XP`, pct: lv.pct, c: HUD_C.violet },
      { k: EVO_NAME[stageOf(s.tokens)]!, v: `${tokens(s.tokens)}/${tokens(EVO[Math.min(EVO.length - 1, stageOf(s.tokens) + 1)]!)}`, pct: evoPct(s.tokens), c: HUD_C.gold },
      { k: 'FRIENDSHIP', v: `♥${s.pets} · ${s.snacks} SNACKS`, c: HUD_C.pink },
    ],
  }
}

// ---------- the pixel HUD (desktop and phone) ----------

function drawHud(b: Buf, s: QgState, now: number, mood: Mood) {
  // the open menu, over a dimmed room
  if (s.tab !== 'hud') {
    const m = menu(s, s.tab, now)
    dim(b, 0, 19, W, 79)
    panel(b, 26, 28, 140, 68)
    text(b, '▶', 30, 31, HUD_C.accent)
    text(b, m.title.slice(0, 30), 36, 31, HUD_C.gold)
    m.rows.slice(0, 7).forEach((r, i) => {
      const y = 41 + i * 8
      text(b, r.k.slice(0, 12), 30, y, r.k.startsWith(' ') ? HUD_C.dim : HUD_C.text)
      if (r.pct !== undefined) bar(b, 80, y + 1, 34, r.pct, r.c && r.c !== HUD_C.dim ? r.c : undefined)
      const v = r.v.slice(0, r.pct !== undefined ? 11 : 20)
      text(b, v, 162 - textWidth(v), y, r.c ?? HUD_C.text)
    })
  }

  // top left: model and context
  panel(b, 1, 1, 70, 17)
  text(b, '◆', 4, 4, HUD_C.accent)
  text(b, prettyModel(s.model), 9, 4, HUD_C.gold)
  const lv = level(s.xp)
  const lvText = `LV${lv.lv}`
  text(b, lvText, 68 - textWidth(lvText), 4, HUD_C.violet)
  text(b, 'CTX', 4, 11, HUD_C.dim)
  bar(b, 17, 12, 34, s.ctx)
  text(b, `${s.ctx}%`, 54, 11, HUD_C.text)

  // top right: the rate-limit windows
  panel(b, 104, 1, 87, 25)
  slots(s.limits).forEach((sl, i) => {
    const y = 4 + i * 7
    const l = sl.limit
    text(b, sl.short, 107, y, HUD_C.dim)
    bar(b, 125, y + 1, 24, l ? l.pct : null)
    const pct = l ? `${Math.round(l.pct)}%` : '--'
    text(b, pct, 152, y, l ? levelColor(l.pct) : HUD_C.dim)
    const left = slotLeft(l, now)
    text(b, left, 188 - textWidth(left), y, HUD_C.text)
  })

  // bottom: what Clawd does, money, turns, xp
  panel(b, 1, 98, 190, 9)
  text(b, '●', 4, 100, MOOD_COLOR[mood])
  const doing = LABEL[mood] + (s.tool && (mood === 'work' || mood === 'wait') ? ` · ${s.tool}` : '')
  text(b, doing.slice(0, 26), 9, 100, HUD_C.text)
  const right = `$${s.usd.toFixed(2)}  T${s.turns}`
  bar(b, 160, 101, 28, lv.pct, HUD_C.violet)
  text(b, right, 157 - textWidth(right), 100, HUD_C.text)

}

// ---------- the module ----------

// local mirror of the state, for the terminal's animation (no read per frame)
let S: QgState = INITIAL
let curX = INITIAL.x
let tick = 0
let termCols = 0
let termRows = 0
let sceneRows = 40 // the terminal scene's maximum height in rows, from the `hauteur` option
let sceneCols = 96 // and its maximum width in columns, from the `largeur` option
let sceneMode = 'auto' // `resolution`: hd, mini, or auto (the full room when it fits at half size or more)
let isMini = false // whether the terminal draws the room in characters right now

async function set($: EngineInterface, fn: (s: QgState) => QgState) {
  await update($, st, s => {
    const next = fn(s)
    S = next
    return next
  })
  void publish($)
}

function goTo(s: QgState, station: Station, now: number): QgState {
  const x = station === 'center' ? STATION_X.center + ((s.counts.center % 3) - 1) * 8 : STATION_X[station]
  if (x === s.x) return { ...s, station }
  return { ...s, station, walkFrom: s.x, x, walkAt: now }
}

async function flash($: EngineInterface, mood: Mood, ms: number) {
  const now = await $.clock.now()
  await set($, s => ({ ...s, flash: mood, flashUntil: now + ms }))
  $.clock.after(ms + 50, () => $.ui.invalidate('ui.render'))
}

type Game = { xp: number; pets: number; snacks: number }
// what this session already added to the shared save: every session open at
// once adds its own gains to it, so none overwrites what another earned
let banked: Game = { xp: 0, pets: 0, snacks: 0 }
let saveQueued = false
function persist($: EngineInterface) {
  if (saveQueued) return
  saveQueued = true
  $.clock.after(3000, async () => {
    saveQueued = false
    const saved = ((await $.store.get('game')) ?? {}) as Partial<Game>
    const now: Game = { xp: S.xp, pets: S.pets, snacks: S.snacks }
    await $.store.set('game', {
      xp: (saved.xp ?? 0) + now.xp - banked.xp,
      pets: (saved.pets ?? 0) + now.pets - banked.pets,
      snacks: (saved.snacks ?? 0) + now.snacks - banked.snacks,
    })
    banked = now
    if (myId) await $.store.set(`tok:${myId}`, S.tokens)
  })
}

// ---------- the crew: every Claude open on this machine, in one shared office ----------
// Each session writes where its Clawd stands to a file of its own in a shared
// folder and reads everyone else's: the same room in every window.

type Mail = { to: string; at: number }
type Mate = {
  id: string; name: string; x: number; walkFrom: number; walkAt: number; mood: Mood; station: Station
  tool: string; agents: number; at: number; wave: number; mail: Mail | null; power?: Power
}

const CREW_COLORS = ['#d77757', '#7aa2f7', '#9ece6a', '#bb9af7', '#e0af68', '#73daca', '#ff6f91', '#7cc4ff'].map(hex)
const STALE_MS = 15_000
const MAIL_MS = 2200
const WAVE_MS = 3000

let myId = ''
let myName = ''
let crewDir = ''
let crew: Mate[] = []
let myWave = 0
let myMail: Mail | null = null
let lastBody = ''
let lastWrite = 0
const seenWave: Record<string, number> = {}

function colorOf(id: string) {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return CREW_COLORS[h % CREW_COLORS.length]!
}

/** A small, stable sidestep per session, so two Clawds at one station don't stack. */
function sidestep(id: string) {
  let h = 7
  for (const ch of id) h = (h * 17 + ch.charCodeAt(0)) >>> 0
  return ((h % 5) - 2) * 5
}

function walkingX(m: { x: number; walkFrom: number; walkAt: number }, now: number) {
  const dur = Math.abs(m.x - m.walkFrom) * WALK_MS
  if (now - m.walkAt >= dur) return m.x
  return Math.round(m.walkFrom + ((m.x - m.walkFrom) * (now - m.walkAt)) / dur)
}

function labels(): Map<string, string> {
  const all = [{ id: myId, name: myName }, ...crew].sort((a, b) => a.id.localeCompare(b.id))
  const out = new Map<string, string>()
  for (const m of all) {
    const twins = all.filter(o => o.name === m.name)
    out.set(m.id, (twins.length > 1 ? `${m.name.slice(0, 7)}${twins.indexOf(m) + 1}` : m.name.slice(0, 8)).toUpperCase())
  }
  return out
}

async function publish($: EngineInterface, force = false) {
  if (!crewDir) return
  const now = await $.clock.now()
  const mate: Omit<Mate, 'at'> = {
    id: myId, name: myName, x: S.x, walkFrom: S.walkFrom, walkAt: S.walkAt, mood: moodOf(S, now), station: S.station,
    tool: S.tool, agents: S.agents, wave: myWave, mail: myMail, power: powerOf(S),
  }
  const body = JSON.stringify(mate)
  if (!force && body === lastBody && now - lastWrite < 5000) return
  lastBody = body
  lastWrite = now
  try { await $.fs.write(`${crewDir}/${myId}.json`, JSON.stringify({ ...mate, at: now })) } catch {}
}

async function scan($: EngineInterface) {
  if (!crewDir) return
  const now = await $.clock.now()
  let entries: Awaited<ReturnType<EngineInterface['fs']['list']>> = []
  try { entries = await $.fs.list(crewDir) } catch { return }
  const fresh = entries.filter(f => f.kind === 'file' && f.name.endsWith('.json') && f.name !== `${myId}.json` && now - f.mtimeMs < STALE_MS)
  const next: Mate[] = []
  for (const f of fresh) {
    try {
      const m = JSON.parse(await $.fs.read(`${crewDir}/${f.name}`) as string) as Mate
      if (m.id && m.at && now - m.at < STALE_MS) next.push(m)
    } catch {}
  }
  next.sort((a, b) => a.id.localeCompare(b.id))
  // somebody waved: wave back
  for (const m of next) {
    if (m.wave && m.wave !== seenWave[m.id] && now - m.wave < WAVE_MS) void flash($, 'happy', 2500)
    seenWave[m.id] = m.wave
  }
  const changed = JSON.stringify(next.map(m => ({ ...m, at: 0 }))) !== JSON.stringify(crew.map(m => ({ ...m, at: 0 })))
  crew = next
  const inFlight = [myMail, ...crew.map(m => m.mail)].some(x => x && now - x.at < MAIL_MS)
  if (changed || inFlight) $.ui.invalidate('ui.render')
}

/** Where a letter goes: the mate it names, or up and away when nobody here carries that name. */
function mailTarget(to: string, now: number): number | null {
  const t = to.toLowerCase()
  if (myId && (t.includes(myId) || t === myName.toLowerCase())) return S.x + sidestep(myId)
  const m = crew.find(o => t.includes(o.id) || t === o.name.toLowerCase())
  return m ? walkingX(m, now) + sidestep(m.id) : null
}

/** Every other Clawd, its tag, the ▼ over this one, and the letters in flight. */
function drawCrew(b: Buf, t: number, now: number, myX: number, ownLook: number) {
  if (crew.length === 0) {
    if (myMail && now - myMail.at < MAIL_MS) flight(b, myX, myMail, now)
    return
  }
  const names = labels()
  for (const m of crew) {
    const x = walkingX(m, now) + sidestep(m.id)
    const isWalking = x - sidestep(m.id) !== m.x
    const mood: Mood = isWalking ? 'walk' : m.wave && now - m.wave < WAVE_MS ? 'happy' : m.mood
    mascotTinted(b, x, mood, (t + m.id.charCodeAt(0)) % FRAMES, isWalking ? Math.sign(m.x - m.walkFrom) : 0, colorOf(m.id), m.power)
    tag(b, x, names.get(m.id) ?? '?', colorOf(m.id), false, t)
    if (m.mail && now - m.mail.at < MAIL_MS) flight(b, x, m.mail, now)
  }
  tag(b, myX, names.get(myId) ?? 'YOU', colorOf(myId), true, t)
  if (myMail && now - myMail.at < MAIL_MS) flight(b, myX, myMail, now)
  void ownLook
}

function flight(b: Buf, fromX: number, mail: Mail, now: number) {
  const k = Math.min(1, (now - mail.at) / MAIL_MS)
  const to = mailTarget(mail.to, now)
  const x = to === null ? fromX + k * 20 : fromX + (to - fromX) * k
  const y = FOOT - 40 - Math.sin(Math.PI * k) * 18 - (to === null ? k * 30 : 0)
  envelope(b, x, y)
}

// the room changes once a minute (the clock's hands): cache it
let bgKey = ''
let bgBuf: Buf = blank()
let bgSvg = ''
function room(now: number, lights: boolean) {
  const { hour, minute } = localTime(now)
  const key = `${hour}:${minute}:${lights}`
  if (key !== bgKey) {
    bgKey = key
    bgBuf = background({ hour, minute, lights })
    bgSvg = toPaths(bgBuf)
  }
  return { buf: bgBuf, svg: bgSvg }
}

let tuiKey = ''
let tuiBuf: Grid | null = null
function tuiRoom2(now: number, lights: boolean): Grid {
  const { hour, minute } = localTime(now)
  const key = `${hour}:${minute}:${lights}`
  if (key !== tuiKey || !tuiBuf) {
    tuiKey = key
    tuiBuf = tuiRoom({ hour, minute, lights })
  }
  return tuiBuf
}

async function refresh($: EngineInterface) {
  try {
    const [u, model, turns] = await Promise.all([$.session.usage(), $.session.model(), $.session.turns()])
    const ctx = Math.round(u.context.percent ?? 0)
    const usd = Math.round((u.cost?.usd ?? 0) * 100) / 100
    const limits: Limit[] = u.rateLimits.map(l => ({ kind: l.kind, pct: l.percentUsed, resetsAt: l.resetsAt }))
    const s = S
    const changed = ctx !== s.ctx || usd !== s.usd || model !== s.model || turns !== s.turns ||
      JSON.stringify(limits) !== JSON.stringify(s.limits) || (u.context.tokens ?? 0) !== s.ctxTokens ||
      u.startedAt !== s.startedAt
    if (changed) {
      await set($, x => ({
        ...x, ctx, usd, model, turns, limits, startedAt: u.startedAt,
        ctxTokens: u.context.tokens ?? 0, ctxWindow: u.context.window,
      }))
    }
  } catch {}
}

async function act($: EngineInterface, what: 'pet' | 'snack' | 'dance' | 'lights' | 'wave') {
  const now = await $.clock.now()
  if (what === 'wave') {
    myWave = now
    await set($, s => ({ ...s, lastActive: now }))
    await flash($, 'happy', WAVE_MS)
    return
  }
  if (what === 'lights') {
    await set($, s => ({ ...s, lights: !s.lights, lastActive: now }))
    return
  }
  if (what === 'pet') {
    await set($, s => ({ ...s, pets: s.pets + 1, xp: s.xp + 2, lastActive: now }))
    await flash($, 'happy', 2600)
  } else if (what === 'snack') {
    await set($, s => ({ ...s, snacks: s.snacks + 1, xp: s.xp + 1, lastActive: now }))
    await flash($, 'eat', 3200)
  } else {
    await set($, s => ({ ...s, lastActive: now }))
    await flash($, 'dance', 6400)
  }
  persist($)
}

async function show($: EngineInterface, tab: Tab) {
  await set($, s => ({ ...s, tab: s.tab === tab ? 'hud' : tab }))
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    timeZone = String(options.fuseau ?? '').trim() || (await $.env.get('TZ')) || undefined
    sceneRows = Math.max(10, Math.min(H / 2, Math.round(Number(options.hauteur ?? 40)) || 40))
    sceneCols = Math.max(20, Math.min(W, Math.round(Number(options.largeur ?? 96)) || 96))
    sceneMode = String(options.resolution ?? 'auto')
    S = await read($, st)
    curX = S.x
    const saved = (await $.store.get('game')) as { xp?: number; pets?: number; snacks?: number } | undefined
    if (saved && S.xp === 0) await set($, s => ({ ...s, xp: saved.xp ?? 0, pets: saved.pets ?? 0, snacks: saved.snacks ?? 0 }))
    banked = { xp: S.xp, pets: S.pets, snacks: S.snacks }
    // a resumed session's Clawd picks up the strength it had
    if (S.tokens === 0) {
      const tok = Number((await $.store.get(`tok:${await $.session.id()}`)) ?? 0)
      if (tok > 0) await set($, s => ({ ...s, tokens: tok }))
    }
    myId = await $.session.id()
    const cwd = await $.session.cwd()
    const home = (await $.env.get('HOME')) ?? ''
    myName = cwd === home ? 'home' : (cwd.split('/').filter(Boolean).pop() ?? 'claude')
    if (home) crewDir = `${home}/.claude/clawd-crew`
    void publish($, true)
    $.clock.every(1000, () => publish($))
    $.clock.every(1500, () => scan($))
    await $.command.register({ name: 'clawd', description: "Open Clawd's HQ: a pixel art office with a game HUD of your session" })
    void $.ui.open({ id: PANE, title: 'HQ' })
    await refresh($)

    // terminal animation: one frame every 200 ms, without a full redraw
    $.clock.every(FRAME_MS, () => {
      tick = (tick + 1) % (FRAMES * 64)
      if (curX !== S.x) curX += Math.sign(S.x - curX) * Math.min(WALK_STEP, Math.abs(S.x - curX))
      if (termCols > 0) {
        void $.ui.blit({ requestId: PANE, key: 'scene', cells: terminalFrame(Date.now()) })
          .then(r => { if (r.deny) termCols = 0 }, () => { termCols = 0 })
      }
    })

    // usage, the nap, and a little stroll when idle
    let lastMood: Mood = moodOf(S, Date.now())
    let idleTicks = 0
    $.clock.every(4000, async () => {
      const now = await $.clock.now()
      await refresh($)
      const m = moodOf(S, now)
      if (m !== lastMood) { lastMood = m; $.ui.invalidate('ui.render') }
      if (m === 'idle' && ++idleTicks % 3 === 0) {
        const pal = crew.filter(m => m.mood === 'idle' || m.mood === 'sleep')[Math.floor(Math.random() * crew.length)]
        const x = pal ? Math.max(24, Math.min(170, pal.x + (pal.x > 96 ? -26 : 26))) : 74 + Math.floor(Math.random() * 46)
        await set($, s => ({ ...s, walkFrom: s.x, x, walkAt: now }))
      }
    })
    // countdowns and the wall clock move once a minute
    $.clock.every(60_000, () => $.ui.invalidate('ui.render'))

    return next(e)
  })

  on('command.run', { command: 'clawd' }, async $ => {
    await $.ui.open({ id: PANE, title: 'HQ' })
    return { text: 'HQ open.' }
  })

  // a real message from this Claude to another: a letter flies across the office
  on('session.send', async ($, e, next) => {
    const out = await next(e)
    if (!e.agentId) {
      myMail = { to: String(e.to), at: await $.clock.now() }
      void publish($, true)
      $.clock.after(MAIL_MS + 100, () => { myMail = null; void publish($, true) })
    }
    return out
  })

  on('session.receive', async ($, e, next) => {
    if (!e.agentId && (e.origin.kind === 'peer' || e.origin.kind === 'peer-send-message')) void flash($, 'happy', 2500)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (crewDir && myId) { try { await $.fs.write(`${crewDir}/${myId}.json`, JSON.stringify({ id: myId, at: 0 })) } catch {} }
    return next(e)
  })

  // every request the model answers makes this Claude a little stronger
  on('turn.step', async function* ($, e, next) {
    const out = yield* next(e)
    const u = out.usage
    if (u) {
      const gained = u.input_tokens + u.cache_creation_input_tokens + u.output_tokens
      const before = stageOf(S.tokens)
      await set($, s => ({ ...s, tokens: s.tokens + gained }))
      const after = stageOf(S.tokens)
      if (after > before) {
        void $.ui.toast(before === 0 ? 'Clawd hatched!' : `Clawd evolved: ${EVO_NAME[after]!.toLowerCase()}!`)
        void flash($, 'done', 3500)
      }
      persist($)
    }
    return out
  })

  on('session.measure', async ($, e, next) => {
    void refresh($)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const now = await $.clock.now()
    await set($, s => ({ ...s, base: 'think', lastActive: now }))
    // he reacts to the tone of the message (Haiku, one label)
    const msg = e.text.trim()
    if (msg.length > 3 && !msg.startsWith('/')) {
      void $.model.classify(msg.slice(0, 600), ['happy', 'neutral', 'sad', 'angry'], { model: 'haiku' })
        .then(label => {
          if (label === 'happy') return flash($, 'happy', 2500)
          if (label === 'sad' || label === 'angry') return flash($, 'sad', 2500)
        })
        .catch(() => {})
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId) return next(e) // subagents' tools don't move him
    const now = await $.clock.now()
    const station = stationOf(e.tool)
    const isAgent = e.tool === 'Agent'
    const name = shortTool(e.tool)
    const file = station === 'desk' ? (e as Record<string, unknown>).file_path : undefined
    await set($, s => ({
      ...goTo(s, station, now),
      base: 'work',
      tool: name,
      lastActive: now,
      agents: s.agents + (isAgent ? 1 : 0),
      agentsTotal: s.agentsTotal + (isAgent ? 1 : 0),
      counts: { ...s.counts, [station]: s.counts[station] + 1 },
      tools: Object.keys(s.tools).length < 60 || name in s.tools ? { ...s.tools, [name]: (s.tools[name] ?? 0) + 1 } : s.tools,
      calls: s.calls + 1,
      xp: s.xp + 1,
      files: typeof file === 'string' && !s.files.includes(file) ? [...s.files, file].slice(-300) : s.files,
    }))
    const ran = await next(e)
    const isError = ran.deny === undefined && ran.isError === true
    await set($, s => ({
      ...s,
      base: s.base === 'work' || s.base === 'wait' ? 'think' : s.base,
      agents: Math.max(0, s.agents - (isAgent ? 1 : 0)),
      errors: s.errors + (isError ? 1 : 0),
    }))
    if (isError) void flash($, 'error', 2000)
    persist($)
    return ran
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    await set($, s => ({ ...s, base: 'wait' }))
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    if (e.agentId) return next(e)
    await set($, s => ({ ...s, base: 'compact', compactions: s.compactions + 1 }))
    const out = await next(e)
    await set($, s => ({ ...s, base: 'think' }))
    return out
  })

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    await set($, s => ({ ...goTo(s, 'center', now), base: 'idle', lastActive: now, agents: 0, xp: s.xp + 3 }))
    if (e.reason === 'answer') void flash($, 'done', 3000)
    else if (e.reason === 'error' || e.reason === 'refusal') void flash($, 'error', 3000)
    else void flash($, 'sad', 2000)
    persist($)
    void refresh($)
    return next(e)
  })

  // ---------- drawing ----------

  function look(s: QgState, x: number): number {
    if (s.station === 'center') return 0
    return Math.sign(STATION_X[s.station] - x) || (s.station === 'shelf' ? -1 : 1)
  }

  function terminalFrame(now: number): string {
    const isWalking = curX !== S.x
    const mood = isWalking ? 'walk' : moodOf(S, now)
    const t = tick % FRAMES
    if (isMini) return miniFrame(now, mood, t)
    const lookX = isWalking ? Math.sign(S.x - curX) : look(S, curX)
    const fx = blank()
    stationFx(fx, mood === 'work' ? S.station : null, t, S.lights)
    minis(fx, S.agents, t)
    const m = blank()
    drawCrew(fx, t, now, curX + (crew.length ? sidestep(myId) : 0), 0)
    if (crew.length) mascotTinted(m, curX + sidestep(myId), mood, t, lookX, colorOf(myId), powerOf(S))
    else mascot(m, curX, mood, t, lookX, powerOf(S))
    return toCells(compose(room(now, S.lights).buf, fx, m), termCols, termRows)
  }

  /** The room in characters: no name tags (too small to read), only the ▼ over this Clawd. */
  function miniFrame(now: number, mood: Mood, t: number): string {
    const g = copy(tuiRoom2(now, S.lights))
    tuiFx(g, mood === 'work' ? S.station : null, t, S.lights)
    tuiAgents(g, S.agents, t)
    // every Clawd's column, pushed apart so none overlaps: 11 columns apart at least
    const spots = [
      { id: myId, x: col(curX + (crew.length ? sidestep(myId) : 0)), mate: null as Mate | null },
      ...crew.map(m => ({ id: m.id, x: col(walkingX(m, now) + sidestep(m.id)), mate: m as Mate | null })),
    ].sort((a, b) => a.x - b.x || a.id.localeCompare(b.id))
    for (let pass = 0; pass < 4; pass++) {
      for (let i = 1; i < spots.length; i++) {
        const gap = spots[i]!.x - spots[i - 1]!.x
        if (gap < 11) { spots[i - 1]!.x -= Math.ceil((11 - gap) / 2); spots[i]!.x += Math.floor((11 - gap) / 2) }
      }
      const lo = 5 - spots[0]!.x, hi = spots[spots.length - 1]!.x - (TW - 6)
      if (lo > 0) spots.forEach(p => { p.x += lo })
      else if (hi > 0) spots.forEach(p => { p.x -= hi })
    }
    const full = (c: number) => (c * W) / TW // back to the full room's coordinates
    let myX = curX
    for (const p of spots) {
      const m = p.mate
      if (!m) { myX = full(p.x); continue }
      const isWalking = walkingX(m, now) !== m.x
      const mmood: Mood = isWalking ? 'walk' : m.wave && now - m.wave < WAVE_MS ? 'happy' : m.mood
      tuiMascot(g, full(p.x), mmood, (t + m.id.charCodeAt(0)) % FRAMES, m.power, colorOf(m.id))
    }
    tuiMascot(g, myX, mood, t, powerOf(S), crew.length ? colorOf(myId) : undefined)
    if (crew.length) tuiMarker(g, myX, t)
    const letters = [{ from: myX, mail: myMail }, ...crew.map(m => ({ from: walkingX(m, now) + sidestep(m.id), mail: m.mail }))]
    for (const { from, mail } of letters) {
      if (!mail || now - mail.at >= MAIL_MS) continue
      const k = Math.min(1, (now - mail.at) / MAIL_MS)
      const to = mailTarget(mail.to, now)
      tuiEnvelope(g, to === null ? from + k * 20 : from + (to - from) * k, k, to === null)
    }
    return tuiCells(g, termCols, termRows)
  }

  function svgScene(s: QgState, now: number): string {
    const sinceWalk = now - s.walkAt
    const dur = walkMs(s)
    const isWalking = sinceWalk < dur
    const mood = isWalking ? 'walk' : moodOf(s, now)
    const cycle = FRAMES * FRAME_MS
    const phase = now % cycle

    // the 16 frames of the animation, stacked and lit in turn by CSS, in phase
    // with the wall clock so a redraw carries on where the last one was; 8
    // frames if the drawing nears the Svg size limit
    const walk = isWalking
      ? `.m{animation:wk ${dur / 1000}s steps(${Math.abs(s.x - s.walkFrom)},end) 1 both;animation-delay:-${sinceWalk / 1000}s}` +
        `@keyframes wk{from{transform:translate(${s.walkFrom - s.x}px,0)}to{transform:translate(0,0)}}`
      : ''
    const hud = blank()
    drawHud(hud, s, now, mood)
    const build = (every: number) => {
      let fx = ''
      let me = ''
      for (let t = 0; t < FRAMES; t += every) {
        const delay = `${((t * FRAME_MS - phase) / 1000).toFixed(2)}s`
        const f = blank()
        stationFx(f, mood === 'work' ? s.station : null, t, s.lights)
        drawCrew(f, t, now, s.x + (crew.length ? sidestep(myId) : 0), 0)
        fx += `<g class="f" style="animation-delay:${delay}">${toPaths(f)}</g>`
        const m = blank()
        const lk = isWalking ? Math.sign(s.x - s.walkFrom) : look(s, s.x)
        if (crew.length) mascotTinted(m, s.x + sidestep(myId), mood, t, lk, colorOf(myId), powerOf(s))
        else mascot(m, s.x, mood, t, lk, powerOf(s))
        me += `<g class="f" style="animation-delay:${delay}">${toPaths(m)}</g>`
      }
      let minisSvg = ''
      if (s.agents > 0) {
        for (let t = 0; t < 2; t++) {
          const c = blank()
          minis(c, s.agents, t)
          minisSvg += `<g class="g" style="animation-delay:${((t * FRAME_MS - (now % (2 * FRAME_MS))) / 1000).toFixed(2)}s">${toPaths(c)}</g>`
        }
      }
      const step = (100 * every) / FRAMES
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W * SCALE}" height="${H * SCALE}" shape-rendering="crispEdges">` +
        `<style>.f{visibility:hidden;animation:fr ${cycle / 1000}s step-end infinite}` +
        `.g{visibility:hidden;animation:fr2 ${(2 * FRAME_MS) / 1000}s step-end infinite}` +
        `@keyframes fr{0%{visibility:visible}${step.toFixed(3)}%{visibility:hidden}100%{visibility:hidden}}` +
        `@keyframes fr2{0%{visibility:visible}50%{visibility:hidden}100%{visibility:hidden}}${walk}</style>` +
        room(now, s.lights).svg + fx + minisSvg + `<g class="m">${me}</g>` + toPaths(hud) + `</svg>`
    }
    const full = build(1)
    return full.length <= 128_000 ? full : build(2)
  }

  /** Who else is in the office and what each one is doing. */
  function crewLine(now: number, _hex: (c: number) => string): string {
    const names = labels()
    return 'crew: ' + crew.map(m => {
      const doing = m.wave && now - m.wave < WAVE_MS ? 'waving' : LABEL[m.mood] + (m.tool && (m.mood === 'work' || m.mood === 'wait') ? ` ${m.tool}` : '')
      return `● ${names.get(m.id)?.toLowerCase()} ${doing}${m.agents ? ` +${m.agents} agents` : ''}`
    }).join('  ')
  }

  function hudText() {
    const gauge = (pct: number | null, n: number) => {
      if (pct === null) return '·'.repeat(n)
      const k = Math.round(Math.max(0, Math.min(1, pct / 100)) * n)
      return '█'.repeat(k) + '░'.repeat(n - k)
    }
    const hex6 = (c: number) => `#${c.toString(16).padStart(6, '0')}`
    return { gauge, hex6 }
  }

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const s = await read($, st)
    S = s
    const now = await $.clock.now()
    if (now - s.walkAt < walkMs(s)) $.clock.after(walkMs(s) - (now - s.walkAt) + 60, () => $.ui.invalidate('ui.render'))
    const mood = moodOf(s, now)
    const lv = level(s.xp)

    if (e.surface === 'terminal') {
      const { Box, Text, Raster, Button } = $.ui.resolve(e)
      const { gauge, hex6 } = hudText()
      const m = s.tab !== 'hud' ? menu(s, s.tab, now) : null
      const cols = Math.max(20, e.props.bodyColumns)
      // the rows around the scene: the header, the limits, the status, the crew, the buttons, an open menu
      const around = 5 + (crew.length > 0 ? 1 : 0) + (m ? m.rows.length + 1 : 0)
      const space = Math.max(5, (e.props.scroll?.bodyRows ?? sceneRows + around) - around)
      // the whole room always fits the body, scaled by any factor (not just whole ones),
      // keeping its proportions: a cell is one pixel across and two down
      const maxW = Math.min(cols, sceneCols), maxH = Math.min(space, sceneRows) * 2
      const fit = Math.min(maxW / W, maxH / H)
      // shrunk below half, the full room turns to mush: the hand drawn small one
      // takes over, one pixel per half block, grown by a whole factor if there is room
      isMini = sceneMode === 'mini' || (sceneMode !== 'hd' && fit < 0.5)
      if (isMini) {
        // the room drawn in characters: one cell per cell, the middle columns
        // when narrow, the top of the wall dropped when short, more wall when tall
        termCols = Math.min(TW, maxW)
        termRows = Math.max(6, Math.min(Math.floor(maxH / 2), TH + 4))
      } else {
        termCols = Math.max(1, Math.round(W * fit))
        termRows = Math.max(1, Math.round((H * fit) / 2))
      }
      const sl = slots(s.limits)
      const press = (fn: () => Promise<void>) => () => { void fn() }
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text color="#d77757" bold>◆ {prettyModel(s.model)}</Text>
            <Text color="#b48cff">LV{lv.lv}</Text>
            <Text color="#ffd34e">{EVO_NAME[stageOf(s.tokens)]!.toLowerCase()} {tokens(s.tokens)}</Text>
            <Text dimColor>ctx</Text>
            <Text color={hex6(levelColor(s.ctx))}>{gauge(s.ctx, 10)}</Text>
            <Text>{s.ctx}%</Text>
          </Box>
          <Raster key="scene" columns={termCols} rows={termRows} cells={terminalFrame(now)} />
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {sl.map(x => (
              <Text>
                <Text dimColor>{x.short.toLowerCase()} </Text>
                <Text color={x.limit ? hex6(levelColor(x.limit.pct)) : undefined}>{gauge(x.limit ? x.limit.pct : null, 6)}</Text>
                <Text> {x.limit ? `${Math.round(x.limit.pct)}% ${slotLeft(x.limit, now)}` : '--'}</Text>
              </Text>
            ))}
          </Box>
          <Text color={hex6(MOOD_COLOR[mood])}>
            ● {LABEL[mood]}{s.tool && (mood === 'work' || mood === 'wait') ? ` · ${s.tool}` : ''}
            <Text dimColor> · ${s.usd.toFixed(2)} · turn {s.turns} · {s.xp} xp</Text>
          </Text>
          {crew.length > 0 && <Text>{crewLine(now, hex6)}</Text>}
          <Text dimColor>{e.props.isFocused ? 'keys below are live · esc: back to the prompt' : 'ctrl+x tab (or a click) to use the keys below · esc to leave'}</Text>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button plain hotkey="p" label="Pet" onPress={press(() => act($, 'pet'))} />
            <Button plain hotkey="s" label="Snack" onPress={press(() => act($, 'snack'))} />
            <Button plain hotkey="d" label="Dance" onPress={press(() => act($, 'dance'))} />
            {crew.length > 0 && <Button plain hotkey="w" label="Wave" onPress={press(() => act($, 'wave'))} />}
            <Button plain hotkey="l" label={s.lights ? 'Lights off' : 'Lights on'} onPress={press(() => act($, 'lights'))} />
            <Button plain hotkey="1" label="Limits" dimColor={s.tab !== 'limits'} onPress={press(() => show($, 'limits'))} />
            <Button plain hotkey="2" label="Tools" dimColor={s.tab !== 'tools'} onPress={press(() => show($, 'tools'))} />
            <Button plain hotkey="3" label="Session" dimColor={s.tab !== 'session'} onPress={press(() => show($, 'session'))} />
          </Box>
          {m && (
            <Box flexDirection="column">
              <Text color="#ffd34e" bold>▶ {m.title}</Text>
              {m.rows.map(r => (
                <Text>
                  <Text dimColor={r.k.startsWith(' ')}>{r.k.toLowerCase().padEnd(13)}</Text>
                  {r.pct !== undefined && <Text color={hex6(r.c && r.c !== HUD_C.dim ? r.c : levelColor(r.pct ?? 0))}>{gauge(r.pct ?? null, 12)} </Text>}
                  <Text color={r.c ? hex6(r.c) : undefined}>{r.v.toLowerCase()}</Text>
                </Text>
              ))}
            </Box>
          )}
        </Box>
      )
    }

    const { Box, Text, Svg, Button } = $.ui.resolve(e)
    const press = (fn: () => Promise<void>) => () => { void fn() }
    const tabs: Array<[Tab, string]> = [['limits', '📊 Limits'], ['tools', '🛠 Tools'], ['session', '🎮 Session']]
    return (
      <Box flexDirection="column" gap={1}>
        {crew.length > 0 && <Text>{crewLine(now, x => `#${x.toString(16).padStart(6, '0')}`)}</Text>}
        {Svg
          ? <Svg source={svgScene(s, now)} alt={`Clawd is ${LABEL[mood]} in the HQ`} />
          : <Text>● Clawd is {LABEL[mood]}</Text>}
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button label="♥ Pet" onPress={press(() => act($, 'pet'))} />
          <Button label="🍪 Snack" onPress={press(() => act($, 'snack'))} />
          <Button label="🕺 Dance" onPress={press(() => act($, 'dance'))} />
          {crew.length > 0 && <Button label="👋 Wave" onPress={press(() => act($, 'wave'))} />}
          <Button label={s.lights ? '🌙 Lights off' : '💡 Lights on'} onPress={press(() => act($, 'lights'))} />
          {tabs.map(([tab, label]) => (
            <Button key={tab} label={label} variant={s.tab === tab ? 'primary' : 'secondary'} onPress={press(() => show($, tab))} />
          ))}
        </Box>
      </Box>
    )
  })
}

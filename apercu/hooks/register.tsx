import type { EngineInterface, Register } from 'claude-code'

// /apercu : ce que Claude construit (site, app mobile, client lourd, jeu), en
// direct dans un panneau du client desktop, VS Code, du téléphone ou du terminal.
//
// Un hub tourne sur la machine de la session (daemon/apercu.py, 127.0.0.1
// seulement) et tient une ou plusieurs « cibles » : Chromium, un appareil
// Android (adb), un simulateur iOS, un écran, ou un adaptateur qui parle le
// protocole Aperçu (PROTOCOLE.md), sur cette machine ou ailleurs. Les cibles
// d'un projet sont décrites dans son .apercu.json, que Claude écrit lui-même en
// intégrant le projet (skill apercu:integrer). Les images remontent par le
// canal du client (Remote Control compris), tes gestes redescendent.
// Claude pilote la même cible avec l'outil `apercu` : chacun voit ce que fait l'autre.
//
// On vise par repères numérotés, comme Vimium, quand la cible sait dire où sont
// ses boutons ; sinon par une grille (A1, B3…) posée sur l'image.

type Hint = { n: number; x: number; y: number; w: number; h: number; label: string; kind: string }
type Log = { at: number; kind: string; text: string }
type CibleInfo = { nom: string; pilote: string; status: string; error: string; url: string }
type Frame = {
  seq: number
  cible?: string
  pilote?: string
  status?: string
  error?: string
  cibles?: CibleInfo[]
  active?: string | null
  actions?: string[]
  url: string
  device: string
  vw: number
  vh: number
  hints: Hint[]
  console: Log[]
  last: { by: string; text: string; at: number } | null
  jpeg?: string
  rgb?: string
  iw?: number
  ih?: number
}

const PANE = 'apercu'
const TICK_MS = 350
const ORANGE = '#d77757'

let port = 7357
let python = 'python3'
let startUrl = 'http://localhost:3000'
let cibles: CibleInfo[] = []
let active: string | null = null
let showGrid = false
const GRID_COLS = 8
let frame: Frame | null = null
let jpeg = ''
let cells: { cells: string; columns: number; rows: number } | null = null
let rasterCols = 80
let surface = 'desktop'
let starting = false
let failure = ''
let isPolling = false
let showHints = true
let attachPath: string | null = null
let consoleSeen = 0

const api = (path: string) => `http://127.0.0.1:${port}${path}`

async function alive($: EngineInterface): Promise<boolean> {
  const r = await $.http.fetch(api('/state')).catch(() => null)
  return Boolean(r?.ok)
}

/** Démarre le navigateur s'il ne tourne pas déjà (une autre session peut l'avoir lancé). */
async function ensureDaemon($: EngineInterface): Promise<boolean> {
  if (await alive($)) return true
  if (!starting) {
    starting = true
    failure = ''
    void (async () => {
      let err = ''
      try {
        const child = $.process.spawn({
          argv: [python, `${$.plugin.root}/daemon/apercu.py`, 'serve', '--port', String(port)],
        })
        for await (const c of child) if (c.stream === 'stderr') err = (err + c.text).slice(-1200)
        const end = await child.result
        failure = /No module named 'playwright'/.test(err)
          ? `Playwright manque pour ${python} : pip install playwright && playwright install chromium (ou règle « python » sur un venv qui l'a).`
          : err.trim().split('\n').slice(-3).join('\n') || `le navigateur s'est arrêté (code ${end.code})`
      } catch (e) {
        failure = `impossible de lancer ${python} : ${String(e)}`
      } finally {
        starting = false
        $.ui.invalidate('ui.render')
      }
    })()
  }
  for (let i = 0; i < 60; i++) {
    await $.clock.sleep(500)
    if (await alive($)) return true
    if (!starting) return false
  }
  return false
}

async function post($: EngineInterface, path: string, body: Record<string, unknown>): Promise<Record<string, any>> {
  const r = await $.http.fetch(api(path), { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
  return JSON.parse(r.text)
}

/** Les cibles du projet : son .apercu.json s'il en a un, sinon un Chromium sur l'URL réglée. */
async function loadProject($: EngineInterface): Promise<string> {
  const root = await $.session.root()
  const path = `${root}/.apercu.json`
  const has = await $.fs.read(path).then(() => true, () => false)
  if (has) {
    const out = await post($, '/config', { chemin: path })
    if (out.ok === false) return `✗ ${path} : ${out.error}`
    cibles = out.cibles
    active = out.active
    return `cibles de ${path} : ${(out.chargees as string[]).join(', ')}`
  }
  const list = await post($, '/cibles', { nom: 'web', pilote: 'web', url: startUrl, appareil: 'desktop' }).catch(() => null)
  if (list) { cibles = list.cibles; active = list.active }
  return `pas de .apercu.json dans ${root} : Chromium sur ${startUrl}`
}

async function act($: EngineInterface, body: Record<string, unknown>): Promise<Frame & { ok?: boolean; error?: string; path?: string }> {
  const r = await $.http.fetch(api('/act'), { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
  const out = JSON.parse(r.text)
  if (!r.ok && body.by !== 'claude') $.ui.toast(`Aperçu : ${out.error ?? r.status}`)
  void tick($, true)
  return out
}

/** Va chercher la dernière capture si elle a changé, et redessine. */
async function tick($: EngineInterface, force = false) {
  if (isPolling && !force) return
  isPolling = true
  try {
    if (!force) {
      const panes = await $.ui.panes()
      if (!panes.some(p => p.id === PANE)) return
    }
    const since = frame && (surface === 'terminal' ? cells : jpeg) ? frame.seq : -1
    const q = surface === 'terminal'
      ? `fmt=rgb&w=${rasterCols}&h=${pixelRows(rasterCols)}`
      : 'fmt=jpeg'
    const r = await $.http.fetch(api(`/frame?since=${since}&${q}`)).catch(() => null)
    if (!r?.ok) return
    const f = JSON.parse(r.text) as Frame
    if (f.cibles) { cibles = f.cibles; active = f.active ?? null }
    if (f.seq < 0) { frame = null; $.ui.invalidate('ui.render'); return }
    if (frame && f.cible !== frame.cible) { jpeg = ''; cells = null }
    const isNew = !frame || f.seq !== frame.seq || f.console.length !== consoleSeen || f.last?.at !== frame.last?.at
    frame = f
    consoleSeen = f.console.length
    if (f.jpeg) jpeg = f.jpeg
    if (f.rgb && f.iw && f.ih) cells = toCells(f.rgb, f.iw, f.ih)
    if (isNew || f.jpeg || f.rgb) $.ui.invalidate('ui.render')
  } finally {
    isPolling = false
  }
}

function pixelRows(cols: number): number {
  const ratio = frame && frame.vw ? frame.vh / frame.vw : 0.625
  return Math.min(80, Math.max(2, Math.round(cols * ratio))) & ~1
}

function toCells(rgbB64: string, w: number, h: number) {
  const bin = atob(rgbB64)
  const rows = Math.ceil(h / 2)
  const words = new Uint32Array(w * rows * 3)
  const px = (x: number, y: number) => {
    const o = (y * w + x) * 3
    return (bin.charCodeAt(o) << 16) | (bin.charCodeAt(o + 1) << 8) | bin.charCodeAt(o + 2)
  }
  let k = 0
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < w; c++) {
      words[k++] = 0x2580
      words[k++] = px(c, 2 * r)
      words[k++] = 2 * r + 1 < h ? px(c, 2 * r + 1) : 0x01000000
    }
  }
  const bytes = new Uint8Array(words.buffer)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return { cells: btoa(s), columns: w, rows }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')

/** La capture et ses repères en un seul SVG (l'image en data URI, les numéros dessinés par-dessus). */
function toSvg(f: Frame): string {
  // le panneau réduit souvent la page : les badges grossissent d'autant pour rester lisibles
  const k = Math.max(1, f.vw / 640)
  const badges = showHints
    ? f.hints.map(h => {
        const label = String(h.n)
        const bw = (8 + label.length * 8) * k
        const bh = 17 * k
        const x = Math.max(0, Math.min(f.vw - bw, h.x - 4 * k))
        const y = Math.max(0, h.y - bh / 2)
        return `<g><title>${esc(`${h.n} · ${h.kind} · ${h.label}`)}</title><rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="${4 * k}" fill="${ORANGE}" stroke="#fff" stroke-width="${1.5 * k}"/>`
          + `<text x="${x + bw / 2}" y="${y + 13 * k}" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="${12 * k}" font-weight="700" fill="#fff">${label}</text></g>`
      }).join('')
    : ''
  const grid = showGrid || f.hints.length === 0 ? gridSvg(f, k) : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f.vw} ${f.vh}" width="${f.vw}" height="${f.vh}">`
    + `<image href="data:image/jpeg;base64,${jpeg}" x="0" y="0" width="${f.vw}" height="${f.vh}" preserveAspectRatio="xMinYMin meet"/>${grid}${badges}</svg>`
}

/** La grille de visée des cibles sans repères (jeux, canvas, écrans) : A1 en haut à gauche. */
function gridRows(f: Frame): number {
  return Math.max(2, Math.min(12, Math.round(GRID_COLS * f.vh / Math.max(1, f.vw))))
}

function gridSvg(f: Frame, k: number): string {
  const rows = gridRows(f)
  const cw = f.vw / GRID_COLS
  const ch = f.vh / rows
  let out = ''
  for (let c = 1; c < GRID_COLS; c++) out += `<line x1="${c * cw}" y1="0" x2="${c * cw}" y2="${f.vh}" stroke="${ORANGE}" stroke-opacity=".45" stroke-width="${k}"/>`
  for (let r = 1; r < rows; r++) out += `<line x1="0" y1="${r * ch}" x2="${f.vw}" y2="${r * ch}" stroke="${ORANGE}" stroke-opacity=".45" stroke-width="${k}"/>`
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const label = `${String.fromCharCode(65 + c)}${r + 1}`
      out += `<text x="${c * cw + 3 * k}" y="${r * ch + 12 * k}" font-family="ui-monospace,Menlo,monospace" font-size="${11 * k}" font-weight="700" fill="#fff" stroke="#000" stroke-width="${0.6 * k}" paint-order="stroke">${label}</text>`
    }
  }
  return out
}

/** « C4 » (ou « C4.7.2 » pour viser un point dans la case, de 0 à 9) en position relative. */
function gridPoint(f: Frame, cell: string): { fx: number; fy: number } | null {
  const m = /^([A-Za-z])(\d{1,2})(?:\.(\d)\.(\d))?$/.exec(cell)
  if (!m) return null
  const rows = gridRows(f)
  const c = (m[1] ?? 'A').toUpperCase().charCodeAt(0) - 65
  const r = Number(m[2]) - 1
  if (c < 0 || c >= GRID_COLS || r < 0 || r >= rows) return null
  const dx = m[3] !== undefined ? (Number(m[3]) + 0.5) / 10 : 0.5
  const dy = m[4] !== undefined ? (Number(m[4]) + 0.5) / 10 : 0.5
  return { fx: (c + dx) / GRID_COLS, fy: (r + dy) / rows }
}

/** Une ligne tapée dans le champ : « 3 » touche le repère 3, « 3 texte » le remplit, une URL l'ouvre, le reste est tapé. */
async function submit($: EngineInterface, raw: string) {
  const v = raw.trim()
  if (!v) return act($, { type: 'key', key: 'Enter' })
  let m = /^(\d+)$/.exec(v)
  if (m) return act($, { type: 'hint', n: Number(m[1]) })
  m = /^(\d+)\s+(.+)$/.exec(v)
  if (m) return act($, { type: 'hint', n: Number(m[1]), text: m[2] })
  const cell = frame && gridPoint(frame, v)
  if (cell) return act($, { type: 'tap', ...cell })
  if (/^(https?:\/\/|localhost\b|127\.|\d+\.\d+\.\d+\.\d+|[\w-]+(\.[\w-]+)+(:\d+)?(\/|$))/i.test(v) && !/\s/.test(v)) {
    return act($, { type: 'goto', url: v })
  }
  return act($, { type: 'type', text: v })
}

async function attach($: EngineInterface) {
  const now = await $.clock.now()
  const path = `/tmp/apercu-${now}.png`
  const r = await act($, { type: 'shot', path })
  if (r.path) {
    attachPath = r.path
    $.ui.toast('Capture jointe à ton prochain message')
    $.ui.invalidate('ui.render')
  }
}

function describe(f: Frame & { path?: string }): string {
  const lines = [`[${f.cible ?? '?'} · ${f.pilote ?? '?'}] ${f.url}  ${f.vw}x${f.vh}${f.status && f.status !== 'prête' ? `  (${f.status} : ${f.error})` : ''}`]
  if (f.path) lines.push(`capture pleine résolution : ${f.path} (lis-la avec Read pour voir l'écran)`)
  if (f.hints.length) for (const h of f.hints) lines.push(`  ${String(h.n).padStart(2)} ${h.kind.padEnd(6)} ${h.label}`)
  else lines.push('  pas de repères : vise par position relative (action tap, fx/fy de 0 à 1), après une capture (shot) pour voir où.')
  const errs = f.console.filter(c => c.kind !== 'warning' && c.kind !== 'info').slice(-8)
  if (errs.length) lines.push('console et journal :', ...errs.map(c => `  ! ${c.kind}: ${c.text.slice(0, 300)}`))
  const others = (f.cibles ?? []).filter(c => c.nom !== f.cible)
  if (others.length) lines.push(`autres cibles : ${others.map(c => `${c.nom} (${c.pilote}, ${c.status})`).join(', ')}`)
  return lines.join('\n')
}

function listing(out: Record<string, any>): string {
  if (out.ok === false) return `Échec : ${out.error}`
  const rows = (out.cibles as CibleInfo[]).map(c => `${c.nom === out.active ? '*' : ' '} ${c.nom} · ${c.pilote} · ${c.status}${c.error ? ` : ${c.error}` : ''}`)
  return [out.config ? `config : ${out.config}` : 'pas de .apercu.json chargé', ...rows].join('\n') || 'aucune cible'
}

async function choose($: EngineInterface, nom: string) {
  const out = await post($, '/active', { nom })
  if (out.ok === false) { $.ui.toast(`Aperçu : ${out.error}`); return }
  active = out.active
  frame = null
  jpeg = ''
  cells = null
  void tick($, true)
}

const TOOL_DESCRIPTION = [
  'Voit et pilote ce que l\'utilisateur regarde en direct dans le panneau Aperçu (desktop, mobile en Remote Control ou terminal) : le site, l\'app mobile, le client lourd ou le jeu du projet.',
  'Chaque projet décrit ses « cibles » dans .apercu.json à sa racine : web (Chromium, ou un Chromium/Electron existant par cdp), adb (Android), ios (simulateur), ecran (un écran ou une zone), pont (un adaptateur qui parle le protocole Aperçu, sur cette machine ou une autre).',
  'S\'il n\'y en a pas encore, ou si l\'utilisateur demande l\'aperçu d\'un projet qui n\'est pas un site local : intègre-le d\'abord en suivant la skill apercu:integrer (détecter le type de projet, choisir le pilote, écrire un adaptateur si besoin, monter le pont réseau, écrire .apercu.json, puis action "config").',
  'Actions : cibles, config (recharge .apercu.json), choisir, state, touch (repère n, avec text pour remplir), tap (fx, fy de 0 à 1), type, key, scroll, back, home, goto/reload/device (web), launch (adb, ios), shot (capture PNG à lire avec Read).',
  'L\'utilisateur agit sur la même cible entre deux appels : relis l\'état avant d\'enchaîner.',
].join(' ')

export const register: Register = (on, options) => {
  port = Number(options.port) || 7357
  python = String(options.python ?? '').trim() || 'python3'
  startUrl = String(options.url ?? '').trim() || startUrl

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'apercu', description: 'Le site, l\'app ou le jeu du projet, en direct dans un panneau (navigable)' })
    await $.tool.register({
      name: 'apercu',
      description: TOOL_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['cibles', 'config', 'choisir', 'state', 'goto', 'touch', 'tap', 'type', 'key', 'scroll', 'back', 'forward', 'reload', 'home', 'launch', 'device', 'shot'] },
          cible: { type: 'string', description: 'la cible visée (l\'active par défaut) ; pour choisir : celle qui devient active' },
          chemin: { type: 'string', description: 'pour config : le .apercu.json (celui de la racine du projet par défaut)' },
          url: { type: 'string', description: 'pour goto (web, ios : URL), launch (paquet Android ou bundle iOS)' },
          n: { type: 'number', description: 'pour touch : le numéro du repère' },
          text: { type: 'string', description: 'pour type, ou pour touch (remplit le champ touché)' },
          fx: { type: 'number', description: 'pour tap : position horizontale relative, 0 à 1' },
          fy: { type: 'number', description: 'pour tap : position verticale relative, 0 à 1' },
          key: { type: 'string', description: 'pour key : Enter, Tab, Escape, Backspace, ArrowDown…' },
          dy: { type: 'number', description: 'pour scroll : pixels, négatif vers le haut (500 par défaut)' },
          device: { type: 'string', enum: ['mobile', 'tablette', 'desktop'] },
          full: { type: 'boolean', description: 'pour shot (web) : toute la page et pas seulement l\'écran' },
        },
        required: ['action'],
      },
    })
    $.clock.every(TICK_MS, () => void tick($))
    return next(e)
  })

  on('command.run', { command: 'apercu' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: 'Aperçu', focus: true })
    void (async () => {
      if (!(await ensureDaemon($))) return
      const arg = e.args?.trim() ?? ''
      const note = await loadProject($)
      if (!arg) $.ui.toast(note)
      else if (cibles.some(c => c.nom === arg)) await choose($, arg)
      else await act($, { type: 'goto', url: arg })
      await tick($, true)
    })()
    return { text: 'Aperçu ouvert dans un panneau.' }
  })

  on('tool.call', { tool: 'mcp__apercu__apercu' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const text = (t: string, isError = false) => ({ result: { content: [{ type: 'text' as const, text: t }], isError } })
    if (!(await ensureDaemon($))) return text(`Hub indisponible : ${failure || 'il ne démarre pas'}`, true)
    const a = String(input.action)
    const cible = input.cible ? String(input.cible) : undefined
    if (a === 'cibles') return text(listing(JSON.parse((await $.http.fetch(api('/cibles'))).text)))
    if (a === 'config') {
      if (input.chemin) {
        const out = await post($, '/config', { chemin: String(input.chemin) })
        return text(listing(out), out.ok === false)
      }
      return text(`${await loadProject($)}\n${listing(JSON.parse((await $.http.fetch(api('/cibles'))).text))}`)
    }
    if (a === 'choisir') {
      const out = await post($, '/active', { nom: cible })
      if (out.ok !== false) await choose($, String(cible))
      return text(listing(out), out.ok === false)
    }
    let out: Frame & { ok?: boolean; error?: string; path?: string }
    if (a === 'state') {
      const r = await $.http.fetch(api(`/state${cible ? `?cible=${encodeURIComponent(cible)}` : ''}`))
      out = JSON.parse(r.text)
      if ((out as any).seq === -1) return text('Aucune cible. Intègre le projet (skill apercu:integrer) ou action "config".')
    } else {
      const body: Record<string, unknown> = { by: 'claude', type: a === 'touch' ? 'hint' : a, cible }
      for (const k of ['url', 'n', 'text', 'fx', 'fy', 'key', 'dy', 'full']) if (input[k] !== undefined) body[k] = input[k]
      if (a === 'device') body.name = input.device
      if (a === 'shot') body.path = `/tmp/apercu-${await $.clock.now()}.png`
      out = await act($, body)
    }
    return out.ok === false ? text(`Échec : ${out.error}`, true) : text(describe(out))
  })

  // la capture jointe part avec le prochain message
  on('prompt.submit', async ($, e, next) => {
    if (!attachPath) return next(e)
    const note = `L'utilisateur a joint une capture de l'aperçu (${frame?.cible ?? ''}, ${frame?.url ?? ''}) : ${attachPath}. Lis-la avec Read pour voir ce qu'il voit.`
    attachPath = null
    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    surface = e.surface
    const { Box, Text, Button } = $.ui.resolve(e)
    rasterCols = Math.max(20, Math.min(160, e.props.bodyColumns - 1))

    const tabs = cibles.length > 1
      ? <Box flexWrap="wrap">{cibles.map(c => (
          <Button key={`c-${c.nom}`} label={`${c.status === 'prête' ? '' : c.status === 'en panne' ? '✗ ' : '⏳ '}${c.nom}`}
            variant={c.nom === active ? 'primary' : undefined} onPress={() => choose($, c.nom)} />
        ))}</Box>
      : null

    if (!frame) {
      const down = cibles.find(c => c.nom === active && c.status !== 'prête')
      return (
        <Box flexDirection="column">
          {tabs}
          <Text dimColor>{failure ? `✗ ${failure}` : starting ? '⏳ Démarrage du hub…' : down ? `${down.status === 'en panne' ? '✗' : '⏳'} ${down.nom} : ${down.error || down.status}` : cibles.length ? 'En attente d\'une image…' : 'Aucune cible. Demande à Claude de brancher l\'aperçu sur ce projet.'}</Text>
          {failure && <Button key="retry" label="Réessayer" variant="primary" onPress={() => ensureDaemon($).then(() => tick($, true))} />}
        </Box>
      )
    }
    const f = frame
    const last = f.last && f.last.by === 'claude' ? `🤖 Claude : ${f.last.text}` : f.last ? `👆 ${f.last.text}` : ''
    const errors = f.console.filter(c => c.kind !== 'warning' && c.kind !== 'info').slice(-3)
    const can = (x: string) => !f.actions || f.actions.includes(x)

    let view = <Text dimColor>⏳ capture…</Text>
    if (e.surface === 'terminal' && cells) {
      const { Raster } = $.ui.resolve(e)
      view = <Raster key="view" columns={cells.columns} rows={cells.rows} cells={cells.cells} />
    } else if (e.surface !== 'terminal' && jpeg) {
      const { Svg } = $.ui.resolve(e)
      view = <Svg source={toSvg(f)} alt={`Aperçu de ${f.url}`} isInteractive />
    }

    const controls = [
      can('back') && <Button key="back" label="◀" hotkey="b" onPress={() => act($, { type: 'back' })} />,
      can('home') && <Button key="home" label="⌂" hotkey="o" onPress={() => act($, { type: 'home' })} />,
      can('reload') && <Button key="reload" label="↻" hotkey="r" onPress={() => act($, { type: 'reload' })} />,
      <Button key="up" label="⬆" hotkey="u" onPress={() => act($, { type: 'scroll', dy: -500 })} />,
      <Button key="down" label="⬇" hotkey="d" onPress={() => act($, { type: 'scroll', dy: 500 })} />,
      <Button key="enter" label="⏎" hotkey="e" onPress={() => act($, { type: 'key', key: 'Enter' })} />,
      can('device') && f.pilote === 'web' && f.device !== 'cdp' && <Button key="device" label={f.device === 'desktop' ? '📱 mobile' : '🖥 desktop'} hotkey="m" onPress={() => act($, { type: 'device', name: f.device === 'desktop' ? 'mobile' : 'desktop' })} />,
      f.hints.length > 0 && <Button key="hints" label={showHints ? 'repères ✓' : 'repères'} hotkey="h" onPress={() => { showHints = !showHints; $.ui.invalidate('ui.render') }} />,
      f.hints.length > 0 && <Button key="grid" label={showGrid ? 'grille ✓' : 'grille'} hotkey="g" onPress={() => { showGrid = !showGrid; $.ui.invalidate('ui.render') }} />,
      <Button key="attach" label={attachPath ? '📎 jointe' : '📎 joindre'} hotkey="j" variant="primary" onPress={() => attach($)} />,
    ].filter(Boolean)
    const gridOn = showGrid || f.hints.length === 0

    return (
      <Box flexDirection="column">
        {tabs}
        <Text><Text bold>{f.url}</Text><Text dimColor>  {f.pilote} {f.vw}×{f.vh}</Text></Text>
        {last ? <Text color={f.last?.by === 'claude' ? 'magenta' : 'gray'}>{last}</Text> : null}
        {view}
        {e.surface === 'terminal' && f.hints.length > 0 && (
          <Text dimColor wrap="wrap">{f.hints.map(h => `${h.n} ${h.label}`).join(' · ')}</Text>
        )}
        {e.surface === 'terminal' && gridOn && (
          <Text dimColor>grille {GRID_COLS}×{gridRows(f)} : A1 en haut à gauche, {String.fromCharCode(64 + GRID_COLS)}{gridRows(f)} en bas à droite</Text>
        )}
        {errors.map((c, i) => <Text key={`err-${i}`} color="red" wrap="truncate-end">! {c.kind} : {c.text}</Text>)}
        <Box flexWrap="wrap">{controls}</Box>
        {e.surface === 'mobile'
          ? <Box flexWrap="wrap">{f.hints.slice(0, 16).map(h => <Button key={`h-${h.n}`} label={`${h.n} ${h.label.slice(0, 16)}`} onPress={() => act($, { type: 'hint', n: h.n })} />)}</Box>
          : (() => {
              const { Input } = $.ui.resolve(e)
              const help = f.hints.length ? 'n° pour toucher · n° + texte pour remplir' : 'case (C4) pour toucher'
              return <Input key="cmd" placeholder={`${help} · ${f.pilote === 'web' ? 'une URL · ' : ''}du texte à taper`} submitLabel="OK" onSubmit={v => void submit($, v)} />
            })()}
      </Box>
    )
  })
}

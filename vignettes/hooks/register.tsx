import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Shot } from '../types'
import { decodePng, resize, toCells } from './png'
import type { Rgba } from './png'

// Le client desktop affiche les images que Claude lit ou partage ; le terminal
// n'en montre que le nom. Ce mod les dessine en miniature sous la ligne de
// l'outil (demi-blocs colorés, ou vraies images sur kitty / Ghostty), et les
// garde dans une galerie /voir, lisible aussi depuis le téléphone en Remote Control.
//
// PNG décodé ici même ; JPEG, WebP, GIF, HEIC passent par le premier outil
// trouvé sur la machine (ImageMagick, ffmpeg, sips sur macOS, Pillow).

type Src = { key: string; label: string; path?: string; b64?: string; mime?: string }
type Pic = { rgba: Rgba; png?: string; w: number; h: number }

const PANE = 'vignettes'
const IMG = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif)$/i
const MAX_JS_PX = 4_000_000
const EXT_SIZE = 320
const MAX_SHOTS = 60

const shots = atom({ plugin: 'vignettes', key: 'shots' } as const, [])
const pos = atom({ plugin: 'vignettes', key: 'pos' } as const, 0)

// tout ce qui pèse reste dans le module (perdu au rechargement, refait depuis le chemin)
const srcs = new Map<string, Src>()
const pending = new Set<string>()
const pics = new Map<string, Pic | null>()
const cellCache = new Map<string, { cells: string; columns: number; rows: number }>()
const inputs = new Map<string, Record<string, unknown>>()

let cwd = ''
let isKitty = false
let maxCols = 40
let maxRows = 12

// réduit une image venue d'un outil externe en PNG non entrelacé, écrit en base64
const SCRIPT = `
in="$1"; size="$2"; t="\${TMPDIR:-/tmp}/vignette-$$"
if [ "$in" = "-" ]; then base64 -d > "$t.in" 2>/dev/null || exit 3; in="$t.in"; fi
ok=
if command -v magick >/dev/null 2>&1; then magick "$in[0]" -auto-orient -thumbnail "\${size}x\${size}" -strip -interlace none "PNG32:$t.png" 2>/dev/null && ok=1; fi
if [ -z "$ok" ] && command -v convert >/dev/null 2>&1; then convert "$in[0]" -auto-orient -thumbnail "\${size}x\${size}" -strip -interlace none "PNG32:$t.png" 2>/dev/null && ok=1; fi
if [ -z "$ok" ] && command -v ffmpeg >/dev/null 2>&1; then ffmpeg -v error -y -i "$in" -frames:v 1 -vf "scale=\${size}:\${size}:force_original_aspect_ratio=decrease" "$t.png" 2>/dev/null && ok=1; fi
if [ -z "$ok" ] && command -v sips >/dev/null 2>&1; then sips -s format png -Z "$size" "$in" --out "$t.png" >/dev/null 2>&1 && ok=1; fi
if [ -z "$ok" ] && command -v python3 >/dev/null 2>&1; then python3 -c 'import sys
from PIL import Image
im = Image.open(sys.argv[1]); im.thumbnail((int(sys.argv[3]),) * 2); im.convert("RGBA").save(sys.argv[2])' "$in" "$t.png" "$size" 2>/dev/null && ok=1; fi
[ -n "$ok" ] && base64 < "$t.png" | tr -d '\\n'
rm -f "$t.png" "$t.in"
[ -n "$ok" ]
`

function fromB64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function pngPixels(b: Uint8Array): number {
  const w = ((b[16]! << 24) | (b[17]! << 16) | (b[18]! << 8) | b[19]!) >>> 0
  const h = ((b[20]! << 24) | (b[21]! << 16) | (b[22]! << 8) | b[23]!) >>> 0
  return w * h
}

const base = (p: string) => p.split('/').pop() || p
const abs = (p: string) => (p.startsWith('/') || !cwd ? p : `${cwd}/${p}`)

/** Les images d'un appel d'outil, d'après son entrée et son résultat. */
function sourcesOf(tool: string, id: string, input: Record<string, unknown> | undefined, output: unknown): Src[] {
  const out = output as any
  if (tool === 'SendUserFile') {
    const atts: any[] = Array.isArray(out?.attachments) ? out.attachments : []
    const paths = atts.length
      ? atts.filter(a => a?.isImage || IMG.test(String(a?.path))).map(a => String(a.path))
      : (Array.isArray(input?.files) ? (input!.files as unknown[]).map(String) : []).filter(p => IMG.test(p))
    return paths.map(p => ({ key: abs(p), label: base(p), path: abs(p) }))
  }
  if (tool === 'Read') {
    if (out?.type !== 'image') return []
    const path = typeof input?.file_path === 'string' ? input.file_path : undefined
    return [{ key: path ?? id, label: path ? base(path) : 'image lue', path, b64: out.file?.base64, mime: out.file?.type }]
  }
  if (!tool.startsWith('mcp__')) return []
  // captures d'écran et autres images rendues par un serveur MCP
  const found: Src[] = []
  const walk = (v: unknown, depth: number) => {
    if (!v || typeof v !== 'object' || depth > 4 || found.length >= 4) return
    if (Array.isArray(v)) return v.forEach(x => walk(x, depth + 1))
    const o = v as Record<string, any>
    const data = o.type === 'image' ? (typeof o.data === 'string' ? o.data : o.source?.data) : undefined
    if (typeof data === 'string' && data.length > 100) {
      found.push({ key: `${id}#${found.length}`, label: tool.replace(/^mcp__/, '').replace(/__/g, ' '), b64: data, mime: o.mimeType ?? o.source?.media_type })
      return
    }
    Object.values(o).forEach(x => walk(x, depth + 1))
  }
  walk(output, 0)
  return found
}

async function external($: EngineInterface, src: Src): Promise<Pic | null> {
  const argv = ['sh', '-c', SCRIPT, 'vignette', src.path ?? '-', String(EXT_SIZE)]
  const r = await $.process.run(argv, { stdin: src.path ? undefined : src.b64, timeoutMs: 30_000 }).catch(() => null)
  if (!r || r.exitCode !== 0 || !r.stdout.trim()) return null
  const png = r.stdout.trim()
  try {
    const rgba = decodePng(fromB64(png))
    return { rgba, png, w: rgba.width, h: rgba.height }
  } catch {
    return null
  }
}

async function load($: EngineInterface, src: Src): Promise<Pic | null> {
  let png: string | undefined
  if (src.b64 && src.mime === 'image/png') png = src.b64
  else if (src.path && /\.png$/i.test(src.path)) {
    png = await $.fs.read(src.path, { as: 'bytes' }).then(r => r.base64).catch(() => undefined)
  }
  if (png) {
    const bytes = fromB64(png)
    if (pngPixels(bytes) <= MAX_JS_PX) {
      try {
        const rgba = decodePng(bytes)
        return { rgba, png, w: rgba.width, h: rgba.height }
      } catch {
        // entrelacé ou exotique : l'outil externe le réécrit
      }
    }
  }
  return (await external($, src)) ?? (src.path && src.b64 ? external($, { ...src, path: undefined }) : null)
}

function ensure($: EngineInterface, src: Src) {
  srcs.set(src.key, src)
  if (pics.has(src.key) || pending.has(src.key)) return
  pending.add(src.key)
  void load($, src)
    .catch(() => null)
    .then(pic => {
      pics.set(src.key, pic)
      pending.delete(src.key)
      $.ui.invalidate('ui.render')
    })
}

/** La grille de demi-blocs d'une image, à la taille qui tient dans maxW × maxH cellules. */
function cellsFor(key: string, pic: Pic, maxW: number, maxH: number) {
  const id = `${key}@${maxW}x${maxH}`
  const hit = cellCache.get(id)
  if (hit) return hit
  const s = Math.min(maxW / pic.w, (maxH * 2) / pic.h, 8)
  const pw = Math.max(1, Math.round(pic.w * s))
  const ph = Math.max(2, Math.round(pic.h * s))
  const px = resize(pic.rgba, pw, ph)
  const out = { cells: toCells(px, pw, ph), columns: pw, rows: Math.ceil(ph / 2) }
  if (cellCache.size > 200) cellCache.clear()
  cellCache.set(id, out)
  return out
}

/** Pour le desktop et le mobile : l'image en SVG, une rangée de rectangles par couleur. */
function toSvg(pic: Pic, maxW: number, maxH: number): string {
  const s = Math.min(maxW / pic.w, maxH / pic.h, 1)
  const w = Math.max(1, Math.round(pic.w * s))
  const h = Math.max(1, Math.round(pic.h * s))
  const px = resize(pic.rgba, w, h, 0xffffff)
  const paths = new Map<number, string>()
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w;) {
      // couleurs ramenées à 4 bits par canal : les plages d'une même teinte se regroupent
      const c = px[y * w + x]! & 0xf0f0f0
      let n = 1
      while (x + n < w && (px[y * w + x + n]! & 0xf0f0f0) === c) n++
      paths.set(c, (paths.get(c) ?? '') + `M${x} ${y}h${n}v1h-${n}z`)
      x += n
    }
  }
  const body = [...paths].map(([c, d]) => `<path fill="#${(c | 0x080808).toString(16).padStart(6, '0')}" d="${d}"/>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">${body}</svg>`
}

async function remember($: EngineInterface, tool: string, found: Src[]) {
  if (found.length === 0) return
  const now = await $.clock.now()
  await update($, shots, prev => {
    const keep = prev.filter(s => !found.some(f => f.key === s.key))
    return [...keep, ...found.map(f => ({ key: f.key, label: f.label, tool, at: now }))].slice(-MAX_SHOTS)
  })
  const list = await read($, shots)
  await update($, pos, () => list.length - 1)
}

async function step($: EngineInterface, d: number) {
  const list = await read($, shots)
  await update($, pos, p => Math.max(0, Math.min(list.length - 1, p + d)))
}

export const register: Register = (on, options) => {
  maxCols = Math.max(8, Math.min(120, Number(options.largeur) || 40))
  maxRows = Math.max(3, Math.min(60, Number(options.hauteur) || 12))

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    const term = `${(await $.env.get('TERM_PROGRAM')) ?? ''} ${(await $.env.get('TERM')) ?? ''}`
    const inTmux = Boolean(await $.env.get('TMUX'))
    isKitty = options.pixels === 'kitty' || (options.pixels !== 'blocs' && !inTmux && /kitty|ghostty|wezterm/i.test(term))
    await $.command.register({ name: 'voir', description: 'Galerie des images lues ou partagées dans cette session' })
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (!('result' in r) || r.isError) return r
    const input = e as unknown as Record<string, unknown>
    const found = sourcesOf(e.tool, e.tool_use_id, input, r.result)
    if (found.length) {
      inputs.set(e.tool_use_id, input)
      found.forEach(src => ensure($, src))
      void remember($, e.tool, found)
    }
    return r
  })

  on('command.run', { command: 'voir' }, async $ => {
    const list = await read($, shots)
    await $.ui.open({ id: PANE, title: 'Images', focus: true, closeOnEscape: true })
    return { text: list.length ? `${list.length} image(s) dans la galerie.` : 'Aucune image vue pour l\'instant dans cette session.' }
  })

  // la miniature sous la ligne de l'outil, dans le terminal seulement : ailleurs le client montre déjà l'image
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isErrored) return next(e)
    const found = sourcesOf(e.props.tool, e.props.tool_use_id, inputs.get(e.props.tool_use_id), e.props.output)
    if (found.length === 0) return next(e)
    const own = await next(e)
    found.forEach(src => ensure($, src))
    const { Box, Text, Raster, Image } = $.ui.resolve(e)
    const width = Math.min(maxCols, Math.max(8, (e.viewport?.columns ?? 80) - 6))
    return (
      <Box flexDirection="column">
        {own}
        <Box flexDirection="row" marginLeft={2}>
          {found.map((src, i) => {
            const pic = pics.get(src.key)
            if (pic === undefined) return <Text key={`w${i}`} dimColor>⏳ {src.label}  </Text>
            if (pic === null) return <Text key={`x${i}`} dimColor>({src.label} : pas de décodeur pour ce format, installe ImageMagick ou ffmpeg)  </Text>
            const c = cellsFor(src.key, pic, width, maxRows)
            const source = src.path && /\.png$/i.test(src.path) ? { file: src.path, format: 'png' as const } : pic.png ? { png: pic.png } : undefined
            return (
              <Box key={`t${i}`} flexDirection="column" marginRight={2}>
                {isKitty && source
                  ? <Image key={`i${i}`} source={source} columns={c.columns} rows={c.rows} alt={src.label} />
                  : <Raster key={`r${i}`} columns={c.columns} rows={c.rows} cells={c.cells} />}
                <Text dimColor>{src.label}</Text>
              </Box>
            )
          })}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const list = await read($, shots)
    const at = Math.max(0, Math.min(list.length - 1, await read($, pos)))
    const { Box, Text, Button } = $.ui.resolve(e)
    if (list.length === 0) {
      return <Text dimColor>Aucune image pour l'instant. Celles que Claude lit ou partage arriveront ici.</Text>
    }
    const shot = list[at]!
    const src = srcs.get(shot.key) ?? { key: shot.key, label: shot.label, path: shot.key.startsWith('/') ? shot.key : undefined }
    ensure($, src)
    const pic = pics.get(shot.key)
    const cols = Math.max(10, e.props.bodyColumns - 2)

    let view = <Text dimColor>⏳ chargement…</Text>
    if (pic === null) view = <Text dimColor>Image illisible ici (format non décodé, ou plus en mémoire depuis le rechargement).</Text>
    else if (pic && e.surface === 'terminal') {
      const { Raster, Image } = $.ui.resolve(e)
      const c = cellsFor(shot.key, pic, Math.min(cols, 120), 30)
      const source = src.path && /\.png$/i.test(src.path) ? { file: src.path, format: 'png' as const } : pic.png ? { png: pic.png } : undefined
      view = isKitty && source
        ? <Image key="big-i" source={source} columns={c.columns} rows={c.rows} alt={shot.label} />
        : <Raster key="big" columns={c.columns} rows={c.rows} cells={c.cells} />
    } else if (pic && e.surface !== 'terminal') {
      const { Svg } = $.ui.resolve(e)
      const pxW = Math.min(cols * 8, 640)
      view = <Svg source={toSvg(pic, 200, 150)} alt={shot.label} width={pxW} height={Math.round((pxW * pic.h) / pic.w)} />
    }

    return (
      <Box flexDirection="column">
        <Text bold>{shot.label} <Text dimColor>({at + 1}/{list.length}{pic ? `, ${pic.w}×${pic.h} px` : ''}, via {shot.tool})</Text></Text>
        {view}
        <Box>
          <Button key="prev" label="◀ Précédente" hotkey="p" onPress={() => step($, -1)} />
          <Button key="next" label="Suivante ▶" hotkey="n" variant="primary" onPress={() => step($, 1)} />
          {src.path && <Button key="copy" label="Copier le chemin" hotkey="c" onPress={() => $.ui.copy({ text: src.path! })} />}
        </Box>
      </Box>
    )
  })
}

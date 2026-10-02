// Décodeur PNG minimal en pur JavaScript (le module d'un mod n'a ni Node ni
// WebAssembly) : inflate (RFC 1951) + défiltrage + mise à l'échelle.
// Les PNG entrelacés (Adam7) sont refusés : l'appelant passe alors par un
// outil externe qui réécrit une vignette non entrelacée.

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

type Tree = { counts: Uint16Array; symbols: Uint16Array }

function build(lengths: Uint8Array, off: number, n: number): Tree {
  const counts = new Uint16Array(16)
  const symbols = new Uint16Array(n)
  for (let i = 0; i < n; i++) counts[lengths[off + i]!]!++
  counts[0] = 0
  const offs = new Uint16Array(16)
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1]! + counts[i - 1]!
  for (let i = 0; i < n; i++) {
    const len = lengths[off + i]!
    if (len) symbols[offs[len]!++] = i
  }
  return { counts, symbols }
}

const FIXED = (() => {
  const l = new Uint8Array(288 + 30)
  for (let i = 0; i < 144; i++) l[i] = 8
  for (let i = 144; i < 256; i++) l[i] = 9
  for (let i = 256; i < 280; i++) l[i] = 7
  for (let i = 280; i < 288; i++) l[i] = 8
  for (let i = 288; i < 318; i++) l[i] = 5
  return { lit: build(l, 0, 288), dist: build(l, 288, 30) }
})()

/** Décompresse un flux deflate brut dans `out` (taille connue d'avance). */
export function inflate(src: Uint8Array, out: Uint8Array): number {
  let p = 0
  let buf = 0
  let cnt = 0
  let o = 0
  const bits = (n: number) => {
    while (cnt < n) {
      if (p >= src.length) throw new Error('deflate tronqué')
      buf |= src[p++]! << cnt
      cnt += 8
    }
    const v = buf & ((1 << n) - 1)
    buf >>>= n
    cnt -= n
    return v
  }
  const decode = (t: Tree) => {
    let code = 0, first = 0, index = 0
    for (let len = 1; len < 16; len++) {
      code |= bits(1)
      const count = t.counts[len]!
      if (code - count < first) return t.symbols[index + (code - first)]!
      index += count
      first += count
      first <<= 1
      code <<= 1
    }
    throw new Error('code deflate invalide')
  }

  let isFinal = 0
  do {
    isFinal = bits(1)
    const type = bits(2)
    if (type === 0) {
      buf = 0
      cnt = 0
      const len = src[p]! | (src[p + 1]! << 8)
      p += 4
      out.set(src.subarray(p, p + len), o)
      p += len
      o += len
      continue
    }
    let lit = FIXED.lit
    let dist = FIXED.dist
    if (type === 2) {
      const hlit = bits(5) + 257
      const hdist = bits(5) + 1
      const hclen = bits(4) + 4
      const cl = new Uint8Array(19)
      for (let i = 0; i < hclen; i++) cl[CLORDER[i]!] = bits(3)
      const ct = build(cl, 0, 19)
      const ll = new Uint8Array(hlit + hdist)
      for (let i = 0; i < hlit + hdist;) {
        const sym = decode(ct)
        if (sym < 16) ll[i++] = sym
        else {
          let rep = 0
          let val = 0
          if (sym === 16) { val = ll[i - 1]!; rep = 3 + bits(2) }
          else if (sym === 17) rep = 3 + bits(3)
          else rep = 11 + bits(7)
          while (rep--) ll[i++] = val
        }
      }
      lit = build(ll, 0, hlit)
      dist = build(ll, hlit, hdist)
    } else if (type !== 1) throw new Error('bloc deflate invalide')

    for (;;) {
      let sym = decode(lit)
      if (sym < 256) { out[o++] = sym; continue }
      if (sym === 256) break
      sym -= 257
      const len = LBASE[sym]! + bits(LEXT[sym]!)
      const ds = decode(dist)
      const d = DBASE[ds]! + bits(DEXT[ds]!)
      for (let i = 0; i < len; i++, o++) out[o] = out[o - d]!
    }
  } while (!isFinal)
  return o
}

export type Rgba = { width: number; height: number; data: Uint8Array }

const u32 = (d: Uint8Array, i: number) => ((d[i]! << 24) | (d[i + 1]! << 16) | (d[i + 2]! << 8) | d[i + 3]!) >>> 0

/** Lit un PNG non entrelacé, toutes profondeurs et types de couleur, en RGBA 8 bits. */
export function decodePng(file: Uint8Array): Rgba {
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10]
  if (!SIG.every((v, i) => file[i] === v)) throw new Error('pas un PNG')
  let w = 0, h = 0, depth = 0, ctype = 0, interlace = 0
  let palette: Uint8Array | null = null
  let trns: Uint8Array | null = null
  const idat: Uint8Array[] = []
  for (let i = 8; i < file.length;) {
    const len = u32(file, i)
    const type = String.fromCharCode(file[i + 4]!, file[i + 5]!, file[i + 6]!, file[i + 7]!)
    const data = file.subarray(i + 8, i + 8 + len)
    if (type === 'IHDR') {
      w = u32(data, 0); h = u32(data, 4); depth = data[8]!; ctype = data[9]!; interlace = data[12]!
    } else if (type === 'PLTE') palette = data
    else if (type === 'tRNS') trns = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    i += 12 + len
  }
  if (interlace) throw new Error('PNG entrelacé')
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[ctype]
  if (!channels || !w || !h) throw new Error('PNG non pris en charge')

  const total = idat.reduce((n, c) => n + c.length, 0)
  const z = new Uint8Array(total)
  let k = 0
  for (const c of idat) { z.set(c, k); k += c.length }

  const bitsPP = channels * depth
  const rowBytes = Math.ceil((w * bitsPP) / 8)
  const bpp = Math.max(1, bitsPP >> 3)
  const raw = new Uint8Array(h * (rowBytes + 1))
  inflate(z.subarray(2), raw)

  // défiltrage, en place, ligne par ligne
  const px = new Uint8Array(h * rowBytes)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (rowBytes + 1)]!
    const src = y * (rowBytes + 1) + 1
    const cur = y * rowBytes
    const prev = cur - rowBytes
    for (let x = 0; x < rowBytes; x++) {
      const r = raw[src + x]!
      const a = x >= bpp ? px[cur + x - bpp]! : 0
      const b = y > 0 ? px[prev + x]! : 0
      const c = x >= bpp && y > 0 ? px[prev + x - bpp]! : 0
      let v = r
      if (f === 1) v = r + a
      else if (f === 2) v = r + b
      else if (f === 3) v = r + ((a + b) >> 1)
      else if (f === 4) {
        const pp = a + b - c
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c)
        v = r + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
      }
      px[cur + x] = v & 255
    }
  }

  const out = new Uint8Array(w * h * 4)
  const sample = (row: number, i: number): number => {
    if (depth === 8) return px[row + i]!
    if (depth === 16) return px[row + i * 2]!
    const perByte = 8 / depth
    const byte = px[row + Math.floor(i / perByte)]!
    const shift = 8 - depth * ((i % perByte) + 1)
    return (byte >> shift) & ((1 << depth) - 1)
  }
  const scale = depth < 8 ? 255 / ((1 << depth) - 1) : 1
  for (let y = 0; y < h; y++) {
    const row = y * rowBytes
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      if (ctype === 3) {
        const idx = sample(row, x)
        out[o] = palette?.[idx * 3] ?? 0
        out[o + 1] = palette?.[idx * 3 + 1] ?? 0
        out[o + 2] = palette?.[idx * 3 + 2] ?? 0
        out[o + 3] = trns && idx < trns.length ? trns[idx]! : 255
      } else if (ctype === 0 || ctype === 4) {
        const g = Math.round(sample(row, x * channels) * scale)
        out[o] = out[o + 1] = out[o + 2] = g
        out[o + 3] = ctype === 4 ? sample(row, x * 2 + 1) : 255
      } else {
        out[o] = sample(row, x * channels)
        out[o + 1] = sample(row, x * channels + 1)
        out[o + 2] = sample(row, x * channels + 2)
        out[o + 3] = ctype === 6 ? sample(row, x * 4 + 3) : 255
      }
    }
  }
  return { width: w, height: h, data: out }
}

/** Réduit l'image à tw × th par moyenne (au plus 4 × 4 points par pixel), alpha mélangé sur `bg`. */
export function resize(img: Rgba, tw: number, th: number, bg = 0x1e1e1e): Uint32Array {
  const out = new Uint32Array(tw * th)
  const br = (bg >> 16) & 255, bgG = (bg >> 8) & 255, bb = bg & 255
  for (let ty = 0; ty < th; ty++) {
    const y0 = (ty * img.height) / th, y1 = ((ty + 1) * img.height) / th
    for (let tx = 0; tx < tw; tx++) {
      const x0 = (tx * img.width) / tw, x1 = ((tx + 1) * img.width) / tw
      let r = 0, g = 0, b = 0, n = 0
      const sy = Math.max(1, Math.min(4, Math.round(y1 - y0)))
      const sx = Math.max(1, Math.min(4, Math.round(x1 - x0)))
      for (let j = 0; j < sy; j++) {
        const y = Math.min(img.height - 1, Math.floor(y0 + ((j + 0.5) * (y1 - y0)) / sy))
        for (let i = 0; i < sx; i++) {
          const x = Math.min(img.width - 1, Math.floor(x0 + ((i + 0.5) * (x1 - x0)) / sx))
          const o = (y * img.width + x) * 4
          const a = img.data[o + 3]! / 255
          r += img.data[o]! * a + br * (1 - a)
          g += img.data[o + 1]! * a + bgG * (1 - a)
          b += img.data[o + 2]! * a + bb * (1 - a)
          n++
        }
      }
      out[ty * tw + tx] = (Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(b / n)
    }
  }
  return out
}

/** Demi-blocs « ▀ » : deux pixels par cellule, base64 des triplets du Raster. */
export function toCells(px: Uint32Array, w: number, h: number): string {
  const rows = Math.ceil(h / 2)
  const words = new Uint32Array(w * rows * 3)
  let k = 0
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < w; c++) {
      words[k++] = 0x2580
      words[k++] = px[2 * r * w + c]!
      words[k++] = 2 * r + 1 < h ? px[(2 * r + 1) * w + c]! : 0x01000000
    }
  }
  const bytes = new Uint8Array(words.buffer)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

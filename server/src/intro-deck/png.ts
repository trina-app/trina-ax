// A small PNG reader and writer for the intro deck's logos (docs/DECISIONS.md "D2"): a transparent logo that does not
// read on a ground is drawn in one colour (its alpha kept), which the PowerPoint file and the PDF need as a picture of
// its own (the preview uses a CSS mask). Also the logo's pixels for its treatment, where no ffmpeg is installed (hosted
// Linux has none). Non-interlaced PNGs of 8 or 16 bits per channel, every colour type; anything else is not read
// (null), and the logo then sits on a light card instead.
import zlib from 'node:zlib'
import { crc32 } from '../files/zip-write'

export interface Rgba { width: number; height: number; data: Uint8Array }

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const MAX_PIXELS = 25_000_000

export function decodePng(b: Uint8Array): Rgba | null {
  try {
    if (b.length < 33 || SIG.some((v, i) => b[i] !== v)) return null
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
    let at = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0
    let palette: Uint8Array | null = null, trns: Uint8Array | null = null
    const idat: Uint8Array[] = []
    while (at + 8 <= b.length) {
      const len = dv.getUint32(at), kind = String.fromCharCode(b[at + 4]!, b[at + 5]!, b[at + 6]!, b[at + 7]!)
      const body = b.subarray(at + 8, at + 8 + len)
      if (kind === 'IHDR') { width = dv.getUint32(at + 8); height = dv.getUint32(at + 12); depth = b[at + 16]!; type = b[at + 17]!; interlace = b[at + 20]! }
      else if (kind === 'PLTE') palette = body
      else if (kind === 'tRNS') trns = body
      else if (kind === 'IDAT') idat.push(body)
      else if (kind === 'IEND') break
      at += 12 + len
    }
    if (!width || !height || width * height > MAX_PIXELS || interlace || (depth !== 8 && depth !== 16 && !(type === 3 && depth <= 8))) return null
    const chans = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type]
    if (!chans) return null
    const bitsPP = chans * depth
    const bpp = Math.max(1, bitsPP >> 3)
    const stride = Math.ceil((width * bitsPP) / 8)
    const raw = zlib.inflateSync(Buffer.concat(idat.map((x) => Buffer.from(x))))
    if (raw.length < (stride + 1) * height) return null
    const cur = new Uint8Array(stride), prev = new Uint8Array(stride)
    const out = new Uint8Array(width * height * 4)
    for (let y = 0; y < height; y++) {
      const f = raw[y * (stride + 1)]!
      const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp]! : 0, up = prev[i]!, c = i >= bpp ? prev[i - bpp]! : 0
        let v = row[i]!
        if (f === 1) v += a
        else if (f === 2) v += up
        else if (f === 3) v += (a + up) >> 1
        else if (f === 4) { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c }
        cur[i] = v & 255
      }
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4
        const s = (k: number) => (depth === 16 ? cur[(x * chans + k) * 2]! : cur[x * chans + k]!)
        if (type === 3) {
          const bits = depth, perByte = 8 / bits
          const byte = cur[Math.floor(x / perByte)]!
          const idx = bits === 8 ? byte : (byte >> (8 - bits * ((x % perByte) + 1))) & ((1 << bits) - 1)
          out[o] = palette?.[idx * 3] ?? 0; out[o + 1] = palette?.[idx * 3 + 1] ?? 0; out[o + 2] = palette?.[idx * 3 + 2] ?? 0
          out[o + 3] = trns && idx < trns.length ? trns[idx]! : 255
        } else if (type === 0 || type === 4) {
          const g = s(0)
          out[o] = out[o + 1] = out[o + 2] = g
          out[o + 3] = type === 4 ? s(1) : 255
        } else {
          out[o] = s(0); out[o + 1] = s(1); out[o + 2] = s(2)
          out[o + 3] = type === 6 ? s(3) : 255
        }
      }
      prev.set(cur)
    }
    return { width, height, data: out }
  } catch { return null }
}

function chunk(kind: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(kind, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(kind, 'ascii'), Buffer.from(body)])), 0)
  return Buffer.concat([head, Buffer.from(body), crc])
}

export function encodePng(img: Rgba): Uint8Array {
  const { width, height, data } = img
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([Buffer.from(SIG), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array(0))])
}

/** The picture in one colour, its alpha kept (null: not a PNG this reader reads). */
export function recolorPng(bytes: Uint8Array, hex: string): Uint8Array | null {
  const img = decodePng(bytes)
  if (!img) return null
  const n = Number.parseInt(hex.slice(1, 7), 16)
  const r = (n >> 16) & 255, g = (n >> 8) & 255, bl = n & 255
  const alpha = hex.length === 9 ? Number.parseInt(hex.slice(7), 16) / 255 : 1
  const d = img.data
  for (let i = 0; i < d.length; i += 4) { d[i] = r; d[i + 1] = g; d[i + 2] = bl; d[i + 3] = Math.round(d[i + 3]! * alpha) }
  return encodePng(img)
}

/** `size` × `size` point-sampled RGBA (as the website reading samples a logo), for the logo's treatment. */
export function sampleRgba(img: Rgba, size = 64): Uint8Array {
  const out = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sx = Math.min(img.width - 1, Math.floor(((x + 0.5) * img.width) / size)), sy = Math.min(img.height - 1, Math.floor(((y + 0.5) * img.height) / size))
    out.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (y * size + x) * 4)
  }
  return out
}

/** A PNG cut out from its background: most of its edge is transparent (a product shot, a screen mock-up). Shown whole,
 * never cropped, on the slide's own ground. */
export function isCutout(bytes: Uint8Array): boolean {
  if (!(bytes[0] === 0x89 && bytes[1] === 0x50)) return false
  const img = decodePng(bytes)
  if (!img) return false
  const { width: w, height: h, data } = img
  let edge = 0, clear = 0
  const look = (x: number, y: number) => { edge++; if (data[(y * w + x) * 4 + 3]! < 200) clear++ }
  const step = Math.max(1, Math.floor(Math.max(w, h) / 400))
  for (let x = 0; x < w; x += step) { look(x, 0); look(x, h - 1) }
  for (let y = 0; y < h; y += step) { look(0, y); look(w - 1, y) }
  return edge > 0 && clear / edge >= 0.5
}

/** A gradient as a small PNG with alpha, for the PowerPoint file: Apple's renderer (Quick Look, the Mac and iPhone
 * preview of an attachment) draws a gradFill's transparent stops as opaque, so a scrim over a photo would hide the
 * photo; a picture with alpha shows the same everywhere. `dir`: where the first stop is (up: the first stop at the
 * bottom; radial: at the centre, the last at the ellipse's edge). Stretched to its rectangle by the viewer. */
export function gradientPng(stops: { at: number; color: string }[], dir: 'up' | 'down' | 'right' | 'left' | 'radial'): Uint8Array {
  const s = [...stops].sort((a, b) => a.at - b.at)
  const rgba = (hex: string) => { const n = Number.parseInt(hex.slice(1, 7), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, hex.length === 9 ? Number.parseInt(hex.slice(7), 16) : 255] }
  const at = (t: number): number[] => {
    if (t <= s[0]!.at) return rgba(s[0]!.color)
    for (let i = 1; i < s.length; i++) {
      if (t <= s[i]!.at) {
        const a = rgba(s[i - 1]!.color), b = rgba(s[i]!.color), k = (t - s[i - 1]!.at) / Math.max(1e-6, s[i]!.at - s[i - 1]!.at)
        return a.map((v, j) => Math.round(v + (b[j]! - v) * k))
      }
    }
    return rgba(s[s.length - 1]!.color)
  }
  const N = 256
  const [w, h] = dir === 'radial' ? [N, N] : dir === 'up' || dir === 'down' ? [2, N] : [N, 2]
  const data = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const t = dir === 'radial' ? Math.min(1, Math.hypot((x + 0.5) / w - 0.5, (y + 0.5) / h - 0.5) * 2)
      : dir === 'down' ? y / (h - 1) : dir === 'up' ? 1 - y / (h - 1) : dir === 'right' ? x / (w - 1) : 1 - x / (w - 1)
    data.set(at(t), (y * w + x) * 4)
  }
  return encodePng({ width: w, height: h, data })
}

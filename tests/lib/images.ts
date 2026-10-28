// Small images for the team logo tests (shared/src/team-icon.ts): a real PNG a browser draws, and JPEG / WebP files
// whose headers carry a size (the server reads only the header, it never decodes an image).
import zlib from 'node:zlib'

const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(b: Uint8Array): number {
  let c = 0xffffffff
  for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** A w × h PNG: a coloured square with a white diamond in the middle (easy to tell from the default mark). */
export function makePng(w = 64, h = 64, rgb: [number, number, number] = [37, 99, 235]): Uint8Array<ArrayBuffer> {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3
      const inside = Math.abs(x - w / 2) / w + Math.abs(y - h / 2) / h < 0.28
      raw[o] = inside ? 255 : rgb[0]
      raw[o + 1] = inside ? 255 : rgb[1]
      raw[o + 2] = inside ? 255 : rgb[2]
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // RGB
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
}

/** A JPEG header: SOI, a JFIF APP0 segment, an EXIF-like APP1 segment, then a baseline frame header with the size. */
export function makeJpeg(w = 64, h = 64, sof = 0xc0): Uint8Array<ArrayBuffer> {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]
  const app1 = [0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00]
  const frame = [0xff, sof, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]
  return new Uint8Array([0xff, 0xd8, ...app0, ...app1, 0xff, 0xff, ...frame, 0xff, 0xd9, ...new Array(32).fill(0)])
}

const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))

/** A WebP header of each kind: VP8X (extended), VP8 (lossy) or VP8L (lossless), with the size. */
export function makeWebp(w = 64, h = 64, kind: 'VP8X' | 'VP8 ' | 'VP8L' = 'VP8X'): Uint8Array<ArrayBuffer> {
  let chunk: number[]
  if (kind === 'VP8X') chunk = [...ascii('VP8X'), ...le32(10), 0, 0, 0, 0, (w - 1) & 0xff, ((w - 1) >> 8) & 0xff, ((w - 1) >> 16) & 0xff, (h - 1) & 0xff, ((h - 1) >> 8) & 0xff, ((h - 1) >> 16) & 0xff]
  else if (kind === 'VP8 ') chunk = [...ascii('VP8 '), ...le32(10), 0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, w & 0xff, (w >> 8) & 0x3f, h & 0xff, (h >> 8) & 0x3f]
  else {
    const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14)
    chunk = [...ascii('VP8L'), ...le32(5), 0x2f, ...le32(bits)]
  }
  const body = [...ascii('WEBP'), ...chunk, ...new Array(16).fill(0)]
  return new Uint8Array([...ascii('RIFF'), ...le32(body.length), ...body])
}

export const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><script>alert(1)</script><rect width="64" height="64"/></svg>')

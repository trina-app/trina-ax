// Image dimensions from the first bytes (PNG, JPEG, GIF, WebP) without running a decoder, and thumbnails made by an
// isolated ffmpeg (tools/isolate.ts). No ffmpeg: no thumbnail (the endpoint falls back to small originals).
import fs from 'node:fs'
import path from 'node:path'
import { which } from '../config'
import { makeWorkDir, runIsolated } from '../tools/isolate'
import { exifOrientation } from './metadata'

export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const n = b.byteLength
  // PNG: signature + IHDR
  if (n >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return ok(v.getUint32(16), v.getUint32(20))
  // GIF87a / GIF89a
  if (n >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return ok(v.getUint16(6, true), v.getUint16(8, true))
  // WebP: RIFF....WEBP VP8 / VP8L / VP8X
  if (n >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const fourcc = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!)
    if (fourcc === 'VP8 ') return ok(v.getUint16(26, true) & 0x3fff, v.getUint16(28, true) & 0x3fff)
    if (fourcc === 'VP8L') { const bits = v.getUint32(21, true); return ok((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1) }
    if (fourcc === 'VP8X') return ok(1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)))
  }
  // JPEG: walk the segments to a SOFn marker
  if (n >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < n) {
      if (b[i] !== 0xff) { i++; continue }
      const m = b[i + 1]!
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue }
      const len = v.getUint16(i + 2)
      if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) return ok(v.getUint16(i + 7), v.getUint16(i + 5))
      i += 2 + len
    }
  }
  return null
}
const ok = (width: number, height: number) => (width > 0 && height > 0 && width < 100_000 && height < 100_000 ? { width, height } : null)

/** The size a picture is shown at: imageSize with its EXIF orientation applied (5–8 turn it a quarter, so width and
 * height swap). A phone's portrait photo is often stored landscape with orientation 6; browsers, ffmpeg's thumbnail and
 * the preview all show it upright, so a box made from the stored size would crop it. */
export function displaySize(b: Uint8Array): { width: number; height: number } | null {
  const s = imageSize(b)
  if (!s) return null
  return exifOrientation(b) >= 5 ? { width: s.height, height: s.width } : s
}

/** Can this picture have see-through pixels, by its first bytes? A PNG with an alpha channel (colour type 4 or 6) or
 * a tRNS chunk (a palette's or one colour's transparency), a WebP with the alpha flag (VP8X) or a lossless one with
 * alpha (VP8L), any GIF (its transparent colour). A PNG whose chunks before the picture run past `b`: yes (ffmpeg's
 * look at the pixels decides). JPEG, HEIC, BMP, TIFF and anything else: no. */
export function mayHaveAlpha(b: Uint8Array): boolean {
  const n = b.byteLength
  if (n >= 26 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    if (b[25] === 4 || b[25] === 6) return true
    for (let i = 8; ;) {
      if (i + 8 > n) return true
      const name = String.fromCharCode(b[i + 4]!, b[i + 5]!, b[i + 6]!, b[i + 7]!)
      if (name === 'tRNS') return true
      if (name === 'IDAT' || name === 'IEND') return false
      i += 12 + new DataView(b.buffer, b.byteOffset + i, 4).getUint32(0)
    }
  }
  if (n >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return true // GIF8
  if (n >= 25 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const fourcc = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!)
    if (fourcc === 'VP8X') return (b[20]! & 0x10) !== 0
    if (fourcc === 'VP8L') return (b[24]! & 0x10) !== 0 // alpha_is_used, bit 28 of the 32 bits after the signature
  }
  return false
}

/** The first `n` bytes of a file (fewer when it is shorter). */
export function firstBytes(p: string, n = 64 * 1024): Buffer {
  const b = Buffer.alloc(n)
  const fd = fs.openSync(p, 'r')
  try { return b.subarray(0, fs.readSync(fd, b, 0, n, 0)) } finally { fs.closeSync(fd) }
}

/** a thumbnail at most (320 px JPEG at -q:v 5 is a few tens of KB; a 640 px RGBA PNG is 1.6 MB before compression) */
const THUMB_MAX_BYTES = 4 * 1024 * 1024
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export type ThumbExt = 'jpg' | 'png'
export interface ThumbOptions {
  /** make only a PNG one: a picture without see-through pixels gets none (null), an older JPEG one stays */
  transparentOnly?: boolean
  /** below interactive work (tools/isolate.ts background); stopped with `signal` */
  background?: boolean
  signal?: AbortSignal
}

/** Make a thumbnail (longest side `max`) of `src`: `<dstBase>.jpg`, or `<dstBase>.png` when the picture has pixels you
 * can see through (a JPEG has no transparency: a transparent PNG's background turned black in one, a red seal stamp
 * on a black square). Returns which one was written, or null when no converter is available or it failed. A picture
 * that can have transparency (mayHaveAlpha) is looked at first: its alpha at the thumbnail's size, one byte a pixel,
 * from a first ffmpeg run; any byte under 255 makes it a PNG. When that look fails the JPEG one is made, as before.
 * The file is written under a temporary name and renamed, so a reader never gets half of it. */
export async function makeThumbnail(src: string, dstBase: string, max = 320, workBase?: string, ffmpeg = which('ffmpeg'), o: ThumbOptions = {}): Promise<ThumbExt | null> {
  if (!ffmpeg) return null
  const alphaPossible = mayHaveAlpha(firstBytes(src))
  if (o.transparentOnly && !alphaPossible) return null
  const work = makeWorkDir(workBase)
  try {
    const input = path.join(work, 'in' + path.extname(src).toLowerCase().replace(/[^.a-z0-9]/g, ''))
    fs.copyFileSync(src, input)
    const scale = `scale='min(${max},iw)':'min(${max},ih)':force_original_aspect_ratio=decrease`
    // every picture comes on stdout, never as a file in the work folder: a converter taken over by the image could
    // leave a link to another file there, and the server would copy that file as the thumbnail (tools/isolate.ts
    // readOutput)
    const run = (vf: string, out: string[], maxStdout: number) => runIsolated({
      cmd: ffmpeg, workDir: work, timeoutMs: 20_000, maxStdout, background: o.background, signal: o.signal,
      args: ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', path.basename(input), '-frames:v', '1', '-vf', vf, ...out, 'pipe:1'],
    })
    let png = false
    if (alphaPossible) {
      const a = await run(`${scale},format=rgba,alphaextract`, ['-f', 'rawvideo', '-pix_fmt', 'gray'], max * max + 1)
      png = a.code === 0 && a.stdout.length > 0 && a.stdout.some((x) => x < 255)
    }
    if (o.transparentOnly && !png) return null
    // scaled premultiplied: straight alpha would blend the colour of see-through pixels (black) into the edges, a
    // dark outline round a red stamp
    const r = png
      ? await run(`format=rgba,premultiply=inplace=1,${scale},unpremultiply=inplace=1,format=rgba`, ['-f', 'image2pipe', '-c:v', 'png'], THUMB_MAX_BYTES)
      : await run(scale, ['-q:v', '5', '-f', 'image2pipe', '-c:v', 'mjpeg'], THUMB_MAX_BYTES)
    const b = r.stdout
    const ok = png ? b.length > 8 && PNG_SIG.every((x, i) => b[i] === x) : b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
    if (r.code !== 0 || !ok) return null
    const ext: ThumbExt = png ? 'png' : 'jpg'
    const dst = `${dstBase}.${ext}`
    const tmp = `${dst}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`
    fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 })
    try {
      fs.writeFileSync(tmp, b, { mode: 0o600 })
      fs.chmodSync(tmp, 0o600)
      fs.renameSync(tmp, dst)
    } finally { fs.rmSync(tmp, { force: true }) }
    return ext
  } finally { fs.rmSync(work, { recursive: true, force: true }) }
}

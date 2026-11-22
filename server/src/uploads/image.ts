// Image dimensions from the first bytes (PNG, JPEG, GIF, WebP) without running a decoder, and thumbnails made by an
// isolated ffmpeg (tools/isolate.ts). No ffmpeg: no thumbnail (the endpoint falls back to small originals).
import fs from 'node:fs'
import path from 'node:path'
import { nativeBinDir, which } from '../config'
import { heicRefusal, heicToJpeg, heicTools, isHeic, PREVIEW_INPUT_MAX } from '../files/heic-preview'
import { CONVERT_RSS_MIB, imageSlot } from '../files/vision'
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

/** A picture's format by its first bytes (never its name), as people name it, or null. */
export function imageFormat(b: Uint8Array): 'PNG' | 'JPEG' | 'GIF' | 'WebP' | 'HEIC' | null {
  if (b.byteLength >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'PNG'
  if (b.byteLength >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'JPEG'
  if (b.byteLength >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'GIF'
  if (b.byteLength >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'WebP'
  if (looksHeic(b)) return 'HEIC'
  return null
}

/** How see-through a picture is: `background` (its four corners are see-through: a seal or logo on nothing), `some`
 * (some pixels, not the corners), `opaque` (it has an alpha channel and the look found nothing see-through: said as "the
 * background is not see-through", since one see-through pixel in a big picture averages away), `none` (it cannot have
 * see-through pixels: JPEG, a PNG without alpha or tRNS); null when it could not be looked at. */
export type SeeThrough = 'background' | 'some' | 'opaque' | 'none'
/** the side of the alpha sample: small, and its corners are the picture's corners */
const ALPHA_SAMPLE = 32
/** pictures larger than this are not looked at (the normalizer refuses them for the model anyway; ffmpeg decodes the
 * whole picture: 12000 x 12000 took 667 MB) */
const ALPHA_LOOK_MAX_PIXELS = 50_000_000

/**
 * Whether a picture has see-through pixels, and where: a picture that cannot have them (mayHaveAlpha) is `none` without
 * a look; one that can is shrunk to 32 x 32 by an isolated ffmpeg (its alpha only, one byte a pixel, as makeThumbnail
 * looks), in the image conversion slots and under the converters' memory cap, and its corners decide. The AI's own
 * picture of an image is drawn on white (mycel-safeops vision), so without this it cannot tell a transparent seal from
 * a white one (AI scenario VIEW-05, 2026-11-17). null: no ffmpeg, too large, a format ffmpeg could not read, or one
 * this does not know (a HEIC can carry an alpha picture too, rarely: not looked at).
 */
export async function seeThrough(bytes: Uint8Array, o: { ffmpeg?: string | null; workBase?: string; signal?: AbortSignal } = {}): Promise<SeeThrough | null> {
  const format = imageFormat(bytes)
  if (!format || format === 'HEIC') return null
  if (!mayHaveAlpha(bytes.subarray(0, 64 * 1024))) return 'none'
  const size = imageSize(bytes)
  if (!size || size.width * size.height > ALPHA_LOOK_MAX_PIXELS) return null
  const ffmpeg = o.ffmpeg === undefined ? which('ffmpeg') : o.ffmpeg
  if (!ffmpeg) return null
  return imageSlot(async () => {
    const work = makeWorkDir(o.workBase)
    try {
      const input = path.join(work, `in.${format.toLowerCase()}`)
      fs.writeFileSync(input, bytes, { mode: 0o600 })
      const n = ALPHA_SAMPLE
      const r = await runIsolated({
        cmd: ffmpeg, workDir: work, timeoutMs: 20_000, maxRssMiB: CONVERT_RSS_MIB, maxStdout: n * n + 1, signal: o.signal,
        args: ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', path.basename(input), '-frames:v', '1', '-vf', `scale=${n}:${n}:flags=area,format=rgba,alphaextract`, '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
      })
      const a = r.stdout
      if (r.code !== 0 || a.length !== n * n) return null
      // a corner counts as see-through when it is mostly so (the shrink averages the edge of a seal into it, and a
      // picture half see-through everywhere has a half see-through background)
      const corners = [a[0]!, a[n - 1]!, a[n * (n - 1)]!, a[n * n - 1]!]
      if (corners.every((x) => x < 192)) return 'background'
      return a.some((x) => x < 255) ? 'some' : 'opaque'
    } finally { fs.rmSync(work, { recursive: true, force: true }) }
  }, o.signal)
}

/** One line on a picture for the AI: its format, its size as shown (EXIF orientation applied) and how see-through it
 * is, each part only when known; '' when nothing is. `L`-free: the AI says it in the person's words. */
export function imageFactsLine(bytes: Uint8Array, see: SeeThrough | null): string {
  const format = imageFormat(bytes)
  const size = format === 'HEIC' ? null : displaySize(bytes)
  const parts = [format, size ? `${size.width} × ${size.height} pixels` : null].filter(Boolean)
  const alpha = see === 'background' ? 'see-through background (shown white in your picture of it)'
    : see === 'some' ? 'some see-through parts, not the background (shown white in your picture of it)'
      : see === 'opaque' ? 'the background is not see-through'
        : see === 'none' ? 'no see-through parts' : null
  if (alpha) parts.push(alpha)
  return parts.length ? `Read from the file itself: ${parts.join(', ')}. Say these as facts when asked.` : ''
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
  /** the converter's memory cap (tools/isolate.ts maxRssMiB); none: the isolate's default */
  maxRssMiB?: number
}

/** ffmpeg's reader for a picture, chosen by its first bytes (never its name or a probe): a file named .png that is
 * something else is read as a PNG and fails, it never reaches another demuxer (a playlist, a concat list, a URL).
 * null: a format this does not know (TIFF, SVG...): ffmpeg probes it, with only local files allowed. */
function demuxerOf(b: Uint8Array): string | null {
  const f = imageFormat(b)
  if (f === 'PNG') return 'png_pipe'
  if (f === 'JPEG') return 'jpeg_pipe'
  if (f === 'GIF') return 'gif'
  if (f === 'WebP') return 'webp_pipe'
  if (b.byteLength >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp_pipe'
  return null
}

/** Make a thumbnail (longest side `max`) of `src`: `<dstBase>.jpg`, or `<dstBase>.png` when the picture has pixels you
 * can see through (a JPEG has no transparency: a transparent PNG's background turned black in one, a red seal stamp
 * on a black square). Returns which one was written, or null when no converter is available or it failed. A picture
 * that can have transparency (mayHaveAlpha) is looked at first: its alpha at the thumbnail's size, one byte a pixel,
 * from a first ffmpeg run; any byte under 255 makes it a PNG. When that look fails the JPEG one is made, as before.
 * The file is written under a temporary name and renamed, so a reader never gets half of it. */
export async function makeThumbnail(src: string, dstBase: string, max = 320, workBase?: string, ffmpeg = which('ffmpeg'), o: ThumbOptions = {}): Promise<ThumbExt | null> {
  // room and chat files are stored without their name: a HEIC is known by its first bytes too
  if (isHeic(src) || looksHeic(firstBytes(src))) return o.transparentOnly ? null : heicThumbnail(src, dstBase, max, o)
  if (!ffmpeg) return null
  const head = firstBytes(src)
  const alphaPossible = mayHaveAlpha(head)
  if (o.transparentOnly && !alphaPossible) return null
  const demuxer = demuxerOf(head)
  const work = makeWorkDir(workBase)
  try {
    const input = path.join(work, 'in' + path.extname(src).toLowerCase().replace(/[^.a-z0-9]/g, ''))
    fs.copyFileSync(src, input)
    const scale = `scale='min(${max},iw)':'min(${max},ih)':force_original_aspect_ratio=decrease`
    // every picture comes on stdout, never as a file in the work folder: a converter taken over by the image could
    // leave a link to another file there, and the server would copy that file as the thumbnail (tools/isolate.ts
    // readOutput)
    const run = (vf: string, out: string[], maxStdout: number) => runIsolated({
      cmd: ffmpeg, workDir: work, timeoutMs: 20_000, maxStdout, background: o.background, signal: o.signal, ...(o.maxRssMiB ? { maxRssMiB: o.maxRssMiB } : {}),
      args: ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file', ...(demuxer ? ['-f', demuxer] : []), '-i', path.basename(input), '-frames:v', '1', '-vf', vf, ...out, 'pipe:1'],
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
    writeThumb(dstBase, ext, b)
    return ext
  } finally { fs.rmSync(work, { recursive: true, force: true }) }
}

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'])
/** a HEIF still image by its file-type box (major brand) */
export const looksHeic = (b: Uint8Array): boolean => b.length >= 12 && Buffer.from(b.subarray(4, 8)).toString('latin1') === 'ftyp' && HEIC_BRANDS.has(Buffer.from(b.subarray(8, 12)).toString('latin1'))

function writeThumb(dstBase: string, ext: ThumbExt, b: Uint8Array) {
  const dst = `${dstBase}.${ext}`
  const tmp = `${dst}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`
  fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 })
  try {
    fs.writeFileSync(tmp, b, { mode: 0o600 })
    fs.chmodSync(tmp, 0o600)
    fs.renameSync(tmp, dst)
  } finally { fs.rmSync(tmp, { force: true }) }
}

/**
 * An iPhone photo (HEIC / HEIF): browsers other than Safari cannot draw it, and ffmpeg decodes only the first tile of
 * a phone HEIC. Decoded like the file panel preview (files/heic-preview.ts: the declared size checked first, then
 * heif-dec or macOS ImageIO, isolated), then made small by the Go helper (`mycel-safeops resize`: upright pixels, no
 * photo details, JPEG), in the image conversion slots (files/vision.ts: a few at a time, so twenty photos in one chat
 * do not start twenty decoders). null: no decoder or helper here, or a too large photo; a damaged one throws (the
 * callers keep no thumbnail either way, and the chip shows the picture icon).
 */
async function heicThumbnail(src: string, dstBase: string, max: number, o: ThumbOptions): Promise<ThumbExt | null> {
  const st = fs.statSync(src)
  if (st.size > PREVIEW_INPUT_MAX) return null
  const bytes = fs.readFileSync(src)
  if (heicRefusal(bytes)) return null
  const helper = path.join(nativeBinDir(), 'mycel-safeops')
  if (!fs.existsSync(helper)) return null
  const decoded = await imageSlot(() => heicToJpeg(bytes, heicTools(), o.signal, { maxPx: max }), o.signal)
  if (!decoded) return null
  // details none (2) + JPEG (4) + upright (16)
  const r = await imageSlot(() => runIsolated({
    cmd: helper, args: ['resize', String(max), '0', '0', '0', '22'], stdin: decoded, timeoutMs: 30_000, maxRssMiB: 1536,
    maxStdout: THUMB_MAX_BYTES, background: o.background, signal: o.signal, env: { GOMAXPROCS: '2', GOMEMLIMIT: '800MiB' },
  }), o.signal)
  const b = r.stdout
  if (r.code !== 0 || !(b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)) return null
  writeThumb(dstBase, 'jpg', b)
  return 'jpg'
}

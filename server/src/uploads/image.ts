// Image dimensions from the first bytes (PNG, JPEG, GIF, WebP) without running a decoder, and thumbnails made by an
// isolated ffmpeg (tools/isolate.ts). No ffmpeg: no thumbnail (the endpoint falls back to small originals).
import fs from 'node:fs'
import path from 'node:path'
import { which } from '../config'
import { makeWorkDir, runIsolated } from '../tools/isolate'

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

/** Make a JPEG thumbnail (longest side `max`) of `src` into `dst`. Returns false when no converter is available. */
export async function makeThumbnail(src: string, dst: string, max = 320, workBase?: string): Promise<boolean> {
  const ffmpeg = which('ffmpeg')
  if (!ffmpeg) return false
  const work = makeWorkDir(workBase)
  try {
    const input = path.join(work, 'in' + path.extname(src).toLowerCase().replace(/[^.a-z0-9]/g, ''))
    fs.copyFileSync(src, input)
    const r = await runIsolated({
      cmd: ffmpeg, workDir: work, timeoutMs: 20_000,
      args: ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', path.basename(input), '-frames:v', '1', '-vf', `scale='min(${max},iw)':'min(${max},ih)':force_original_aspect_ratio=decrease`, '-q:v', '5', 'thumb.jpg'],
    })
    const out = path.join(work, 'thumb.jpg')
    if (r.code !== 0 || !fs.existsSync(out)) return false
    fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 })
    fs.copyFileSync(out, dst)
    fs.chmodSync(dst, 0o600)
    return true
  } finally { fs.rmSync(work, { recursive: true, force: true }) }
}

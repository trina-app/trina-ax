// Preview images of HEIC / HEIF photos (QA R2-FMT-10). Browsers other than Safari cannot draw HEIC, so the file panel
// asks the server for a JPEG copy (GET /api/files/preview).
//
// Converters, in this order. Each one runs isolated (tools/isolate.ts), like the other converters:
// 1. libheif's heif-dec (heif-convert in libheif < 1.17): the Linux server image has it (libheif-examples); on a Mac
//    it comes from Homebrew libheif. It joins the tiles of a phone photo and applies the rotation in the file.
// 2. macOS only: mycel-ocr --jpeg <max px> (native/ocr, Apple ImageIO). It reads stdin and writes a JPEG to stdout.
// Not used: sips (it writes to the per-user temp folder, which the sandbox does not allow) and ffmpeg (its CLI
// decodes only the first 512x512 tile of a tiled phone HEIC; measured with ffmpeg 7.1 and 8.0).
// No converter: the caller gets null and the web shows the "cannot preview" panel.
//
// Limits: input at most PREVIEW_INPUT_MAX bytes, output at most PREVIEW_OUTPUT_MAX bytes, a time limit and a memory
// limit per run, at most PREVIEW_RUNS_MAX runs at the same time. Results are cached under <dataDir>/previewcache by
// the sha256 of the file content (so the cache cannot show a file to somebody who cannot read it: the caller must
// have the same bytes first), at most PREVIEW_CACHE_MAX bytes (the oldest go first).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { which, ocrBin } from '../config'
import { ToolError } from '../policy/errors'
import { openChecked } from '../team-files/place'
import { makeWorkDir, runIsolated } from '../tools/isolate'
import { ext } from './extract'

export const HEIC_EXT: ReadonlySet<string> = new Set(['heic', 'heif'])
export const isHeic = (name: string) => HEIC_EXT.has(ext(name))

/** largest HEIC file the server converts (phone photos are 1-10 MB) */
export const PREVIEW_INPUT_MAX = 50 * 1024 * 1024
/** largest JPEG the server sends (the web image preview limit, web/src/lib/preview.ts) */
export const PREVIEW_OUTPUT_MAX = 20 * 1024 * 1024
/** longest side of the macOS JPEG (heif-dec keeps the full size) */
export const PREVIEW_MAX_PX = 4096
export const PREVIEW_TIMEOUT_MS = 30_000
const PREVIEW_RSS_MIB = 1536
const PREVIEW_RUNS_MAX = 2
export const PREVIEW_CACHE_MAX = 200 * 1024 * 1024
/** changes when the converter output changes, so old cache files are not used */
const CACHE_VERSION = 'v1'

export interface HeicTools {
  /** heif-dec or heif-convert */
  heifDec: string | null
  /** mycel-ocr with the --jpeg mode (macOS only) */
  imageIo: string | null
}

export function heicTools(): HeicTools {
  return {
    heifDec: which('heif-dec') ?? which('heif-convert'),
    imageIo: process.platform === 'darwin' ? ocrBin() : null,
  }
}

const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff

/**
 * A JPEG of the primary image of a HEIC / HEIF file. null: no converter on this machine. Throws ToolError when every
 * converter failed (a damaged file, a time or memory limit).
 */
export async function heicToJpeg(bytes: Uint8Array, tools: HeicTools, signal?: AbortSignal): Promise<Buffer | null> {
  if (!tools.heifDec && !tools.imageIo) return null
  let why = ''
  if (tools.heifDec) {
    const r = await viaHeifDec(tools.heifDec, bytes, signal)
    if (Buffer.isBuffer(r)) return r
    why = r
  }
  if (tools.imageIo) {
    const r = await viaImageIo(tools.imageIo, bytes, signal)
    if (Buffer.isBuffer(r)) return r
    why = r
  }
  signal?.throwIfAborted()
  throw new ToolError(`could not make a preview of the photo (${why})`)
}

async function viaHeifDec(bin: string, bytes: Uint8Array, signal?: AbortSignal): Promise<Buffer | string> {
  const work = makeWorkDir()
  try {
    fs.writeFileSync(path.join(work, 'in.heic'), bytes, { mode: 0o600 })
    // heif-convert (libheif < 1.17) does not know --quiet / --codec-threads
    const modern = path.basename(bin) === 'heif-dec'
    const r = await runIsolated({
      cmd: bin, workDir: work, timeoutMs: PREVIEW_TIMEOUT_MS, maxRssMiB: PREVIEW_RSS_MIB, maxStdout: 1024 * 1024, signal,
      args: [...(modern ? ['--quiet', '--codec-threads', '1'] : []), '-q', '85', 'in.heic', 'out.jpg'],
    })
    if (r.killed) return `heif-dec: ${r.killed}`
    if (r.code !== 0) return `heif-dec: ${r.stderr.trim().split('\n')[0]?.slice(0, 200) || 'exit ' + r.code}`
    // a file with more than one top-level image: out-1.jpg, out-2.jpg, ... (the first one is the primary image)
    const name = ['out.jpg', 'out-1.jpg', 'out-primary.jpg'].find((n) => fs.existsSync(path.join(work, n)))
    if (!name) return 'heif-dec wrote no image'
    const st = fs.statSync(path.join(work, name))
    if (st.size > PREVIEW_OUTPUT_MAX) return 'the preview is too large'
    const out = fs.readFileSync(path.join(work, name))
    return isJpeg(out) ? out : 'heif-dec wrote no JPEG'
  } finally { fs.rmSync(work, { recursive: true, force: true }) }
}

async function viaImageIo(bin: string, bytes: Uint8Array, signal?: AbortSignal): Promise<Buffer | string> {
  const r = await runIsolated({
    cmd: bin, args: ['--jpeg', String(PREVIEW_MAX_PX)], stdin: bytes, timeoutMs: PREVIEW_TIMEOUT_MS,
    maxRssMiB: PREVIEW_RSS_MIB, maxStdout: PREVIEW_OUTPUT_MAX, signal,
  })
  if (r.killed) return `mycel-ocr: ${r.killed}`
  if (r.code !== 0) return `mycel-ocr: ${r.stderr.trim().split('\n')[0]?.slice(0, 200) || 'exit ' + r.code}`
  // an older mycel-ocr without --jpeg reads the photo as text: never send that as an image
  return isJpeg(r.stdout) ? r.stdout : 'mycel-ocr has no JPEG mode (build it again with native/build.sh)'
}

/** Converted previews by content hash, with a size limit and at most PREVIEW_RUNS_MAX conversions at a time. */
export class HeicPreviews {
  private running = 0
  private waiting: (() => void)[] = []
  private inFlight = new Map<string, Promise<Buffer | null>>()
  private toolsCache: HeicTools | null

  constructor(private dir: string, tools?: HeicTools, private cacheMax = PREVIEW_CACHE_MAX) {
    this.toolsCache = tools ?? null
  }

  private tools(): HeicTools { return (this.toolsCache ??= heicTools()) }

  /**
   * The JPEG preview of the HEIC file at `abs` (authorized by the caller) and its ETag. null: no converter.
   * The file is read through a descriptor opened with O_NOFOLLOW and checked (openChecked). A conversion is shared
   * by all callers that ask for the same content, so it does not stop when one caller goes away (the time limit
   * stops it).
   */
  async jpeg(abs: string): Promise<{ bytes: Buffer; etag: string } | null> {
    const bytes = readCapped(abs)
    const key = crypto.createHash('sha256').update(CACHE_VERSION).update('\0').update(bytes).digest('hex')
    const file = path.join(this.dir, key + '.jpg')
    const hit = this.read(file)
    if (hit) return { bytes: hit, etag: key }
    let p = this.inFlight.get(key)
    if (!p) {
      p = this.slot(() => heicToJpeg(bytes, this.tools())).finally(() => this.inFlight.delete(key))
      this.inFlight.set(key, p)
    }
    const out = await p
    if (!out) return null
    this.write(file, out)
    return { bytes: out, etag: key }
  }

  private read(file: string): Buffer | null {
    try {
      const b = fs.readFileSync(file)
      const now = new Date()
      fs.utimesSync(file, now, now)
      return b
    } catch { return null }
  }

  private write(file: string, bytes: Buffer) {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
      fs.writeFileSync(tmp, bytes, { mode: 0o600 })
      fs.renameSync(tmp, file)
      this.prune()
    } catch {} // the cache is an optimization; the answer is still sent
  }

  /** Remove the least recently used files until the folder holds at most cacheMax bytes. */
  prune() {
    let files: { p: string; size: number; at: number }[] = []
    try {
      files = fs.readdirSync(this.dir).filter((n) => n.endsWith('.jpg')).map((n) => {
        const st = fs.statSync(path.join(this.dir, n))
        return { p: path.join(this.dir, n), size: st.size, at: st.mtimeMs }
      })
    } catch { return }
    let total = files.reduce((s, f) => s + f.size, 0)
    files.sort((a, b) => a.at - b.at)
    for (const f of files) {
      if (total <= this.cacheMax) break
      try { fs.rmSync(f.p, { force: true }) } catch {}
      total -= f.size
    }
  }

  private async slot<T>(f: () => Promise<T>): Promise<T> {
    if (this.running >= PREVIEW_RUNS_MAX) await new Promise<void>((r) => this.waiting.push(r))
    else this.running++
    try { return await f() } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.running--
    }
  }
}

/** The whole file, read through the checked descriptor; over PREVIEW_INPUT_MAX: "too large" (HTTP 413). */
function readCapped(abs: string): Buffer {
  const { fd, st } = openChecked(abs)
  try {
    if (st.size > PREVIEW_INPUT_MAX) throw new ToolError(`too large to preview (over ${PREVIEW_INPUT_MAX / 1024 / 1024} MB)`)
    const buf = Buffer.alloc(st.size)
    let off = 0
    while (off < st.size) { const n = fs.readSync(fd, buf, off, st.size - off, off); if (n <= 0) break; off += n }
    return buf.subarray(0, off)
  } finally { fs.closeSync(fd) }
}

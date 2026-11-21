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
// Before any converter runs, the sizes the file declares are read (heicSize: the `ispe` property of every image item,
// the primary one first): a file whose primary image or any other image is over 50 megapixels or 65,535 px a side is
// refused undecoded (a decompression bomb), and so is a file that declares no primary image size, names a property it
// does not have, or holds more boxes than any photo. A derived image (a grid of tiles, an overlay) is decoded at its
// own output size, which `ispe` may understate; for those the converter's time, memory and work-folder limits are the
// backstop (review of feat/photos-heic-keep-meta).
//
// Limits: input at most PREVIEW_INPUT_MAX bytes, output at most PREVIEW_OUTPUT_MAX bytes, a time, memory and
// work-folder limit per run, at most PREVIEW_RUNS_MAX runs at the same time and at most PREVIEW_QUEUE_MAX conversions
// waiting. Fairness: one person runs at most PREVIEW_PER_USER_MAX conversion (less than PREVIEW_RUNS_MAX, so another
// person always has a run) and has at most PREVIEW_PER_USER_WAIT_MAX more waiting. A free run goes first to a person
// other than the one who just used it. A conversion that waits longer than PREVIEW_WAIT_MS stops waiting. Over a limit
// and after the wait limit: 'busy' (the web says "busy, try again"). A request waits with no file bytes in memory:
// only a running conversion reads its file. A request that goes away leaves the queue, and a conversion that nobody
// waits for any more stops. A failed conversion is remembered for PREVIEW_FAIL_TTL_MS, so a bad photo does not keep
// the converters busy ('busy' is not a failure and is not remembered).
// Results are cached under <dataDir>/previewcache by the sha256 of the file content (so the cache cannot show a file
// to somebody who cannot read it: the caller must have the same bytes first), at most PREVIEW_CACHE_MAX bytes (the
// oldest go first). The sha256 of a file is kept by its inode, size, mtime and ctime, so a cache hit does not read
// the whole file again.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { which, ocrBin } from '../config'
import { ToolError } from '../policy/errors'
import { hashOpen, openChecked } from '../team-files/place'
import { makeWorkDir, readOutput, runIsolated } from '../tools/isolate'
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
export const PREVIEW_RUNS_MAX = 2
/** conversions that wait for a free run; more: 'busy' */
export const PREVIEW_QUEUE_MAX = 8
/** conversions of one person that run at the same time (less than PREVIEW_RUNS_MAX: the other runs are for others) */
export const PREVIEW_PER_USER_MAX = 1
/** conversions of one person that wait for a run; more: 'busy' */
export const PREVIEW_PER_USER_WAIT_MAX = 1
/** longest wait for a run; then 'busy' (try again), not an endless wait */
export const PREVIEW_WAIT_MS = 15_000
/** preview requests of one person that are not done (hashing, waiting, running); more: 'busy' */
const PREVIEW_PER_USER_OPEN_MAX = 4
/** how long a failed conversion is remembered (by content) */
export const PREVIEW_FAIL_TTL_MS = 10 * 60_000
export const PREVIEW_CACHE_MAX = 200 * 1024 * 1024
/** changes when the converter output or the key changes, so old cache files are not used */
const CACHE_VERSION = 'v2'

/** The cache key (and ETag) of the preview of a file whose content has this sha256. */
export const previewKey = (fileSha: string) => crypto.createHash('sha256').update(CACHE_VERSION).update('\0').update(fileSha).digest('hex')

/**
 * true: the route answers "cannot preview" (503 no_preview). Only the input limit ('too_large', 413) and a missing
 * file ('not_found', 404) are other answers. The decision uses the error code, never the message text (converter
 * stderr can contain any words).
 */
export function noPreviewError(e: unknown): boolean {
  return e instanceof ToolError && e.code !== 'too_large' && e.code !== 'not_found'
}

const aborted = () => new ToolError('the preview request was canceled', 'aborted')
const busy = () => new ToolError('too many photo previews are being made; try again soon', 'busy')

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

/** the most pixels and the longest side of an image any converter is asked to decode (safeops.VisionPixelMax, VisionSideInMax) */
export const HEIC_PIXELS_MAX = 50_000_000
export const HEIC_SIDE_MAX = 65_535

/**
 * The size a HEIC / HEIF file declares for its primary image (ISO/IEC 23008-12: meta > pitm, iprp > ipco ispe, ipma),
 * read from the box headers only, with every offset checked; `largest`: the largest image item it declares (a grid's
 * tiles, thumbnails, other top-level images: heif-dec decodes every top-level image). null: no primary image size
 * (not a HEIF file, or a damaged one).
 */
export function heicSize(b: Uint8Array): { width: number; height: number; largest: number; longest: number } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const type = (at: number) => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!)
  /** the child boxes of [from, to): [type, payload start, payload end], at most 4096 */
  let capped = false
  const boxes = (from: number, to: number): [string, number, number][] => {
    const out: [string, number, number][] = []
    for (let p = from; p + 8 <= to;) {
      // more boxes than any photo has: refused as damaged (a filler could hide a large image past a cap)
      if (out.length >= 4096) { capped = true; break }
      let size = v.getUint32(p)
      let head = 8
      if (size === 1) {
        if (p + 16 > to) break
        const big = v.getBigUint64(p + 8)
        if (big > BigInt(to - p)) break
        size = Number(big)
        head = 16
      } else if (size === 0) size = to - p
      if (size < head || p + size > to) break
      out.push([type(p + 4), p + head, p + size])
      p += size
    }
    return out
  }
  if (b.length < 16 || type(4) !== 'ftyp') return null
  const meta = boxes(0, b.length).find(([t]) => t === 'meta')
  if (!meta || meta[1] + 4 > meta[2]) return null
  const inMeta = boxes(meta[1] + 4, meta[2])
  const pitm = inMeta.find(([t]) => t === 'pitm')
  const iprp = inMeta.find(([t]) => t === 'iprp')
  if (!pitm || !iprp || pitm[1] + 6 > pitm[2]) return null
  const primary = b[pitm[1]] === 0 ? v.getUint16(pitm[1] + 4) : pitm[1] + 8 <= pitm[2] ? v.getUint32(pitm[1] + 4) : -1
  const inIprp = boxes(iprp[1], iprp[2])
  const ipco = inIprp.find(([t]) => t === 'ipco')
  if (!ipco) return null
  // the properties, 1-based; ispe: version/flags, then width and height
  const props = boxes(ipco[1], ipco[2])
  const ispe = (i: number) => {
    const p = props[i - 1]
    if (!p || p[0] !== 'ispe' || p[1] + 12 > p[2]) return null
    return { width: v.getUint32(p[1] + 4), height: v.getUint32(p[1] + 8) }
  }
  let largest = 0, longest = 0
  for (let i = 1; i <= props.length; i++) {
    const s = ispe(i)
    if (s) { largest = Math.max(largest, s.width * s.height); longest = Math.max(longest, s.width, s.height) }
  }
  let found: { width: number; height: number } | null = null
  for (const [t, from, to] of inIprp) {
    if (t !== 'ipma' || from + 8 > to) continue
    const version = b[from]!, wide = (b[from + 3]! & 1) === 1
    const count = v.getUint32(from + 4)
    let p = from + 8
    for (let e = 0; e < count && p < to; e++) {
      const idSize = version < 1 ? 2 : 4
      if (p + idSize + 1 > to) return null
      const id = idSize === 2 ? v.getUint16(p) : v.getUint32(p)
      const n = b[p + idSize]!
      p += idSize + 1
      if (p + n * (wide ? 2 : 1) > to) return null
      for (let k = 0; k < n; k++) {
        const index = wide ? v.getUint16(p) & 0x7fff : b[p]! & 0x7f
        p += wide ? 2 : 1
        // a property that is not there: damaged (never skipped past a size check)
        if (index > props.length) return null
        if (id === primary && !found) found = ispe(index)
      }
    }
  }
  return found && !capped ? { ...found, largest, longest } : null
}

/** null: the file may be decoded; else why not ('too_large': over the pixel limits, 'damaged': no primary image size) */
export function heicRefusal(b: Uint8Array): 'too_large' | 'damaged' | null {
  const s = heicSize(b)
  if (!s || s.width < 1 || s.height < 1) return 'damaged'
  return s.largest > HEIC_PIXELS_MAX || s.longest > HEIC_SIDE_MAX ? 'too_large' : null
}

/** How a photo is decoded: for the preview and the AI (the default), or for a smaller copy that keeps its details. */
export interface HeicDecode {
  /** keep the photo's EXIF (heif-dec keeps it anyway; macOS ImageIO only with --meta) at JPEG quality 92 */
  keepMeta?: boolean
  /** longest side of the macOS JPEG (default PREVIEW_MAX_PX; heif-dec keeps the full size) */
  maxPx?: number
  /** largest JPEG accepted (default PREVIEW_OUTPUT_MAX) */
  outputMax?: number
}

/** A failed converter run: why, and whether the next converter may still try (not after a time / memory / disk kill). */
interface Failed { why: string; stop: boolean }
const failed = (why: string, killed: string | null = null): Failed => ({ why, stop: !!killed })

/**
 * A JPEG of the primary image of a HEIC / HEIF file, its pixels upright (the tag in its EXIF, when there is one, may
 * still name the old orientation: Debian 12's heif-convert). null: no converter on this machine. Throws ToolError
 * 'too_large' for a file over the pixel limits and 'preview_failed' when the file declares no primary image size or
 * the converters failed (a damaged file, a time or memory limit). When a converter is stopped by a limit, the next one
 * does not run (a crafted file would only use the next limit as well).
 */
export async function heicToJpeg(bytes: Uint8Array, tools: HeicTools, signal?: AbortSignal, o: HeicDecode = {}): Promise<Buffer | null> {
  // the declared size first, on every server: an oversized photo is refused from its header, with or without a decoder
  const refused = heicRefusal(bytes)
  if (refused === 'too_large') throw new ToolError('the photo is over 50 megapixels or 65,535 px a side', 'too_large')
  if (!tools.heifDec && !tools.imageIo) return null
  if (refused) throw new ToolError('could not make a preview of the photo (no primary image size)', 'preview_failed')
  let why = ''
  let stop = false
  if (tools.heifDec) {
    const r = await viaHeifDec(tools.heifDec, bytes, signal, o)
    if (Buffer.isBuffer(r)) return r
    ;({ why, stop } = r)
  }
  if (tools.imageIo && !stop) {
    signal?.throwIfAborted()
    const r = await viaImageIo(tools.imageIo, bytes, signal, o)
    if (Buffer.isBuffer(r)) return r
    why = r.why
  }
  signal?.throwIfAborted()
  throw new ToolError(`could not make a preview of the photo (${why})`, 'preview_failed')
}

async function viaHeifDec(bin: string, bytes: Uint8Array, signal?: AbortSignal, o: HeicDecode = {}): Promise<Buffer | Failed> {
  const outMax = o.outputMax ?? PREVIEW_OUTPUT_MAX
  const work = makeWorkDir()
  try {
    await fs.promises.writeFile(path.join(work, 'in.heic'), bytes, { mode: 0o600 })
    // heif-convert (libheif < 1.17) does not know --quiet / --codec-threads
    const modern = path.basename(bin) === 'heif-dec'
    // heif-dec writes one JPEG for each top-level image: the work folder limit stops a file with many large images
    const r = await runIsolated({
      cmd: bin, workDir: work, timeoutMs: PREVIEW_TIMEOUT_MS, maxRssMiB: PREVIEW_RSS_MIB, maxStdout: 1024 * 1024, signal,
      maxWorkBytes: bytes.length + 2 * outMax,
      args: [...(modern ? ['--quiet', '--codec-threads', '1'] : []), '-q', o.keepMeta ? '92' : '85', 'in.heic', 'out.jpg'],
    })
    if (r.killed) return failed(`heif-dec: stopped (${r.killed})`, r.killed)
    if (r.code !== 0) return failed(`heif-dec: ${r.stderr.trim().split('\n')[0]?.slice(0, 200) || 'exit ' + r.code}`)
    // a file with more than one top-level image: out-1.jpg, out-2.jpg, ... in item order. out-1.jpg is the first
    // top-level image, which is the primary image in phone photos (not in every file). Each is read without following
    // a link (tools/isolate.ts readOutput): heif-dec taken over by the photo could leave a link to another file there.
    for (const name of ['out.jpg', 'out-1.jpg', 'out-primary.jpg']) {
      const got = readOutput(work, name, outMax)
      if (!got.ok && got.why === 'missing') continue
      if (!got.ok && got.why === 'too_large') return failed(`the JPEG is over ${outMax / 1024 / 1024} MB`)
      if (!got.ok) return failed('heif-dec wrote no plain file')
      return isJpeg(got.bytes) ? got.bytes : failed('heif-dec wrote no JPEG')
    }
    return failed('heif-dec wrote no image')
  } finally { fs.rmSync(work, { recursive: true, force: true }) }
}

async function viaImageIo(bin: string, bytes: Uint8Array, signal?: AbortSignal, o: HeicDecode = {}): Promise<Buffer | Failed> {
  const r = await runIsolated({
    cmd: bin, args: ['--jpeg', String(o.maxPx ?? PREVIEW_MAX_PX), ...(o.keepMeta ? ['--meta'] : [])], stdin: bytes, timeoutMs: PREVIEW_TIMEOUT_MS,
    maxRssMiB: PREVIEW_RSS_MIB, maxStdout: o.outputMax ?? PREVIEW_OUTPUT_MAX, signal,
  })
  if (r.killed) return failed(`mycel-ocr: stopped (${r.killed})`, r.killed)
  if (r.code !== 0) return failed(`mycel-ocr: ${r.stderr.trim().split('\n')[0]?.slice(0, 200) || 'exit ' + r.code}`)
  // an older mycel-ocr without --jpeg reads the photo as text: never send that as an image
  return isJpeg(r.stdout) ? r.stdout : failed('mycel-ocr has no JPEG mode (build it again with native/build.sh)')
}

/** A conversion that waits for a run */
interface Waiter { owner: string; go: () => void }

type Convert = (bytes: Uint8Array, tools: HeicTools, signal?: AbortSignal) => Promise<Buffer | null>

/** One conversion, shared by every request for the same content. */
interface Job {
  /** the person who started it (the fairness limits count it for this person) */
  owner: string
  promise: Promise<Buffer | null>
  ctrl: AbortController
  /** requests that wait for it now */
  refs: number
  done: boolean
}

/**
 * Converted previews by content hash, with a size limit, at most PREVIEW_RUNS_MAX conversions at a time, a limited
 * queue and a short memory of failed conversions.
 */
export class HeicPreviews {
  private running = 0
  /** running conversions by owner */
  private runs = new Map<string, number>()
  private waiting: Waiter[] = []
  private jobs = new Map<string, Job>()
  private failures = new Map<string, { err: ToolError; until: number }>()
  private perUser = new Map<string, number>()
  private shas = new Map<string, string>()
  private hashing = new Map<string, Promise<string>>()
  private toolsCache: HeicTools | null

  constructor(private dir: string, tools?: HeicTools, private cacheMax = PREVIEW_CACHE_MAX, private convert: Convert = heicToJpeg, private waitMs = PREVIEW_WAIT_MS) {
    this.toolsCache = tools ?? null
  }

  private tools(): HeicTools { return (this.toolsCache ??= heicTools()) }

  /** conversions running now and waiting for a run (for tests and logs) */
  stats() { return { running: this.running, waiting: this.waiting.length } }

  /**
   * The JPEG preview of the HEIC file at `abs` (authorized by the caller) and its ETag. null: no converter.
   * The file is opened with O_NOFOLLOW and checked (openChecked; with `seen`, as the very file the caller's check
   * saw, also when it is read for the conversion). A conversion is shared by all requests for the
   * same content; it stops when no request waits for it any more (`signal`). Errors (ToolError): 'too_large' (input
   * limit), 'not_found', 'busy' (a queue limit), 'aborted', 'preview_failed', 'changed' (the file changed while it
   * was read).
   */
  async jpeg(abs: string, o: { user?: string; signal?: AbortSignal; seen?: fs.Stats } = {}): Promise<{ bytes: Buffer; etag: string } | null> {
    // counted before the first await, so parallel requests of one person cannot all pass the check
    const user = o.user ?? ''
    const open = this.perUser.get(user) ?? 0
    if (open >= PREVIEW_PER_USER_OPEN_MAX) throw busy()
    this.perUser.set(user, open + 1)
    try { return await this.preview(abs, user, o.signal, o.seen) } finally {
      const n = (this.perUser.get(user) ?? 1) - 1
      if (n > 0) this.perUser.set(user, n)
      else this.perUser.delete(user)
    }
  }

  private async preview(abs: string, user: string, signal?: AbortSignal, seen?: fs.Stats): Promise<{ bytes: Buffer; etag: string } | null> {
    // the content hash (and so the cached preview and the ETag) comes from the file that was checked: hashed through
    // this descriptor, never through the name again
    const { fd, st } = openChecked(abs, seen)
    let fileSha: string
    try {
      if (st.size > PREVIEW_INPUT_MAX) throw new ToolError(`too large to preview (over ${PREVIEW_INPUT_MAX / 1024 / 1024} MB)`, 'too_large')
      fileSha = await this.fileSha(abs, st, fd)
    } finally { fs.closeSync(fd) }
    const key = previewKey(fileSha)
    const file = path.join(this.dir, key + '.jpg')
    const hit = await this.read(file)
    if (hit) return { bytes: hit, etag: key }
    const bad = this.failures.get(key)
    if (bad && bad.until > Date.now()) throw bad.err
    if (bad) this.failures.delete(key)
    if (signal?.aborted) throw aborted()
    let job = this.jobs.get(key)
    if (!job) {
      if (!this.canRun(user)) {
        if (this.waiting.length >= PREVIEW_QUEUE_MAX) throw busy()
        if (this.waiting.filter((w) => w.owner === user).length >= PREVIEW_PER_USER_WAIT_MAX) throw busy()
      }
      job = this.start(key, abs, fileSha, file, user, seen)
    }
    const out = await this.wait(job, key, signal)
    return out ? { bytes: out, etag: key } : null
  }

  /** Wait for a job; the last request that goes away stops it. */
  private async wait(job: Job, key: string, signal?: AbortSignal): Promise<Buffer | null> {
    job.refs++
    let onAbort = () => {}
    try {
      return await new Promise<Buffer | null>((resolve, reject) => {
        onAbort = () => reject(aborted())
        signal?.addEventListener('abort', onAbort, { once: true })
        job.promise.then(resolve, reject)
      })
    } finally {
      signal?.removeEventListener('abort', onAbort)
      if (--job.refs === 0 && !job.done) {
        // a new request for the same content starts a new job (this one stops)
        if (this.jobs.get(key) === job) this.jobs.delete(key)
        job.ctrl.abort()
      }
    }
  }

  private start(key: string, abs: string, fileSha: string, file: string, owner: string, seen?: fs.Stats): Job {
    const ctrl = new AbortController()
    const job: Job = { owner, ctrl, refs: 0, done: false, promise: null as unknown as Promise<Buffer | null> }
    job.promise = (async () => {
      await this.slot(owner, ctrl.signal)
      try {
        // the bytes are read only now (a waiting request holds none), and must be the content that was hashed
        const bytes = await readHashed(abs, fileSha, seen)
        ctrl.signal.throwIfAborted()
        const out = await this.convert(bytes, this.tools(), ctrl.signal)
        if (out) await this.write(file, out)
        return out
      } catch (e) {
        if (ctrl.signal.aborted) throw aborted()
        if (e instanceof ToolError) throw e
        // a spawn or read error (for example a converter that was removed): "cannot preview", and remembered
        throw new ToolError(`could not make a preview of the photo (${e instanceof Error ? e.message : String(e)})`.slice(0, 300), 'preview_failed')
      } finally { this.release(owner) }
    })()
    job.promise.then(() => {}, (e) => {
      if (ctrl.signal.aborted || !(e instanceof ToolError) || e.code !== 'preview_failed') return
      this.failures.set(key, { err: e, until: Date.now() + PREVIEW_FAIL_TTL_MS })
      if (this.failures.size > 1000) this.failures.delete(this.failures.keys().next().value!)
    }).finally(() => {
      job.done = true
      if (this.jobs.get(key) === job) this.jobs.delete(key)
    })
    this.jobs.set(key, job)
    return job
  }

  /** sha256 of the content of the open file `fd` (`st`: its fstat), kept by inode, size, mtime and ctime (ctime cannot
   * be set by a user). A hash already running for the same key reads the same file (same inode, same times). */
  private fileSha(abs: string, st: fs.Stats, fd: number): Promise<string> {
    const k = `${abs}\0${st.dev}\0${st.ino}\0${st.size}\0${st.mtimeMs}\0${st.ctimeMs}`
    const hit = this.shas.get(k)
    if (hit) return Promise.resolve(hit)
    let p = this.hashing.get(k)
    if (!p) {
      p = hashOpen(fd).then((h) => {
        this.shas.set(k, h)
        if (this.shas.size > 1000) this.shas.delete(this.shas.keys().next().value!)
        return h
      }).finally(() => this.hashing.delete(k))
      this.hashing.set(k, p)
    }
    return p
  }

  private async read(file: string): Promise<Buffer | null> {
    try {
      const b = await fs.promises.readFile(file)
      const now = new Date()
      await fs.promises.utimes(file, now, now)
      return b
    } catch { return null }
  }

  private async write(file: string, bytes: Buffer) {
    try {
      await fs.promises.mkdir(this.dir, { recursive: true, mode: 0o700 })
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
      await fs.promises.writeFile(tmp, bytes, { mode: 0o600 })
      await fs.promises.rename(tmp, file)
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

  /** true: a conversion of `owner` can run now (a free run, and the person runs fewer than PREVIEW_PER_USER_MAX) */
  private canRun(owner: string): boolean {
    return this.running < PREVIEW_RUNS_MAX && (this.runs.get(owner) ?? 0) < PREVIEW_PER_USER_MAX
  }

  private take(owner: string) {
    this.running++
    this.runs.set(owner, (this.runs.get(owner) ?? 0) + 1)
  }

  /**
   * Wait for a run. A stop signal removes the request from the queue; after waitMs it leaves the queue with 'busy'.
   */
  private slot(owner: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(aborted())
    if (this.canRun(owner)) { this.take(owner); return Promise.resolve() }
    return new Promise<void>((resolve, reject) => {
      const leave = (e: ToolError) => {
        const i = this.waiting.indexOf(w)
        if (i >= 0) this.waiting.splice(i, 1)
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        reject(e)
      }
      const onAbort = () => leave(aborted())
      const timer = setTimeout(() => leave(busy()), this.waitMs)
      const w: Waiter = { owner, go: () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); resolve() } }
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiting.push(w)
    })
  }

  /**
   * A run of `owner` is done. Free runs go to waiting conversions in order, but a person who runs PREVIEW_PER_USER_MAX
   * conversions is skipped, and a person other than `owner` goes first (so one person with many files cannot keep
   * the others waiting longer than one conversion).
   */
  private release(owner: string) {
    this.running--
    const n = (this.runs.get(owner) ?? 1) - 1
    if (n > 0) this.runs.set(owner, n)
    else this.runs.delete(owner)
    while (this.running < PREVIEW_RUNS_MAX) {
      const ok = (w: Waiter) => (this.runs.get(w.owner) ?? 0) < PREVIEW_PER_USER_MAX
      const i = [this.waiting.findIndex((w) => ok(w) && w.owner !== owner), this.waiting.findIndex(ok)].find((x) => x >= 0) ?? -1
      if (i < 0) break
      const [next] = this.waiting.splice(i, 1)
      this.take(next!.owner)
      next!.go()
    }
  }
}

/**
 * The whole file, read through the checked descriptor in parts (the event loop is not blocked) and hashed on the way.
 * Over PREVIEW_INPUT_MAX: 'too_large'. Not the content with the sha256 `want`: 'changed'.
 */
async function readHashed(abs: string, want: string, seen?: fs.Stats): Promise<Buffer> {
  const { fd, st } = openChecked(abs, seen)
  try {
    if (st.size > PREVIEW_INPUT_MAX) throw new ToolError(`too large to preview (over ${PREVIEW_INPUT_MAX / 1024 / 1024} MB)`, 'too_large')
    const buf = Buffer.alloc(st.size)
    const h = crypto.createHash('sha256')
    let off = 0
    while (off < st.size) {
      const n = await new Promise<number>((res, rej) => fs.read(fd, buf, off, Math.min(4 * 1024 * 1024, st.size - off), off, (err, n) => (err ? rej(err) : res(n))))
      if (n <= 0) break
      h.update(buf.subarray(off, off + n))
      off += n
    }
    if (h.digest('hex') !== want) throw new ToolError('the photo changed while it was read', 'changed')
    return buf.subarray(0, off)
  } finally { fs.closeSync(fd) }
}

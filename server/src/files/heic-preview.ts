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
// Limits: input at most PREVIEW_INPUT_MAX bytes, output at most PREVIEW_OUTPUT_MAX bytes, a time, memory and
// work-folder limit per run, at most PREVIEW_RUNS_MAX runs at the same time, at most PREVIEW_QUEUE_MAX conversions
// waiting and at most PREVIEW_PER_USER_MAX open requests of one person (over a limit: 'busy'). A request waits
// with no file bytes in memory: only a running conversion reads its file. A request that goes away leaves the queue,
// and a conversion that nobody waits for any more stops. A failed conversion is remembered for PREVIEW_FAIL_TTL_MS,
// so a bad photo does not keep the converters busy.
// Results are cached under <dataDir>/previewcache by the sha256 of the file content (so the cache cannot show a file
// to somebody who cannot read it: the caller must have the same bytes first), at most PREVIEW_CACHE_MAX bytes (the
// oldest go first). The sha256 of a file is kept by its inode, size, mtime and ctime, so a cache hit does not read
// the whole file again.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { which, ocrBin } from '../config'
import { ToolError } from '../policy/errors'
import { hashFile, openChecked } from '../team-files/place'
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
export const PREVIEW_RUNS_MAX = 2
/** conversions that wait for a free run; more: 'busy' */
export const PREVIEW_QUEUE_MAX = 8
/** preview requests of one person that are not done (a cache hit is done at once); more: 'busy' */
export const PREVIEW_PER_USER_MAX = 4
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

/** A failed converter run: why, and whether the next converter may still try (not after a time / memory / disk kill). */
interface Failed { why: string; stop: boolean }
const failed = (why: string, killed: string | null = null): Failed => ({ why, stop: !!killed })

/**
 * A JPEG of the primary image of a HEIC / HEIF file. null: no converter on this machine. Throws ToolError
 * 'preview_failed' when the converters failed (a damaged file, a time or memory limit). When a converter is stopped by
 * a limit, the next one does not run (a crafted file would only use the next limit as well).
 */
export async function heicToJpeg(bytes: Uint8Array, tools: HeicTools, signal?: AbortSignal): Promise<Buffer | null> {
  if (!tools.heifDec && !tools.imageIo) return null
  let why = ''
  let stop = false
  if (tools.heifDec) {
    const r = await viaHeifDec(tools.heifDec, bytes, signal)
    if (Buffer.isBuffer(r)) return r
    ;({ why, stop } = r)
  }
  if (tools.imageIo && !stop) {
    signal?.throwIfAborted()
    const r = await viaImageIo(tools.imageIo, bytes, signal)
    if (Buffer.isBuffer(r)) return r
    why = r.why
  }
  signal?.throwIfAborted()
  throw new ToolError(`could not make a preview of the photo (${why})`, 'preview_failed')
}

async function viaHeifDec(bin: string, bytes: Uint8Array, signal?: AbortSignal): Promise<Buffer | Failed> {
  const work = makeWorkDir()
  try {
    await fs.promises.writeFile(path.join(work, 'in.heic'), bytes, { mode: 0o600 })
    // heif-convert (libheif < 1.17) does not know --quiet / --codec-threads
    const modern = path.basename(bin) === 'heif-dec'
    // heif-dec writes one JPEG for each top-level image: the work folder limit stops a file with many large images
    const r = await runIsolated({
      cmd: bin, workDir: work, timeoutMs: PREVIEW_TIMEOUT_MS, maxRssMiB: PREVIEW_RSS_MIB, maxStdout: 1024 * 1024, signal,
      maxWorkBytes: bytes.length + 2 * PREVIEW_OUTPUT_MAX,
      args: [...(modern ? ['--quiet', '--codec-threads', '1'] : []), '-q', '85', 'in.heic', 'out.jpg'],
    })
    if (r.killed) return failed(`heif-dec: stopped (${r.killed})`, r.killed)
    if (r.code !== 0) return failed(`heif-dec: ${r.stderr.trim().split('\n')[0]?.slice(0, 200) || 'exit ' + r.code}`)
    // a file with more than one top-level image: out-1.jpg, out-2.jpg, ... in item order. out-1.jpg is the first
    // top-level image, which is the primary image in phone photos (not in every file).
    const name = ['out.jpg', 'out-1.jpg', 'out-primary.jpg'].find((n) => fs.existsSync(path.join(work, n)))
    if (!name) return failed('heif-dec wrote no image')
    const st = fs.statSync(path.join(work, name))
    if (st.size > PREVIEW_OUTPUT_MAX) return failed(`the JPEG is over ${PREVIEW_OUTPUT_MAX / 1024 / 1024} MB`)
    const out = await fs.promises.readFile(path.join(work, name))
    return isJpeg(out) ? out : failed('heif-dec wrote no JPEG')
  } finally { fs.rmSync(work, { recursive: true, force: true }) }
}

async function viaImageIo(bin: string, bytes: Uint8Array, signal?: AbortSignal): Promise<Buffer | Failed> {
  const r = await runIsolated({
    cmd: bin, args: ['--jpeg', String(PREVIEW_MAX_PX)], stdin: bytes, timeoutMs: PREVIEW_TIMEOUT_MS,
    maxRssMiB: PREVIEW_RSS_MIB, maxStdout: PREVIEW_OUTPUT_MAX, signal,
  })
  if (r.killed) return failed(`mycel-ocr: stopped (${r.killed})`, r.killed)
  if (r.code !== 0) return failed(`mycel-ocr: ${r.stderr.trim().split('\n')[0]?.slice(0, 200) || 'exit ' + r.code}`)
  // an older mycel-ocr without --jpeg reads the photo as text: never send that as an image
  return isJpeg(r.stdout) ? r.stdout : failed('mycel-ocr has no JPEG mode (build it again with native/build.sh)')
}

type Convert = (bytes: Uint8Array, tools: HeicTools, signal?: AbortSignal) => Promise<Buffer | null>

/** One conversion, shared by every request for the same content. */
interface Job {
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
  private waiting: { go: () => void }[] = []
  private jobs = new Map<string, Job>()
  private failures = new Map<string, { err: ToolError; until: number }>()
  private perUser = new Map<string, number>()
  private shas = new Map<string, string>()
  private hashing = new Map<string, Promise<string>>()
  private toolsCache: HeicTools | null

  constructor(private dir: string, tools?: HeicTools, private cacheMax = PREVIEW_CACHE_MAX, private convert: Convert = heicToJpeg) {
    this.toolsCache = tools ?? null
  }

  private tools(): HeicTools { return (this.toolsCache ??= heicTools()) }

  /** conversions running now and waiting for a run (for tests and logs) */
  stats() { return { running: this.running, waiting: this.waiting.length } }

  /**
   * The JPEG preview of the HEIC file at `abs` (authorized by the caller) and its ETag. null: no converter.
   * The file is opened with O_NOFOLLOW and checked (openChecked). A conversion is shared by all requests for the
   * same content; it stops when no request waits for it any more (`signal`). Errors (ToolError): 'too_large' (input
   * limit), 'not_found', 'busy' (a queue limit), 'aborted', 'preview_failed', 'changed' (the file changed while it
   * was read).
   */
  async jpeg(abs: string, o: { user?: string; signal?: AbortSignal } = {}): Promise<{ bytes: Buffer; etag: string } | null> {
    // counted before the first await, so parallel requests of one person cannot all pass the check
    const user = o.user ?? ''
    const open = this.perUser.get(user) ?? 0
    if (open >= PREVIEW_PER_USER_MAX) throw busy()
    this.perUser.set(user, open + 1)
    try { return await this.preview(abs, o.signal) } finally {
      const n = (this.perUser.get(user) ?? 1) - 1
      if (n > 0) this.perUser.set(user, n)
      else this.perUser.delete(user)
    }
  }

  private async preview(abs: string, signal?: AbortSignal): Promise<{ bytes: Buffer; etag: string } | null> {
    const { fd, st } = openChecked(abs)
    fs.closeSync(fd)
    if (st.size > PREVIEW_INPUT_MAX) throw new ToolError(`too large to preview (over ${PREVIEW_INPUT_MAX / 1024 / 1024} MB)`, 'too_large')
    const fileSha = await this.fileSha(abs, st)
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
      if (this.running >= PREVIEW_RUNS_MAX && this.waiting.length >= PREVIEW_QUEUE_MAX) throw busy()
      job = this.start(key, abs, fileSha, file)
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

  private start(key: string, abs: string, fileSha: string, file: string): Job {
    const ctrl = new AbortController()
    const job: Job = { ctrl, refs: 0, done: false, promise: null as unknown as Promise<Buffer | null> }
    job.promise = (async () => {
      await this.slot(ctrl.signal)
      try {
        // the bytes are read only now (a waiting request holds none), and must be the content that was hashed
        const bytes = await readHashed(abs, fileSha)
        ctrl.signal.throwIfAborted()
        const out = await this.convert(bytes, this.tools(), ctrl.signal)
        if (out) await this.write(file, out)
        return out
      } finally { this.release() }
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

  /** sha256 of the file content, kept by inode, size, mtime and ctime (ctime cannot be set by a user) */
  private fileSha(abs: string, st: fs.Stats): Promise<string> {
    const k = `${abs}\0${st.dev}\0${st.ino}\0${st.size}\0${st.mtimeMs}\0${st.ctimeMs}`
    const hit = this.shas.get(k)
    if (hit) return Promise.resolve(hit)
    let p = this.hashing.get(k)
    if (!p) {
      p = hashFile(abs).then((h) => {
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

  /** Wait for a free run. A stop signal removes the request from the queue. */
  private slot(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(aborted())
    if (this.running < PREVIEW_RUNS_MAX) { this.running++; return Promise.resolve() }
    return new Promise<void>((resolve, reject) => {
      const w = { go: () => { signal.removeEventListener('abort', onAbort); resolve() } }
      const onAbort = () => {
        const i = this.waiting.indexOf(w)
        if (i >= 0) this.waiting.splice(i, 1)
        reject(aborted())
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiting.push(w)
    })
  }

  /** A run is done: the next waiting conversion gets its place. */
  private release() {
    const next = this.waiting.shift()
    if (next) next.go()
    else this.running--
  }
}

/**
 * The whole file, read through the checked descriptor in parts (the event loop is not blocked) and hashed on the way.
 * Over PREVIEW_INPUT_MAX: 'too_large'. Not the content with the sha256 `want`: 'changed'.
 */
async function readHashed(abs: string, want: string): Promise<Buffer> {
  const { fd, st } = openChecked(abs)
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

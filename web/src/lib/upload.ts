// Uploads (tab 4 "업로드와 오래 걸리는 작업"): small files in one multipart request, larger ones as a chunked
// upload session (8 MB chunks, sha256 checked by the server). A session survives a dropped connection and a page
// reload: it is remembered per file (name, size, mtime, target) and continues from the chunks the server already has.
import { createSHA256 } from 'hash-wasm'
import { t } from '../i18n'
import { UPLOADS_KEY } from './localData'
import { API, ApiError, SMALL_UPLOAD_MAX, UPLOAD_CHUNK_SIZE, type ApiClient, type UploadComplete, type UploadSession, type UploadTarget } from '@mycel/shared/api'

/** Up to this size one request is enough; bigger files go chunked. */
export const SINGLE_REQUEST_MAX = 8 * 1024 * 1024
/** The browser counts sent bytes many times a second, and each report redraws what shows it: a new whole percent, at most
 * this often, is enough for a person. */
const REPORT_EVERY_MS = 250
/** Uploads on their way at a time, on the whole page: a small file, or one chunk of a large one. Each holds a copy in memory
 * until its request ends, and the file screen and a chat start all that was picked at once: 20 files of 8 MB took 684 MB in
 * WebKit's network process. A folder upload sends three at a time by itself and takes its places in the same line. */
const COPIES_AT_ONCE = 3
/** No byte out for this long: the upload goes on without its place, and the line moves. There is no time limit on a
 * request, so a stopped one would otherwise hold its place until the person removes it. */
const PLACE_IDLE_MS = 20_000

/** No byte can go out, so the upload waits for the connection before it tries again: at most this long, then it fails
 * (the row offers 다시 시도). QA TC-223: it gave up after about 15 s and stayed failed when the network came back. */
export const CONNECTION_WAIT_MS = 10 * 60_000
/** the longest pause between two tries while the connection is gone (the browser's `online` event ends it sooner) */
const CONNECTION_PAUSE_MAX_MS = 10_000

/** `loaded` and `total` count the file's own bytes, in every phase. `waiting`: the connection is gone and the upload
 * goes on by itself when it is back (`loaded` stays what had gone out). */
export interface UploadProgress {
  phase: 'hashing' | 'uploading' | 'finishing' | 'waiting'
  loaded: number
  total: number
}

export type Running = { phase: UploadProgress['phase'] | null; loaded: number; total: number } | null | undefined

/** The whole percent of a running upload, or null when there is no number to show: nothing has gone out yet, the file
 * is being hashed (a percent of that would fall back to 0 when the bytes start), or the server is taking the last of
 * it. Never 100 while the upload runs: the answer can still take a while, and 100 would look stuck. */
export function uploadPercent(p: Running): number | null {
  if (p?.phase !== 'uploading' || !p.total) return null
  const pct = Math.floor((p.loaded / p.total) * 100)
  return pct > 0 ? Math.min(pct, 99) : null
}

/** The share of the bar: full while the server finishes, what had gone out while it waits for the connection. */
export function uploadBar(p: Running): number {
  if (p?.phase === 'finishing') return 100
  if (p?.phase === 'waiting') return p.total ? Math.min(99, Math.floor((p.loaded / p.total) * 100)) : 0
  return uploadPercent(p) ?? 0
}

/** What a running upload says beside its spinner. */
export function uploadLabel(p: Running, t: (key: 'files.preparing' | 'files.finishing' | 'files.waitingConnection') => string): string {
  if (p?.phase === 'finishing') return t('files.finishing')
  if (p?.phase === 'waiting') return t('files.waitingConnection')
  const pct = uploadPercent(p)
  return pct === null ? t('files.preparing') : `${pct}%`
}

export interface UploadOptions {
  client: ApiClient
  onProgress?: (p: UploadProgress) => void
  signal?: AbortSignal
  /** where resumable sessions are remembered (default localStorage) */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null
  /** wait between retries (tests pass 0) */
  retryDelayMs?: number
  /** at least this long between reports of bytes on their way (tests pass 0) */
  reportEveryMs?: number
  /** how long an upload with no byte out keeps its place (tests pass less) */
  placeIdleMs?: number
  /** how long it waits for a lost connection before it fails (CONNECTION_WAIT_MS; tests pass less) */
  connectionWaitMs?: number
  singleRequestMax?: number
}

const STORE_KEY = UPLOADS_KEY
/** unfinished upload sessions remembered for resuming */
export const REMEMBER_MAX = 50

export function fingerprint(file: Pick<File, 'name' | 'size' | 'lastModified'>, target: UploadTarget): string {
  return JSON.stringify([file.name, file.size, file.lastModified, target])
}

function readStore(s: UploadOptions['storage']): Record<string, string> {
  try { return JSON.parse(s?.getItem(STORE_KEY) ?? '{}') as Record<string, string> } catch { return {} }
}
function writeStore(s: UploadOptions['storage'], v: Record<string, string>) {
  try {
    if (Object.keys(v).length) s?.setItem(STORE_KEY, JSON.stringify(v))
    else s?.removeItem(STORE_KEY)
  } catch { /* storage full / blocked: resume just won't survive a reload */ }
}

/** sha256 of a Blob, read in chunks (never the whole file in memory). */
export async function sha256Hex(blob: Blob, onProgress?: (done: number) => void, signal?: AbortSignal): Promise<string> {
  const h = await createSHA256()
  h.init()
  for (let off = 0; off < blob.size; off += UPLOAD_CHUNK_SIZE) {
    signal?.throwIfAborted()
    h.update(new Uint8Array(await blob.slice(off, off + UPLOAD_CHUNK_SIZE).arrayBuffer()))
    onProgress?.(Math.min(blob.size, off + UPLOAD_CHUNK_SIZE))
  }
  return h.digest('hex')
}

// 507 storage_full is an answer, not a server fault: a person must free space first, so it ends the file at once
// No answer at all is a TypeError (fetch, and lib/xhr.ts the same); a file that cannot be read (a DOMException) or an answer
// that is not what was asked for is not made better by sending again
const retryable = (e: unknown) => e instanceof TypeError || (e instanceof ApiError && ((e.status >= 500 && e.code !== 'storage_full') || e.code === 'rate_limited' || e.code === 'unavailable'))
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')) }, { once: true })
  })

/** The connection is gone, not refused: no answer at all (lib/xhr.ts: a TypeError), or the relay could not reach the
 * team server (502, 504). */
const connectionLost = (e: unknown) => e instanceof TypeError || (e instanceof ApiError && (e.status === 502 || e.status === 504))
const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false

/** A pause of up to `ms` that the browser's `online` event ends at once. */
const untilOnline = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const win = typeof window === 'undefined' ? null : window
    const done = () => {
      clearTimeout(timer)
      win?.removeEventListener('online', done)
      signal?.removeEventListener('abort', stop)
      resolve()
    }
    const stop = () => {
      clearTimeout(timer)
      win?.removeEventListener('online', done)
      reject(signal?.reason ?? new DOMException('aborted', 'AbortError'))
    }
    const timer = setTimeout(done, ms)
    win?.addEventListener('online', done)
    signal?.addEventListener('abort', stop, { once: true })
  })

/**
 * `fn` again after a failure that may pass. A server error: 5 tries in all (1, 2, 4, 8 s between). A lost connection
 * (QA TC-223): the upload waits for it, a growing pause up to 10 s or until the browser is online again, and asks
 * nothing while the browser says it is offline, for up to `connectionWaitMs`; `waiting` is called while it waits.
 */
async function withRetry<T>(fn: () => Promise<T>, o: UploadOptions, waiting?: () => void, tries = 5): Promise<T> {
  let lostSince: number | null = null
  let pauses = 0
  for (let i = 0; ; ) {
    try {
      return await fn()
    } catch (e) {
      if (o.signal?.aborted || !retryable(e)) throw e
      if (connectionLost(e)) {
        lostSince ??= Date.now()
        const left = () => (o.connectionWaitMs ?? CONNECTION_WAIT_MS) - (Date.now() - lostSince!)
        if (left() <= 0) throw e
        waiting?.()
        const pause = Math.min(CONNECTION_PAUSE_MAX_MS, (o.retryDelayMs ?? 1000) * 2 ** pauses++)
        await untilOnline(Math.min(pause, left()), o.signal)
        while (offline() && left() > 0) await untilOnline(Math.min(CONNECTION_PAUSE_MAX_MS, left()), o.signal)
        continue
      }
      if (++i >= tries) throw e
      await sleep((o.retryDelayMs ?? 1000) * 2 ** (i - 1), o.signal)
    }
  }
}

/** One file to a target. Returns what the server made of it (file entry, attachment or transcription job). */
export async function uploadFile(file: File, target: UploadTarget, o: UploadOptions): Promise<UploadComplete> {
  const max = Math.min(o.singleRequestMax ?? SINGLE_REQUEST_MAX, SMALL_UPLOAD_MAX)
  if (file.size <= max) return uploadSmall(file, target, o)
  return uploadChunked(file, target, o)
}

/** Reports bytes on their way, sparingly (REPORT_EVERY_MS). A report of a new phase goes straight to o.onProgress. */
function sparingly(o: UploadOptions) {
  let at = 0
  let percent = -1
  return (p: UploadProgress) => {
    const now = Date.now()
    const pct = Math.floor((p.loaded / p.total) * 100)
    if (pct === percent || now - at < (o.reportEveryMs ?? REPORT_EVERY_MS)) return
    at = now
    percent = pct
    o.onProgress?.(p)
  }
}

let onTheirWay = 0
/** Uploads that gave their place back and still run. A slow line that reports late can look stopped, so this has a limit
 * too: with COPIES_AT_ONCE more, at most six copies are on their way, what a browser opens to one host anyway. */
let overtime = 0
const inLine: (() => void)[] = []

interface Place {
  /** bytes went out */
  moved(): void
  /** the upload or the chunk ended, whichever way */
  end(): void
}

function holdPlace(idleMs: number): Place {
  let held = true
  let timer: ReturnType<typeof setTimeout>
  const giveBack = () => {
    held = false
    // the next in line takes the place over as it is
    const next = inLine.shift()
    if (next) next()
    else onTheirWay--
  }
  const watch = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (overtime >= COPIES_AT_ONCE) return watch()
      overtime++
      giveBack()
    }, idleMs)
  }
  watch()
  return {
    moved: () => { if (held) watch() },
    end: () => {
      clearTimeout(timer)
      if (held) giveBack()
      else overtime--
    },
  }
}

/** A voice recording is in memory already, there is one at a time, and the person waits for it with the message box shut. */
const NO_PLACE: Place = { moved: () => {}, end: () => {} }

/** A place among COPIES_AT_ONCE, first come first served. A cancel leaves the line at once. */
async function takePlace(target: UploadTarget, o: UploadOptions): Promise<Place> {
  if (target.kind === 'transcribe') return NO_PLACE
  const { signal } = o
  signal?.throwIfAborted()
  if (onTheirWay < COPIES_AT_ONCE) onTheirWay++
  else {
    await new Promise<void>((resolve, reject) => {
      const turn = () => {
        signal?.removeEventListener('abort', leave)
        resolve()
      }
      const leave = () => {
        inLine.splice(inLine.indexOf(turn), 1)
        reject(signal!.reason)
      }
      inLine.push(turn)
      signal?.addEventListener('abort', leave, { once: true })
    })
  }
  return holdPlace(o.placeIdleMs ?? PLACE_IDLE_MS)
}

async function uploadSmall(file: File, target: UploadTarget, o: UploadOptions): Promise<UploadComplete> {
  const total = file.size
  const finishing = () => o.onProgress?.({ phase: 'finishing', loaded: total, total })
  o.onProgress?.({ phase: 'uploading', loaded: 0, total })
  // a file for a team folder is sent again after a lost connection: if the first one did arrive (its answer was lost),
  // the server keeps that one at its name and answers with it, no "(2)" (TeamFiles.placeUpload keepSame). An
  // attachment or a recording is sent once, as before: a second one would be a second attachment or transcription.
  if (target.kind !== 'path') return smallOnce(file, target, o, finishing, { now: false })
  const waiting = { now: false }
  return withRetry(() => smallOnce(file, target, o, finishing, waiting), o, () => {
    waiting.now = true
    o.onProgress?.({ phase: 'waiting', loaded: 0, total })
  })
}

/** One try of a small upload, in a place of the line. `waiting.now`: the try after a wait for the connection, whose first
 * bytes out say so at once (not after a new whole percent). */
async function smallOnce(file: File, target: UploadTarget, o: UploadOptions, finishing: () => void, waiting: { now: boolean }): Promise<UploadComplete> {
  const total = file.size
  const place = await takePlace(target, o)
  try {
    // WebKit bug 319985: Safari and iOS from 26.5 can send a File with no bytes (Content-Length: 0), and a page under a
    // service worker is the reported case, as this app with web/pwa/sw.js is. A copy in memory goes out whole. In every
    // browser: all browsers on an iPhone are WebKit, a wrong guess from the user agent fails the whole upload, and only a
    // few copies exist at a time. A chunk of a larger file is copied too: a slice is still read from the disk by the network
    // process, which is where iOS refuses it.
    const body = new Blob([await file.arrayBuffer()], { type: file.type })
    o.signal?.throwIfAborted()
    const report = sparingly(o)
    // the last byte out is not the end: the server still stores the file and answers
    const onUploadProgress = o.onProgress && ((sent: number) => {
      place.moved()
      const back = waiting.now
      waiting.now = false
      if (sent >= 1) finishing()
      else if (back) o.onProgress?.({ phase: 'uploading', loaded: Math.round(sent * total), total })
      else report({ phase: 'uploading', loaded: Math.round(sent * total), total })
    })
    const request = { signal: o.signal, onUploadProgress }
    // the server refuses a part of another size before it stores it; this is for one that has no such check
    const kept = (size: number | null) => { if (size !== total) throw new ApiError(400, { code: 'validation', message: t('files.incompleteUpload') }) }
    let out: UploadComplete
    if (target.kind === 'path') {
      const slash = target.path.lastIndexOf('/')
      const folder = slash < 0 ? '' : target.path.slice(0, slash)
      const name = target.path.slice(slash + 1)
      const entry = await o.client.call(API.upload, { body: { fields: { folder, name, onExists: target.onExists, size: String(total) }, file: body, filename: name }, ...request })
      kept(entry.size)
      out = { kind: 'path', entry }
    } else if (target.kind === 'attachment') {
      const attachment = await o.client.call(API.uploadAttachment, { body: { fields: { chatId: target.chatId, name: target.name, size: String(total) }, file: body, filename: target.name }, ...request })
      kept(attachment.size)
      out = { kind: 'attachment', attachment }
    } else {
      const { jobId } = await o.client.call(API.transcribe, { body: { fields: target.chatId ? { chatId: target.chatId } : {}, file: body, filename: target.name }, ...request })
      out = { kind: 'transcribe', jobId }
    }
    finishing()
    return out
  } finally {
    place.end()
  }
}

async function uploadChunked(file: File, target: UploadTarget, o: UploadOptions): Promise<UploadComplete> {
  const storage = o.storage === undefined ? (typeof localStorage === 'undefined' ? null : localStorage) : o.storage
  const fp = fingerprint(file, target)
  const total = file.size
  o.onProgress?.({ phase: 'hashing', loaded: 0, total })
  const sha256 = await sha256Hex(file, (done) => o.onProgress?.({ phase: 'hashing', loaded: done, total }), o.signal)
  // the most bytes reported so far: a chunk sent again does not take the number back (or a folder's sum, which adds these)
  let shown = 0
  /** waiting for the connection (QA TC-223): the row says so, with the bytes that went out; the next bytes say so at once */
  let waitingNow = false
  const waiting = () => {
    waitingNow = true
    o.onProgress?.({ phase: 'waiting', loaded: shown, total })
  }

  // resume a session for the same file if the server still has it
  let session: UploadSession | null = null
  const known = readStore(storage)[fp]
  if (known) {
    try {
      // picked again while the connection is still gone: wait for it, or the chunks the server has would be lost
      const s = await withRetry(() => o.client.call(API.getUploadSession, { params: { id: known }, signal: o.signal }), o, waiting)
      if (s.sha256 === sha256 && s.size === total) session = s
    } catch { /* expired or gone: start over */ }
  }
  if (!session) {
    session = await withRetry(() => o.client.call(API.createUploadSession, { body: { target, size: total, sha256 }, signal: o.signal }), o, waiting)
    const store = { ...readStore(storage), [fp]: session.id }
    // sessions of uploads that were never finished pile up otherwise; the server drops them after a while anyway
    const keys = Object.keys(store)
    for (const k of keys.slice(0, Math.max(0, keys.length - REMEMBER_MAX))) delete store[k]
    writeStore(storage, store)
  }

  const id = session.id
  const size = session.chunkSize
  let received = new Set(session.received)
  const sentSoFar = (onItsWay = 0): UploadProgress => {
    shown = Math.max(shown, Math.min(total, received.size * size + onItsWay))
    return { phase: 'uploading', loaded: shown, total }
  }
  const report = sparingly(o)
  o.onProgress?.(sentSoFar())
  for (let n = 0; n < session.chunkCount; n++) {
    if (received.has(n)) continue
    o.signal?.throwIfAborted()
    const chunk = file.slice(n * size, Math.min(total, (n + 1) * size))
    const r = await withRetry(async () => {
      // a place for this try only: not between tries, and between chunks other files get their turn
      const place = await takePlace(target, o)
      try {
        const body = new Blob([await chunk.arrayBuffer()]) // why a copy: uploadSmall
        o.signal?.throwIfAborted()
        const onUploadProgress = o.onProgress && ((sent: number) => {
          place.moved()
          const p = sentSoFar(Math.round(sent * chunk.size))
          if (waitingNow) o.onProgress?.(p)
          else report(p)
          waitingNow = false
        })
        return await o.client.call(API.uploadChunk, { params: { id, n: String(n) }, body, signal: o.signal, onUploadProgress })
      } catch (e) {
        // after a network drop, ask what arrived before sending again
        if (!(e instanceof ApiError)) {
          const s = await o.client.call(API.getUploadSession, { params: { id }, signal: o.signal }).catch(() => null)
          if (s?.received.includes(n)) return { received: s.received }
        }
        throw e
      } finally {
        place.end()
      }
    }, o, waiting)
    waitingNow = false
    received = new Set(r.received)
    o.onProgress?.(sentSoFar())
  }
  o.onProgress?.({ phase: 'finishing', loaded: total, total })
  const done = await withRetry(() => o.client.call(API.completeUploadSession, { params: { id }, signal: o.signal }), o, () => o.onProgress?.({ phase: 'waiting', loaded: total, total }))
  const store = readStore(storage)
  delete store[fp]
  writeStore(storage, store)
  return done
}

/** Drop an unfinished session (the person cancelled). */
export async function cancelUpload(file: File, target: UploadTarget, client: ApiClient, storage: UploadOptions['storage'] = typeof localStorage === 'undefined' ? null : localStorage) {
  const store = readStore(storage)
  const id = store[fingerprint(file, target)]
  if (!id) return
  delete store[fingerprint(file, target)]
  writeStore(storage, store)
  await client.call(API.cancelUploadSession, { params: { id } }).catch(() => {})
}

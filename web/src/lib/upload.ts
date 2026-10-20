// Uploads (tab 4 "업로드와 오래 걸리는 작업"): small files in one multipart request, larger ones as a chunked
// upload session (8 MB chunks, sha256 checked by the server). A session survives a dropped connection and a page
// reload: it is remembered per file (name, size, mtime, target) and continues from the chunks the server already has.
import { createSHA256 } from 'hash-wasm'
import { API, ApiError, SMALL_UPLOAD_MAX, UPLOAD_CHUNK_SIZE, type ApiClient, type UploadComplete, type UploadSession, type UploadTarget } from '@mycel/shared/api'

/** Up to this size one request is enough (and shows progress less needed); bigger files go chunked. */
export const SINGLE_REQUEST_MAX = 8 * 1024 * 1024

export interface UploadProgress {
  phase: 'hashing' | 'uploading' | 'finishing'
  loaded: number
  total: number
}

export interface UploadOptions {
  client: ApiClient
  onProgress?: (p: UploadProgress) => void
  signal?: AbortSignal
  /** where resumable sessions are remembered (default localStorage) */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null
  /** wait between retries (tests pass 0) */
  retryDelayMs?: number
  singleRequestMax?: number
}

const STORE_KEY = 'mycel.uploads'

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

const retryable = (e: unknown) => !(e instanceof ApiError) || e.status >= 500 || e.code === 'rate_limited' || e.code === 'unavailable'
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')) }, { once: true })
  })

async function withRetry<T>(fn: () => Promise<T>, o: UploadOptions, tries = 5): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (o.signal?.aborted || i >= tries - 1 || !retryable(e)) throw e
      await sleep((o.retryDelayMs ?? 1000) * 2 ** i, o.signal)
    }
  }
}

/** One file to a target. Returns what the server made of it (file entry, attachment or transcription job). */
export async function uploadFile(file: File, target: UploadTarget, o: UploadOptions): Promise<UploadComplete> {
  const max = Math.min(o.singleRequestMax ?? SINGLE_REQUEST_MAX, SMALL_UPLOAD_MAX)
  if (file.size <= max) return uploadSmall(file, target, o)
  return uploadChunked(file, target, o)
}

async function uploadSmall(file: File, target: UploadTarget, o: UploadOptions): Promise<UploadComplete> {
  o.onProgress?.({ phase: 'uploading', loaded: 0, total: file.size })
  let out: UploadComplete
  if (target.kind === 'path') {
    const slash = target.path.lastIndexOf('/')
    const folder = slash < 0 ? '' : target.path.slice(0, slash)
    const name = target.path.slice(slash + 1)
    const entry = await o.client.call(API.upload, { body: { fields: { folder, name, onExists: target.onExists }, file, filename: name }, signal: o.signal })
    out = { kind: 'path', entry }
  } else if (target.kind === 'attachment') {
    const attachment = await o.client.call(API.uploadAttachment, { body: { fields: { chatId: target.chatId, name: target.name }, file, filename: target.name }, signal: o.signal })
    out = { kind: 'attachment', attachment }
  } else {
    const { jobId } = await o.client.call(API.transcribe, { body: { fields: {}, file, filename: target.name }, signal: o.signal })
    out = { kind: 'transcribe', jobId }
  }
  o.onProgress?.({ phase: 'finishing', loaded: file.size, total: file.size })
  return out
}

async function uploadChunked(file: File, target: UploadTarget, o: UploadOptions): Promise<UploadComplete> {
  const storage = o.storage === undefined ? (typeof localStorage === 'undefined' ? null : localStorage) : o.storage
  const fp = fingerprint(file, target)
  const total = file.size
  o.onProgress?.({ phase: 'hashing', loaded: 0, total })
  const sha256 = await sha256Hex(file, (done) => o.onProgress?.({ phase: 'hashing', loaded: done, total }), o.signal)

  // resume a session for the same file if the server still has it
  let session: UploadSession | null = null
  const known = readStore(storage)[fp]
  if (known) {
    try {
      const s = await o.client.call(API.getUploadSession, { params: { id: known }, signal: o.signal })
      if (s.sha256 === sha256 && s.size === total) session = s
    } catch { /* expired or gone: start over */ }
  }
  if (!session) {
    session = await withRetry(() => o.client.call(API.createUploadSession, { body: { target, size: total, sha256 }, signal: o.signal }), o)
    writeStore(storage, { ...readStore(storage), [fp]: session.id })
  }

  const id = session.id
  const size = session.chunkSize
  let received = new Set(session.received)
  const report = () => o.onProgress?.({ phase: 'uploading', loaded: Math.min(total, received.size * size), total })
  report()
  for (let n = 0; n < session.chunkCount; n++) {
    if (received.has(n)) continue
    o.signal?.throwIfAborted()
    const chunk = file.slice(n * size, Math.min(total, (n + 1) * size))
    const r = await withRetry(async () => {
      try {
        return await o.client.call(API.uploadChunk, { params: { id, n: String(n) }, body: chunk, signal: o.signal })
      } catch (e) {
        // after a network drop, ask what arrived before sending again
        if (!(e instanceof ApiError)) {
          const s = await o.client.call(API.getUploadSession, { params: { id }, signal: o.signal }).catch(() => null)
          if (s?.received.includes(n)) return { received: s.received }
        }
        throw e
      }
    }, o)
    received = new Set(r.received)
    report()
  }
  o.onProgress?.({ phase: 'finishing', loaded: total, total })
  const done = await withRetry(() => o.client.call(API.completeUploadSession, { params: { id }, signal: o.signal }), o)
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

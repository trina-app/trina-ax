import { describe, expect, test } from 'bun:test'
import { ApiClient, ApiError, FileEntry, UPLOAD_CHUNK_SIZE, uuidv7, type UploadSession } from '@mycel/shared/api'
import { currentLocale, translate } from '../../src/i18n'
import { errorText } from '../../src/lib/api'
import { cancelUpload, fingerprint, REMEMBER_MAX, sha256Hex, uploadFile, uploadLabel, uploadPercent, type UploadProgress } from '../../src/lib/upload'

const entry = (path: string): FileEntry => ({ name: path.split('/').pop()!, path, type: 'file', size: 1, mtime: new Date().toISOString(), mime: null, access: 'write' })
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })

class MemStorage {
  m = new Map<string, string>()
  getItem(k: string) { return this.m.get(k) ?? null }
  setItem(k: string, v: string) { this.m.set(k, v) }
  removeItem(k: string) { this.m.delete(k) }
}

/** One try of a chunk: the shares that went out, then how it ended. */
type ChunkTry = { sent: number[]; end: 'ok' | 'net' | number }

/** A tiny upload-session server: records calls, can fail chunk PUTs on purpose. With `sent`, each watched request
 * reports those shares of its body before it is answered, as lib/xhr.ts does; `tries` scripts a chunk try by try. */
function fakeServer(o: { failChunk?: Set<number>; dropAfterStore?: Set<number>; refuseCreate?: { code: string; status: number }[]; sent?: number[]; tries?: Record<number, ChunkTry[]>; storedSize?: number } = {}) {
  const calls: string[] = []
  const watched: string[] = []
  const parts: { name: string; type: string; size: number; declared: FormDataEntryValue | null }[] = []
  const chunkBodies: Blob[] = []
  const chunkTries = new Map<number, number>()
  const stored = (fd: FormData) => {
    const file = fd.get('file') as File
    parts.push({ name: file.name, type: file.type, size: file.size, declared: fd.get('size') })
    return o.storedSize ?? file.size
  }
  const transcribeFields: Record<string, string>[] = []
  const sessions = new Map<string, UploadSession & { chunks: Map<number, number> }>()
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://t')
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${url.pathname}`)
    expect(new Headers(init?.headers).get('x-mycel-csrf') ?? (method === 'GET' ? '1' : null)).toBe('1')
    if (method === 'POST' && url.pathname === '/api/files/upload') {
      const fd = init!.body as FormData
      return json({ ...entry(`${fd.get('folder')}/${fd.get('name')}`), size: stored(fd) }, 201)
    }
    if (method === 'POST' && url.pathname === '/api/uploads') {
      const fd = init!.body as FormData
      return json({ id: uuidv7(), name: fd.get('name'), path: 'users/u/.attachments/c/a.pdf', size: stored(fd), mime: 'application/pdf', kind: 'pdf' }, 201)
    }
    if (method === 'POST' && url.pathname === '/api/transcribe') {
      const fd = init!.body as FormData
      stored(fd)
      transcribeFields.push(Object.fromEntries([...fd.entries()].filter(([, v]) => typeof v === 'string')) as Record<string, string>)
      return json({ jobId: uuidv7() }, 202)
    }
    if (method === 'POST' && url.pathname === '/api/upload-sessions') {
      const refused = o.refuseCreate?.shift()
      if (refused) return json({ error: { code: refused.code, message: refused.code } }, refused.status)
      const b = JSON.parse(String(init!.body))
      const s = { id: uuidv7(), target: b.target, size: b.size, sha256: b.sha256, chunkSize: UPLOAD_CHUNK_SIZE, chunkCount: Math.ceil(b.size / UPLOAD_CHUNK_SIZE), received: [], expiresAt: new Date(Date.now() + 1e6).toISOString(), chunks: new Map() }
      sessions.set(s.id, s)
      const { chunks: _c, ...out } = s
      return json(out, 201)
    }
    const m = url.pathname.match(/^\/api\/upload-sessions\/([^/]+)(?:\/(chunks)\/(\d+)|\/(complete))?$/)
    if (m) {
      const s = sessions.get(m[1]!)
      if (!s) return json({ error: { code: 'gone', message: 'gone' } }, 410)
      if (m[2]) {
        const n = Number(m[3])
        chunkBodies.push(init!.body as Blob)
        if (o.failChunk?.has(n)) {
          o.failChunk.delete(n)
          return json({ error: { code: 'internal', message: 'boom' } }, 500)
        }
        s.chunks.set(n, (init!.body as Blob).size)
        if (o.dropAfterStore?.has(n)) {
          o.dropAfterStore.delete(n)
          throw new TypeError('network dropped')
        }
        return json({ received: [...s.chunks.keys()].sort((a, b) => a - b) })
      }
      if (m[4]) return json(s.target.kind === 'transcribe' ? { kind: 'transcribe', jobId: uuidv7() } : { kind: 'path', entry: entry((s.target as { path: string }).path) })
      if (method === 'DELETE') {
        sessions.delete(s.id)
        return new Response(null, { status: 204 })
      }
      const { chunks, ...out } = s
      return json({ ...out, received: [...chunks.keys()] })
    }
    return json({ error: { code: 'not_found', message: 'nf' } }, 404)
  }) as typeof fetch
  const fetchWithProgress = async (input: string, init: RequestInit, onSent: (share: number) => void) => {
    watched.push(`${init.method} ${input}`)
    const n = Number(/chunks\/(\d+)$/.exec(input)?.[1] ?? -1)
    const script = o.tries?.[n]
    if (script) {
      const at = chunkTries.get(n) ?? 0
      chunkTries.set(n, at + 1)
      const step = script[Math.min(at, script.length - 1)]!
      for (const share of step.sent) onSent(share)
      if (step.end === 'net') throw new TypeError('Network request failed')
      if (step.end !== 'ok') return json({ error: { code: 'internal', message: 'boom' } }, step.end)
      return fetchFn(input, init)
    }
    for (const share of o.sent ?? []) onSent(share)
    return fetchFn(input, init)
  }
  return { calls, watched, parts, chunkBodies, sessions, transcribeFields, client: new ApiClient({ baseUrl: '', fetch: fetchFn, ...(o.sent || o.tries ? { fetchWithProgress } : {}) }) }
}

const bigFile = (chunks: number, extra = 10) => new File([new Uint8Array(UPLOAD_CHUNK_SIZE * chunks + extra).fill(7)], 'big.bin', { lastModified: 1 })

describe('uploads', () => {
  test('sha256 is computed in chunks and matches Bun', async () => {
    const f = bigFile(1, 12345)
    const expected = new Bun.CryptoHasher('sha256').update(new Uint8Array(await f.arrayBuffer())).digest('hex')
    expect(await sha256Hex(f)).toBe(expected)
  })

  test('small files go in one multipart request', async () => {
    const s = fakeServer()
    const r = await uploadFile(new File(['hello'], 'a.txt'), { kind: 'path', path: 'docs/a.txt', onExists: 'rename' }, { client: s.client, storage: null })
    expect(r.kind === 'path' && r.entry.path).toBe('docs/a.txt')
    expect(s.calls).toEqual(['POST /api/files/upload'])
  })

  test('a small file counts the bytes that went out, on the file\'s own size, and then says it is finishing', async () => {
    const s = fakeServer({ sent: [0.25, 0.5, 1] })
    const seen: UploadProgress[] = []
    const r = await uploadFile(new File([new Uint8Array(1000)], 'a.pdf'), { kind: 'path', path: 'docs/a.pdf', onExists: 'rename' }, { client: s.client, storage: null, reportEveryMs: 0, onProgress: (p) => seen.push(p) })
    expect(r.kind).toBe('path')
    expect(s.watched).toEqual(['POST /api/files/upload'])
    expect(seen.slice(0, 4)).toEqual([
      { phase: 'uploading', loaded: 0, total: 1000 },
      { phase: 'uploading', loaded: 250, total: 1000 },
      { phase: 'uploading', loaded: 500, total: 1000 },
      { phase: 'finishing', loaded: 1000, total: 1000 },
    ])
    expect(seen.at(-1)).toEqual({ phase: 'finishing', loaded: 1000, total: 1000 })
  })

  test('an upload nobody watches stays a plain fetch (voice input)', async () => {
    const s = fakeServer({ sent: [1] })
    await uploadFile(new File(['abc'], 'voice.webm'), { kind: 'transcribe', name: 'voice.webm' }, { client: s.client, storage: null })
    expect(s.calls).toEqual(['POST /api/transcribe'])
    expect(s.watched).toEqual([])
  })

  test('a client without a progress transport goes through its fetch: no numbers, the same result', async () => {
    const s = fakeServer()
    const seen: UploadProgress[] = []
    const r = await uploadFile(new File(['hello'], 'a.txt'), { kind: 'path', path: 'docs/a.txt', onExists: 'rename' }, { client: s.client, storage: null, onProgress: (p) => seen.push(p) })
    expect(r.kind).toBe('path')
    expect(seen.map((p) => p.phase)).toEqual(['uploading', 'finishing'])
  })

  test('a watched upload keeps the client\'s contract: CSRF header, ApiError from a refusal, parsed answer', async () => {
    const answers = [json({ error: { code: 'forbidden', message: 'no' } }, 403), json({ not: 'a file entry' }, 201)]
    const headers: Headers[] = []
    const client = new ApiClient({ baseUrl: '', fetch: (() => { throw new Error('not this one') }) as unknown as typeof fetch, fetchWithProgress: async (_input, init) => { headers.push(new Headers(init.headers)); return answers.shift()! } })
    const go = () => uploadFile(new File(['x'], 'a.txt'), { kind: 'path', path: 'a.txt', onExists: 'rename' }, { client, storage: null, onProgress: () => {} })
    const refused = await go().catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(ApiError)
    expect((refused as ApiError).code).toBe('forbidden')
    expect(headers[0]!.get('x-mycel-csrf')).toBe('1')
    expect(await go().catch((e: unknown) => (e as Error).name)).toBe('ZodError')
  })

  test('a large file counts the chunk that is on its way, on top of the chunks the server has', async () => {
    const s = fakeServer({ sent: [0.5, 1] })
    const seen: UploadProgress[] = []
    const half = UPLOAD_CHUNK_SIZE / 2
    await uploadFile(bigFile(1, half), { kind: 'path', path: 'x/big.bin', onExists: 'rename' }, { client: s.client, storage: null, retryDelayMs: 0, reportEveryMs: 0, onProgress: (p) => seen.push(p) })
    const sending = seen.filter((p) => p.phase === 'uploading').map((p) => p.loaded)
    expect(sending).toContain(half)
    expect(sending).toContain(UPLOAD_CHUNK_SIZE + half / 2)
    expect(sending).toEqual([...sending].sort((a, b) => a - b))
    expect(Math.max(...sending)).toBe(UPLOAD_CHUNK_SIZE + half)
    expect(s.watched.filter((c) => c.startsWith('PUT'))).toHaveLength(2)
    // the session calls around the chunks send no file bytes
    expect(s.watched.filter((c) => !c.startsWith('PUT'))).toEqual([])
  })

  describe('a chunk that is sent again', () => {
    const run = async (tries: Record<number, ChunkTry[]>) => {
      const s = fakeServer({ tries })
      const seen: UploadProgress[] = []
      await uploadFile(bigFile(2, 1000), { kind: 'path', path: 'x/big.bin', onExists: 'rename' }, { client: s.client, storage: null, retryDelayMs: 0, reportEveryMs: 0, onProgress: (p) => seen.push(p) })
      const sending = seen.filter((p) => p.phase === 'uploading')
      return { puts: s.watched.filter((c) => c.startsWith('PUT')).length, loaded: sending.map((p) => p.loaded), labels: seen.map((p) => uploadLabel(p, (k) => k)) }
    }
    const forward = (l: number[]) => expect(l).toEqual([...l].sort((a, b) => a - b))

    test('a lost connection late in a chunk does not take the number back', async () => {
      const r = await run({ 1: [{ sent: [0.3, 0.6, 0.9], end: 'net' }, { sent: [0.1, 0.5, 1], end: 'ok' }] })
      expect(r.puts).toBe(4)
      forward(r.loaded)
      expect(Math.max(...r.loaded)).toBe(UPLOAD_CHUNK_SIZE * 2 + 1000)
    })

    test('a 503 does not either', async () => {
      const r = await run({ 1: [{ sent: [0.5, 1], end: 503 }, { sent: [0.2, 1], end: 'ok' }] })
      expect(r.puts).toBe(4)
      forward(r.loaded)
    })

    test('on the first chunk the words do not go back to "preparing" after a number', async () => {
      const r = await run({ 0: [{ sent: [0.5, 0.9], end: 'net' }, { sent: [0.005, 0.5, 1], end: 'ok' }] })
      forward(r.loaded)
      const firstNumber = r.labels.findIndex((l) => l.endsWith('%'))
      expect(firstNumber).toBeGreaterThan(0)
      expect(r.labels.slice(firstNumber)).not.toContain('files.preparing')
    })

    test('a chunk that fails for good still ends the upload', async () => {
      const s = fakeServer({ tries: { 0: [{ sent: [0.5], end: 500 }] } })
      await expect(uploadFile(bigFile(1), { kind: 'path', path: 'x/big.bin', onExists: 'rename' }, { client: s.client, storage: null, retryDelayMs: 0, onProgress: () => {} })).rejects.toBeInstanceOf(ApiError)
      expect(s.watched.filter((c) => c.startsWith('PUT'))).toHaveLength(5)
    })
  })

  describe('a small file goes as a copy in memory (WebKit bug 319985: a File from disk can go out with no bytes)', () => {
    /** a File whose bytes are read through arrayBuffer(), as the page reads them */
    const counted = (bytes: number, name: string, type: string, read: () => Promise<ArrayBuffer>) => Object.assign(new File([new Uint8Array(bytes)], name, { type }), { arrayBuffer: read })

    test.each([
      ['a chat attachment', { kind: 'attachment', chatId: uuidv7(), name: '보고서.pdf' }, '보고서.pdf'],
      ['a team file', { kind: 'path', path: 'docs/보고서.pdf', onExists: 'rename' }, '보고서.pdf'],
      ['voice input', { kind: 'transcribe', name: 'voice.webm' }, 'voice.webm'],
    ] as const)('%s: read first, and the name, the type and the bytes go with it', async (_label, target, name) => {
      const s = fakeServer()
      let reads = 0
      const file = counted(1000, 'picked-name.pdf', 'application/pdf', async () => { reads++; return new Uint8Array(1000).fill(7).buffer })
      await uploadFile(file, target, { client: s.client, storage: null })
      expect(reads).toBe(1)
      expect(s.parts).toEqual([{ name, type: 'application/pdf', size: 1000, declared: target.kind === 'transcribe' ? null : '1000' }])
    })

    test('a file that cannot be read fails at once, and nothing is sent', async () => {
      const s = fakeServer()
      const gone = new DOMException('the file is gone', 'NotReadableError')
      const file = counted(1000, 'a.pdf', 'application/pdf', async () => { throw gone })
      expect(await uploadFile(file, { kind: 'path', path: 'a.pdf', onExists: 'rename' }, { client: s.client, storage: null }).catch((e: unknown) => e)).toBe(gone)
      expect(s.calls).toEqual([])
      // the screen's words for it: the network text, not a message of the browser
      expect(errorText(gone, 'ko', 'network')).toBe('network')
    })

    test('cancelled while it is read: nothing is sent', async () => {
      const s = fakeServer()
      const stop = new AbortController()
      const file = counted(1000, 'a.pdf', 'application/pdf', async () => { stop.abort(); return new ArrayBuffer(1000) })
      const e = await uploadFile(file, { kind: 'path', path: 'a.pdf', onExists: 'rename' }, { client: s.client, storage: null, signal: stop.signal }).catch((x: unknown) => x)
      expect((e as DOMException).name).toBe('AbortError')
      expect(s.calls).toEqual([])
    })
  })

  describe('small files take turns: each copy stays in memory until its request ends', () => {
    const tick = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)) }
    const target = (n: number) => ({ kind: 'path', path: `docs/${n}.pdf`, onExists: 'rename' }) as const
    const pdf = (n: number) => new File([new Uint8Array(100)], `${n}.pdf`)

    /** A server whose answers wait for `open`. `peak` counts requests that are on their way together. */
    function held() {
      const waiting: { answer: () => void; name: string }[] = []
      const started: string[] = []
      let now = 0
      let peak = 0
      const fetchFn = (async (_input: string, init: RequestInit) => {
        const fd = init.body as FormData
        const name = String(fd.get('name'))
        started.push(name)
        peak = Math.max(peak, ++now)
        await new Promise<void>((resolve, reject) => {
          waiting.push({ answer: resolve, name })
          init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
        }).finally(() => { now-- })
        return json({ ...entry(`docs/${name}`), size: (fd.get('file') as File).size }, 201)
      }) as unknown as typeof fetch
      return { client: new ApiClient({ baseUrl: '', fetch: fetchFn }), started, waiting, peak: () => peak, open: () => waiting.shift()!.answer() }
    }

    test('three at a time, in the order they came, and all go through', async () => {
      const s = held()
      const all = Promise.all([1, 2, 3, 4, 5, 6, 7].map((n) => uploadFile(pdf(n), target(n), { client: s.client, storage: null })))
      await tick()
      expect(s.started).toEqual(['1.pdf', '2.pdf', '3.pdf'])
      s.open()
      await tick()
      expect(s.started).toEqual(['1.pdf', '2.pdf', '3.pdf', '4.pdf'])
      for (let n = 0; n < 6; n++) {
        s.open()
        await tick()
      }
      expect((await all).map((r) => r.kind)).toEqual(Array(7).fill('path'))
      expect(s.peak()).toBe(3)
    })

    test('a file in line is not read yet, and says it is preparing', async () => {
      const s = held()
      let reads = 0
      const counted = (n: number) => Object.assign(pdf(n), { arrayBuffer: async () => { reads++; return new ArrayBuffer(100) } })
      const seen: (UploadProgress | null)[] = []
      const all = Promise.all([1, 2, 3, 4, 5].map((n) => uploadFile(counted(n), target(n), { client: s.client, storage: null, onProgress: (p) => n === 5 && seen.push(p) })))
      await tick()
      expect(reads).toBe(3)
      expect(seen.map((p) => uploadLabel(p, (k) => k))).toEqual(['files.preparing'])
      for (let n = 0; n < 5; n++) {
        s.open()
        await tick()
      }
      await all
      expect(reads).toBe(5)
    })

    test('cancelled in line: it leaves at once, is never read, and the next one does not wait for it', async () => {
      const s = held()
      const first = [1, 2, 3].map((n) => uploadFile(pdf(n), target(n), { client: s.client, storage: null }))
      const stop = new AbortController()
      let read = false
      const inLine = Object.assign(pdf(4), { arrayBuffer: async () => { read = true; return new ArrayBuffer(100) } })
      const cancelled = uploadFile(inLine, target(4), { client: s.client, storage: null, signal: stop.signal }).catch((e: unknown) => e)
      const after = uploadFile(pdf(5), target(5), { client: s.client, storage: null })
      await tick()
      stop.abort()
      expect(((await cancelled) as DOMException).name).toBe('AbortError')
      for (let n = 0; n < 3; n++) {
        s.open()
        await tick()
      }
      await tick()
      expect(s.started).toEqual(['1.pdf', '2.pdf', '3.pdf', '5.pdf'])
      s.open()
      await Promise.all([...first, after])
      expect(read).toBe(false)
    })

    test('an upload that ends badly gives its place on: a refusal, a lost connection, a file that cannot be read, a cancel', async () => {
      const go = async (fail: (f: File, t: ReturnType<typeof target>) => Promise<unknown>) => {
        // four at once: the fourth starts only when one of the first three ended, whichever way it ended
        const s = held()
        const ok = [2, 3].map((n) => uploadFile(pdf(n), target(n), { client: s.client, storage: null }))
        const bad = fail(pdf(1), target(1)).catch(() => 'failed')
        const next = uploadFile(pdf(9), target(9), { client: s.client, storage: null })
        expect(await bad).toBe('failed')
        await tick()
        expect(s.started).toContain('9.pdf')
        for (let n = 0; n < 3; n++) {
          s.open()
          await tick()
        }
        await Promise.all([...ok, next])
      }
      const refusing = new ApiClient({ baseUrl: '', fetch: (async () => json({ error: { code: 'forbidden', message: 'no' } }, 403)) as unknown as typeof fetch })
      await go((f, t) => uploadFile(f, t, { client: refusing, storage: null }))
      const lost = new ApiClient({ baseUrl: '', fetch: (async () => { throw new TypeError('Network request failed') }) as unknown as typeof fetch })
      // (a lost connection is waited for: here no time at all, so it ends now)
      await go((f, t) => uploadFile(f, t, { client: lost, storage: null, connectionWaitMs: 0 }))
      await go((f, t) => uploadFile(Object.assign(f, { arrayBuffer: async () => { throw new DOMException('gone', 'NotReadableError') } }), t, { client: lost, storage: null, connectionWaitMs: 0 }))
      const stop = new AbortController()
      const stopping = held()
      await go((f, t) => {
        const r = uploadFile(f, t, { client: stopping.client, storage: null, signal: stop.signal })
        setTimeout(() => stop.abort(), 0)
        return r
      })
    })

    test('a large file holds a place for each chunk only, so other files get in between its chunks', async () => {
      const waiting: { n: string; go: () => void }[] = []
      const order: string[] = []
      let session: UploadSession | null = null
      const fetchFn = (async (input: string, init: RequestInit) => {
        if (input === '/api/upload-sessions') {
          const b = JSON.parse(String(init.body))
          session = { id: uuidv7(), target: b.target, size: b.size, sha256: b.sha256, chunkSize: UPLOAD_CHUNK_SIZE, chunkCount: Math.ceil(b.size / UPLOAD_CHUNK_SIZE), received: [], expiresAt: new Date(Date.now() + 1e6).toISOString() }
          return json(session, 201)
        }
        if (input.endsWith('/complete')) return json({ kind: 'path', entry: entry('x/big.bin') })
        const n = /chunks\/(\d+)$/.exec(input)?.[1] ?? String((init.body as FormData).get('name'))
        order.push(n)
        await new Promise<void>((go) => waiting.push({ n, go }))
        if (/chunks/.test(input)) {
          session!.received.push(Number(n))
          return json({ received: session!.received })
        }
        return json({ ...entry('x'), size: 100 }, 201)
      }) as unknown as typeof fetch
      const client = new ApiClient({ baseUrl: '', fetch: fetchFn })
      const large = uploadFile(bigFile(1), { kind: 'path', path: 'x/big.bin', onExists: 'rename' }, { client, storage: null, retryDelayMs: 0 })
      for (let i = 0; i < 40 && !order.length; i++) await tick()
      expect(order).toEqual(['0'])
      const small = [1, 2, 3].map((n) => uploadFile(pdf(n), target(n), { client, storage: null }))
      await tick()
      expect(order).toEqual(['0', '1.pdf', '2.pdf'])
      // the first chunk ends: its place goes to the next file in line, and the second chunk goes to the end of the line
      waiting.shift()!.go()
      for (let i = 0; i < 40 && order.length < 4; i++) await tick()
      expect(order).toEqual(['0', '1.pdf', '2.pdf', '3.pdf'])
      for (let i = 0; i < 4; i++) {
        waiting.shift()?.go()
        await tick()
      }
      await Promise.all([large, ...small])
      expect(order).toEqual(['0', '1.pdf', '2.pdf', '3.pdf', '1'])
    })

    test('voice input does not stand in line: three uploads that stopped do not hold it up', async () => {
      const s = held()
      const stopped = [1, 2, 3].map((n) => uploadFile(pdf(n), target(n), { client: s.client, storage: null }))
      await tick()
      const voice = fakeServer()
      expect((await uploadFile(new File(['abc'], 'voice.webm'), { kind: 'transcribe', name: 'voice.webm' }, { client: voice.client, storage: null })).kind).toBe('transcribe')
      expect((await uploadFile(bigFile(1), { kind: 'transcribe', name: 'long.webm' }, { client: voice.client, storage: null, retryDelayMs: 0 })).kind).toBe('transcribe')
      expect(s.waiting).toHaveLength(3)
      for (let n = 0; n < 3; n++) s.open()
      await Promise.all(stopped)
    })

    test('a chunk goes as a copy in memory, each try, and the bytes are the chunk\'s own', async () => {
      const s = fakeServer({ failChunk: new Set([0]) })
      let reads = 0
      const real = Blob.prototype.arrayBuffer
      Blob.prototype.arrayBuffer = function () { if (this.size === UPLOAD_CHUNK_SIZE) reads++; return real.call(this) }
      try {
        await uploadFile(bigFile(1), { kind: 'path', path: 'x/big.bin', onExists: 'rename' }, { client: s.client, storage: null, retryDelayMs: 0 })
      } finally {
        Blob.prototype.arrayBuffer = real
      }
      expect(s.chunkBodies.map((b) => b.size)).toEqual([UPLOAD_CHUNK_SIZE, UPLOAD_CHUNK_SIZE, 10])
      // the hash reads the first chunk once, each of its two tries once more; the small tail is another size
      expect(reads).toBe(3)
      expect(new Uint8Array(await s.chunkBodies[2]!.arrayBuffer())).toEqual(new Uint8Array(10).fill(7))
    })

    test('cancelled while a chunk waits for its place: it leaves the line, and nothing more goes up', async () => {
      const s = held()
      const stopped = [1, 2, 3].map((n) => uploadFile(pdf(n), target(n), { client: s.client, storage: null }))
      const large = fakeServer()
      const stop = new AbortController()
      const cancelled = uploadFile(bigFile(1), { kind: 'path', path: 'x/big.bin', onExists: 'rename' }, { client: large.client, storage: null, retryDelayMs: 0, signal: stop.signal }).catch((e: unknown) => e)
      for (let i = 0; i < 40 && !large.calls.length; i++) await tick()
      await tick()
      stop.abort()
      expect(((await cancelled) as DOMException).name).toBe('AbortError')
      expect(large.calls.filter((c) => c.startsWith('PUT'))).toEqual([])
      for (let n = 0; n < 3; n++) s.open()
      await Promise.all(stopped)
    })

    describe('an upload that has stopped moving', () => {
      const ms = (n: number) => new Promise((r) => setTimeout(r, n))
      /** the places are all free again: three go at once, the fourth waits */
      const placesAreBack = async () => {
        const s = held()
        const all = [1, 2, 3, 4].map((n) => uploadFile(pdf(n), target(n), { client: s.client, storage: null }))
        await tick()
        expect(s.started).toEqual(['1.pdf', '2.pdf', '3.pdf'])
        for (let n = 0; n < 4; n++) {
          s.open()
          await tick()
        }
        await Promise.all(all)
      }

      test('after 20 s with no byte out it gives its place back: the fourth upload ends while three stay stopped', async () => {
        const s = held()
        const stopped = [1, 2, 3].map((n) => uploadFile(pdf(n), target(n), { client: s.client, storage: null, placeIdleMs: 5 }))
        const fourth = uploadFile(pdf(4), target(4), { client: fakeServer().client, storage: null })
        expect((await fourth).kind).toBe('path')
        expect(s.waiting).toHaveLength(3)
        for (let n = 0; n < 3; n++) s.open()
        await Promise.all(stopped)
        await placesAreBack()
      })

      test('the place goes back once: an upload that ends after that takes no second place along', async () => {
        const s = held()
        const stopped = [1, 2, 3].map((n) => uploadFile(pdf(n), target(n), { client: s.client, storage: null, placeIdleMs: 5 }))
        await ms(30)
        for (let n = 0; n < 3; n++) s.open()
        await Promise.all(stopped)
        await placesAreBack()
        await placesAreBack()
      })

      test('bytes that go out keep the place: a slow upload is not taken for a stopped one', async () => {
        let moving = true
        const slow = new ApiClient({
          baseUrl: '',
          fetchWithProgress: async (_input, _init, onSent) => {
            for (let i = 1; i < 12; i++) {
              onSent(i / 20)
              await ms(5)
            }
            moving = false
            return json({ ...entry('docs/x'), size: 100 }, 201)
          },
        })
        const three = [1, 2, 3].map((n) => uploadFile(pdf(n), target(n), { client: slow, storage: null, placeIdleMs: 30, reportEveryMs: 0, onProgress: () => {} }))
        const s = held()
        const fourth = uploadFile(pdf(4), target(4), { client: s.client, storage: null })
        await Promise.all(three)
        expect(moving).toBe(false)
        await tick()
        expect(s.started).toEqual(['4.pdf'])
        s.open()
        await fourth
      })

      test('at most three go on without a place: six at a time at the very most, as a browser opens to one host', async () => {
        const s = held()
        const all = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => uploadFile(pdf(n), target(n), { client: s.client, storage: null, placeIdleMs: 3 }))
        await ms(60)
        expect(s.started).toHaveLength(6)
        s.open()
        await ms(40)
        expect(s.started).toHaveLength(7)
        for (let n = 0; n < 7; n++) {
          await ms(15)
          if (s.waiting.length) s.open()
        }
        for (let i = 0; i < 40 && s.waiting.length; i++) {
          s.open()
          await tick()
        }
        await Promise.all(all)
        await placesAreBack()
      })
    })
  })

  describe('the size the server kept', () => {
    const attachment = () => ({ kind: 'attachment', chatId: uuidv7(), name: 'a.pdf' }) as const
    const path = { kind: 'path', path: 'docs/a.pdf', onExists: 'rename' } as const
    const thousand = () => new File([new Uint8Array(1000)], 'a.pdf')

    test.each([['a chat attachment', attachment()], ['a team file', path]] as const)('%s: 0 bytes kept of 1000 is a failed upload, in words', async (_label, target) => {
      const s = fakeServer({ storedSize: 0 })
      const e = await uploadFile(thousand(), target, { client: s.client, storage: null }).catch((x: unknown) => x)
      expect(e).toBeInstanceOf(ApiError)
      expect(errorText(e, currentLocale(), 'network')).toBe(translate(currentLocale(), 'files.incompleteUpload'))
    })

    test('an empty file stays an upload (.gitkeep), and says it is empty', async () => {
      const s = fakeServer()
      const r = await uploadFile(new File([], '.gitkeep'), { kind: 'path', path: 'docs/.gitkeep', onExists: 'rename' }, { client: s.client, storage: null })
      expect(r.kind).toBe('path')
      expect(s.parts[0]).toMatchObject({ size: 0, declared: '0' })
    })
  })

  test('the bytes are reported sparingly: a new whole percent, at most every 250 ms; the last byte at once', async () => {
    const s = fakeServer({ sent: [0.1, 0.2, 0.3, 1] })
    const seen: UploadProgress[] = []
    await uploadFile(new File([new Uint8Array(1000)], 'a.pdf'), { kind: 'path', path: 'docs/a.pdf', onExists: 'rename' }, { client: s.client, storage: null, onProgress: (p) => seen.push(p) })
    expect(seen.filter((p) => p.phase === 'uploading').map((p) => p.loaded)).toEqual([0, 100])
    expect(seen.filter((p) => p.phase === 'finishing').length).toBeGreaterThan(0)

    const same = fakeServer({ sent: [0.101, 0.102, 0.103, 0.2] })
    const again: number[] = []
    await uploadFile(new File([new Uint8Array(1000)], 'a.pdf'), { kind: 'path', path: 'docs/a.pdf', onExists: 'rename' }, { client: same.client, storage: null, reportEveryMs: 0, onProgress: (p) => p.phase === 'uploading' && again.push(p.loaded) })
    expect(again).toEqual([0, 101, 200])
  })

  test('what a running upload says: a number only for bytes on their way, never 0 or 100', () => {
    const at = (phase: UploadProgress['phase'], loaded: number, total = 1000) => ({ phase, loaded, total })
    expect(uploadPercent(null)).toBeNull()
    expect(uploadPercent(at('hashing', 1000))).toBeNull()
    expect(uploadPercent(at('uploading', 0))).toBeNull()
    expect(uploadPercent(at('uploading', 9))).toBeNull()
    expect(uploadPercent(at('uploading', 10))).toBe(1)
    expect(uploadPercent(at('uploading', 500))).toBe(50)
    expect(uploadPercent(at('uploading', 996))).toBe(99)
    expect(uploadPercent(at('uploading', 1000))).toBe(99)
    expect(uploadPercent(at('finishing', 1000))).toBeNull()
    expect(uploadPercent(at('uploading', 0, 0))).toBeNull()

    const t = (key: string) => key
    expect(uploadLabel(null, t)).toBe('files.preparing')
    expect(uploadLabel(at('hashing', 700), t)).toBe('files.preparing')
    expect(uploadLabel(at('uploading', 0), t)).toBe('files.preparing')
    expect(uploadLabel(at('uploading', 420), t)).toBe('42%')
    expect(uploadLabel(at('uploading', 1000), t)).toBe('99%')
    expect(uploadLabel(at('finishing', 1000), t)).toBe('files.finishing')
  })

  test('voice input names its chat (the server refuses to send a confidential chat\'s recording out), small and chunked', async () => {
    const s = fakeServer()
    const chatId = uuidv7()
    const r = await uploadFile(new File(['abc'], 'voice.webm'), { kind: 'transcribe', name: 'voice.webm', chatId }, { client: s.client, storage: null })
    expect(r.kind).toBe('transcribe')
    expect(s.transcribeFields).toEqual([{ chatId }])
    // a new chat (no id yet): no chat field
    await uploadFile(new File(['abc'], 'voice.webm'), { kind: 'transcribe', name: 'voice.webm' }, { client: s.client, storage: null })
    expect(s.transcribeFields[1]).toEqual({})
    const long = await uploadFile(bigFile(1), { kind: 'transcribe', name: 'long.webm', chatId }, { client: s.client, storage: null, retryDelayMs: 0 })
    expect(long.kind).toBe('transcribe')
    expect([...s.sessions.values()][0]!.target).toEqual({ kind: 'transcribe', name: 'long.webm', chatId })
  })

  test('large files use a chunked session: create, every chunk, complete', async () => {
    const s = fakeServer()
    const progress: string[] = []
    const r = await uploadFile(bigFile(2), { kind: 'path', path: 'video/big.bin', onExists: 'rename' }, { client: s.client, storage: new MemStorage(), retryDelayMs: 0, onProgress: (p) => progress.push(p.phase) })
    expect(r.kind).toBe('path')
    expect(s.calls).toEqual(['POST /api/upload-sessions', 'PUT /api/upload-sessions/' + [...s.sessions.keys()][0] + '/chunks/0', 'PUT /api/upload-sessions/' + [...s.sessions.keys()][0] + '/chunks/1', 'PUT /api/upload-sessions/' + [...s.sessions.keys()][0] + '/chunks/2', 'POST /api/upload-sessions/' + [...s.sessions.keys()][0] + '/complete'])
    expect(progress[0]).toBe('hashing')
    expect(progress.at(-1)).toBe('finishing')
  })

  test('a 5xx chunk is retried; a dropped connection asks what arrived instead of resending blindly', async () => {
    const s = fakeServer({ failChunk: new Set([1]), dropAfterStore: new Set([0]) })
    await uploadFile(bigFile(1), { kind: 'path', path: 'x/big.bin', onExists: 'rename' }, { client: s.client, storage: null, retryDelayMs: 0 })
    const id = [...s.sessions.keys()][0]
    const puts = s.calls.filter((c) => c.startsWith('PUT'))
    expect(puts).toEqual([`PUT /api/upload-sessions/${id}/chunks/0`, `PUT /api/upload-sessions/${id}/chunks/1`, `PUT /api/upload-sessions/${id}/chunks/1`])
    expect(s.calls).toContain(`GET /api/upload-sessions/${id}`)
  })

  test('a 507 at session create ends the file at once, a 5xx there is retried', async () => {
    const creates = (s: ReturnType<typeof fakeServer>) => s.calls.filter((c) => c === 'POST /api/upload-sessions').length
    const full = fakeServer({ refuseCreate: [{ code: 'storage_full', status: 507 }] })
    const refused = await uploadFile(bigFile(1), { kind: 'path', path: 'x/big.bin', onExists: 'rename' }, { client: full.client, storage: null, retryDelayMs: 0 }).catch((e: unknown) => e)
    expect((refused as ApiError).code).toBe('storage_full')
    expect(creates(full)).toBe(1)
    const flaky = fakeServer({ refuseCreate: [{ code: 'internal', status: 500 }] })
    await uploadFile(bigFile(1), { kind: 'path', path: 'x/big.bin', onExists: 'rename' }, { client: flaky.client, storage: null, retryDelayMs: 0 })
    expect(creates(flaky)).toBe(2)
  })

  test('after a reload the same file continues the remembered session from the missing chunks', async () => {
    const storage = new MemStorage()
    const s = fakeServer()
    const file = bigFile(2)
    const target = { kind: 'path' as const, path: 'v/big.bin', onExists: 'rename' as const }
    const ctrl = new AbortController()
    // first attempt: stop after chunk 0
    const first = uploadFile(file, target, {
      client: s.client,
      storage,
      retryDelayMs: 0,
      signal: ctrl.signal,
      onProgress: (p) => {
        if (p.phase === 'uploading' && p.loaded >= UPLOAD_CHUNK_SIZE) ctrl.abort()
      },
    })
    await expect(first).rejects.toThrow()
    const id = [...s.sessions.keys()][0]!
    expect(JSON.parse(storage.getItem('mycel.uploads')!)).toEqual({ [fingerprint(file, target)]: id })
    s.calls.length = 0
    await uploadFile(file, target, { client: s.client, storage, retryDelayMs: 0 })
    expect(s.calls[0]).toBe(`GET /api/upload-sessions/${id}`)
    expect(s.calls.filter((c) => c.startsWith('PUT'))).toEqual([`PUT /api/upload-sessions/${id}/chunks/1`, `PUT /api/upload-sessions/${id}/chunks/2`])
    expect(storage.getItem('mycel.uploads')).toBeNull()
  })

  test('cancelling a stopped upload drops the server session and forgets it (no resume, no open slot held)', async () => {
    const storage = new MemStorage()
    const s = fakeServer()
    const file = bigFile(2)
    const target = { kind: 'path' as const, path: 'v/cancel.bin', onExists: 'rename' as const }
    const ctrl = new AbortController()
    await expect(uploadFile(file, target, { client: s.client, storage, retryDelayMs: 0, signal: ctrl.signal, onProgress: (p) => p.phase === 'uploading' && p.loaded > 0 && ctrl.abort() })).rejects.toThrow()
    const id = [...s.sessions.keys()][0]!
    await cancelUpload(file, target, s.client, storage)
    expect(s.calls.at(-1)).toBe(`DELETE /api/upload-sessions/${id}`)
    expect(s.sessions.size).toBe(0)
    expect(storage.getItem('mycel.uploads')).toBeNull()
  })

  test('remembered unfinished sessions are bounded (oldest forgotten first)', async () => {
    const storage = new MemStorage()
    const old: Record<string, string> = {}
    for (let i = 0; i < REMEMBER_MAX + 10; i++) old[`stale-${i}`] = uuidv7()
    storage.setItem('mycel.uploads', JSON.stringify(old))
    const s = fakeServer()
    const file = bigFile(1)
    // the person leaves while it uploads: the session stays remembered
    const stop = new AbortController()
    await uploadFile(file, { kind: 'path', path: 'x/big.bin', onExists: 'rename' }, { client: s.client, storage, retryDelayMs: 0, signal: stop.signal, onProgress: (p) => p.phase === 'uploading' && stop.abort() }).catch(() => {})
    const kept = JSON.parse(storage.getItem('mycel.uploads')!) as Record<string, string>
    expect(Object.keys(kept)).toHaveLength(REMEMBER_MAX)
    expect(kept['stale-0']).toBeUndefined()
    expect(Object.keys(kept).at(-1)).toBe(fingerprint(file, { kind: 'path', path: 'x/big.bin', onExists: 'rename' }))
  })
})

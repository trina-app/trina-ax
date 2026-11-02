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
  return { calls, watched, parts, sessions, transcribeFields, client: new ApiClient({ baseUrl: '', fetch: fetchFn, ...(o.sent || o.tries ? { fetchWithProgress } : {}) }) }
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

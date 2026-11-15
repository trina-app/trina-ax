// Several chunks of one large file at once (lib/upload.ts sendChunks, CHUNKS_AT_ONCE), inside the page's line of
// uploads (COPIES_AT_ONCE): the order they start in, a retry, a chunk that fails for good, the caps, the resume.
import { describe, expect, test } from 'bun:test'
import { ApiClient, ApiError, FileEntry, uuidv7, type UploadSession } from '@mycel/shared/api'
import { CHUNKS_AT_ONCE, COPIES_AT_ONCE, sendChunks, uploadFile, type UploadProgress } from '../../src/lib/upload'

const tick = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)) }
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
const entry = (path: string): FileEntry => ({ name: path.split('/').pop()!, path, type: 'file', size: 1, mtime: new Date().toISOString(), mime: null, access: 'write' })
/** The fake servers here take chunks of this size (the session says so; the page follows it), so the files stay small
 * and quick to hash; `big` makes any file over SMALL go chunked. */
const CHUNK = 1000
const big = { singleRequestMax: 100 } as const
const bigFile = (chunks: number, extra = 10, name = 'big.bin') => new File([new Uint8Array(CHUNK * chunks + extra).fill(7)], name, { lastModified: 1 })
const target = (path: string) => ({ kind: 'path', path, onExists: 'rename' }) as const

/** sendChunks with chunks that end when the test says so */
function held() {
  const started: number[] = []
  const ends = new Map<number, { ok: () => void; fail: (e: unknown) => void; signal: AbortSignal }>()
  let now = 0
  let peak = 0
  const send = (n: number, signal: AbortSignal) => {
    started.push(n)
    peak = Math.max(peak, ++now)
    return new Promise<void>((ok, fail) => {
      ends.set(n, { ok, fail, signal })
      signal.addEventListener('abort', () => fail(signal.reason), { once: true })
    }).finally(() => { now-- })
  }
  return { started, ends, send, peak: () => peak, inFlight: () => now }
}

describe('sendChunks: the chunks of one file, a few at a time', () => {
  test('they start in order, never more than the width at once, and all go', async () => {
    const h = held()
    const all = sendChunks([0, 1, 2, 3, 4, 5, 6], 3, h.send)
    await tick()
    expect(h.started).toEqual([0, 1, 2])
    // a later chunk may end first: the next in order takes its lane
    h.ends.get(2)!.ok()
    await tick()
    expect(h.started).toEqual([0, 1, 2, 3])
    for (const n of [0, 1, 3, 4, 5, 6]) {
      for (let i = 0; i < 20 && !h.ends.has(n); i++) await tick()
      h.ends.get(n)!.ok()
      await tick()
    }
    await all
    expect(h.started).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(h.peak()).toBe(3)
  })

  test('only what is pending goes (a resume skips the chunks the server has); a width wider than that is fine', async () => {
    const h = held()
    const all = sendChunks([1, 3], 5, h.send)
    await tick()
    expect(h.started).toEqual([1, 3])
    h.ends.get(1)!.ok()
    h.ends.get(3)!.ok()
    await all
    // nothing at all to send: it ends at once
    await sendChunks([], 3, h.send)
    // a width of 0 or less still sends, one at a time
    const one = held()
    const p = sendChunks([0, 1], 0, one.send)
    await tick()
    expect(one.started).toEqual([0])
    one.ends.get(0)!.ok()
    await tick()
    one.ends.get(1)!.ok()
    await p
    expect(one.peak()).toBe(1)
  })

  test('a chunk that fails stops the file: no other starts, those on their way are stopped, its own error is thrown', async () => {
    const h = held()
    const boom = new ApiError(400, { code: 'validation', message: 'bad chunk' })
    const all = sendChunks([0, 1, 2, 3, 4], 3, h.send).catch((e: unknown) => e)
    await tick()
    h.ends.get(1)!.fail(boom)
    expect(await all).toBe(boom)
    // the two beside it got the stop; chunks 3 and 4 never started
    expect(h.ends.get(0)!.signal.aborted).toBe(true)
    expect(h.ends.get(2)!.signal.aborted).toBe(true)
    expect(h.started).toEqual([0, 1, 2])
    expect(h.inFlight()).toBe(0)
  })

  test('it ends only when every chunk on its way has ended', async () => {
    const boom = new Error('boom')
    let slowEnded = false
    const send = async (n: number) => {
      if (n === 0) throw boom
      // a chunk that does not listen to the stop: waited for anyway
      await new Promise((r) => setTimeout(r, 30))
      slowEnded = true
    }
    expect(await sendChunks([0, 1], 2, send).catch((e: unknown) => e)).toBe(boom)
    expect(slowEnded).toBe(true)
  })

  test('the file is stopped: the chunks on their way are stopped and the stop\'s reason is thrown', async () => {
    const h = held()
    const stop = new AbortController()
    const all = sendChunks([0, 1, 2, 3], 2, h.send, stop.signal).catch((e: unknown) => e)
    await tick()
    stop.abort(new DOMException('stopped', 'AbortError'))
    expect(((await all) as DOMException).name).toBe('AbortError')
    expect(h.started).toEqual([0, 1])
    // stopped already: nothing starts
    const none = held()
    expect(((await sendChunks([0], 2, none.send, stop.signal).catch((e: unknown) => e)) as DOMException).name).toBe('AbortError')
    expect(none.started).toEqual([])
  })

  test('stopped just as the last chunk ended: still a stop (no complete follows)', async () => {
    const stop = new AbortController()
    const send = async (n: number) => { if (n === 1) stop.abort() }
    expect(await sendChunks([0, 1], 2, send, stop.signal).then(() => 'went on', () => 'stopped')).toBe('stopped')
  })
})

/** An upload-session server whose chunk answers wait for the test (or come at once with `auto`). Counts the requests on
 * their way together, chunks and small files alike. */
function chunkServer(o: { auto?: boolean; fail?: Record<number, (number | 'net')[]>; received?: number[] } = {}) {
  const sessions = new Map<string, UploadSession>()
  const calls: string[] = []
  const waiting: { key: string; go: () => void }[] = []
  let now = 0
  let peak = 0
  const fails = new Map(Object.entries(o.fail ?? {}).map(([k, v]) => [Number(k), [...v]]))
  const fetchFn = (async (input: string, init: RequestInit) => {
    const method = init.method ?? 'GET'
    calls.push(`${method} ${input}`)
    if (method === 'POST' && input === '/api/upload-sessions') {
      const b = JSON.parse(String(init.body))
      const s: UploadSession = { id: uuidv7(), target: b.target, size: b.size, sha256: b.sha256, chunkSize: CHUNK, chunkCount: Math.ceil(b.size / CHUNK), received: [...(o.received ?? [])], expiresAt: new Date(Date.now() + 1e6).toISOString() }
      sessions.set(s.id, s)
      return json(s, 201)
    }
    const m = /^\/api\/upload-sessions\/([^/]+)(?:\/chunks\/(\d+)|\/(complete))?$/.exec(input)
    const isFile = input === '/api/files/upload'
    if (m || isFile) {
      const s = m ? sessions.get(m[1]!)! : null
      if (m && m[3]) {
        // complete: every chunk must be there
        const missing = Array.from({ length: s!.chunkCount }, (_, i) => i).filter((i) => !s!.received.includes(i))
        if (missing.length) return json({ error: { code: 'conflict', message: `missing ${missing}` } }, 409)
        return json({ kind: 'path', entry: entry((s!.target as { path: string }).path) })
      }
      if (m && !m[2]) return json(s)
      const n = m ? Number(m[2]) : -1
      peak = Math.max(peak, ++now)
      try {
        if (!o.auto) {
          await new Promise<void>((go, stop) => {
            waiting.push({ key: m ? `${s!.id.slice(-4)}:${n}` : String((init.body as FormData).get('name')), go })
            init.signal?.addEventListener('abort', () => stop(init.signal!.reason), { once: true })
          })
        } else await new Promise((r) => setTimeout(r, 1))
      } finally { now-- }
      const f = fails.get(n)?.shift()
      if (f === 'net') throw new TypeError('Network request failed')
      if (typeof f === 'number') return json({ error: { code: f >= 500 ? 'internal' : 'validation', message: 'boom' } }, f)
      if (isFile) return json({ ...entry('docs/x'), size: ((init.body as FormData).get('file') as File).size }, 201)
      if (!s!.received.includes(n)) s!.received.push(n)
      return json({ received: [...s!.received].sort((a, b) => a - b) })
    }
    return json({ error: { code: 'not_found', message: 'nf' } }, 404)
  }) as unknown as typeof fetch
  const puts = () => calls.filter((c) => c.startsWith('PUT')).map((c) => Number(/chunks\/(\d+)$/.exec(c)![1]))
  return { client: new ApiClient({ baseUrl: '', fetch: fetchFn }), calls, puts, waiting, peak: () => peak, inFlight: () => now, open: () => waiting.shift()?.go() }
}

/** Answers the server's requests one at a time, as they come, until `p` has settled. */
async function answerAll<T>(s: ReturnType<typeof chunkServer>, p: Promise<T>): Promise<T> {
  let done = false
  void p.finally(() => { done = true }).catch(() => {})
  for (let i = 0; i < 5000 && !done; i++) {
    if (s.waiting.length) s.open()
    await new Promise((r) => setTimeout(r, 0))
  }
  return p
}

describe('a large file: several chunks at once', () => {
  test(`${CHUNKS_AT_ONCE} chunks of one file go at once, in order, and complete comes after the last`, async () => {
    const s = chunkServer()
    const seen: UploadProgress[] = []
    const up = uploadFile(bigFile(3), target('x/big.bin'), { ...big, client: s.client, storage: null, retryDelayMs: 0, reportEveryMs: 0, onProgress: (p) => seen.push(p) })
    for (let i = 0; i < 80 && s.waiting.length < CHUNKS_AT_ONCE; i++) await tick()
    expect(s.puts()).toEqual([0, 1, 2])
    expect(s.calls.some((c) => c.endsWith('/complete'))).toBe(false)
    await answerAll(s, up)
    expect(s.puts()).toEqual([0, 1, 2, 3])
    expect(s.peak()).toBe(CHUNKS_AT_ONCE)
    expect(s.calls.at(-1)).toEndWith('/complete')
    const loaded = seen.filter((p) => p.phase === 'uploading').map((p) => p.loaded)
    expect(loaded).toEqual([...loaded].sort((a, b) => a - b))
    expect(Math.max(...loaded)).toBe(CHUNK * 3 + 10)
  })

  test('the bytes on their way of every chunk add up, and an answer out of order does not count a chunk twice', async () => {
    const shares: Record<number, ((share: number) => void) | undefined> = {}
    const answers: Record<number, (() => void) | undefined> = {}
    const received: number[] = []
    let session: UploadSession | null = null
    const fetchFn = (async (input: string, init: RequestInit) => {
      if (input === '/api/upload-sessions') {
        const b = JSON.parse(String(init.body))
        session = { id: uuidv7(), target: b.target, size: b.size, sha256: b.sha256, chunkSize: CHUNK, chunkCount: Math.ceil(b.size / CHUNK), received: [], expiresAt: new Date(Date.now() + 1e6).toISOString() }
        return json(session, 201)
      }
      return json({ kind: 'path', entry: entry('x/big.bin') })
    }) as unknown as typeof fetch
    const client = new ApiClient({
      baseUrl: '',
      fetch: fetchFn,
      fetchWithProgress: async (input, _init, onSent) => {
        const n = Number(/chunks\/(\d+)$/.exec(input)![1])
        shares[n] = onSent
        await new Promise<void>((r) => { answers[n] = r })
        received.push(n)
        return json({ received: [...received].sort((a, b) => a - b) })
      },
    })
    const seen: number[] = []
    const half = CHUNK / 2
    const up = uploadFile(bigFile(2, half), target('x/big.bin'), { ...big, client, storage: null, retryDelayMs: 0, reportEveryMs: 0, onProgress: (p) => p.phase === 'uploading' && seen.push(p.loaded) })
    for (let i = 0; i < 80 && !shares[2]; i++) await tick()
    shares[0]!(0.5)
    shares[1]!(0.5)
    shares[2]!(1) // the small tail, all out
    expect(seen.at(-1)).toBe(half + half + half)
    // the tail's answer first, then chunk 1's: the sum stays right (the tail is half a chunk, not a whole one)
    answers[2]!()
    await tick()
    expect(seen.at(-1)).toBe(half + half + half)
    shares[1]!(1)
    answers[1]!()
    await tick()
    expect(seen.at(-1)).toBe(half + CHUNK + half)
    shares[0]!(1)
    answers[0]!()
    await up
    expect(seen.at(-1)).toBe(CHUNK * 2 + half)
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
  })

  test('a chunk that fails once is sent again while the others go on; the file arrives whole', async () => {
    const s = chunkServer({ auto: true, fail: { 1: [500], 2: ['net'] } })
    const r = await uploadFile(bigFile(3), target('x/big.bin'), { ...big, client: s.client, storage: null, retryDelayMs: 0 })
    expect(r.kind).toBe('path')
    // chunk 1 twice (a 500), chunk 2 twice (no answer: the session said it was not there)
    expect(s.puts().sort((a, b) => a - b)).toEqual([0, 1, 1, 2, 2, 3])
    expect(s.calls.filter((c) => c.startsWith('GET'))).toHaveLength(1)
    expect(s.calls.at(-1)).toEndWith('/complete')
  })

  test('a chunk that fails for good ends the file, stops the chunks beside it, and sends no complete', async () => {
    const s = chunkServer({ fail: { 1: [400] } })
    const up = uploadFile(bigFile(3), target('x/big.bin'), { ...big, client: s.client, storage: null, retryDelayMs: 0 }).catch((e: unknown) => e)
    for (let i = 0; i < 80 && s.waiting.length < 3; i++) await tick()
    // chunk 1 is answered (with its 400) first
    const one = s.waiting.findIndex((w) => w.key.endsWith(':1'))
    s.waiting.splice(one, 1)[0]!.go()
    const e = await up
    expect(e).toBeInstanceOf(ApiError)
    expect((e as ApiError).status).toBe(400)
    expect(s.puts()).toEqual([0, 1, 2])
    expect(s.inFlight()).toBe(0)
    expect(s.calls.some((c) => c.endsWith('/complete'))).toBe(false)
  })

  test('a resume sends only the chunks the server does not have, still a few at once', async () => {
    const storage = new Map<string, string>()
    const store = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v) }, removeItem: (k: string) => { storage.delete(k) } }
    const s = chunkServer({ auto: true, received: [0, 2] })
    await uploadFile(bigFile(3), target('x/big.bin'), { ...big, client: s.client, storage: store, retryDelayMs: 0 })
    expect(s.puts().sort((a, b) => a - b)).toEqual([1, 3])
    expect(storage.size).toBe(0)
  })

  test('chunks waiting in a full line leave it when the file stops or a chunk fails: every place comes back', async () => {
    const s = chunkServer()
    const small = (n: number) => uploadFile(new File([new Uint8Array(100)], `${n}.pdf`), target(`docs/${n}.pdf`), { client: s.client, storage: null })
    // every place taken by small files that wait for their answer
    const first = Array.from({ length: COPIES_AT_ONCE }, (_, i) => small(i))
    for (let i = 0; i < 80 && s.waiting.length < COPIES_AT_ONCE; i++) await tick()
    // a large file whose chunks all wait in line: stopped there
    const stop = new AbortController()
    const stopped = uploadFile(bigFile(3), target('x/a.bin'), { ...big, client: s.client, storage: null, retryDelayMs: 0, signal: stop.signal }).catch((e: unknown) => e)
    for (let i = 0; i < 80 && !s.calls.some((c) => c === 'POST /api/upload-sessions'); i++) await tick()
    await tick()
    stop.abort()
    expect(((await stopped) as DOMException).name).toBe('AbortError')
    expect(s.puts()).toEqual([])
    // a large file whose first chunk gets a place and fails for good while the others wait in line
    const failing = chunkServer({ auto: true, fail: { 0: [400] } })
    const failed = uploadFile(bigFile(3), target('x/b.bin'), { ...big, client: failing.client, storage: null, retryDelayMs: 0 }).catch((e: unknown) => e)
    for (let i = 0; i < 80 && !failing.calls.some((c) => c === 'POST /api/upload-sessions'); i++) await tick()
    await tick()
    // one small file ends: its place goes to the first chunk in line, which fails; the chunks behind it leave the line
    s.open()
    expect(await failed).toBeInstanceOf(ApiError)
    // (the next chunk may have taken the place the failed one gave back, just before the stop: it is stored, no harm)
    expect(failing.puts()[0]).toBe(0)
    expect(failing.calls.some((c) => c.endsWith('/complete'))).toBe(false)
    await answerAll(s, Promise.all(first))
    // all places are free again: as many as there are go at once
    const again = Array.from({ length: COPIES_AT_ONCE + 1 }, (_, i) => small(100 + i))
    for (let i = 0; i < 80 && s.waiting.length < COPIES_AT_ONCE; i++) await tick()
    await tick()
    expect(s.waiting).toHaveLength(COPIES_AT_ONCE)
    await answerAll(s, Promise.all(again))
  })

  test(`files together never have more than ${COPIES_AT_ONCE} requests on their way, and all arrive`, async () => {
    const s = chunkServer()
    const ups = [
      uploadFile(bigFile(2, 10, 'a.bin'), target('x/a.bin'), { ...big, client: s.client, storage: null, retryDelayMs: 0 }),
      uploadFile(bigFile(2, 10, 'b.bin'), target('x/b.bin'), { ...big, client: s.client, storage: null, retryDelayMs: 0 }),
      ...[1, 2, 3].map((n) => uploadFile(new File([new Uint8Array(100)], `${n}.pdf`), target(`docs/${n}.pdf`), { client: s.client, storage: null })),
    ]
    for (let i = 0; i < 200 && s.waiting.length < COPIES_AT_ONCE; i++) await tick()
    expect(s.inFlight()).toBe(COPIES_AT_ONCE)
    const results = await answerAll(s, Promise.all(ups))
    expect(results.map((r) => r.kind)).toEqual(Array(5).fill('path'))
    expect(s.peak()).toBe(COPIES_AT_ONCE)
    // both large files had every chunk sent once
    expect(s.puts().sort((a, b) => a - b)).toEqual([0, 0, 1, 1, 2, 2])
  })
})

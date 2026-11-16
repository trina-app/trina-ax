// Large files take turns (lib/upload.ts SESSIONS_AT_ONCE): each is an upload session on the server, and a person may
// hold ten unfinished ones. Eleven files of 10 MB dropped on a room at once asked for eleven sessions, the last were
// refused (429) and failed after about 15 s. Also here: a file taken out while its session is being made leaves none
// behind.
import { describe, expect, test } from 'bun:test'
import { ApiClient, uuidv7, type UploadSession, type UploadTarget } from '@mycel/shared/api'
import { SESSIONS_AT_ONCE, uploadFile } from '../../src/lib/upload'

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
const ROOM = uuidv7()
const target = (name: string): UploadTarget => ({ kind: 'room', roomId: ROOM, name })
const file = (name: string, size = 64) => new File([new Uint8Array(size).fill(name.length)], name, { lastModified: 1 })
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

/** An upload-session server that refuses an eleventh open session, like the real one (MAX_OPEN_SESSIONS). `gate`: each
 * session's create waits for it. */
function server(o: { max?: number; createGate?: () => Promise<void> } = {}) {
  const open = new Map<string, UploadSession>()
  const calls: string[] = []
  let most = 0
  let refused = 0
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://t')
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${url.pathname.replace(/[0-9a-f-]{36}/, ':id')}`)
    if (method === 'POST' && url.pathname === '/api/upload-sessions') {
      await o.createGate?.()
      if (open.size >= (o.max ?? 10)) { refused++; return json({ error: { code: 'rate_limited', message: 'too many uploads' } }, 429) }
      const b = JSON.parse(String(init!.body))
      const s: UploadSession = { id: uuidv7(), target: b.target, size: b.size, sha256: b.sha256, chunkSize: 16, chunkCount: Math.ceil(b.size / 16), received: [], expiresAt: new Date(Date.now() + 1e6).toISOString() }
      open.set(s.id, s)
      most = Math.max(most, open.size)
      return json(s, 201)
    }
    const m = url.pathname.match(/^\/api\/upload-sessions\/([^/]+)(?:\/(chunks)\/(\d+)|\/(complete))?$/)
    const s = m && open.get(m[1]!)
    if (!m || !s) return json({ error: { code: 'not_found', message: 'nf' } }, 404)
    if (m[2]) { await tick(1); s.received = [...new Set([...s.received, Number(m[3])])]; return json({ received: s.received }) }
    if (m[4]) { open.delete(s.id); return json({ kind: 'room', file: { id: uuidv7(), name: (s.target as { name: string }).name, size: s.size, mime: 'application/octet-stream', kind: 'other', thumb: false } }) }
    if (method === 'DELETE') { open.delete(s.id); return new Response(null, { status: 204 }) }
    return json(s)
  }) as typeof fetch
  return { client: new ApiClient({ baseUrl: 'http://t', fetch: fetchFn }), open, calls, most: () => most, refused: () => refused }
}
const opts = (s: ReturnType<typeof server>) => ({ client: s.client, storage: null, singleRequestMax: 8, retryDelayMs: 0, reportEveryMs: 0 })

describe('large files take turns', () => {
  test('eleven dropped at once: never more than three sessions open, none refused, all arrive', async () => {
    // one stale session of the person is open already, as after a tab closed mid-upload
    const s = server()
    await s.client.call((await import('@mycel/shared/api')).API.createUploadSession, { body: { target: target('stale.bin'), size: 1, sha256: 'a'.repeat(64) } })
    const phases = new Map<string, Set<string>>()
    const names = Array.from({ length: 11 }, (_, i) => `clip-${i}.mov`)
    const done = await Promise.all(names.map((n) => uploadFile(file(n), target(n), { ...opts(s), onProgress: (p) => { if (!phases.has(n)) phases.set(n, new Set()); phases.get(n)!.add(p.phase) } })))
    expect(done.map((d) => d.kind === 'room' && d.file.name)).toEqual(names)
    expect(s.refused()).toBe(0)
    // the stale one and at most three of this drop
    expect(s.most()).toBeLessThanOrEqual(1 + SESSIONS_AT_ONCE)
    // the first three started at once; the others said they wait, before anything of them was read
    for (const n of names.slice(0, SESSIONS_AT_ONCE)) expect(phases.get(n)!.has('queued')).toBe(false)
    for (const n of names.slice(SESSIONS_AT_ONCE)) expect([...phases.get(n)!][0]).toBe('queued')
  })

  test('a waiting file taken out leaves the line at once, and the one behind it still gets its turn', async () => {
    const s = server({ max: 3 })
    const abort = new AbortController()
    const firsts = ['a.mov', 'b.mov', 'c.mov'].map((n) => uploadFile(file(n), target(n), opts(s)))
    const waiting = uploadFile(file('d.mov'), target('d.mov'), { ...opts(s), signal: abort.signal })
    const last = uploadFile(file('e.mov'), target('e.mov'), opts(s))
    abort.abort()
    await expect(waiting).rejects.toThrow()
    expect((await last).kind).toBe('room')
    await Promise.all(firsts)
    expect(s.calls.filter((c) => c === 'POST /api/upload-sessions')).toHaveLength(4)
    expect(s.open.size).toBe(0)
  })

  test('small files do not wait for a turn (one request each, no session)', async () => {
    const s = server()
    const seen: string[] = []
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const fd = init!.body as FormData
      seen.push(new URL(String(input), 'http://t').pathname)
      return json({ id: uuidv7(), name: String(fd.get('name')), size: Number(fd.get('size')), mime: 'application/octet-stream', kind: 'other', thumb: false }, 201)
    }) as typeof fetch
    const client = new ApiClient({ baseUrl: 'http://t', fetch: fetchFn })
    await Promise.all(Array.from({ length: 6 }, (_, i) => uploadFile(file(`s${i}.txt`, 4), target(`s${i}.txt`), { ...opts(s), client })))
    expect(seen).toEqual(Array(6).fill(`/api/rooms/${ROOM}/files`))
  })
})

describe('a file taken out while its session is being made', () => {
  test('the session the server made after all is dropped, and not remembered for a resume', async () => {
    let letCreate!: () => void
    const gate = new Promise<void>((r) => { letCreate = r })
    const s = server({ createGate: () => gate })
    const kept = new Map<string, string>()
    const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) }
    const abort = new AbortController()
    const p = uploadFile(file('gone.mov'), target('gone.mov'), { ...opts(s), storage, signal: abort.signal })
    // the request is on its way; the person takes the chip out; then the server answers with a new session
    while (!s.calls.includes('POST /api/upload-sessions')) await tick()
    abort.abort()
    letCreate()
    await expect(p).rejects.toThrow()
    await tick(5)
    expect(s.calls).toContain('DELETE /api/upload-sessions/:id')
    expect(s.open.size).toBe(0)
    expect([...kept.values()].join('')).not.toContain('gone.mov')
    // its turn was given back: the next large file starts
    const next = await uploadFile(file('next.mov'), target('next.mov'), { ...opts(server()), storage: null })
    expect(next.kind).toBe('room')
  })
})

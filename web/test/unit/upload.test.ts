import { describe, expect, test } from 'bun:test'
import { ApiClient, FileEntry, UPLOAD_CHUNK_SIZE, uuidv7, type UploadSession } from '@mycel/shared/api'
import { fingerprint, sha256Hex, uploadFile } from '../../src/lib/upload'

const entry = (path: string): FileEntry => ({ name: path.split('/').pop()!, path, type: 'file', size: 1, mtime: new Date().toISOString(), mime: null, access: 'write' })
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })

class MemStorage {
  m = new Map<string, string>()
  getItem(k: string) { return this.m.get(k) ?? null }
  setItem(k: string, v: string) { this.m.set(k, v) }
  removeItem(k: string) { this.m.delete(k) }
}

/** A tiny upload-session server: records calls, can fail chunk PUTs on purpose. */
function fakeServer(o: { failChunk?: Set<number>; dropAfterStore?: Set<number> } = {}) {
  const calls: string[] = []
  const sessions = new Map<string, UploadSession & { chunks: Map<number, number> }>()
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://t')
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${url.pathname}`)
    expect(new Headers(init?.headers).get('x-mycel-csrf') ?? (method === 'GET' ? '1' : null)).toBe('1')
    if (method === 'POST' && url.pathname === '/api/files/upload') {
      const fd = init!.body as FormData
      return json(entry(`${fd.get('folder')}/${fd.get('name')}`), 201)
    }
    if (method === 'POST' && url.pathname === '/api/upload-sessions') {
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
      if (m[4]) return json({ kind: 'path', entry: entry((s.target as { path: string }).path) })
      const { chunks, ...out } = s
      return json({ ...out, received: [...chunks.keys()] })
    }
    return json({ error: { code: 'not_found', message: 'nf' } }, 404)
  }) as typeof fetch
  return { calls, sessions, client: new ApiClient({ baseUrl: '', fetch: fetchFn }) }
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
})

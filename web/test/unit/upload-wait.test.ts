// lib/upload: a lost connection is waited for (QA TC-223). Before, a chunk gave up after 5 tries (about 15 s) and a
// small file after one; the row stayed failed when the network came back. Now a network error (or the relay's 502 /
// 504) makes the upload wait: it reports the phase `waiting`, asks nothing while the browser says it is offline, goes on
// at the browser's `online` event, and fails only after `connectionWaitMs`. A small file for a team folder is sent
// again (the server keeps the same file once, no "(2)"); an attachment is sent once, as before.
import { afterEach, describe, expect, test } from 'bun:test'
import { ApiClient, ApiError, UPLOAD_CHUNK_SIZE, uuidv7, type FileEntry, type UploadSession } from '@mycel/shared/api'
import { uploadBar, uploadFile, uploadLabel, type UploadProgress } from '../../src/lib/upload'

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
const entry = (path: string, size: number): FileEntry => ({ name: path.split('/').pop()!, path, type: 'file', size, mtime: new Date().toISOString(), mime: null, access: 'write' })
const lost = () => new TypeError('Network request failed')

/** A server whose requests fail while `down` is true (no answer: a TypeError), with a log of what reached it. */
function server() {
  const state = { down: false, calls: [] as string[], failed: 0, gateway: 0 }
  let session: (UploadSession & { got: Set<number> }) | null = null
  const answer = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input, 'http://t')
    const method = init.method ?? 'GET'
    if (state.down) {
      state.failed++
      throw lost()
    }
    if (state.gateway > 0) {
      state.gateway--
      return json({ error: { code: 'bad_gateway', message: 'team server unreachable' } }, 502)
    }
    state.calls.push(`${method} ${url.pathname}`)
    if (url.pathname === '/api/files/upload') {
      const fd = init.body as FormData
      return json(entry(`${fd.get('folder')}/${fd.get('name')}`, Number(fd.get('size'))), 201)
    }
    if (url.pathname === '/api/uploads') return json({ id: uuidv7(), name: 'a.pdf', path: 'users/u/.attachments/c/a.pdf', size: 10, mime: 'application/pdf', kind: 'pdf' }, 201)
    if (method === 'POST' && url.pathname === '/api/upload-sessions') {
      const b = JSON.parse(String(init.body))
      session = { id: uuidv7(), target: b.target, size: b.size, sha256: b.sha256, chunkSize: UPLOAD_CHUNK_SIZE, chunkCount: Math.ceil(b.size / UPLOAD_CHUNK_SIZE), received: [], expiresAt: new Date(Date.now() + 1e6).toISOString(), got: new Set() }
      const { got: _g, ...out } = session
      return json(out, 201)
    }
    const chunk = /\/chunks\/(\d+)$/.exec(url.pathname)
    if (chunk && session) {
      session.got.add(Number(chunk[1]))
      return json({ received: [...session.got] })
    }
    if (url.pathname.endsWith('/complete') && session) return json({ kind: 'path', entry: entry(session.target.kind === 'path' ? session.target.path : 'x', session.size) })
    if (method === 'GET' && session) return json({ ...session, received: [...session.got] })
    return json({ error: { code: 'not_found', message: url.pathname } }, 404)
  }
  const client = new ApiClient({
    baseUrl: '',
    fetch: ((input: string, init: RequestInit) => answer(input, init)) as unknown as typeof fetch,
    fetchWithProgress: async (input, init, onSent) => {
      const r = await answer(input, init)
      onSent(1)
      return r
    },
  })
  return { state, client }
}
const small = (n = 10) => new File([new Uint8Array(n).fill(1)], 'IMG_0001.jpg', { type: 'image/jpeg' })
const big = () => new File([new Uint8Array(UPLOAD_CHUNK_SIZE * 2 + 3).fill(2)], 'video.mp4', { type: 'video/mp4' })
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))

// a browser's online state for the tests that need one (bun has no window)
const before = { window: (globalThis as Record<string, unknown>).window, onLine: Object.getOwnPropertyDescriptor(globalThis.navigator, 'onLine') }
function browser(onLine: boolean) {
  const win = new EventTarget()
  ;(globalThis as Record<string, unknown>).window = win
  let on = onLine
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, get: () => on })
  return { goOnline: () => { on = true; win.dispatchEvent(new Event('online')) } }
}
afterEach(() => {
  ;(globalThis as Record<string, unknown>).window = before.window
  if (before.onLine) Object.defineProperty(globalThis.navigator, 'onLine', before.onLine)
  else delete (globalThis.navigator as unknown as Record<string, unknown>).onLine
})

describe('a lost connection', () => {
  test('a small file for a team folder waits, says so, and is sent again when the server answers', async () => {
    const s = server()
    s.state.down = true
    const seen: UploadProgress['phase'][] = []
    const up = uploadFile(small(), { kind: 'path', path: 'shared/photos/IMG_0001.jpg', onExists: 'rename' }, { client: s.client, storage: null, retryDelayMs: 1, reportEveryMs: 0, onProgress: (p) => seen.push(p.phase) })
    while (s.state.failed < 3) await tick()
    s.state.down = false
    const r = await up
    expect(r).toMatchObject({ kind: 'path', entry: { path: 'shared/photos/IMG_0001.jpg' } })
    expect(s.state.calls).toEqual(['POST /api/files/upload'])
    expect(seen).toContain('waiting')
    expect(seen.at(-1)).toBe('finishing')
  })

  test('a large file waits on the chunk where it stopped and goes on from there; the relay\'s 502 counts as lost too', async () => {
    const s = server()
    const seen: UploadProgress[] = []
    let cut = false
    const up = uploadFile(big(), { kind: 'path', path: 'shared/video.mp4', onExists: 'rename' }, {
      client: s.client, storage: null, retryDelayMs: 1, reportEveryMs: 0,
      onProgress: (p) => {
        seen.push(p)
        // the connection goes once the first chunk is in
        if (!cut && p.phase === 'uploading' && p.loaded >= UPLOAD_CHUNK_SIZE) {
          cut = true
          s.state.down = true
        }
      },
    })
    while (s.state.failed < 8) await tick()
    s.state.down = false
    s.state.gateway = 6 // more than the 5 tries a server error gets
    const r = await up
    expect(r).toMatchObject({ kind: 'path', entry: { path: 'shared/video.mp4' } })
    expect(s.state.calls.filter((c) => c.includes('/chunks/'))).toHaveLength(3)
    const waiting = seen.filter((p) => p.phase === 'waiting')
    expect(waiting.length).toBeGreaterThan(0)
    // what had gone out stays on the bar while it waits
    expect(waiting.every((p) => p.loaded >= UPLOAD_CHUNK_SIZE)).toBe(true)
  })

  test('offline: nothing is asked until the browser is online again, then it goes on at once', async () => {
    const b = browser(false)
    const s = server()
    s.state.down = true
    const up = uploadFile(small(), { kind: 'path', path: 'shared/a.jpg', onExists: 'rename' }, { client: s.client, storage: null, retryDelayMs: 1 })
    await tick(60)
    // one try found the connection gone; while offline no other request went out
    expect(s.state.failed).toBe(1)
    s.state.down = false
    b.goOnline()
    expect(await up).toMatchObject({ kind: 'path' })
    expect(s.state.calls).toEqual(['POST /api/files/upload'])
  })

  test('after connectionWaitMs it fails as before; a refusal is not waited for', async () => {
    const s = server()
    s.state.down = true
    const e = await uploadFile(small(), { kind: 'path', path: 'shared/a.jpg', onExists: 'rename' }, { client: s.client, storage: null, retryDelayMs: 1, connectionWaitMs: 30 }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(TypeError)
    let tries = 0
    const counting = new ApiClient({ baseUrl: '', fetch: (async () => { tries++; return json({ error: { code: 'forbidden', message: 'no' } }, 403) }) as unknown as typeof fetch })
    expect(await uploadFile(small(), { kind: 'path', path: 'shared/a.jpg', onExists: 'rename' }, { client: counting, storage: null, retryDelayMs: 1 }).catch((x: unknown) => x)).toBeInstanceOf(ApiError)
    expect(tries).toBe(1)
  })

  test('a chat attachment is sent once, as before (a second one would be a second attachment)', async () => {
    const s = server()
    s.state.down = true
    const e = await uploadFile(small(), { kind: 'attachment', chatId: uuidv7(), name: 'a.pdf' }, { client: s.client, storage: null, retryDelayMs: 1 }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(TypeError)
    expect(s.state.failed).toBe(1)
  })

  test('what a waiting row says and shows', () => {
    const t = (k: string) => k
    expect(uploadLabel({ phase: 'waiting', loaded: 40, total: 100 }, t)).toBe('files.waitingConnection')
    expect(uploadBar({ phase: 'waiting', loaded: 40, total: 100 })).toBe(40)
    expect(uploadBar({ phase: 'waiting', loaded: 100, total: 100 })).toBe(99)
    expect(uploadBar({ phase: 'finishing', loaded: 100, total: 100 })).toBe(100)
    expect(uploadBar({ phase: 'hashing', loaded: 50, total: 100 })).toBe(0)
  })
})

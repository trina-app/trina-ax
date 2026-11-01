// After a server update (lib/chunk-reload.ts, components/ChunkErrorBoundary.tsx, pwa/sw.js): a lazy part that cannot be
// imported reloads the page once and never in a loop, never while something typed or picked would be lost (a draft, a
// message not sent yet, an upload, a recording) or the server is out of reach, the boundary shows a spinner or a Reload
// button instead of a blank page and passes other errors on, and the service worker keeps one cache per build.
import { afterEach, describe, expect, test } from 'bun:test'
import vm from 'node:vm'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChunkErrorBoundary } from '../../src/components/ChunkErrorBoundary'
import { _resetChunkReloadForTest, CHUNK_RELOAD_GUARD_MS, CHUNK_RELOAD_KEY, isChunkLoadError, reloadForChunkError, reloadOnce } from '../../src/lib/chunk-reload'
import { keepUnsentAsDrafts, mayReloadNow, reloadWouldLose, serverUnreachable, unfinishedWork } from '../../src/lib/reload-guard'
import { markBusy } from '../../src/lib/busy'
import { readDraft, writeDraft } from '../../src/lib/localData'
import { useChats } from '../../src/store/chats'
import { useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { currentLocale, translate } from '../../src/i18n'
import { pwaFile, staticBuildId } from '../../scripts/product-pages'

const memory = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, m }
}

describe('a failed lazy import reloads once', () => {
  test('the browsers\' words for a chunk that is gone; other errors are not', () => {
    for (const m of [
      'Failed to fetch dynamically imported module: https://team.test/assets/Members-BrAnr-0M.js', // Chrome, Edge
      'error loading dynamically imported module: https://team.test/assets/Members-BrAnr-0M.js', // Firefox
      'Importing a module script failed.', // Safari
      'Unable to preload CSS for /assets/Settings-x1.css', // Vite's CSS preload
    ]) {
      expect(isChunkLoadError(new TypeError(m))).toBe(true)
      expect(isChunkLoadError(m)).toBe(true)
    }
    expect(isChunkLoadError(Object.assign(new Error('x'), { name: 'ChunkLoadError' }))).toBe(true)
    for (const e of [new Error('Cannot read properties of undefined'), new TypeError('Failed to fetch'), null, undefined, 42, {}]) expect(isChunkLoadError(e)).toBe(false)
  })

  test('once per tab within the guard: a failure right after the reload stays on screen; later, again', () => {
    const s = memory()
    let reloads = 0
    const at = (now: number, busy = false) => reloadOnce({ storage: s, now, busy, reload: () => reloads++ })
    expect(at(1_000_000)).toBe(true)
    expect(reloads).toBe(1)
    expect(s.m.get(CHUNK_RELOAD_KEY)).toBe('1000000')
    // the reloaded page fails too (offline, a broken server): no second reload, no loop
    expect(at(1_000_000 + 3_000)).toBe(false)
    expect(at(1_000_000 + CHUNK_RELOAD_GUARD_MS - 1)).toBe(false)
    expect(reloads).toBe(1)
    // the next server update, later
    expect(at(1_000_000 + CHUNK_RELOAD_GUARD_MS)).toBe(true)
    expect(reloads).toBe(2)
    // a clock that went back does not block for ever
    expect(at(10)).toBe(true)
    expect(reloads).toBe(3)
  })

  test('never while something would be lost, nor without storage to remember it in', () => {
    let reloads = 0
    const reload = () => reloads++
    expect(reloadOnce({ storage: memory(), now: 1, busy: true, reload })).toBe(false)
    expect(reloadOnce({ storage: null, now: 1, busy: false, reload })).toBe(false)
    const blocked = { getItem: () => { throw new Error('SecurityError') }, setItem: () => { throw new Error('SecurityError') } }
    expect(reloadOnce({ storage: blocked, now: 1, busy: false, reload })).toBe(false)
    const full = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError') } }
    expect(reloadOnce({ storage: full, now: 1, busy: false, reload })).toBe(false)
    expect(reloads).toBe(0)
  })
})

describe('the boundary instead of a blank page', () => {
  const chunk = new TypeError('Failed to fetch dynamically imported module: https://team.test/assets/Members-BrAnr-0M.js')
  const boundary = (resetKey?: string) => new ChunkErrorBoundary({ children: createElement('p', null, 'page'), resetKey })
  test('a gone chunk: a spinner while reloading (and until that is decided, so no button flashes up), else the line and a Reload button', () => {
    const b = boundary()
    expect(renderToStaticMarkup(b.render() as never)).toBe('<p>page</p>')
    for (const st of [{ decided: true, reloading: true }, { decided: false, reloading: false }]) {
      b.state = { error: chunk, ...st }
      const spin = renderToStaticMarkup(b.render() as never)
      expect(spin).not.toContain(translate(currentLocale(), 'update.chunkFailed'))
      expect(spin).not.toContain('<button')
    }
    b.state = { error: chunk, decided: true, reloading: false }
    const line = renderToStaticMarkup(b.render() as never)
    expect(line).toContain(translate(currentLocale(), 'update.chunkFailed'))
    expect(line).toContain(`>${translate(currentLocale(), 'update.reload')}</button>`)
    expect(line).toContain('role="alert"')
  })
  test('any other error goes on to the boundary above (as before)', () => {
    const b = boundary()
    const other = new Error('a real bug')
    b.state = { error: other, decided: false, reloading: false }
    expect(() => b.render()).toThrow('a real bug')
    expect(ChunkErrorBoundary.getDerivedStateFromError(other)).toEqual({ error: other, decided: false, reloading: false })
  })
  test('another page tries again; nothing is remounted for that', () => {
    const b = boundary('/admin/members')
    let next: unknown = null
    b.setState = ((s: unknown) => { next = s }) as never
    b.state = { error: chunk, decided: true, reloading: false }
    b.componentDidUpdate({ resetKey: '/admin/members' })
    expect(next).toBeNull()
    b.componentDidUpdate({ resetKey: '/settings' })
    expect(next).toEqual({ error: null, decided: false })
  })
  test('every language has the lines', async () => {
    const { DICTS } = await import('../../src/i18n')
    for (const l of ['ko', 'en', 'id', 'ja', 'es'] as const) {
      expect(DICTS[l]['update.chunkFailed'].length).toBeGreaterThan(10)
      expect(DICTS[l]['update.chunkUnsent'].length).toBeGreaterThan(10)
      expect(DICTS[l]['update.chunkUnsent']).not.toBe(DICTS[l]['update.chunkFailed'])
    }
  })
})

describe('nothing typed is lost by a reload after a server update', () => {
  const chat = '0190a4c0-0000-7000-8000-000000000001'
  const message = (o: Record<string, unknown>) => ({ id: String(Math.random()), chatId: chat, role: 'user', content: 'the quarterly numbers, please', status: 'done', ...o }) as never
  const showing = (...messages: never[]) => useChats.setState({ threads: { [chat]: { messages, nextCursor: null, stale: false } } })
  const releases: (() => void)[] = []
  const drafts = () => {
    const m = new Map<string, string>()
    return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, removeItem: (k: string) => { m.delete(k) }, key: (i: number) => [...m.keys()][i] ?? null, get length() { return m.size } }
  }
  const session = useSession.getState().status
  afterEach(() => {
    for (const r of releases.splice(0)) r()
    useChats.setState({ threads: {} })
    useUi.setState({ conn: 'idle' })
    useSession.setState({ status: session })
  })

  test('the same check as the update watcher: a message being sent or not sent, an answer streaming, a draft, an upload, a recording', () => {
    expect(reloadWouldLose()).toBe(false)
    expect(mayReloadNow()).toBe(true)
    for (const m of [
      message({ local: { clientMessageId: 'c1', state: 'sending' } }), // the server restarts: the send retries for 30 s
      message({ local: { clientMessageId: 'c1', state: 'failed' } }), // "not sent [send again]": only in this tab's memory
      message({ role: 'assistant', status: 'streaming' }),
    ]) {
      showing(m)
      expect(reloadWouldLose()).toBe(true)
      expect(mayReloadNow()).toBe(false)
    }
    showing(message({}))
    expect(reloadWouldLose()).toBe(false)
    for (const kind of ['draft', 'upload', 'recording'] as const) {
      const release = markBusy(kind)
      expect(reloadWouldLose()).toBe(true)
      release()
      expect(reloadWouldLose()).toBe(false)
    }
  })
  test('not while the server is out of reach (the reload would land on the offline page)', () => {
    for (const conn of ['reconnecting', 'offline'] as const) {
      useUi.setState({ conn })
      expect(serverUnreachable()).toBe(true)
      expect(mayReloadNow()).toBe(false)
    }
    for (const conn of ['open', 'idle', 'connecting'] as const) {
      useUi.setState({ conn })
      expect(serverUnreachable()).toBe(false)
    }
  })
  test('a draft is kept for its chat across a reload, and while there is one the page does not reload by itself', () => {
    const s = drafts()
    // what the composer writes on each change, and starts from after the reload
    writeDraft('u1', chat, 'half-typed question about the Q3 report', s)
    expect(readDraft('u1', chat, s)).toBe('half-typed question about the Q3 report')
    expect(readDraft('u2', chat, s)).toBe('')
    releases.push(markBusy('draft'))
    expect(mayReloadNow()).toBe(false)
    // nothing to finish for the person: a draft is kept anyway, as is an answer that streams (on the server)
    expect(unfinishedWork()).toBe(false)
    showing(message({ role: 'assistant', status: 'streaming' }))
    expect(unfinishedWork()).toBe(false)
  })
  test('a reload the person asks for keeps the text of a message not sent (or still being sent) as its chat\'s draft, once', () => {
    const s = drafts()
    useSession.setState({ status: { kind: 'signed-in', me: { user: { id: 'u1' } } } } as never)
    writeDraft('u1', chat, 'and a follow-up', s)
    showing(message({ content: 'the quarterly numbers, please', local: { clientMessageId: 'c1', state: 'failed' } }), message({ content: 'already answered' }))
    expect(unfinishedWork()).toBe(true)
    keepUnsentAsDrafts(s)
    keepUnsentAsDrafts(s)
    expect(readDraft('u1', chat, s)).toBe('and a follow-up\n\nthe quarterly numbers, please')
    // signed out: nothing is written
    useSession.setState({ status: { kind: 'signed-out' } } as never)
    const empty = drafts()
    keepUnsentAsDrafts(empty)
    expect(empty.m.size).toBe(0)
  })
  test('the boundary: held while something would be lost (the line says to finish it first, the one reload is not used up); later it reloads', () => {
    const g = globalThis as { window?: unknown; location?: unknown }
    const saved = { window: g.window, location: g.location }
    const store = memory()
    let reloads = 0
    g.window = { sessionStorage: store }
    g.location = { reload: () => { reloads++ } }
    try {
      const chunk = new TypeError('Failed to fetch dynamically imported module: https://team.test/assets/Files-x1.js')
      showing(message({ local: { clientMessageId: 'c1', state: 'failed' } }))
      const b = new ChunkErrorBoundary({ children: createElement('p', null, 'page'), resetKey: '/files' })
      b.state = { error: chunk, decided: false, reloading: false }
      b.setState = ((p: object) => { b.state = { ...b.state, ...p } }) as never
      b.componentDidCatch(chunk)
      expect(reloads).toBe(0)
      expect(b.state).toMatchObject({ decided: true, reloading: false, unsent: true })
      const line = renderToStaticMarkup(b.render() as never)
      expect(line).toContain(translate(currentLocale(), 'update.chunkUnsent'))
      expect(line).toContain(`>${translate(currentLocale(), 'update.reload')}</button>`)
      expect(store.m.has(CHUNK_RELOAD_KEY)).toBe(false)
      // out of reach: held too, with the usual line (nothing would be lost)
      showing(message({}))
      useUi.setState({ conn: 'reconnecting' })
      expect(reloadForChunkError(chunk)).toBe(false)
      expect(reloads).toBe(0)
      // the message was sent and the server is back: the next failed chunk reloads, once
      useUi.setState({ conn: 'open' })
      expect(reloadForChunkError(chunk)).toBe(true)
      expect(reloads).toBe(1)
      expect(store.m.has(CHUNK_RELOAD_KEY)).toBe(true)
    } finally {
      g.window = saved.window
      g.location = saved.location
      _resetChunkReloadForTest()
    }
  })
})

describe('the service worker keeps only the current build', () => {
  function worker(build: string, existing: string[]) {
    const events = new Map<string, (event: any) => void>()
    const store = new Map<string, string[]>(existing.map((k) => [k, ['/assets/old.js']]))
    vm.runInNewContext(pwaFile('sw.js', build), {
      self: { location: { origin: 'https://team.test' }, addEventListener: (name: string, fn: any) => events.set(name, fn), skipWaiting() {}, clients: { claim: async () => {} } },
      // a same-origin answer (type 'basic', which a constructed Response is not)
      URL, Response, fetch: async () => { const r = { ok: true, type: 'basic', clone: () => r }; return r },
      caches: {
        keys: async () => [...store.keys()],
        delete: async (k: string) => store.delete(k),
        open: async (k: string) => {
          if (!store.has(k)) store.set(k, [])
          return { match: async () => null, put: async (req: Request) => { store.get(k)!.push(new URL(req.url).pathname) } }
        },
      },
    })
    return { events, store }
  }
  test('one cache per build; activating a new build deletes every other cache (the old builds and the never-pruned v1)', async () => {
    const w = worker('b2', ['mycel-static-v1', 'mycel-static-b1'])
    let done: Promise<unknown> | null = null
    w.events.get('activate')!({ waitUntil: (p: Promise<unknown>) => { done = p } })
    await done
    expect([...w.store.keys()]).toEqual([])
    let res: Promise<Response> | null = null
    w.events.get('fetch')!({ request: { method: 'GET', url: 'https://team.test/assets/index-new.js', mode: 'cors' }, respondWith: (r: Promise<Response>) => { res = r } })
    await res
    await Bun.sleep(0)
    expect([...w.store.keys()]).toEqual(['mycel-static-b2'])
    expect(w.store.get('mycel-static-b2')).toEqual(['/assets/index-new.js'])
  })
  test('the build id follows the hashed file names, nothing else; a bad id fails the build', () => {
    const a = staticBuildId(['assets/index-A.js', 'assets/Members-B.js', 'index.html', 'sw.js'])
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(staticBuildId(['assets/Members-B.js', 'assets/index-A.js'])).toBe(a)
    expect(staticBuildId(['assets/index-A2.js', 'assets/Members-B.js'])).not.toBe(a)
    expect(pwaFile('sw.js', a)).toContain(`const CACHE = 'mycel-static-${a}'`)
    expect(pwaFile('sw.js')).toContain(`const CACHE = 'mycel-static-dev'`)
    expect(pwaFile('sw.js', a)).not.toContain('__STATIC_BUILD__')
    expect(() => pwaFile('sw.js', "x'; evil()")).toThrow(/bad build id/)
  })
})

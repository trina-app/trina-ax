// After a server update (lib/chunk-reload.ts, components/ChunkErrorBoundary.tsx, pwa/sw.js): a lazy part that cannot be
// imported reloads the page once and never in a loop, the boundary shows a spinner or a Reload button instead of a blank
// page and passes other errors on, and the service worker keeps one cache per build.
import { describe, expect, test } from 'bun:test'
import vm from 'node:vm'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChunkErrorBoundary } from '../../src/components/ChunkErrorBoundary'
import { CHUNK_RELOAD_GUARD_MS, CHUNK_RELOAD_KEY, isChunkLoadError, reloadOnce } from '../../src/lib/chunk-reload'
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
  test('every language has the line', async () => {
    const { DICTS } = await import('../../src/i18n')
    for (const l of ['ko', 'en', 'id', 'ja', 'es'] as const) expect(DICTS[l]['update.chunkFailed'].length).toBeGreaterThan(10)
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

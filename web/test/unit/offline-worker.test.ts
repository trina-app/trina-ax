import { expect, test } from 'bun:test'
import vm from 'node:vm'
import { pwaFile } from '../../scripts/product-pages'
import { DICTS } from '../../src/i18n'

function worker(network: () => Promise<Response>) {
  const events = new Map<string, (event: any) => void>()
  const cached: string[] = []
  vm.runInNewContext(pwaFile('sw.js'), {
    self: { location: { origin: 'https://team.test' }, addEventListener: (name: string, fn: any) => events.set(name, fn) },
    URL, Response, fetch: network,
    caches: { open: async () => ({ match: async () => null, put: async (req: Request) => { cached.push(req.url) } }) },
  })
  return {
    cached,
    fetch(path: string, mode = 'navigate') {
      let response: Promise<Response> | undefined
      events.get('fetch')!({ request: { method: 'GET', url: new URL(path, 'https://team.test').href, mode }, respondWith: (r: Promise<Response>) => { response = r } })
      return response
    },
  }
}

test('the navigation fallback is self-contained, uncached, localized and reports only a bounded language to desktop', async () => {
  const w = worker(async () => { throw new TypeError('offline') })
  const response = await w.fetch('/')!
  expect(response.status).toBe(503)
  expect(response.headers.get('cache-control')).toBe('no-store')
  const html = await response.text()
  expect(html).toContain('<meta name="mycel-offline" content="navigation-v1">')
  expect(html).not.toMatch(/__OFFLINE_|<script[^>]+src=|<link/)
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!
  for (const [recent, signIn, expected] of [
    ['ko', 'id', 'ko'], ['en', 'ko', 'en'], ['id', null, 'id'], ['ja', 'es', 'ja'], ['es', 'ja', 'es'],
    ['ja-JP', null, 'ja'], [null, 'es-MX', 'es'],
    [null, 'id', 'id'], ['fr', 'ko', 'ko'], ['__proto__', 'toString', 'en'],
    ['ko-KR', null, 'ko'], [null, 'in', 'id'],
    ['<script>alert(1)</script>', null, 'en'], [null, null, 'en'],
  ] as const) {
    for (const blocked of [false, true]) {
      const nodes = Object.fromEntries(['title', 'hint', 'retry'].map(key => [key, { textContent: '', onclick: undefined as (() => void) | undefined }]))
      const document = { documentElement: { lang: '' }, getElementById: (key: string) => nodes[key] }
      let reloads = 0
      const reported: string[] = []
      vm.runInNewContext(script, {
        document, location: { reload: () => reloads++ }, window: { mycelDesktop: { setLocale: (l: string) => reported.push(l) } },
        localStorage: { getItem: (key: string) => { if (blocked) throw Error('blocked'); return key === 'mycel.recentLocale' ? recent : signIn } },
      })
      const locale = blocked ? 'en' : expected
      expect(document.documentElement.lang).toBe(locale)
      expect(nodes.title!.textContent).toBe(DICTS[locale]['conn.cantReach'])
      expect(nodes.hint!.textContent).toBe(DICTS[locale]['conn.cantReachHint'])
      expect(nodes.retry!.textContent).toBe(DICTS[locale]['common.retry'])
      expect(reported).toEqual([locale])
      nodes.retry!.onclick!()
      expect(reloads).toBe(1)
    }
  }
  expect(w.cached).toEqual([])
})

test('normal 503 documents pass through and index, API and chat data never enter the static cache', async () => {
  const response = new Response('<h1>Maintenance</h1>', { status: 503 })
  const w = worker(async () => response)
  expect(await w.fetch('/')).toBe(response)
  expect(await w.fetch('/index.html')).toBe(response)
  expect(await w.fetch('/chats/private-chat')).toBe(response)
  expect(w.fetch('/api/me')).toBeUndefined()
  expect(w.fetch('/api/chats')).toBeUndefined()
  expect(w.fetch('/api')).toBeUndefined()
  expect(w.cached).toEqual([])
})

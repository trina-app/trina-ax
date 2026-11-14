// The demo build's sw.js (web/demo/vite.ts puts it in place of the product's worker), at the demo's base (/ or e.g.
// /demo/, its scope): the page's pictures and downloads (<img src="/api/…">, links) are asked of the page that holds
// the demo's in-page server (web/demo/bridge.ts), since there is no team server behind this static site. The app's own
// public files at root addresses (/favicon.svg, /icons/…) are fetched from under the base. Nothing is cached.
const BASE = new URL(self.registration.scope).pathname
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (url.origin !== self.location.origin || url.pathname === '/api/ws') return
  if (url.pathname.startsWith('/api/')) return e.respondWith(ask(e))
  // under a base: a root address the app wrote for one of its public files
  if (BASE !== '/' && e.request.method === 'GET' && e.request.mode !== 'navigate' && !url.pathname.startsWith(BASE)) {
    e.respondWith(fetch(BASE + url.pathname.slice(1) + url.search))
  }
})

async function ask(e) {
  const client = (e.clientId && (await self.clients.get(e.clientId))) || (await self.clients.matchAll({ type: 'window' }))[0]
  if (!client) return new Response('demo: no page', { status: 503 })
  const req = e.request
  const body = req.method === 'GET' || req.method === 'HEAD' ? null : await req.arrayBuffer()
  const channel = new MessageChannel()
  const answer = new Promise((resolve) => {
    channel.port1.onmessage = (m) => resolve(m.data)
    setTimeout(() => resolve({ status: 504, headers: [], body: null }), 15000)
  })
  client.postMessage({ type: 'demo.fetch', url: req.url, method: req.method, headers: [...req.headers], body }, [channel.port2, ...(body ? [body] : [])])
  const a = await answer
  return new Response(a.body, { status: a.status, headers: a.headers })
}

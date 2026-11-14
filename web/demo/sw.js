// The demo build's /sw.js (web/demo/vite.ts puts it in place of the product's worker): the page's pictures and downloads
// (<img src="/api/…">, links) are asked of the page that holds the demo's in-page server (web/demo/bridge.ts), since
// there is no team server behind this static site. Nothing is cached.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/api/') || url.pathname === '/api/ws') return
  e.respondWith(ask(e))
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

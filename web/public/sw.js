// Team AX service worker (tab 5 PWA): caches only hashed static files (/assets/*, /vendor/chunk-*). index.html, /api
// and the WebSocket always go to the network; when the network is down, page loads get a small offline page.
const CACHE = 'mycel-static-v1'
const OFFLINE_HTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Team AX</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",system-ui,sans-serif;background:#faf9f6;color:#1f1d1a;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;text-align:center}
@media (prefers-color-scheme:dark){body{background:#1b1a18;color:#ece9e3}}button{margin-top:16px;padding:8px 16px;border-radius:8px;border:0;background:#2c6a59;color:#fff;font-size:15px}</style></head>
<body><main><h1 style="font-size:20px">팀 서버에 연결할 수 없어요</h1><p>Can't reach the team server · Server tim tidak bisa dihubungi</p><button onclick="location.reload()">다시 시도 · Retry · Coba lagi</button></main></body></html>`

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key)
      await self.clients.claim()
    })(),
  )
})

// hashed names only: /assets/* (Vite) and /vendor/chunk-* (the vendor entry files keep their names and revalidate)
const HASHED_VENDOR = /^\/vendor\/(chunk|asset)-[a-z0-9]+\.\w+$/
const isStatic = (url) => url.origin === self.location.origin && (url.pathname.startsWith('/assets/') || HASHED_VENDOR.test(url.pathname))

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/api') return
  if (isStatic(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE)
        const hit = await cache.match(req)
        if (hit) return hit
        const res = await fetch(req)
        if (res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => {})
        return res
      })(),
    )
    return
  }
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => new Response(OFFLINE_HTML, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })),
    )
  }
})

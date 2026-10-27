// The service worker (tab 5 PWA; web/scripts/product-pages.ts fills the product name in at build): caches only hashed static files (/assets/*, /vendor/chunk-*). index.html, /api
// and the WebSocket always go to the network; when the network is down, page loads get a small offline page (English:
// the worker cannot know the person's language, and English is the default, docs/DECISIONS.md "언어").
const CACHE = 'mycel-static-v1'
const OFFLINE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>__PRODUCT_NAME_HTML__</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",system-ui,sans-serif;background:#faf9f6;color:#1f1d1a;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;text-align:center}
@media (prefers-color-scheme:dark){body{background:#1b1a18;color:#ece9e3}}button{margin-top:16px;padding:8px 16px;border-radius:8px;border:0;background:#2c6a59;color:#fff;font-size:15px}</style></head>
<body><main><h1 style="font-size:20px">Can't reach the team server</h1><p>Check your internet connection and try again.</p><button onclick="location.reload()">Retry</button></main></body></html>`

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

// Push payloads contain opaque IDs and an event code only. Re-read the current session's
// opt-in, event preferences and own inbox before displaying anything; a stale device/account
// delivery, revoked permission, logged-out browser or offline server fails closed.
let pushEpoch = 0
const pushPending = new Set()
const PUSH_PREF = { 'schedule.success': 'scheduleSuccess', 'schedule.failure': 'scheduleFailure', 'connection.reconnect': 'connectionReconnect' }
const PUSH_BODY = { 'schedule.success': 'A scheduled task completed.', 'schedule.failure': 'A scheduled task needs your attention.', 'connection.reconnect': 'A connection needs you to sign in again.' }
const opaqueId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value)

// Store opaque deduplication receipts, never notification text, prompts, file names or tokens.
// IndexedDB is separate from the static-only asset cache. Keep at most 512 receipts for 24h.
function pushReceipt(id, remember = false) {
  return new Promise((resolve, reject) => {
    const opened = indexedDB.open('mycel-push-receipts', 1)
    opened.onupgradeneeded = () => opened.result.createObjectStore('shown', { keyPath: 'id' })
    opened.onerror = () => reject(new Error('push receipt unavailable'))
    opened.onsuccess = () => {
      const db = opened.result, tx = db.transaction('shown', remember ? 'readwrite' : 'readonly'), store = tx.objectStore('shown')
      let seen = false
      const request = remember ? store.getAll() : store.get(id)
      request.onsuccess = () => {
        if (!remember) { seen = !!request.result && request.result.at > Date.now() - 86400000; return }
        const previous = request.result.sort((a, b) => b.at - a.at)
        for (let i = 0; i < previous.length; i++) if (i >= 511 || previous[i].at <= Date.now() - 86400000) store.delete(previous[i].id)
        store.put({ id, at: Date.now() })
      }
      tx.oncomplete = () => { db.close(); resolve(seen) }
      tx.onerror = tx.onabort = () => { db.close(); reject(new Error('push receipt unavailable')) }
    }
  })
}

self.addEventListener('message', event => {
  if (event.data?.type !== 'push.invalidate' || !event.source?.url || new URL(event.source.url).origin !== self.location.origin) return
  pushEpoch++
  event.waitUntil(self.registration.getNotifications().then(items => { for (const item of items) item.close() }))
})

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let payload
    try { payload = event.data?.json() } catch { return }
    if (!payload || !opaqueId(payload.notificationId) || !opaqueId(payload.subscriptionId) || !Object.hasOwn(PUSH_PREF, payload.code)) return
    const tag = `notification:${payload.subscriptionId}:${payload.notificationId}`, generation = pushEpoch
    if (pushPending.has(tag)) return
    pushPending.add(tag)
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000)
    try {
      if (await pushReceipt(tag)) return
      const get = async path => {
        const response = await fetch(path, { credentials: 'include', cache: 'no-store', redirect: 'error', signal: controller.signal })
        if (!response.ok) throw new Error('push no longer available')
        return response.json()
      }
      const [settings, preferences, item] = await Promise.all([get('/api/push'), get('/api/notification-preferences'), get(`/api/notifications/${payload.notificationId}`)])
      if (generation !== pushEpoch || !settings.configured || !settings.enabled || settings.subscriptionId !== payload.subscriptionId || preferences[PUSH_PREF[payload.code]] !== true || item.id !== payload.notificationId || item.code !== payload.code || item.readAt !== null) return
      await self.registration.showNotification('__PRODUCT_NAME__', { body: PUSH_BODY[payload.code], tag, renotify: false, data: { notificationId: payload.notificationId } })
      if (generation !== pushEpoch) {
        for (const item of await self.registration.getNotifications({ tag })) item.close()
        return
      }
      await pushReceipt(tag, true)
    } catch { /* No content or transport errors are logged from a push delivery. */ }
    finally { clearTimeout(timer); pushPending.delete(tag) }
  })())
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil((async () => {
    // The payload cannot choose a URL or open a chat whose access has since changed.
    const target = new URL('/settings/notifications', self.location.origin).href
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const existing = clients.find(client => new URL(client.url).origin === self.location.origin)
    if (existing) { await existing.navigate(target); await existing.focus() }
    else await self.clients.openWindow(target)
  })())
})

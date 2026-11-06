// The service worker (tab 5 PWA; web/scripts/product-pages.ts fills the product name in at build): caches only hashed static files (/assets/*, /vendor/chunk-*). index.html, /api
// and the WebSocket always go to the network. The offline document is self-contained, with table text and the
// same bounded recovery-language policy as the app (injected at build). It reads origin storage in the page,
// never stores account content in this worker or its cache, and also works with an empty static cache.
// One cache per build: its name carries a hash of the build's file names (product-pages.ts), so a new build is a new
// worker, and activating it deletes every other cache: only the current build's files stay (one cache never pruned
// grew by about 15 MB a release). A tab still on the old build that asks for one of its files then gets the server's
// 404 and reloads once (web/src/lib/chunk-reload.ts).
const CACHE = 'mycel-static-__STATIC_BUILD__'
const OFFLINE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="mycel-offline" content="navigation-v1"><title>__PRODUCT_NAME_HTML__</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",system-ui,sans-serif;background:#fcfbf8;color:#14110f;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;text-align:center}
@media (prefers-color-scheme:dark){body{background:#0e0c0b;color:#f6f2ea}}button{margin-top:16px;padding:8px 16px;border-radius:8px;border:0;background:#e8521a;color:#14110f;font-size:15px}</style></head>
<body><main><h1 id="title" style="font-size:20px">__OFFLINE_TITLE__</h1><p id="hint">__OFFLINE_HINT__</p><button id="retry">__OFFLINE_RETRY__</button></main><script>__OFFLINE_SCRIPT__</script></body></html>`

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
// room.dm / room.mention: a message or an @mention in a room. No switch of their own here: each room's level decides on
// the server, which sends the push only while that level still asks for it (docs/DECISIONS.md "대화방 알림 설정"; a room
// at its own level alerts even with the default 받지 않음, whose older switch roomMessages is then false)
const ROOM_CODES = new Set(['room.dm', 'room.mention'])
const pushWanted = (preferences, code) => ROOM_CODES.has(code) || (Object.hasOwn(PUSH_PREF, code) && preferences[PUSH_PREF[code]] === true)
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

// A room notice while the app is open in a window here: that page makes the room sound itself (web/src/lib/roomSound.ts,
// one sound a device), so the notice is shown silently when a page says it takes care of it (also when this device's
// sound is off). No page, or no answer within PAGE_ASK_MS (a page from before this, a frozen tab): the system's sound.
const PAGE_ASK_MS = 400
async function pageSounds() {
  if (typeof MessageChannel === 'undefined') return false
  const windows = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
    .filter(client => typeof client.postMessage === 'function' && new URL(client.url).origin === self.location.origin)
  if (!windows.length) return false
  const ports = []
  const asked = new Promise(resolve => {
    let left = windows.length
    const timer = setTimeout(() => resolve(false), PAGE_ASK_MS)
    const answer = yes => { if (yes || --left === 0) { clearTimeout(timer); resolve(yes) } }
    for (const client of windows) {
      try {
        const channel = new MessageChannel()
        ports.push(channel.port1)
        channel.port1.onmessage = event => answer(event.data?.type === 'room-sound.answer' && event.data.handled === true)
        client.postMessage({ type: 'room-sound.ask' }, [channel.port2])
      } catch { answer(false) }
    }
  })
  // answered or out of time: no port stays open
  try { return await asked } finally { for (const port of ports) port.close() }
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
    if (!payload || !opaqueId(payload.notificationId) || !opaqueId(payload.subscriptionId) || !(Object.hasOwn(PUSH_PREF, payload.code) || ROOM_CODES.has(payload.code))) return
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
      if (generation !== pushEpoch || !settings.configured || !settings.enabled || settings.subscriptionId !== payload.subscriptionId || !pushWanted(preferences, payload.code) || item.id !== payload.notificationId || item.code !== payload.code || item.readAt !== null) return
      // The authenticated server selects generic table text in the recipient's current account/team language.
      const title = settings.messages?.title, body = settings.messages?.bodies?.[payload.code]
      if (typeof title !== 'string' || !title || typeof body !== 'string' || !body) return
      // a room notice opens its room: the id comes from the signed-in fetch of the notice, never from the payload
      const roomId = item.link === 'room' && opaqueId(item.room?.id) ? item.room.id : undefined
      // a reply in a thread opens that thread (its root's id, from the same signed-in fetch)
      const threadId = roomId && opaqueId(item.room?.thread) ? item.room.thread : undefined
      const silent = payload.code.startsWith('room.') && await pageSounds().catch(() => false)
      if (generation !== pushEpoch) return
      await self.registration.showNotification(title, { body, tag, renotify: false, silent, data: roomId ? { notificationId: payload.notificationId, roomId, ...(threadId ? { threadId } : {}) } : { notificationId: payload.notificationId } })
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
    // The payload cannot choose a URL or open a chat whose access has since changed. A room notice opens its room (the
    // id stored at show time from the authenticated notice; the room page checks membership again).
    const roomId = event.notification.data?.roomId, threadId = event.notification.data?.threadId
    const target = new URL(opaqueId(roomId) ? (opaqueId(threadId) ? `/rooms/${roomId}/t/${threadId}` : `/rooms/${roomId}`) : '/settings/notifications', self.location.origin).href
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const existing = clients.find(client => new URL(client.url).origin === self.location.origin)
    if (existing) { await existing.navigate(target); await existing.focus() }
    else await self.clients.openWindow(target)
  })())
})

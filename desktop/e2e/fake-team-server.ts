// Fake team servers + a fixture website for the desktop e2e tests (run with Bun by playwright.config.ts).
//
//   acme  http://acme.localhost:19151   team page + /api/ws (browser.call / browser.result per shared/src/api/ws.ts)
//   beta  http://beta.localhost:19152   second team (partition isolation)
//   lan   http://lan.localhost:19156    announces an office address https://127.0.0.1:19154 (pinned certificate)
//   bad   http://bad.localhost:19157    announces https://127.0.0.1:19155 with the WRONG fingerprint
//   site  http://shop.test:19153 (= 127.0.0.1, "public" in tests) and http://nas.lan:19153 (= 127.0.0.1, an office
//         address); http://127.0.0.1:19153 itself is "this computer", which the in-app browser never opens
//   attacker  http://attacker.test:19158 (= 127.0.0.1, "public"): logs every full request URL (GET /__log), for the
//         exfiltration tests (exfil.spec.ts)
//
// Test control (any team port): POST /test/call, GET /test/result, GET /test/acks, POST /test/cancel, POST /test/policy
// {allowAll} (Me.team.browserAllowAll: the team's "members can turn on 'Allow all websites'", settings.spec.ts).
// Ports are in component E's range (19150–19159).
import { X509Certificate } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { uuidv7 } from '@mycel/shared'
import { BrowserResult, ClientFrame, type BrowserCall, type Me } from '@mycel/shared/api'

const HERE = import.meta.dir
const WORK = join(HERE, '.work')
mkdirSync(WORK, { recursive: true })

// ---------------------------------------------------------------- certificates (generated per run, never committed)
function makeCert(name: string): { cert: string; key: string; fingerprint: string } {
  const key = join(WORK, `${name}.key`)
  const crt = join(WORK, `${name}.crt`)
  const p = Bun.spawnSync([
    'openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-subj', `/CN=${name}.local`, '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-keyout', key, '-out', crt,
  ], { stderr: 'pipe' })
  if (p.exitCode !== 0) throw new Error(`openssl failed: ${p.stderr.toString()}`)
  const cert = readFileSync(crt, 'utf8')
  return { cert, key: readFileSync(key, 'utf8'), fingerprint: new X509Certificate(cert).fingerprint256 }
}
const good = makeCert('lan-good')
const bad = makeCert('lan-bad')

// ---------------------------------------------------------------- the fake web page bundle
const bundle = await Bun.build({ entrypoints: [join(HERE, 'fake-web.ts')], target: 'browser', format: 'esm' })
if (!bundle.success) throw new Error(bundle.logs.join('\n'))
const appJs = await bundle.outputs[0].text()

// ---------------------------------------------------------------- teams
interface Team {
  name: string
  port: number
  direct?: { port: number; announce: string }
  sockets: Map<string, ServerWebSocket<{ team: Team; windowId: string }>>
  results: Map<string, BrowserResult[]>
  acks: Map<string, number>
  waiters: Map<string, ((r: BrowserResult) => void)[]>
  seq: number
  lastWindow?: string
  /** windows whose page found the desktop bridge (fake-web.ts adds bridge=desktop to /api/ws) */
  bridged: Set<string>
  /** test clock skew: this server's clock runs skewMs ahead of the real one (health time and call deadlines) */
  skewMs: number
  /** POST /api/connect-info/lan-failure bodies the app sent */
  lanFailures: { code: string; csrf: boolean }[]
  /** GET /downloads/index.json requests: whether they carried the team session (update.spec.ts) */
  downloadHits: ('session' | 'none')[]
  /** Me.team.browserAllowAll (undefined: an older server without the policy) */
  browserAllowAll?: boolean
  /** GET /api/me requests that carried the team session (the app reads the policy there) */
  meHits: number
  meUnavailable?: boolean
}
const team = (name: string, port: number, direct?: Team['direct']): Team => ({ name, port, direct, sockets: new Map(), results: new Map(), acks: new Map(), waiters: new Map(), seq: 0, skewMs: 0, bridged: new Set(), lanFailures: [], downloadHits: [], meHits: 0 })
const TEAMS = [team('Acme', 19151), team('Beta', 19152), team('Lan', 19156, { port: 19154, announce: good.fingerprint }), team('Bad', 19157, { port: 19155, announce: good.fingerprint })]

let lanControl: (t: Team, up: boolean) => Promise<void> = async () => {}
const json = (v: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...headers } })
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function teamPage(t: Team) {
  const art = `<script>parent.postMessage({ rtc: typeof RTCPeerConnection, bridge: typeof window.mycelDesktop }, '*')</script>`
  const escape = `<script>setTimeout(() => { location.href = 'http://127.0.0.1:19153/frame-escape' }, 30)</script>`
  // an artifact that tries to get WebRTC back from a fresh same-origin child frame or a blob/data child document
  const nested = `<body><script>
const out = {}
const f = document.createElement('iframe'); document.body.appendChild(f)
try { out.child = typeof f.contentWindow.RTCPeerConnection; out.childCanMake = (() => { try { new f.contentWindow.RTCPeerConnection(); return 'made' } catch (e) { return String(e).slice(0, 80) } })() } catch (e) { out.child = 'error: ' + String(e).slice(0, 120) }
try { out.childData = typeof f.contentWindow.RTCDataChannel } catch (e) { out.childData = 'error' }
try { out.media = typeof navigator.mediaDevices } catch (e) { out.media = 'error' }
const g = document.createElement('iframe'); g.srcdoc = '<script>parent.postMessage({ nestedSrcdoc: typeof RTCPeerConnection }, \\'*\\')<\\/script>'; document.body.appendChild(g)
addEventListener('message', (e) => { if (e.data && 'nestedSrcdoc' in e.data) { out.srcdoc = e.data.nestedSrcdoc; parent.postMessage({ nested: out }, '*') } })
</script></body>`
  return `<!doctype html><html><head><meta charset="utf-8"><title>${t.name}</title><script>addEventListener('message', (e) => { if (e.data && typeof e.data === 'object' && 'rtc' in e.data) window.__frame = e.data; if (e.data && typeof e.data === 'object' && 'nested' in e.data) window.__nested = e.data.nested })</script></head><body>
<h1 id="team">${t.name}</h1><p id="bridge"></p>
<a id="external" href="https://example.com/outside">outside</a>
<iframe id="art" sandbox="allow-scripts" srcdoc="${esc(art)}"></iframe>
<iframe id="nested" sandbox="allow-scripts" srcdoc="${esc(nested)}"></iframe>
<iframe id="escape" sandbox="allow-scripts allow-top-navigation-by-user-activation" srcdoc="${esc(escape)}"></iframe>
<script type="module" src="/app.js"></script></body></html>`
}

function sessionCookie(req: Request): string | null {
  const c = req.headers.get('cookie') ?? ''
  return /(?:^|;\s*)(?:__Host-sid|mycel-dev-sid)=([^;]+)/.exec(c)?.[1] ?? null
}

/** the person a test session belongs to: /test/login?user=<name> makes a session value "u-<name>.<uuid>" */
const sessionUser = (req: Request): string => /^u-([a-z0-9-]{1,40})\./.exec(sessionCookie(req) ?? '')?.[1] ?? 'owner'

function me(t: Team, user = 'owner'): Me {
  return {
    user: { id: user, username: user, name: user === 'owner' ? 'Owner' : user, email: null, role: 'owner', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} as Me['user']['prefs'] },
    groups: [],
    team: { name: `${t.name} Team`, defaultLocale: 'ko', ...(t.browserAllowAll === undefined ? {} : { browserAllowAll: t.browserAllowAll }) },
    session: { id: uuidv7(), client: 'desktop', expiresAt: new Date(Date.now() + 86400_000).toISOString() },
    server: { version: '0.0.0-test', dev: true },
  }
}

function sendCall(t: Team, call: BrowserCall, windowId: string) {
  const ws = t.sockets.get(windowId)
  if (!ws) return false
  ws.send(JSON.stringify({ type: 'browser.call', seq: ++t.seq, at: Date.now(), data: { windowId, call } }))
  return true
}

async function teamFetch(t: Team, req: Request, server: { upgrade: (r: Request, o: { data: { team: Team; windowId: string } }) => boolean }, secure: boolean): Promise<Response | undefined> {
  const url = new URL(req.url)
  const p = url.pathname
  if (p === '/api/ws') {
    const windowId = url.searchParams.get('windowId') ?? ''
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(windowId)) return new Response('bad windowId', { status: 400 })
    if (url.searchParams.get('bridge') === 'desktop') t.bridged.add(windowId)
    return server.upgrade(req, { data: { team: t, windowId } }) ? undefined : new Response('upgrade failed', { status: 400 })
  }
  if (p === '/') return new Response(teamPage(t), { headers: { 'content-type': 'text/html; charset=utf-8' } })
  if (p === '/app.js') return new Response(appJs, { headers: { 'content-type': 'text/javascript' } })
  if (p === '/api/health') return json({ ok: true, version: '0.0.0-test', schema: { applied: 2, readerLevel: 1 }, uptimeSec: 1, time: new Date(Date.now() + t.skewMs).toISOString() })
  if (p === '/test/skew' && req.method === 'POST') {
    t.skewMs = Number(((await req.json()) as { ms?: number }).ms ?? 0)
    return json({ ok: true })
  }
  if (p === '/test/me-unavailable') { t.meUnavailable = url.searchParams.get('on') === '1'; return json({ ok: true }) }
  if (p === '/api/me') {
    if (t.meUnavailable) return json({ error: { code: 'unavailable', message: 'fixture unavailable' } }, 503)
    if (!sessionCookie(req)) return json({ error: { code: 'unauthorized', message: 'sign in' } }, 401)
    t.meHits++
    return json(me(t, sessionUser(req)))
  }
  if (p === '/test/policy' && req.method === 'POST') {
    const b = (await req.json()) as { allowAll?: boolean | null }
    t.browserAllowAll = typeof b.allowAll === 'boolean' ? b.allowAll : undefined
    return json({ ok: true, meHits: t.meHits })
  }
  if (p === '/test/me-hits') return json({ meHits: t.meHits })
  if (p === '/api/connect-info') {
    if (!t.direct) return json({ error: { code: 'not_found', message: 'no direct connection' } }, 404)
    return json({ teamId: `team-${t.name.toLowerCase()}`, lanCertSha256: t.direct.announce, lanPort: t.direct.port, lanHosts: ['127.0.0.1'] })
  }
  if (p === '/api/connect-info/lan-failure' && req.method === 'POST') {
    t.lanFailures.push({ code: String(((await req.json()) as { code?: string }).code), csrf: req.headers.get('x-mycel-csrf') === '1' })
    return new Response(null, { status: 204 })
  }
  if (p === '/test/lan-failures') return json({ items: t.lanFailures })
  // the desktop apps the team offers (signed-in people only, like the real /downloads/): a newer Mac app
  if (p === '/downloads/index.json') {
    t.downloadHits.push(sessionCookie(req) ? 'session' : 'none')
    if (!sessionCookie(req)) return new Response('Sign in first\n', { status: 401 })
    return json({ items: [{ platform: 'windows', file: 'Team-AX-Setup-99.0.0-win-x64.exe', version: '99.0.0', size: 1, signed: false }, { platform: 'mac', file: 'Team-AX-99.0.0-mac-universal.dmg', version: '99.0.0', size: 1, signed: false }] })
  }
  if (p === '/test/downloads-hits') return json({ hits: t.downloadHits })
  if (p === '/test/logout') {
    return json({ ok: true }, 200, { 'set-cookie': secure ? '__Host-sid=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0' : 'mycel-dev-sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' })
  }
  if (p === '/test/login') {
    const user = url.searchParams.get('user')
    const v = user && /^[a-z0-9-]{1,40}$/.test(user) ? `u-${user}.${crypto.randomUUID()}` : crypto.randomUUID()
    // a 30-day cookie like the real server's (auth/service.ts sessionCookie): the sign-in survives an app restart
    return json({ value: v }, 200, { 'set-cookie': secure ? `__Host-sid=${v}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000` : `mycel-dev-sid=${v}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000` })
  }
  if (p === '/test/lan' && req.method === 'POST') {
    await lanControl(t, Boolean(((await req.json()) as { up?: boolean }).up))
    return json({ ok: true })
  }
  if (p === '/test/whoami') return json({ session: sessionCookie(req), secure })
  if (p === '/test/windows') return json({ windows: [...t.sockets.keys()], last: t.lastWindow ?? null, bridged: [...t.bridged].filter((w) => t.sockets.has(w)) })
  if (p === '/test/call' && req.method === 'POST') {
    const b = (await req.json()) as { windowId?: string; tool: string; args?: Record<string, unknown>; callId?: string; turnId?: string; deadlineMs?: number }
    const windowId = b.windowId ?? t.lastWindow
    if (!windowId) return json({ error: 'no window connected' }, 409)
    const call: BrowserCall = {
      callId: b.callId ?? crypto.randomUUID(),
      turnId: b.turnId ?? uuidv7(),
      chatId: uuidv7(),
      tool: b.tool as BrowserCall['tool'],
      args: b.args ?? {},
      deadline: Date.now() + t.skewMs + (b.deadlineMs ?? 120_000),
    }
    if (!sendCall(t, call, windowId)) return json({ error: 'window not connected' }, 409)
    return json({ callId: call.callId, turnId: call.turnId })
  }
  if (p === '/test/cancel' && req.method === 'POST') {
    const b = (await req.json()) as { callId: string; windowId?: string }
    const windowId = b.windowId ?? t.lastWindow!
    t.sockets.get(windowId)?.send(JSON.stringify({ type: 'browser.cancel', seq: ++t.seq, at: Date.now(), data: { windowId, callId: b.callId } }))
    return json({ ok: true })
  }
  if (p === '/test/result') {
    const callId = url.searchParams.get('callId') ?? ''
    const have = t.results.get(callId)
    if (have?.length) return json({ result: have[0], count: have.length, acks: t.acks.get(callId) ?? 0 })
    const r = await new Promise<BrowserResult | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), Number(url.searchParams.get('waitMs') ?? 60_000))
      const list = t.waiters.get(callId) ?? []
      list.push((x) => (clearTimeout(timer), resolve(x)))
      t.waiters.set(callId, list)
    })
    return r ? json({ result: r, count: t.results.get(callId)?.length ?? 1, acks: t.acks.get(callId) ?? 0 }) : json({ error: 'timeout' }, 408)
  }
  if (p === '/test/acks') {
    const callId = url.searchParams.get('callId') ?? ''
    return json({ acks: t.acks.get(callId) ?? 0, results: t.results.get(callId)?.length ?? 0 })
  }
  return new Response('not found', { status: 404 })
}

const websocket = {
  open(ws: ServerWebSocket<{ team: Team; windowId: string }>) {
    const { team: t, windowId } = ws.data
    t.sockets.get(windowId)?.close(4409, 'replaced')
    t.sockets.set(windowId, ws)
    t.lastWindow = windowId
    ws.send(JSON.stringify({ type: 'hello', epoch: 'e2e', seq: t.seq, resumed: false, windowId, serverVersion: '0.0.0-test', pingIntervalMs: 20_000 }))
  },
  message(ws: ServerWebSocket<{ team: Team; windowId: string }>, msg: string | Buffer) {
    const t = ws.data.team
    const f = ClientFrame.safeParse(JSON.parse(String(msg)))
    if (!f.success) return
    if (f.data.type === 'browser.ack') t.acks.set(f.data.callId, (t.acks.get(f.data.callId) ?? 0) + 1)
    if (f.data.type === 'browser.result') {
      const r = BrowserResult.parse(f.data.result)
      const list = t.results.get(r.callId) ?? []
      list.push(r)
      t.results.set(r.callId, list)
      for (const w of t.waiters.get(r.callId) ?? []) w(r)
      t.waiters.delete(r.callId)
    }
  },
  close(ws: ServerWebSocket<{ team: Team; windowId: string }>) {
    const t = ws.data.team
    if (t.sockets.get(ws.data.windowId) === ws) t.sockets.delete(ws.data.windowId)
  },
}

/** the office (LAN) listeners; POST /test/lan {up} on a team port stops / restarts its listener (Wi-Fi changed) */
const lanServers = new Map<Team, ReturnType<typeof Bun.serve>>()
function startLan(t: Team) {
  if (!t.direct || lanServers.has(t)) return
  const c = t.direct.port === 19154 ? good : bad
  lanServers.set(t, Bun.serve({ port: t.direct.port, hostname: '127.0.0.1', idleTimeout: 0, tls: { cert: c.cert, key: c.key }, websocket, fetch: (req, server) => teamFetch(t, req, server, true) }))
}
lanControl = async (t, up) => {
  if (up) return startLan(t)
  // force-close the listener and its open connections (the page's WebSocket included); don't wait for them
  void lanServers.get(t)?.stop(true)
  lanServers.delete(t)
}

for (const t of TEAMS) {
  Bun.serve({ port: t.port, hostname: '127.0.0.1', idleTimeout: 0, websocket, fetch: (req, server) => teamFetch(t, req, server, false) })
  startLan(t)
}

// ---------------------------------------------------------------- fixture website
const hits = new Map<string, number>()
const page = (title: string, body: string) =>
  new Response(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } })

Bun.serve({
  port: 19153,
  hostname: '127.0.0.1',
  fetch(req) {
    const url = new URL(req.url)
    const p = url.pathname
    hits.set(p, (hits.get(p) ?? 0) + 1)
    if (p === '/' || p === '/index.html') {
      return page(
        'Proto Shop',
        `<h1>Proto Shop</h1>
<label>상품 검색 <input id="q" type="search" placeholder="검색"></label>
<button id="add" onclick="count++; document.getElementById('cart').textContent = '장바구니 ' + count + '개'">장바구니 담기</button>
<p id="cart">장바구니 0개</p>
<form id="f"><label>이름 <input id="name" name="name"></label>
<label><input type="checkbox" id="agree" name="agree"> 동의</label>
<select id="ship" name="ship" aria-label="배송"><option value="std">일반</option><option value="fast">빠른 배송</option></select></form>
<label>비밀번호 <input id="pw" type="password" name="pw"></label>
<label>OTP <input id="otp" name="otp" autocomplete="current-password"></label>
<script>let count = 0; console.log('shop ready'); console.error('payment widget failed'); fetch('/data.json').then((r) => r.json()).then((d) => (window.data = d))</script>`,
      )
    }
    if (p === '/data.json') return json({ items: [1, 2, 3] })
    // an open redirect on an allowed site (exfil.spec.ts)
    if (p === '/go') return new Response(null, { status: 302, headers: { location: url.searchParams.get('to') ?? '/' } })
    // payment-card fields (quiet.spec.ts): refused like password fields
    if (p === '/pay.html') {
      return page(
        'Checkout',
        `<h1>Checkout</h1>
<label>배송 메모 <input id="memo" name="memo"></label>
<label>카드 번호 <input id="cc" autocomplete="cc-number" inputmode="numeric"></label>
<label>보안코드 <input id="cvc" name="cvc"></label>`,
      )
    }
    // a page's own sub-request to a name the browser's resolver points at this computer (quiet.spec.ts)
    if (p === '/rebind.html') {
      return page(
        'Rebind probe',
        `<p id="out">pending</p><script>fetch('http://rebind.test:19153/rebind-probe.js', { mode: 'no-cors' }).then(() => (document.getElementById('out').textContent = 'reached'), () => (document.getElementById('out').textContent = 'blocked'))</script>`,
      )
    }
    if (p === '/intranet.html') {
      return page(
        'Intranet probe',
        `<p id="out">pending</p><script>fetch('http://nas.lan:19153/data.json').then(() => (document.getElementById('out').textContent = 'reached'), () => (document.getElementById('out').textContent = 'blocked'))</script>`,
      )
    }
    if (p === '/redirect-private') return new Response(null, { status: 302, headers: { location: 'http://nas.lan:19153/index.html' } })
    if (p === '/redirect-team') return new Response(null, { status: 302, headers: { location: 'http://acme.localhost:19151/' } })
    if (p === '/fetch-team') {
      // a page the AI opened tries the team address and this computer (the person's team session must stay out of reach)
      return page(
        'Team probe',
        `<p id="out">pending</p><script>
const probe = (u) => fetch(u, { credentials: 'include' }).then(() => 'reached', () => 'blocked')
Promise.all(['http://acme.localhost:19151/api/health', 'http://127.0.0.1:19151/api/health', 'http://localhost:19151/api/health'].map(probe)).then((r) => (document.getElementById('out').textContent = r.join(',')))
</script>`,
      )
    }
    if (p === '/huge-viewport') {
      // a page that lies about its size to the main world (the desktop must not build a giant bitmap from it)
      return page('Huge', `<h1>huge</h1><script>for (const k of ['innerWidth', 'innerHeight']) Object.defineProperty(window, k, { get: () => 50000000 })</script>`)
    }
    if (p === '/ua') return page('ua', `<p id="ua">${esc(req.headers.get('user-agent') ?? '')}</p>`)
    if (p === '/set-cookie') {
      const r = page('cookie set', `<p id="c">set</p>`)
      r.headers.set('set-cookie', 'fixture=1; Path=/; Max-Age=3600')
      return r
    }
    if (p === '/cookie') return page('cookie', `<p id="c">${esc(req.headers.get('cookie') ?? '')}</p>`)
    if (p === '/frame-escape') return page('escaped', '<p>escaped</p>')
    if (p === '/test/hits') return json({ hits: hits.get(url.searchParams.get('path') ?? '') ?? 0 })
    return new Response('not found', { status: 404 })
  },
})

console.log(`fake team servers ready: ${TEAMS.map((t) => t.port).join(', ')}, site 19153`)

// attacker.test -> 127.0.0.1:19158: records the full URL of every request (exfil.spec.ts reads /__log)
const attackerLog: string[] = []
Bun.serve({
  port: 19158,
  hostname: '127.0.0.1',
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/__log') return json({ log: attackerLog })
    attackerLog.push(req.url)
    return new Response('<!doctype html><title>ok</title><p>ok</p>', { headers: { 'content-type': 'text/html', 'access-control-allow-origin': '*' } })
  },
})

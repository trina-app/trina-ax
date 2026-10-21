// Office mode over its INTERNET address (docs/OFFICE.md "인터넷 주소"), against a RUNNING office install whose
// cloudflared is connected: every desk request goes to https://<public name> through Cloudflare with Node's normal
// public certificate checks (no office CA), the way a desk opens it without installing anything.
//
//   node tests/install/office-tunnel-e2e.mjs --base https://<public name> --local http://localhost:<app port> \
//     --token <setup token> [--big-mb 120] [--no-claude]
//
// login page with a valid public certificate -> the owner setup is refused over the internet (even with the right
// token) -> setup on the Mac itself (--local) -> owner signs in over the internet (__Host- Secure cookie) -> invite
// (link on the internet address) -> member accepts, signs out and in -> small upload and a big one through 8 MB
// chunks (a single request that big would pass Cloudflare's 100 MB limit) -> wss through the tunnel -> one real chat
// turn reading the small file -> the audit log has the visitor's public IP (Cloudflare's /cdn-cgi/trace says which).
import crypto from 'node:crypto'
import tls from 'node:tls'
import { createRequire } from 'node:module'

const WebSocket = createRequire(new URL('../../relay/package.json', import.meta.url))('ws')

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }
const BASE = arg('--base')
const LOCAL = arg('--local')
const TOKEN = arg('--token')
const BIG_MB = Number(arg('--big-mb', '120'))
const CLAUDE = !process.argv.includes('--no-claude')
if (!BASE || !LOCAL || !TOKEN) { console.error('usage: --base https://<public name> --local http://localhost:<port> --token <setup token>'); process.exit(2) }
const HOST = new URL(BASE).host

const checks = []
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail: String(detail).slice(0, 400) }); console.error(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${String(detail).slice(0, 400)}`}`) }
const PW_OWNER = 'Clinic-owner-pw-2026!'
const PW_DESK = 'Desk-member-pw-2026!'

function jar(base) {
  let cookie = ''
  return {
    get: () => cookie,
    async call(method, p, body, extra = {}) {
      const headers = { origin: base, accept: 'application/json', ...extra.headers }
      if (method !== 'GET') headers['x-mycel-csrf'] = '1'
      if (cookie) headers.cookie = cookie
      let payload
      if (body instanceof FormData || body instanceof Uint8Array) payload = body
      else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body) }
      const res = await fetch(base + p, { method, headers, body: payload, redirect: 'manual' })
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [kv] = c.split(';')
        cookie = /Max-Age=0/i.test(c) ? '' : kv
        this.lastSetCookie = c
      }
      const text = await res.text()
      let json = null
      try { json = JSON.parse(text) } catch {}
      return { status: res.status, json, text, headers: res.headers }
    },
  }
}

function peerCert(host) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port: 443, servername: host }, () => {
      const c = s.getPeerCertificate()
      resolve({ authorized: s.authorized, subject: c.subject?.CN, issuer: `${c.issuer?.O ?? ''} ${c.issuer?.CN ?? ''}`.trim(), validTo: c.valid_to })
      s.end()
    })
    s.once('error', reject)
  })
}

const owner = jar(BASE)
const local = jar(LOCAL)
const desk = jar(BASE)
let summary = {}
try {
  const cert = await peerCert(HOST)
  check('public certificate is valid for the name (Node default CAs)', cert.authorized === true, JSON.stringify(cert))
  const page = await fetch(BASE + '/login')
  const html = await page.text()
  check('login page loads over https through the tunnel', page.status === 200 && /<html/i.test(html), page.status)
  check('HSTS on the internet address', (page.headers.get('strict-transport-security') ?? '').includes('max-age='), page.headers.get('strict-transport-security'))
  const trace = await (await fetch(BASE + '/cdn-cgi/trace')).text()
  const myIp = /^ip=(.+)$/m.exec(trace)?.[1]?.trim()
  check('Cloudflare reports this machine\'s public IP', !!myIp, trace.slice(0, 200))
  const plain = await fetch(`http://${HOST}/api/health`, { redirect: 'manual' }).catch((e) => ({ status: 'error ' + e.message, headers: new Headers() }))
  check('plain http is sent to https', [301, 302, 307, 308].includes(plain.status) && (plain.headers.get('location') ?? '').startsWith('https://'), `${plain.status} ${plain.headers.get('location')}`)

  const st = await owner.call('GET', '/api/setup')
  check('setup pending on a fresh install', st.json?.needed === true, st.text)
  const remote = await owner.call('POST', '/api/setup', { setupToken: TOKEN, teamName: 'Office Tunnel Test', locale: 'ko', owner: { username: 'director', name: 'Director', password: PW_OWNER } })
  check('owner setup is refused over the internet (even with the right token)', remote.status === 403 && !owner.get(), remote.text)
  const setup = await local.call('POST', '/api/setup', { setupToken: TOKEN, teamName: 'Office Tunnel Test', locale: 'ko', owner: { username: 'director', name: 'Director', password: PW_OWNER } })
  check('setup on the Mac itself (http://localhost)', setup.status === 201, setup.text)

  const bad = await owner.call('POST', '/api/auth/login', { username: 'director', password: 'not the password 123' })
  check('a wrong password is refused over the internet', bad.status === 401, bad.text)
  const ol = await owner.call('POST', '/api/auth/login', { username: 'director', password: PW_OWNER })
  check('owner signs in over the internet', ol.status === 200, ol.text)
  check('session cookie is __Host-, Secure, HttpOnly', /^__Host-sid=/.test(owner.get()) && /;\s*Secure/i.test(owner.lastSetCookie) && /HttpOnly/i.test(owner.lastSetCookie), owner.lastSetCookie)
  const evil = await owner.call('POST', '/api/auth/logout', undefined, { headers: { origin: 'https://evil.example' } })
  check('another Origin is refused (CSRF)', evil.status === 403, evil.text)

  const inv = await owner.call('POST', '/api/admin/invites', { role: 'member' })
  check('invite link uses the internet address', inv.status === 201 && String(inv.json?.url ?? '').startsWith(`${BASE}/invite/`), inv.json?.url)
  const acc = await desk.call('POST', `/api/invites/${inv.json.token}/accept`, { username: 'desk1', name: 'Front desk 1', password: PW_DESK })
  check('member accepts the invite over the internet', acc.status === 201, acc.text)
  await desk.call('POST', '/api/auth/logout')
  const login = await desk.call('POST', '/api/auth/login', { username: 'desk1', password: PW_DESK })
  check('member signs in over the internet', login.status === 200 && /^__Host-sid=/.test(desk.get()), login.text)

  const word = 'TUNNEL-' + crypto.randomBytes(3).toString('hex').toUpperCase()
  const fd = new FormData()
  fd.set('folder', 'users/desk1')
  fd.set('file', new Blob([`Front desk note\nThe code word for today is ${word}.\n`], { type: 'text/plain' }), 'desk-note.txt')
  const up = await desk.call('POST', '/api/files/upload', fd)
  check('small upload over the internet', up.status === 201, up.text)
  const filePath = up.json?.path ?? 'users/desk1/desk-note.txt'

  // big file: 8 MB chunks (what the web app does above 50 MB)
  const size = BIG_MB * 1024 * 1024
  const big = crypto.randomBytes(size)
  const sha = crypto.createHash('sha256').update(big).digest('hex')
  const t1 = Date.now()
  const sess = await desk.call('POST', '/api/upload-sessions', { target: { kind: 'path', path: `users/desk1/big-${BIG_MB}mb.bin`, onExists: 'replace' }, size, sha256: sha })
  check(`upload session for ${BIG_MB} MB`, sess.status === 201, sess.text)
  let chunksOk = true
  for (let n = 0; n < sess.json.chunkCount && chunksOk; n++) {
    const part = big.subarray(n * sess.json.chunkSize, Math.min(size, (n + 1) * sess.json.chunkSize))
    const r = await desk.call('PUT', `/api/upload-sessions/${sess.json.id}/chunks/${n}`, new Uint8Array(part), { headers: { 'content-type': 'application/octet-stream' } })
    if (r.status !== 200) { chunksOk = false; check(`chunk ${n}`, false, `${r.status} ${r.text}`) }
  }
  const done = await desk.call('POST', `/api/upload-sessions/${sess.json.id}/complete`)
  check(`${BIG_MB} MB upload through 8 MB chunks completes with the right SHA-256`, chunksOk && done.status === 200 && done.json?.entry?.size === size, done.text)
  const bigSecs = (Date.now() - t1) / 1000
  const dl = await fetch(`${BASE}/api/files/download?path=${encodeURIComponent(`users/desk1/big-${BIG_MB}mb.bin`)}`, { headers: { cookie: desk.get() } })
  const got = crypto.createHash('sha256').update(Buffer.from(await dl.arrayBuffer())).digest('hex')
  check(`${BIG_MB} MB download over the internet matches`, dl.status === 200 && got === sha, `${dl.status} ${got}`)

  const windowId = 'win-tunnel-' + crypto.randomBytes(4).toString('hex')
  const ws = new WebSocket(`wss://${HOST}/api/ws?windowId=${windowId}`, 'mycel.v1', { headers: { cookie: desk.get(), origin: BASE } })
  const frames = []
  const waiters = []
  ws.on('message', (d) => {
    let f
    try { f = JSON.parse(String(d)) } catch { return }
    frames.push(f)
    for (const w of [...waiters]) if (w.pred(f)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(f) }
  })
  const next = (pred, ms) => new Promise((resolve, reject) => {
    const hit = frames.find(pred)
    if (hit) return resolve(hit)
    const w = { pred, resolve }
    waiters.push(w)
    setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error('timeout')) } }, ms)
  })
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  const hello = await next((f) => f.type === 'hello', 10_000)
  check('WebSocket (wss) through the tunnel says hello', !!hello, JSON.stringify(hello).slice(0, 200))
  const wsEvil = new WebSocket(`wss://${HOST}/api/ws?windowId=${windowId}x`, 'mycel.v1', { headers: { cookie: desk.get(), origin: 'https://evil.example' } })
  const evilClose = await new Promise((resolve) => { wsEvil.once('close', (code) => resolve(code)); wsEvil.once('error', () => resolve('error')) })
  check('WebSocket with another Origin is closed (4403)', evilClose === 4403, evilClose)

  if (CLAUDE) {
    const chat = await desk.call('POST', '/api/chats', {})
    check('member creates a chat', chat.status === 201, chat.text)
    const t0 = Date.now()
    const sent = await desk.call('POST', `/api/chats/${chat.json.id}/messages`, {
      content: `Read the file ${filePath} in the team folder and reply with only the code word written in it.`,
      clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [],
    }, { headers: { 'x-mycel-window': windowId } })
    check('turn queued', sent.status === 202, sent.text)
    const mid = sent.json?.assistantMessage?.id
    const fin = await next((f) => f.type === 'message.done' && f.data?.messageId === mid, 6 * 60_000).catch((e) => ({ error: e.message }))
    const content = fin?.data?.message?.content ?? ''
    const deltas = frames.filter((f) => f.type === 'message.delta' && f.data?.messageId === mid).length
    check('real Claude turn finished', fin?.data?.status === 'done' || fin?.data?.message?.status === 'done', JSON.stringify(fin).slice(0, 400))
    check('answer has the code word from the uploaded file', content.includes(word), content)
    check('answer streamed through the tunnel (message.delta frames)', deltas >= 1, deltas)
    summary = { turnSeconds: (Date.now() - t0) / 1000, deltas, answer: content.slice(0, 200) }
  }
  ws.close()

  const audit = await owner.call('GET', '/api/admin/audit?source=auth&limit=100')
  const rows = audit.json?.items ?? []
  const logins = rows.filter((r) => r.action === 'auth.login' || r.action === 'auth.login_failed')
  const ips = [...new Set(logins.map((r) => r.detail?.ip).filter(Boolean))]
  check('audit log has the visitor\'s public IP (CF-Connecting-IP), not 127.0.0.1', !!myIp && ips.includes(myIp) && !ips.includes('127.0.0.1'), `trace ip ${myIp}; audit ips ${ips.join(',')}; status ${audit.status}`)
  summary = { ...summary, publicIp: myIp, auditIps: ips, cert, bigMb: BIG_MB, bigUploadSeconds: bigSecs }
} catch (e) {
  check('no unexpected error', false, e?.stack ?? e)
}
console.log(JSON.stringify({ ok: checks.every((c) => c.ok), checks: checks.length, failed: checks.filter((c) => !c.ok), ...summary }, null, 1))
process.exit(checks.every((c) => c.ok) ? 0 : 1)

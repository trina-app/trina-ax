// Office mode over the office network (docs/OFFICE.md), against a RUNNING office install, the way a desk PC uses it:
// every request goes to https://<LAN address>:<lanPort> and the certificate is checked against the office CA only
// (NODE_EXTRA_CA_CERTS; Node's OpenSSL enforces the CA's name constraints, Bun's BoringSSL cannot check IP ones).
//
//   NODE_EXTRA_CA_CERTS=<home>/tls/ca.crt \
//     node tests/install/office-lan.mjs --base https://192.168.1.18:8443 --token <setup token> [--helper http://192.168.1.18:8442]
//
// First-run setup (owner) -> invite -> member accepts -> member signs out and in -> member uploads a file into their
// folder -> WebSocket (wss) -> ONE real chat turn that reads the file -> the answer streams as message.delta frames
// and names the code word. Prints PASS/FAIL lines and a JSON summary; exit 1 on a failure.
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

// the relay workspace's ws (Node's own WebSocket cannot send the Cookie header)
const WebSocket = createRequire(new URL('../../relay/package.json', import.meta.url))('ws')

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }
const BASE = arg('--base')
const TOKEN = arg('--token')
const HELPER = arg('--helper')
if (!BASE || !TOKEN) { console.error('usage: --base https://<lan>:<port> --token <setup token> [--helper http://<lan>:<port>]'); process.exit(2) }

const checks = []
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail: String(detail).slice(0, 400) }); console.error(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${String(detail).slice(0, 400)}`}`) }
const PW_OWNER = 'Office-owner-pw-2026!'
const PW_DESK = 'Desk-member-pw-2026!'

function jar() {
  let cookie = ''
  return {
    get: () => cookie,
    async call(method, p, body, extra = {}) {
      const headers = { origin: BASE, accept: 'application/json', ...extra.headers }
      if (method !== 'GET') headers['x-mycel-csrf'] = '1'
      if (cookie) headers.cookie = cookie
      let payload
      if (body instanceof FormData) payload = body
      else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body) }
      const res = await fetch(BASE + p, { method, headers, body: payload })
      const set = res.headers.getSetCookie?.() ?? []
      for (const c of set) {
        const [kv] = c.split(';')
        if (/Max-Age=0/i.test(c)) cookie = ''
        else cookie = kv
        this.lastSetCookie = c
      }
      const text = await res.text()
      let json = null
      try { json = JSON.parse(text) } catch {}
      return { status: res.status, json, text }
    },
  }
}

const owner = jar()
const desk = jar()
let summary = {}
try {
  if (HELPER) {
    const r = await fetch(HELPER + '/api/health').catch((e) => ({ status: 'error ' + e.message }))
    check('helper port does not serve the API', r.status === 404, r.status)
    const page = await fetch(HELPER + '/')
    check('helper page answers with the CA download', page.status === 200 && (await page.text()).includes('/ca.cer'), page.status)
  }
  const plain = await fetch(BASE.replace('https:', 'http:') + '/api/health').then((r) => r.status).catch(() => 'refused')
  check('plain http on the LAN port is not served', plain !== 200, plain)

  const st = await owner.call('GET', '/api/setup')
  check('setup needed on a fresh install', st.json?.needed === true, st.text)
  const setup = await owner.call('POST', '/api/setup', { setupToken: TOKEN, teamName: 'Office Test', locale: 'ko', owner: { username: 'director', name: 'Director', password: PW_OWNER } })
  check('first-run setup over the LAN address', setup.status === 201, setup.text)
  check('session cookie is __Host-, Secure, HttpOnly on https', /^__Host-/.test(owner.get()) && /;\s*Secure/i.test(owner.lastSetCookie) && /HttpOnly/i.test(owner.lastSetCookie), owner.lastSetCookie)

  const inv = await owner.call('POST', '/api/admin/invites', { role: 'member' })
  check('owner creates an invite', inv.status === 201 && !!inv.json?.token, inv.text)
  check('invite link uses the office address', String(inv.json?.url ?? '').startsWith(BASE), inv.json?.url)
  const acc = await desk.call('POST', `/api/invites/${inv.json.token}/accept`, { username: 'desk1', name: 'Front desk 1', password: PW_DESK })
  check('member accepts the invite', acc.status === 201, acc.text)
  const out = await desk.call('POST', '/api/auth/logout')
  check('member signs out', out.status === 204, out.text)
  const login = await desk.call('POST', '/api/auth/login', { username: 'desk1', password: PW_DESK })
  check('member signs in over the LAN address', login.status === 200 && !!desk.get(), login.text)
  const me = await desk.call('GET', '/api/me')
  check('member session works', me.status === 200, me.text)

  const word = 'OFFICE-' + crypto.randomBytes(3).toString('hex').toUpperCase()
  const folder = 'users/desk1'
  const fd = new FormData()
  fd.set('folder', folder)
  fd.set('file', new Blob([`Front desk note\nThe code word for today is ${word}.\n`], { type: 'text/plain' }), 'desk-note.txt')
  const up = await desk.call('POST', '/api/files/upload', fd)
  check('member uploads a file into their folder', up.status === 201, up.text)
  const filePath = up.json?.path ?? `${folder}/desk-note.txt`

  const windowId = 'win-office-' + crypto.randomBytes(4).toString('hex')
  const ws = new WebSocket(BASE.replace('https:', 'wss:') + `/api/ws?windowId=${windowId}`, 'mycel.v1', { headers: { cookie: desk.get(), origin: BASE } })
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
  check('WebSocket over wss on the LAN address says hello', !!hello, JSON.stringify(hello).slice(0, 200))

  const chat = await desk.call('POST', '/api/chats', {})
  check('member creates a chat', chat.status === 201, chat.text)
  const t0 = Date.now()
  const sent = await desk.call('POST', `/api/chats/${chat.json.id}/messages`, {
    content: `Read the file ${filePath} in the team folder and reply with only the code word written in it.`,
    clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [],
  }, { headers: { 'x-mycel-window': windowId } })
  check('turn queued', sent.status === 202, sent.text)
  const mid = sent.json?.assistantMessage?.id
  const done = await next((f) => f.type === 'message.done' && f.data?.messageId === mid, 6 * 60_000).catch((e) => ({ error: e.message }))
  const content = done?.data?.message?.content ?? ''
  const deltas = frames.filter((f) => f.type === 'message.delta' && f.data?.messageId === mid).length
  check('real Claude turn finished', done?.data?.status === 'done' || done?.data?.message?.status === 'done', JSON.stringify(done).slice(0, 400))
  check('answer has the code word from the uploaded file', content.includes(word), content)
  check('answer streamed over the WebSocket (message.delta frames)', deltas >= 1, deltas)
  ws.close()
  summary = { seconds: (Date.now() - t0) / 1000, deltas, answer: content.slice(0, 200), steps: (done?.data?.message?.steps ?? []).map((s) => `${s.tool}:${s.status}`) }
} catch (e) {
  check('no unexpected error', false, e?.stack ?? e)
}
console.log(JSON.stringify({ ok: checks.every((c) => c.ok), checks: checks.length, failed: checks.filter((c) => !c.ok), ...summary }, null, 1))
process.exit(checks.every((c) => c.ok) ? 0 : 1)

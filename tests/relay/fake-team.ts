// A team server for the relay conformance tests: the real relay client (server/src/relay-client) in its own Bun
// process with a small app instead of the Hono app (ported from spike-relay/team-server.ts).
//   /hello                 { instance, epoch, ip }
//   /api/integrations/oauth/callback   { path, query } (F2 wake tests)
//   /bytes?n=&rid=         n patterned bytes, produced on demand (debug: produced, lastPullAt, cancelAt)
//   /upload?rid=&delay=    sha256 of the request body (delay ms per chunk = slow disk; debug: bytes, errorAt)
//   /slow?ms=              answers after ms
//   /_debug?rid=           the debug record
//   ws /chat?id=&n=&iv=&epoch=&after=   numbered events; resume token = (epoch, seq): another epoch -> reset
//   ws /echo, ws /idle
// env: RELAY_URL TEAM_ID KEY_FILE [INSTANCE CONNS PING_MS DEAD_MS BACKOFF_BASE_MS]
import fs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { loadPrivateKey } from '@mycel/shared/relay-protocol'
import { RelayClient } from '../../server/src/relay-client/client'
import type { VirtualWebSocket } from '../../server/src/services'

const env = process.env
const INSTANCE = env.INSTANCE ?? randomUUID().replace(/-/g, '').slice(0, 12)
/** resume epoch of this process (like the server's ctx.epoch) */
const EPOCH = randomUUID().slice(0, 8)
const log = (msg: string, f: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...f }))

const PATTERN = (() => { const b = new Uint8Array(1 << 20); let x = 2463534242; for (let i = 0; i < b.length; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; b[i] = x & 255 } return b })()
const debug = new Map<string, Record<string, number | string>>()

async function app(req: Request, info: { ip: string | null }): Promise<Response> {
  const u = new URL(req.url)
  const rid = u.searchParams.get('rid') ?? ''
  switch (u.pathname) {
    case '/hello': return Response.json({ instance: INSTANCE, epoch: EPOCH, ip: info.ip })
    // F2 wake tests: an OAuth callback arrives intact (path and query) once the team server is awake
    case '/api/integrations/oauth/callback': return Response.json({ path: u.pathname, query: u.search })
    case '/slow': await Bun.sleep(Number(u.searchParams.get('ms') ?? 1000)); return new Response('late')
    case '/_debug': return Response.json(debug.get(rid) ?? null)
    case '/bytes': {
      if (req.body) for await (const _ of req.body as unknown as AsyncIterable<Uint8Array>) { /* drain a small POST body */ }
      const total = Number(u.searchParams.get('n') ?? 1e6)
      const d = { total, produced: 0, lastPullAt: 0, cancelAt: 0, doneAt: 0 }
      debug.set(rid, d)
      let off = 0
      return new Response(new ReadableStream<Uint8Array>({
        pull(c) {
          d.lastPullAt = Date.now()
          if (off >= total) { d.doneAt = Date.now(); c.close(); return }
          const n = Math.min(65536, total - off)
          const p = off % PATTERN.length
          c.enqueue(PATTERN.slice(p, p + n))
          off += n
          d.produced = off
        },
        cancel() { d.cancelAt = Date.now() },
      }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/octet-stream' } })
    }
    case '/upload': {
      const h = createHash('sha256')
      const delay = Number(u.searchParams.get('delay') ?? 0)
      const d = { bytes: 0, errorAt: 0 }
      debug.set(rid || 'upload', d)
      try {
        for await (const ch of req.body as unknown as AsyncIterable<Uint8Array>) { h.update(ch); d.bytes += ch.byteLength; if (delay) await Bun.sleep(delay) }
      } catch (e) {
        d.errorAt = Date.now()
        throw e
      }
      return Response.json({ bytes: d.bytes, sha256: h.digest('hex') })
    }
  }
  return new Response('not found', { status: 404 })
}

// ------------------------------------------------------------------ WebSockets
type Chat = { events: string[]; subs: Set<VirtualWebSocket>; timer: ReturnType<typeof setInterval> | null }
const chats = new Map<string, Chat>()

function attachWs(ws: VirtualWebSocket, req: Request): boolean {
  const u = new URL(req.url)
  if (u.pathname === '/echo') { ws.onMessage = (m) => ws.send(m); return true }
  if (u.pathname === '/idle') { ws.onMessage = () => {}; return true }
  if (u.pathname !== '/chat') return false
  const id = u.searchParams.get('id')!
  const n = Number(u.searchParams.get('n') ?? 200)
  const iv = Number(u.searchParams.get('iv') ?? 50)
  const epoch = u.searchParams.get('epoch')
  let after = Number(u.searchParams.get('after') ?? 0)
  if (epoch && epoch !== EPOCH) {
    // resume token from another server process: the seq numbers mean nothing here
    ws.send(JSON.stringify({ type: 'reset', epoch: EPOCH }))
    after = 0
  }
  let c = chats.get(id)
  if (!c) {
    const cc: Chat = { events: [], subs: new Set(), timer: null }
    c = cc
    chats.set(id, cc)
    cc.timer = setInterval(() => {
      const seq = cc.events.length + 1
      const ev = JSON.stringify(seq > n ? { seq, epoch: EPOCH, done: true, ts: Date.now() } : { seq, epoch: EPOCH, ts: Date.now(), inst: INSTANCE, tok: '토큰 lorem ipsum ' + seq })
      cc.events.push(ev)
      for (const s of cc.subs) s.send(ev)
      if (seq > n && cc.timer) clearInterval(cc.timer)
    }, iv)
  }
  ws.send(JSON.stringify({ type: 'hello', epoch: EPOCH }))
  for (let i = after; i < c.events.length; i++) ws.send(c.events[i])
  c.subs.add(ws)
  const chat = c
  ws.onClose = () => { chat.subs.delete(ws) }
  return true
}

const client = new RelayClient({
  url: env.RELAY_URL!,
  teamId: env.TEAM_ID!,
  key: loadPrivateKey(fs.readFileSync(env.KEY_FILE!, 'utf8')),
  instance: INSTANCE,
  connections: Number(env.CONNS ?? 2),
  pingMs: env.PING_MS ? Number(env.PING_MS) : undefined,
  deadMs: env.DEAD_MS ? Number(env.DEAD_MS) : undefined,
  backoffBaseMs: env.BACKOFF_BASE_MS ? Number(env.BACKOFF_BASE_MS) : undefined,
  fetch: app,
  attachWs,
  log: {
    debug: (m, f) => log(m, f ?? {}), info: (m, f) => log(m, f ?? {}), warn: (m, f) => log(m, f ?? {}), error: (m, f) => log(m, f ?? {}),
  },
  onState: (s) => log('state', { state: s.state, detail: s.detail, conns: s.conns }),
  onEvent: (e) => log('event', { type: e.type }),
})
client.start()
log('fake team started', { instance: INSTANCE, epoch: EPOCH })
process.on('SIGTERM', () => { client.stop(); process.exit(0) })

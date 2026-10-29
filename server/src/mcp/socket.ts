// The server end of the tool connection. Only the gate (native/mycel-gate) connects here, through a socket in
// a private 0700 folder. The gate's first line carries a shared secret and the peer credentials of the process
// that connected to the public tools.sock; the bridge's first line carries the turn token.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Database } from 'bun:sqlite'
import type { FileService } from '../files/service'
import type { Peer, Turn, TurnRegistry } from '../turns'
import { makeHandler } from './protocol'

export interface McpSocketServer { path: string; secret: string; stop(): void; connections: number; rejected: { reason: string; peer?: Peer }[] }

type S = { buf: string; dec: TextDecoder; stage: 'gate' | 'hello' | 'auth' | 'mcp' | 'closed'; peer?: Peer; turn?: Turn; handle?: (m: any) => Promise<any>; queue: Promise<void>
  /** bytes the kernel did not take yet (Bun's socket.write may write only part; the rest goes out on drain) */
  out: Buffer[] }

/** Write everything, in order: what the socket does not take now is kept and flushed on drain. */
function send(sock: any, data: string) {
  const s: S = sock.data
  const b = Buffer.from(data)
  if (s.out.length) { s.out.push(b); return }
  const n = sock.write(b)
  if (n < b.length) s.out.push(b.subarray(Math.max(0, n)))
}
function flush(sock: any) {
  const s: S = sock.data
  if(s.turn?.revoked) { s.out=[]; sock.end(); return }
  while (s.out.length) {
    const b = s.out[0]!
    const n = sock.write(b)
    if (n < b.length) { s.out[0] = b.subarray(Math.max(0, n)); return }
    s.out.shift()
  }
}

export function startMcpSocket(sockPath: string, files: FileService, db: Database, turns: TurnRegistry): McpSocketServer {
  fs.mkdirSync(path.dirname(sockPath), { recursive: true, mode: 0o700 })
  fs.chmodSync(path.dirname(sockPath), 0o700)
  try { fs.unlinkSync(sockPath) } catch {}
  const secret = crypto.randomBytes(32).toString('hex')
  const state: McpSocketServer = { path: sockPath, secret, stop: () => {}, connections: 0, rejected: [] }
  const connLog = db.query('INSERT INTO tool_events (turn_id, user_id, tool, summary, ok) VALUES (?,?,?,?,?)')

  const reject = (sock: any, s: S, reason: string) => {
    s.stage = 'closed'
    state.rejected.push({ reason, peer: s.peer })
    connLog.run(s.turn?.id ?? null, s.turn?.userId ?? null, '(connect)', `rejected: ${reason} peer=${JSON.stringify(s.peer ?? null)}`.slice(0, 1000), 0)
    try { send(sock, JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'not authorized: ' + reason } }) + '\n') } catch {}
    try { sock.end() } catch {}
  }

  const pump = (sock: any) => {
    const s: S = sock.data
    let i
    while (s.stage !== 'closed' && s.stage !== 'auth' && (i = s.buf.indexOf('\n')) >= 0) {
      const line = s.buf.slice(0, i); s.buf = s.buf.slice(i + 1)
      if (!line.trim()) continue
      let msg: any
      try { msg = JSON.parse(line) } catch { if (s.stage !== 'mcp') return reject(sock, s, 'bad handshake'); continue }
      if (s.stage === 'gate') {
        const g = msg?.gate
        if (!g || typeof g.secret !== 'string' || g.secret.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(g.secret), Buffer.from(secret)))
          return reject(sock, s, 'connection did not come through the gate')
        s.peer = { pid: +g.pid, uid: +g.uid, gid: +g.gid, pgid: +g.pgid, sid: +g.sid }
        s.stage = 'hello'
      } else if (s.stage === 'hello') {
        s.stage = 'auth'
        turns.authenticate(msg?.hello?.token, s.peer!, 3000, (seen) => { s.turn = seen }).then((t) => {
          if (typeof t === 'string') return reject(sock, s, t)
          s.turn = t
          t.abort.signal.addEventListener('abort',()=>{s.out=[];s.stage='closed';try{sock.end()}catch{}},{once:true})
          s.handle = makeHandler(files, db, { user: files.principal(t.userId), turnId: t.id, files: t.files, signal: t.abort.signal }, t.tools)
          s.stage = 'mcp'
          connLog.run(t.id, t.userId, '(connect)', `accepted peer=${JSON.stringify(s.peer)}`, 1)
          pump(sock)
        }, (e) => reject(sock, s, String(e?.message ?? e)))
      } else {
        const turn = s.turn!
        s.queue = s.queue.then(async () => {
          if (turn.revoked) return reject(sock, s, 'turn ended')
          const out = await s.handle!(msg).catch((e) => ({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32603, message: String(e?.message ?? e) } }))
          if (turn.revoked) { s.out=[]; return reject(sock,s,'turn ended') }
          try { out?.beforeDelivery?.() } catch { s.out=[]; return reject(sock,s,'source access changed') }
          if (out && s.stage === 'mcp') try { send(sock, JSON.stringify(out) + '\n') } catch {}
        })
      }
    }
  }

  const server = Bun.listen<S>({
    unix: sockPath,
    socket: {
      open(sock) { sock.data = { buf: '', dec: new TextDecoder('utf-8'), stage: 'gate', queue: Promise.resolve(), out: [] }; state.connections++ },
      drain(sock) { if (sock.data) flush(sock) },
      data(sock, chunk) {
        const s = sock.data
        if (s.stage === 'closed') return
        // one decoder per connection: a read may end in the middle of a multi-byte character (Korean file names,
        // file contents in write calls), which a per-chunk toString() would turn into U+FFFD
        s.buf += s.dec.decode(chunk, { stream: true })
        if (s.buf.length > 64 * 1024 * 1024) return reject(sock, s, 'message too large')
        pump(sock)
      },
      close(sock) { if (sock.data) sock.data.stage = 'closed' },
      error() {},
    },
  })
  fs.chmodSync(sockPath, 0o600)
  state.stop = () => { server.stop(true); try { fs.unlinkSync(sockPath) } catch {} }
  return state
}

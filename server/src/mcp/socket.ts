// The server end of the tool connection. Only the gate (native/mycel-gate) connects here, through a socket in
// a private 0700 folder. The gate's first line carries a shared secret and the peer credentials of the process
// that connected to the public tools.sock; the bridge's first line carries the turn token.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Database } from 'bun:sqlite'
import type { FileService } from '../files/service'
import type { Peer, Turn, TurnRegistry } from '../turns'
import { PARALLEL_READ_TOOLS } from '../rooms/ai-tools'
import { makeHandler } from './protocol'

export interface McpSocketServer { path: string; secret: string; stop(): void; connections: number; rejected: { reason: string; peer?: Peer }[] }

type S = { buf: string; dec: TextDecoder; stage: 'gate' | 'hello' | 'auth' | 'mcp' | 'closed'; peer?: Peer; turn?: Turn; handle?: (m: any) => Promise<any>; calls: CallQueue
  /** bytes the kernel did not take yet (Bun's socket.write may write only part; the rest goes out on drain) */
  out: { bytes: Buffer; guard?: () => void }[] }

/** read-only tool calls of one connection (one answer, its sub-agents included) that run at the same time, at most */
export const MAX_PARALLEL_READS = 4

/** A call of a read-only tool (rooms/ai-tools.ts PARALLEL_READ_TOOLS): it may run next to other such calls. */
export function parallelCall(msg: any): boolean {
  return msg?.method === 'tools/call' && PARALLEL_READ_TOOLS.has(String(msg.params?.name ?? ''))
}

/**
 * The messages of one tool connection, started in the order they came. A read-only tool call (parallelCall) runs next
 * to the other read-only calls, at most `max` at once. Everything else (write, edit, edit_files, any other or unknown
 * tool, initialize, tools/list, notifications) runs alone: it starts once every earlier message has finished, and
 * nothing that came after it starts before it has finished. So a read after a write sees the write, and a write after
 * reads comes after them, as when every message ran one at a time. Answers go out as each call finishes, each with its
 * own JSON-RPC id (the engines match them by id).
 */
export class CallQueue {
  private waiting: { parallel: boolean; run: () => Promise<void> }[] = []
  private running = 0
  private alone = false
  constructor(private readonly max = MAX_PARALLEL_READS) {}
  push(parallel: boolean, run: () => Promise<void>) {
    this.waiting.push({ parallel, run })
    this.next()
  }
  private next() {
    while (this.waiting.length && !this.alone) {
      const job = this.waiting[0]!
      if (job.parallel ? this.running >= this.max : this.running > 0) return
      this.waiting.shift()
      this.running++
      this.alone = !job.parallel
      // started on a later microtask, as on the one promise chain before: the line loop (pump) never runs a handler
      // itself. A job that throws does not hold up the ones after it
      void Promise.resolve().then(job.run).catch(() => {}).then(() => { this.running--; this.alone = false; this.next() })
    }
  }
}

/** Write everything, in order: what the socket does not take now is kept and flushed on drain. */
export function send(sock: any, data: string, guard?: () => void) {
  const s: S = sock.data
  const b = Buffer.from(data)
  if (s.out.length) { s.out.push({ bytes: b, guard }); return }
  guard?.()
  const n = sock.write(b)
  if (n < b.length) s.out.push({ bytes: b.subarray(Math.max(0, n)), guard })
}
export function flush(sock: any) {
  const s: S = sock.data
  if(s.turn?.revoked) { s.out=[]; sock.end(); return }
  while (s.out.length) {
    const pending = s.out[0]!
    try { pending.guard?.() } catch { s.out=[]; s.stage='closed'; sock.end(); return }
    const b = pending.bytes
    const n = sock.write(b)
    if (n < b.length) { pending.bytes = b.subarray(Math.max(0, n)); return }
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
        // read-only tool calls run side by side, everything else one at a time in order (CallQueue)
        s.calls.push(parallelCall(msg), async () => {
          if (turn.revoked) return reject(sock, s, 'turn ended')
          const out = await s.handle!(msg).catch((e) => ({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32603, message: String(e?.message ?? e) } }))
          if (turn.revoked) { s.out=[]; return reject(sock,s,'turn ended') }
          try { out?.beforeDelivery?.() } catch { s.out=[]; return reject(sock,s,'source access changed') }
          if (out && s.stage === 'mcp') try { send(sock, JSON.stringify(out) + '\n', out.beforeDelivery) } catch {}
        })
      }
    }
  }

  const server = Bun.listen<S>({
    unix: sockPath,
    socket: {
      open(sock) { sock.data = { buf: '', dec: new TextDecoder('utf-8'), stage: 'gate', calls: new CallQueue(), out: [] }; state.connections++ },
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

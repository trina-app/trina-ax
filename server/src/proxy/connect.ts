// Codex network path (design tab 1 "리슨", tab 2 "Codex 네트워크"): the engine account may reach only the local model
// proxy (pf + engine sandbox). A Codex turn gets HTTPS_PROXY=http://turn:<proxy token>@127.0.0.1:<port>, and the
// model proxy answers its CONNECT here:
//   - Proxy-Authorization: Basic base64("turn:" + token), a live proxy token (not revoked, not expired) -> else 407
//   - the token's turn is a RUNNING Codex turn (a Claude turn's token, or a finished turn -> 403), or the engine
//     account's device login started by the server CLI (codex-login:pid-<pid>)
//   - the TCP peer is a process of that turn's engine session (asked of the launcher, like the Claude path) -> else 403
//   - the target is exactly one of the allowed host:port pairs (codex.connectHosts; default chatgpt.com:443 and
//     auth.openai.com:443, the hosts Codex 0.163 was seen to use) -> else 403
// Then 200 Connection Established and the bytes are piped both ways (TLS stays end to end: the proxy cannot see or
// count Codex usage; the turn's usage event does). Every refusal is audited. One CONNECT per connection.
import crypto from 'node:crypto'
import net from 'node:net'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Database } from 'bun:sqlite'
import { audit } from '../admin/audit'

export const CODEX_CONNECT_HOSTS = ['chatgpt.com:443', 'auth.openai.com:443']
/** proxy_tokens.turn_id of the engine account's Codex login (server CLI codex-login): pending until the launcher
 * reported the login process, then bound to its pid (= its session id: the launcher starts it with setsid) */
export const CODEX_LOGIN_PENDING = 'codex-login:pending-'
export const CODEX_LOGIN_BOUND = 'codex-login:pid-'

export interface ConnectOpts {
  db: Database
  /** allowed host:port targets, matched exactly */
  hosts?: string[]
  /** session id of the engine process that owns this loopback connection (launcher tcp-peer); null = unknown.
   * Absent = no peer check (unit tests only; production always passes it). */
  peerSession?: (clientPort: number, serverPort: number) => Promise<number | null>
  /** engine session of a running turn (TurnRegistry pgid); null when the turn is not running here */
  turnSession?: (turnId: string) => number | null
  /** open the upstream connection (tests) */
  dial?: (host: string, port: number) => net.Socket
  /** how long a CONNECT of a codex-login token waits for the CLI to bind it to the login process */
  loginBindWaitMs?: number
  /** how often open tunnels are re-checked (token revoked or expired, turn no longer running -> closed); default 1000 */
  sweepMs?: number
}

export interface ConnectHandler {
  (req: IncomingMessage, sock: Duplex, head: Buffer): Promise<void>
  /** open tunnels (tests / diagnostics) */
  open(): number
  /** close every tunnel (proxy stop) */
  closeAll(): void
}

const sha = (t: string) => crypto.createHash('sha256').update(t).digest('hex')

function refuse(sock: Duplex, status: 403 | 407 | 502, extra = '') {
  const text = status === 407 ? 'Proxy Authentication Required' : status === 403 ? 'Forbidden' : 'Bad Gateway'
  try { sock.end(`HTTP/1.1 ${status} ${text}\r\n${extra}Content-Length: 0\r\nConnection: close\r\n\r\n`) } catch {}
}

/** The 'connect' listener of the model proxy's node:http server. */
export function codexConnectHandler(o: ConnectOpts): ConnectHandler {
  const hosts = new Set(o.hosts ?? CODEX_CONNECT_HOSTS)
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  // Open tunnels outlive the CONNECT check: a tunnel stays open after its token was revoked (turn over, login CLI
  // done) unless something closes it. A process of the turn that survived the turn (or the login process after the
  // CLI gave up) would keep a live pipe to chatgpt.com. The sweep closes every tunnel whose token is no longer valid
  // or whose turn is no longer running.
  const tunnels = new Map<Duplex, { tokenHash: string; turnId: string; up: net.Socket }>()
  let timer: ReturnType<typeof setInterval> | null = null
  const valid = (tokenHash: string, turnId: string) => {
    const r = o.db.query('SELECT turn_id, expires_at, revoked_at FROM proxy_tokens WHERE token_hash = ?').get(tokenHash) as
      { turn_id: string; expires_at: string; revoked_at: string | null } | null
    if (!r || r.revoked_at || r.expires_at < new Date().toISOString() || r.turn_id !== turnId) return false
    if (turnId.startsWith('codex-login:')) return true
    const t = o.db.query('SELECT status FROM turns WHERE id = ?').get(turnId) as { status: string } | null
    return t?.status === 'running'
  }
  const sweep = () => {
    for (const [sock, t] of tunnels) {
      let ok = false
      try { ok = valid(t.tokenHash, t.turnId) } catch { ok = false }
      if (!ok) { t.up.destroy(); sock.destroy(); tunnels.delete(sock) }
    }
    if (!tunnels.size && timer) { clearInterval(timer); timer = null }
  }
  const track = (sock: Duplex, tokenHash: string, turnId: string, up: net.Socket) => {
    tunnels.set(sock, { tokenHash, turnId, up })
    const drop = () => { tunnels.delete(sock) }
    sock.once('close', drop); up.once('close', drop)
    if (!timer) { timer = setInterval(sweep, o.sweepMs ?? 1000); (timer as { unref?(): void }).unref?.() }
  }
  const handler = async (req: IncomingMessage, sock: Duplex, head: Buffer) => {
    sock.on('error', () => {})
    const target = String(req.url ?? '')
    const clientPort = (sock as net.Socket).remotePort ?? 0
    const serverPort = (sock as net.Socket).localPort ?? 0
    const deny = (status: 403 | 407, reason: string, actor: string | null = null, turn: string | null = null) => {
      audit(o.db, { actor, action: 'proxy.connect_refused', target: turn, detail: { reason, host: target.slice(0, 120) } })
      refuse(sock, status, status === 407 ? 'Proxy-Authenticate: Basic realm="team-ax"\r\n' : '')
    }
    // token
    const m = /^Basic\s+([A-Za-z0-9+/=]+)$/.exec(String(req.headers['proxy-authorization'] ?? '').trim())
    const cred = m ? Buffer.from(m[1]!, 'base64').toString('utf8') : ''
    if (!cred.startsWith('turn:') || cred.length < 10) return deny(407, 'missing proxy token')
    const tokenHash = sha(cred.slice(5))
    const row = () => o.db.query('SELECT turn_id, user_id, expires_at, revoked_at FROM proxy_tokens WHERE token_hash = ?').get(tokenHash) as
      { turn_id: string; user_id: string; expires_at: string; revoked_at: string | null } | null
    let r = row()
    if (!r || r.revoked_at || r.expires_at < new Date().toISOString()) return deny(407, 'invalid proxy token')

    // whose token: a running Codex turn, or the engine account's device login
    let session: number | null = null
    if (r.turn_id.startsWith('codex-login:')) {
      const until = Date.now() + (o.loginBindWaitMs ?? 3000)
      while (r && r.turn_id.startsWith(CODEX_LOGIN_PENDING) && Date.now() < until) { await sleep(50); r = row() }
      if (!r || r.revoked_at) return deny(407, 'invalid proxy token')
      const pid = r.turn_id.startsWith(CODEX_LOGIN_BOUND) ? Number(r.turn_id.slice(CODEX_LOGIN_BOUND.length)) : NaN
      if (!Number.isInteger(pid) || pid <= 1) return deny(403, 'login token is not bound to the login process', r.user_id, r.turn_id)
      session = pid
    } else {
      const t = o.db.query('SELECT engine, status FROM turns WHERE id = ?').get(r.turn_id) as { engine: string; status: string } | null
      if (!t || t.engine !== 'codex') return deny(403, 'only Codex turns may open tunnels', r.user_id, r.turn_id)
      if (t.status !== 'running') return deny(403, 'the turn is not running', r.user_id, r.turn_id)
      if (o.turnSession) {
        session = o.turnSession(r.turn_id)
        if (session === null) return deny(403, 'the turn is not running here', r.user_id, r.turn_id)
      }
    }
    // target
    if (!hosts.has(target)) return deny(403, 'host not allowed', r.user_id, r.turn_id)
    // caller: a process of that engine session
    if (o.peerSession) {
      const sid = await o.peerSession(clientPort, serverPort)
      if (sid === null || session === null || sid !== session) return deny(403, 'caller is not part of this turn', r.user_id, r.turn_id)
    }
    const i = target.lastIndexOf(':')
    const host = target.slice(0, i), port = Number(target.slice(i + 1))
    const up = (o.dial ?? ((h, p) => net.connect(p, h)))(host, port)
    let open = false
    const turnId = r.turn_id
    up.on('connect', () => {
      open = true
      if (sock.destroyed) { up.destroy(); return }
      track(sock, tokenHash, turnId, up)
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head?.length) up.write(head)
      up.pipe(sock)
      sock.pipe(up)
    })
    up.on('error', () => { if (!open) refuse(sock, 502); else sock.destroy() })
    sock.on('close', () => up.destroy())
    up.on('close', () => sock.destroy())
  }
  return Object.assign(handler, {
    open: () => tunnels.size,
    closeAll: () => {
      for (const [sock, t] of tunnels) { t.up.destroy(); sock.destroy() }
      tunnels.clear()
      if (timer) { clearInterval(timer); timer = null }
    },
  })
}

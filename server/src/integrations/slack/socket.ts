// The Socket Mode connection (https://docs.slack.dev/apis/events-api/using-socket-mode/): apps.connections.open with
// the app-level token gives a wss:// address; Slack says "hello", then sends envelopes, each acknowledged at once with
// its envelope_id (before any work, so Slack never waits 3 seconds and sends it again). Slack refreshes connections
// every few hours ("disconnect" with refresh_requested, or a warning before it): a new connection is opened and the old
// one closed once the new one said hello. A lost connection is opened again after 1, 2, 4 … seconds (at most a
// minute); a token Slack refuses waits five minutes between tries. The token is never logged or put in an error.
import type { Logger } from '../../log'
import type { SlackErrorCode, SlackState } from '@mycel/shared/api'
import { SlackApi, SlackApiError } from './api'
import { Disconnect, Envelope, Hello } from './envelope'

export interface SocketOptions {
  api: SlackApi
  appToken: () => string | null
  onEnvelope: (e: Envelope) => void
  onState: (s: SlackState, err: SlackErrorCode | null) => void
  log: Logger
  retryMs?: number
}

const HELLO_WAIT_MS = 30_000
const MAX_FRAME = 1024 * 1024
const REFUSED = new Set(['invalid_auth', 'token_revoked', 'not_authed', 'account_inactive', 'not_allowed_token_type', 'token_expired'])

export function errorCode(e: unknown): SlackErrorCode {
  const c = e instanceof SlackApiError ? e.code : ''
  if (c === 'invalid_auth' || c === 'not_authed' || c === 'account_inactive' || c === 'token_expired') return 'invalid_auth'
  if (c === 'token_revoked') return 'token_revoked'
  if (c === 'missing_scope') return 'missing_scope'
  if (c === 'not_allowed_token_type') return 'not_app_token'
  if (c === 'ratelimited') return 'ratelimited'
  if (c === 'unreachable' || c === 'http_error' || c === 'redirected') return 'unreachable'
  return 'unknown'
}

export class SlackSocket {
  state: SlackState = 'off'
  lastError: SlackErrorCode | null = null
  /** the app's id, as Slack's hello says it (envelopes of another app are dropped) */
  appId: string | null = null
  private sockets = new Set<WebSocket>()
  private current: WebSocket | null = null
  private stopped = true
  private failures = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private opening = false

  constructor(private readonly o: SocketOptions) {}

  start() {
    if (!this.stopped) return
    this.stopped = false
    this.failures = 0
    void this.connect()
  }

  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const s of this.sockets) try { s.close(1000) } catch {}
    this.sockets.clear()
    this.current = null
    this.set('off', null)
  }

  private set(s: SlackState, err: SlackErrorCode | null) {
    this.state = s; this.lastError = err
    try { this.o.onState(s, err) } catch {}
  }

  private later(ms: number) {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; void this.connect() }, ms)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  private backoff(): number {
    const base = this.o.retryMs ?? 1000
    const ms = Math.min(60_000, base * 2 ** Math.min(this.failures, 8))
    this.failures++
    return ms + Math.floor(Math.random() * Math.min(1000, base))
  }

  /** Open a new connection (also while one is open: Slack's refresh). */
  private async connect() {
    if (this.stopped || this.opening) return
    this.opening = true
    try {
      const token = this.o.appToken()
      if (!token) { this.set('error', 'key_unsafe'); return }
      if (this.state !== 'connected') this.set('connecting', this.lastError)
      let url: unknown
      try { url = (await this.o.api.call('apps.connections.open', token)).url }
      catch (e) {
        const code = errorCode(e)
        this.set('error', code)
        this.o.log.warn('slack connection could not be opened', { reason: code })
        this.later(e instanceof SlackApiError && REFUSED.has(e.code) ? 5 * 60_000 : e instanceof SlackApiError && e.retryAfter ? e.retryAfter * 1000 : this.backoff())
        return
      }
      if (this.stopped) return
      if (!this.o.api.socketUrlOk(url)) { this.set('error', 'unknown'); this.o.log.warn('slack gave an unexpected socket address'); this.later(this.backoff()); return }
      this.open(url)
    } finally { this.opening = false }
  }

  private open(url: string) {
    let ws: WebSocket
    try { ws = new WebSocket(url) } catch { this.set('error', 'unreachable'); this.later(this.backoff()); return }
    this.sockets.add(ws)
    let greeted = false
    const helloTimer = setTimeout(() => { if (!greeted) try { ws.close(4000) } catch {} }, HELLO_WAIT_MS)
    ;(helloTimer as { unref?: () => void }).unref?.()
    ws.addEventListener('message', (m) => {
      const data = typeof m.data === 'string' ? m.data : ''
      if (!data || data.length > MAX_FRAME) return
      let j: unknown
      try { j = JSON.parse(data) } catch { return }
      const hello = Hello.safeParse(j)
      if (hello.success) {
        greeted = true; clearTimeout(helloTimer)
        this.failures = 0
        if (hello.data.connection_info?.app_id) this.appId = hello.data.connection_info.app_id
        // the new connection is up: the older ones (a refresh) go
        for (const s of this.sockets) if (s !== ws) try { s.close(1000) } catch {}
        this.current = ws
        this.set('connected', null)
        return
      }
      const bye = Disconnect.safeParse(j)
      if (bye.success) {
        if (bye.data.reason === 'link_disabled') { this.set('error', 'socket_mode_off'); try { ws.close(1000) } catch {}; this.later(60_000); return }
        // refresh_requested / warning: a new connection now; this one closes when the new one is up
        void this.connect()
        return
      }
      const env = Envelope.safeParse(j)
      if (!env.success) return
      // acknowledge first: the work happens after, and Slack does not send it again
      try { ws.send(JSON.stringify({ envelope_id: env.data.envelope_id })) } catch {}
      try { this.o.onEnvelope(env.data) } catch (e) { this.o.log.error('slack envelope failed', { err: e }) }
    })
    ws.addEventListener('close', () => {
      clearTimeout(helloTimer)
      this.sockets.delete(ws)
      if (this.stopped) return
      if (this.current === ws) { this.current = null; this.set('connecting', null) }
      // nothing left open (not a refresh that already has its new connection): open again
      if (!this.sockets.size) this.later(this.backoff())
    })
  }
}

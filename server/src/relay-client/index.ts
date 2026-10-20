// Wires the relay client into the server (component F). Started by routes/relay.ts init() when config.relay.url is
// set: load / create the team key, register the team address at that relay if needed, keep the control connections,
// serve relayed requests with ctx.appFetch(req, { ip, via: 'relay' }) and relayed WebSockets with the realtime hub's
// attachVirtual(). ctx.services.relay.status() feeds GET /api/admin/connection (component G).
import { X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import type { ConnectionStatus, Locale } from '@mycel/shared/api'
import type { RelayEvent } from '@mycel/shared/relay-protocol'
import type { AppContext } from '../context'
import type { RelayStatusProvider } from '../services'
import { RelayClient, relayApiBase, type RelayClientState } from './client'
import { RelayRegistrationError, ensureRegistered, forgetRegistration, heartbeat, loadOrCreateKey, recordRelayEvent, type Registration } from './registration'

export { RelayClient, relayApiBase, responseHeaders } from './client'
export { RelayWebSocket } from './virtual-ws'

/** Team name used in dev when MYCEL_RELAY_URL is set but no name is configured. */
export const DEV_TEAM_NAME = 'myteam'
const HEARTBEAT_MS = 24 * 3600_000

const NOTICES: Record<string, Record<Locale, string>> = {
  relay_took_over: {
    ko: '이 서버가 다른 서버를 대신해 팀 주소에 연결되었습니다. 예전 서버를 쓰고 있지 않다면 팀 키가 복사되었는지 확인하세요.',
    en: 'This server took over the team address from another server. If you did not move the server, check whether the team key was copied.',
    id: 'Server ini mengambil alih alamat tim dari server lain. Jika Anda tidak memindahkan server, periksa apakah kunci tim telah disalin.',
  },
  relay_replaced: {
    ko: '다른 서버가 같은 팀 키로 팀 주소에 연결해서 이 서버의 원격 접속이 멈췄습니다.',
    en: 'Another server connected to the team address with the same team key, so remote access on this server stopped.',
    id: 'Server lain terhubung ke alamat tim dengan kunci tim yang sama, sehingga akses jarak jauh di server ini berhenti.',
  },
  relay_key_rejected: {
    ko: '등록되지 않은 키로 팀 주소에 연결하려는 시도가 있었고 거부되었습니다.',
    en: 'Someone tried to connect to the team address with an unregistered key; it was rejected.',
    id: 'Ada upaya terhubung ke alamat tim dengan kunci yang tidak terdaftar; upaya itu ditolak.',
  },
}

function directInfo(ctx: AppContext): ConnectionStatus['direct'] {
  const tls = ctx.config.tls
  if (!tls) return { enabled: false, port: 8443, fingerprintSha256: null }
  let fp: string | null = null
  try { fp = new X509Certificate(fs.readFileSync(tls.certFile)).fingerprint256.replace(/:/g, '').toLowerCase() } catch { fp = null }
  return { enabled: true, port: tls.port, fingerprintSha256: fp }
}

function notifyAdmins(ctx: AppContext, code: keyof typeof NOTICES, level: 'info' | 'warn'): void {
  try {
    const rows = ctx.db.query(`SELECT id, locale FROM users WHERE role IN ('owner','admin') AND status = 'active'`).all() as { id: string; locale: Locale }[]
    for (const u of rows) {
      const msgs = NOTICES[code]
      ctx.services.realtime.publish(u.id, { type: 'notice', data: { level, code, message: msgs[u.locale] ?? msgs.ko } })
    }
  } catch (e) {
    ctx.log.warn('relay notice failed', { err: e })
  }
}

export interface RelayService extends RelayStatusProvider {
  client(): RelayClient | null
  registration(): Registration | null
  stop(): void
}

export function startRelayClient(ctx: AppContext): RelayService {
  const url = ctx.config.relay.url
  const log = ctx.log.child({ c: 'relay' })
  let reg: Registration | null = null
  let client: RelayClient | null = null
  let stopped = false
  let pre: { state: ConnectionStatus['state']; detail: string | null } = { state: 'connecting', detail: null }
  let regTimer: ReturnType<typeof setTimeout> | null = null
  let hbTimer: ReturnType<typeof setInterval> | null = null

  const service: RelayService = {
    status(): ConnectionStatus {
      const direct = directInfo(ctx)
      if (!url) return { mode: 'direct-only', address: null, state: 'disabled', detail: null, connectedSince: null, direct }
      const mode: ConnectionStatus['mode'] = /(^|\.)treesoop\.com$/.test(new URL(relayApiBase(url)).hostname) ? 'relay' : 'self-relay'
      if (!client) return { mode, address: reg?.address ?? null, state: pre.state, detail: pre.detail, connectedSince: null, direct }
      const s: RelayClientState = client.state
      const state: ConnectionStatus['state'] = s.state === 'stopped' ? 'offline' : s.state
      return { mode, address: s.address ?? reg?.address ?? null, state, detail: s.detail, connectedSince: s.connectedSince ? new Date(s.connectedSince).toISOString() : null, direct }
    },
    client: () => client,
    registration: () => reg,
    stop() {
      stopped = true
      if (regTimer) clearTimeout(regTimer)
      if (hbTimer) clearInterval(hbTimer)
      client?.stop()
    },
  }
  if (!url) return service

  let relayApi: string
  try {
    relayApi = relayApiBase(url)
  } catch {
    pre = { state: 'offline', detail: 'bad_url' }
    log.error('relay url is not a ws:// or wss:// URL', { url })
    return service
  }
  const name = ctx.config.relay.teamName ?? (ctx.config.mode === 'dev' ? DEV_TEAM_NAME : null)
  let keyPair: ReturnType<typeof loadOrCreateKey>
  try {
    keyPair = loadOrCreateKey(ctx.config.dataDir)
  } catch (e) {
    pre = { state: 'offline', detail: 'key_unreadable' }
    log.error('relay team key could not be loaded or created', { err: e })
    return service
  }
  const { key, publicKey } = keyPair

  const beat = () => {
    if (!reg) return
    heartbeat({ db: ctx.db, relayApi, teamId: reg.teamId, key, version: ctx.version }).catch((e) => log.debug('relay heartbeat failed', { err: e }))
  }

  const begin = (r: Registration) => {
    reg = r
    let lastState: string | null = null
    client = new RelayClient({
      url, teamId: r.teamId, key, log,
      fetch: (req, info) => ctx.appFetch(req, { ip: info.ip, via: 'relay' }),
      attachWs: (ws, req, info) => {
        const hub = ctx.services.realtime
        if (!hub.attachVirtual) return false
        hub.attachVirtual(ws, req, { ip: info.ip, via: 'relay' })
        return true
      },
      onState: (s) => {
        // the relay no longer knows this team (its registry was reset, or the address was released): register again
        if (s.state === 'offline' && s.detail === 'auth_failed' && s.lastError === 'unknown team' && client) {
          log.warn('relay does not know this team any more; registering the address again', { name })
          client.stop()
          client = null
          if (hbTimer) { clearInterval(hbTimer); hbTimer = null }
          forgetRegistration(ctx.db, relayApi)
          pre = { state: 'connecting', detail: 're_registering' }
          regTimer = setTimeout(register, 1000)
          return
        }
        if (s.state === lastState) return
        lastState = s.state
        recordRelayEvent(ctx.db, s.state, s.detail)
        if (s.state === 'replaced') notifyAdmins(ctx, 'relay_replaced', 'warn')
      },
      onEvent: (ev: RelayEvent, self: string) => {
        if (ev.type === 'instance_replaced' && ev.by === self) { recordRelayEvent(ctx.db, 'took_over', ev.previous); notifyAdmins(ctx, 'relay_took_over', 'warn') }
        else if (ev.type === 'key_rejected') { recordRelayEvent(ctx.db, 'key_rejected', String(ev.count)); notifyAdmins(ctx, 'relay_key_rejected', 'warn') }
        else if (ev.type === 'notice') log.info('relay notice', { code: ev.code, message: ev.message })
      },
    })
    client.start()
    beat()
    hbTimer = setInterval(beat, HEARTBEAT_MS)
    hbTimer.unref?.()
  }

  if (!name) {
    pre = { state: 'not_registered', detail: 'team_name_missing' }
    log.warn('relay url is set but no team name (config relay.teamName / MYCEL_RELAY_TEAM): remote access is off')
    return service
  }

  let attempt = 0
  const register = () => {
    regTimer = null
    if (stopped) return
    ensureRegistered({ db: ctx.db, dataDir: ctx.config.dataDir, relayApi, name, key, publicKey, log })
      .then((r) => { if (!stopped) begin(r) })
      .catch((e: unknown) => {
        const code = e instanceof RelayRegistrationError ? e.code : 'internal'
        // a taken / reserved / invalid name needs a person: don't retry; an unreachable relay: retry with backoff
        const permanent = ['name_taken', 'name_reserved', 'invalid_name', 'key_in_use'].includes(code)
        pre = { state: permanent ? 'not_registered' : 'offline', detail: code }
        log.warn('relay registration failed', { code, err: e instanceof Error ? e.message : e, retry: !permanent })
        if (!permanent && !stopped) regTimer = setTimeout(register, Math.min(300_000, 5000 * 2 ** attempt++))
      })
  }
  register()
  return service
}

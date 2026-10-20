// Connection mode (design tab 6 "연결: 팀 주소와 원격 접속"). Component G owns the admin endpoints; the live relay
// state comes from the relay client (component F, ctx.services.relay). Until F is installed the state is derived from
// the configuration. The mode is stored in config/server.json (relay.url) and applies after a restart.
import crypto from 'node:crypto'
import fs from 'node:fs'
import type { ConnectionMode, ConnectionStatus } from '@mycel/shared/api'
import type { AppContext } from '../context'

/** Our relay (tab 6: wss://relay.treesoop.com/connect). The production relay is not running yet (WORKPLAN "막힌 것"). */
export const OFFICIAL_RELAY_URL = 'wss://relay.treesoop.com/connect'

export function modeOf(url: string | null): ConnectionMode {
  if (!url) return 'direct-only'
  return url === OFFICIAL_RELAY_URL ? 'relay' : 'self-relay'
}

let fpCache: { file: string; mtime: number; fp: string | null } | null = null
/** SHA-256 fingerprint of the office-network TLS certificate (desktop app pins it). */
export function certFingerprint(certFile: string): string | null {
  try {
    const st = fs.statSync(certFile)
    if (fpCache && fpCache.file === certFile && fpCache.mtime === st.mtimeMs) return fpCache.fp
    const fp = new crypto.X509Certificate(fs.readFileSync(certFile)).fingerprint256
    fpCache = { file: certFile, mtime: st.mtimeMs, fp }
    return fp
  } catch {
    return null
  }
}

export function connectionStatus(ctx: AppContext): ConnectionStatus {
  const cfg = ctx.config
  const direct = { enabled: !!cfg.tls, port: cfg.tls?.port ?? 8443, fingerprintSha256: cfg.tls ? certFingerprint(cfg.tls.certFile) : null }
  if (ctx.services.relay) {
    const s = ctx.services.relay.status()
    return { ...s, direct: s.direct.fingerprintSha256 || !direct.enabled ? s.direct : direct }
  }
  const mode = modeOf(cfg.relay.url)
  return {
    mode,
    address: null,
    state: mode === 'direct-only' ? 'disabled' : cfg.relay.teamName ? 'connecting' : 'not_registered',
    detail: null,
    connectedSince: null,
    direct,
  }
}

export class ConnectionChangeError extends Error {
  constructor(public code: 'unsupported' | 'no_config' | 'invalid', message: string) { super(message) }
}

/** Write the new relay settings into the server's config file. Returns the URL now configured. */
export function saveConnectionMode(configFile: string | null, mode: ConnectionMode, relayUrl?: string): string | null {
  if (mode === 'cloudflare' || mode === 'tailscale') throw new ConnectionChangeError('unsupported', `${mode} is not available in this version`)
  if (!configFile) throw new ConnectionChangeError('no_config', 'this server runs without a config file (development); set relay.url in .dev/server.json')
  let url: string | null
  if (mode === 'direct-only') url = null
  else if (mode === 'relay') url = OFFICIAL_RELAY_URL
  else {
    if (!relayUrl) throw new ConnectionChangeError('invalid', 'self-relay needs relayUrl')
    const u = new URL(relayUrl)
    if (u.protocol !== 'wss:') throw new ConnectionChangeError('invalid', 'relayUrl must be a wss:// address')
    url = u.toString()
  }
  const raw = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) as Record<string, unknown> : {}
  const relay = (raw.relay && typeof raw.relay === 'object' ? raw.relay : {}) as Record<string, unknown>
  raw.relay = { ...relay, url }
  const tmp = configFile + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, configFile)
  return url
}

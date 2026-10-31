// Connection mode (design tab 6 "연결: 팀 주소와 원격 접속"). Component G owns the admin endpoints; the live relay
// state comes from the relay client (component F, ctx.services.relay). Until F is installed the state is derived from
// the configuration. The mode is stored in config/server.json (relay.url) and applies after a restart.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ConnectionMode, ConnectionStatus } from '@mycel/shared/api'
import { isServiceHost, SERVICE_HOSTS } from '@mycel/shared/service-hosts'
import { PUBLIC_HOST_RE } from '../app-config'
import type { AppContext } from '../context'
import { relayApiBase } from '../relay-client/client'
import { saveClaimCode } from '../relay-client/registration'

/** Our relay (tab 6, shared/src/service-hosts.ts). The production relay is not running yet (WORKPLAN "막힌 것"). */
export const OFFICIAL_RELAY_URL: string = SERVICE_HOSTS.officialRelayUrl

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

/**
 * The connection modes Admin > System offers. The official relay only while it runs (relay.officialAvailable;
 * before that it could be picked and never connected). Cloudflare tunnel and Tailscale are not in v1 (tab 6).
 */
export function availableModes(cfg: AppContext['config']): ConnectionMode[] {
  // office mode (docs/OFFICE.md): the office network only; its supervisor rewrites server.json at every start
  if (cfg.office) return ['direct-only']
  return cfg.relay.officialAvailable ? ['relay', 'self-relay', 'direct-only'] : ['self-relay', 'direct-only']
}

/** names that only answer on a local network, or are reserved and never on the internet (RFC 2606, 6761, 6762 appendix G,
 * 8375 home.arpa): a public address never ends so */
const LOCAL_NAME = /\.(?:local|localhost|localdomain|lan|home|arpa|internal|intranet|corp|private|test|example|invalid)$/

/**
 * The address the team reaches this server at without the relay, as far as the server knows (Admin > System >
 * Diagnostics, the relay line; the Connection card): `tunnel.host` (the Linux installer's `--public-host`, office mode's
 * TEAMAX_PUBLIC_HOST), else the first of `publicOrigins` (MYCEL_PUBLIC_ORIGINS, for example the server's own domain in
 * front of it) that is https on its standard port with an internet name: not localhost, an IP address, a local-network
 * name or the office listener's port (office mode lists the desks' addresses there). A relay's team address is not one
 * either, though the hosted cloud lists it there: a hosted team address (<team>.trina.app, isServiceHost) and
 * `relayAddress` (this server's address at its relay, when known) are reached through the relay. Host only (punycode,
 * no trailing dot). null = none known.
 */
export function publicAddress(cfg: Pick<AppContext['config'], 'tunnel' | 'publicOrigins'>, relayAddress: string | null = null): string | null {
  if (cfg.tunnel?.host) return cfg.tunnel.host
  let relayHost: string | null = null
  try { if (relayAddress) relayHost = new URL(relayAddress).hostname.replace(/\.$/, '') } catch {}
  for (const o of cfg.publicOrigins) {
    let u: URL
    try { u = new URL(o) } catch { continue }
    const host = u.hostname.replace(/\.$/, '')
    if (u.protocol !== 'https:' || u.port !== '' || !PUBLIC_HOST_RE.test(host) || LOCAL_NAME.test(host)) continue
    if (isServiceHost(host) || host === relayHost) continue
    return host
  }
  return null
}

export function connectionStatus(ctx: AppContext): ConnectionStatus {
  const cfg = ctx.config
  // office mode: the fingerprint the desks compare is the office CA's (tls/ca.crt next to the server certificate)
  const fpFile = cfg.tls ? (cfg.office ? path.join(path.dirname(cfg.tls.certFile), 'ca.crt') : cfg.tls.certFile) : null
  const direct = { enabled: !!cfg.tls, port: cfg.tls?.port ?? 8443, fingerprintSha256: fpFile ? certFingerprint(fpFile) : null }
  const extra = { teamName: cfg.relay.teamName, availableModes: availableModes(cfg) }
  if (ctx.services.relay) {
    const s = ctx.services.relay.status()
    return { ...s, direct: s.direct.fingerprintSha256 || !direct.enabled ? s.direct : direct, ...extra, publicAddress: publicAddress(cfg, s.address) }
  }
  const mode = modeOf(cfg.relay.url)
  return {
    mode,
    address: null,
    state: mode === 'direct-only' ? 'disabled' : cfg.relay.teamName ? 'connecting' : 'not_registered',
    detail: null,
    connectedSince: null,
    direct,
    ...extra,
    publicAddress: publicAddress(cfg),
  }
}

export class ConnectionChangeError extends Error {
  constructor(public code: 'unsupported' | 'no_config' | 'invalid' | 'team_name_missing', message: string) { super(message) }
}

export interface SaveConnectionOptions {
  relayUrl?: string
  /** team name at the relay (relay.teamName); kept when not given */
  teamName?: string
  /** the official relay may be chosen (config relay.officialAvailable) */
  officialAvailable?: boolean
}

/** Keep a claim code for the relay at `relayUrl` (wss://…/connect) and the team name it was issued for. */
export function saveClaimCodeFor(dataDir: string, relayUrl: string, teamName: string, code: string): void {
  saveClaimCode(dataDir, { relayApi: relayApiBase(relayUrl), name: teamName.trim().toLowerCase(), code: code.trim() })
}

/** Write the new relay settings into the server's config file. Returns the URL now configured. */
export function saveConnectionMode(configFile: string | null, mode: ConnectionMode, o: SaveConnectionOptions = {}): string | null {
  const relayUrl = o.relayUrl
  if (mode === 'cloudflare' || mode === 'tailscale') throw new ConnectionChangeError('unsupported', `${mode} is not available in this version`)
  if (mode === 'relay' && !o.officialAvailable) throw new ConnectionChangeError('unsupported', 'the official relay is not available yet')
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
  const teamName = o.teamName ?? (typeof relay.teamName === 'string' && relay.teamName ? relay.teamName : null)
  // a relay without a team name stays "not registered" forever (install-guide check: there was no field for it)
  if (url && !teamName) throw new ConnectionChangeError('team_name_missing', 'a relay connection needs a team name')
  raw.relay = { ...relay, url, ...(o.teamName ? { teamName: o.teamName } : {}) }
  const tmp = configFile + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, configFile)
  return url
}

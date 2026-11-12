// Connection mode (design tab 6 "연결: 팀 주소와 원격 접속"). Component G owns the admin endpoints; the live relay
// state comes from the relay client (component F, ctx.services.relay). Until F is installed the state is derived from
// the configuration. The mode is stored in config/server.json (relay.url) and applies after a restart.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ConnectionMode, ConnectionStatus } from '@mycel/shared/api'
import { isServiceHost, SERVICE_HOSTS } from '@mycel/shared/service-hosts'
import { isLoopbackHost } from '@mycel/shared/team-link'
import { PUBLIC_HOST_RE } from '../app-config'
import type { Context } from 'hono'
import type { AppContext } from '../context'
import type { AppEnv } from '../http/env'
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

/** Where a request reached this server, as the server itself saw it (never a client-sent X-Forwarded-* header): the
 * request URL (its scheme is the listener's, its host the Host header the host check let through) and how it came in
 * (requestContext's info). */
export interface ReachedAt { url: string; via: string; tunnel?: boolean }

export function reachedAt(c: Context<AppEnv>): ReachedAt {
  const info = c.get('info')
  return { url: c.req.url, via: info?.via ?? 'test', ...(info?.tunnel ? { tunnel: true } : {}) }
}

const reachable = (o: string): URL | null => {
  try {
    const u = new URL(o)
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || isLoopbackHost(u.hostname)) return null
    return u
  } catch {
    return null
  }
}

/**
 * The address a server without a relay or public address is reached at (QA TC-089: a self-installed office server at
 * https://192.168.1.2:19300 or https://host.ts.net:8489 showed no team address, though that is what people type into
 * the apps). With the port. A configured public origin (MYCEL_PUBLIC_ORIGINS) that names the host this request came in
 * at wins (a TLS proxy in front, such as `tailscale serve`, hands the server plain http: the origin says https), else
 * the request's own origin, else (a request from this machine itself: localhost) the first configured origin that is
 * not this machine. Only a request that came straight to a listener counts (via 'direct', not the office public
 * address: that one is `tunnel.host`). Never a loopback address. null = none.
 */
export function reachedAddress(cfg: Pick<AppContext['config'], 'publicOrigins'>, at: ReachedAt | null | undefined): string | null {
  const origins = cfg.publicOrigins.map(reachable).filter((u): u is URL => u !== null)
  let req: URL | null = null
  if (at && at.via === 'direct' && !at.tunnel) { try { req = new URL(at.url) } catch { req = null } }
  if (req) {
    const named = origins.find((u) => u.host === req!.host)
    if (named) return named.origin
    const own = reachable(req.origin)
    if (own) return own.origin
  }
  return origins[0]?.origin ?? null
}

/**
 * The team's address for its own members (GET /api/me team.address: Settings › 앱 "팀 주소", the install pictures): the
 * relay address when this server has one (https://acme.trina.app; dev http://demo.localhost:19161), else the public
 * address it knows (publicAddress, as https). A server that is not on a relay at all (no relay.url) gives the address
 * it is reached at (reachedAddress: the office network address with its port, http included; the web says the apps
 * need https). A server on a relay whose address is not known yet (connecting, offline) gives none: over the office
 * network the request's address is the office's own (192.168.x.x), which a new device elsewhere cannot use, while the
 * relay address works everywhere.
 */
export function teamAddressOf(ctx: Pick<AppContext, 'config' | 'services'>, at?: ReachedAt | null): string | null {
  let relayAddress: string | null = null
  try { relayAddress = ctx.services.relay?.status().address ?? null } catch { relayAddress = null }
  if (relayAddress) {
    try {
      const u = new URL(relayAddress)
      if ((u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password) return u.origin
    } catch { /* not an address: fall through to the public address */ }
  }
  const pub = publicAddress(ctx.config, relayAddress)
  if (pub) return `https://${pub}`
  if (ctx.config.relay?.url) return null
  return reachedAddress(ctx.config, at)
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

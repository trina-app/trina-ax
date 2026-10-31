// Relay configuration: command-line flags win over RELAY_* environment variables, which win over the defaults.
// `--dev` (bun run dev:relay): 127.0.0.1:19161, domain localhost (teams at http://<team>.localhost:19161), registry in
// <repo>/.dev/relay, light proof of work.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULTS, DEFAULT_POW_BITS } from '@mycel/shared/relay-protocol'
import { parseTrustedProxies, type IpRange } from './proxies.ts'

export const DEV_RELAY_PORT = 19161
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export interface RelayConfig {
  dev: boolean
  host: string
  port: number
  /** team addresses are <team>.<domain>: the first of `domains` (registration answers, the team server's address) */
  domain: string
  /** every domain this relay serves team addresses under (`--domain a.com,b.com`; the first is the default). A second
   * domain lets teams move to a dedicated team-address domain (Public Suffix List) without breaking old links. */
  domains: string[]
  /** scheme and port of the public team address (dev: http + 19161; production: https behind Cloudflare) */
  publicProto: 'http' | 'https'
  publicPort: number | null
  /** registry database folder */
  dataDir: string
  /** take the client IP from this header (production behind Cloudflare: cf-connecting-ip); null = socket peer */
  clientIpHeader: string | null
  /**
   * socket peers whose clientIpHeader is believed (default: Cloudflare's published ranges). Any other peer — someone
   * who reached the origin directly — is identified by its socket address, whatever header it sends.
   */
  trustedProxies: IpRange[]
  powBits: number
  /** requests for a team that is not connected wait this long for it (relay restart / team reconnecting) */
  holdMs: number
  /** a control connection that sends nothing for this long is dropped (half-open) */
  silenceMs: number
  /** time from the end of the request body to the response head */
  responseTimeoutMs: number
  /** a request body that sends nothing for this long (while the team server is ready for more) is aborted: 408 */
  bodyIdleMs: number
  /** time for the team server to accept or refuse a WebSocket */
  wsOpenTimeoutMs: number
  /** a stream waiting this long for its head triggers a PING on its connection ... */
  stallMs: number
  /** ... which must be answered within this, else the connection is dropped */
  pongTimeoutMs: number
  /** relay -> browser WebSocket protocol ping */
  clientPingMs: number
  initialWindow: number
  maxStreamsPerConn: number
  maxConnsPerTeam: number
  clientWsCap: number
  /** expose GET /_stats to loopback callers */
  stats: boolean
  /** extra reserved names (comma separated in RELAY_RESERVED) */
  reserved: string[]
  /** --dev only: built-in reserved names that may be registered anyway (RELAY_DEV_NAMES, default 'demo') */
  devNames: string[]
  /** registrations per IP per hour (memory only, never stored) */
  registerPerIpPerHour: number
  /**
   * public self-registration with proof of work (RELAY_OPEN_REGISTRATION; default: on with --dev, else off). Off (the
   * production relay, control-plane D17): POST /teams needs a claim code; cloud teams are made by the operator API.
   */
  openRegistration: boolean
  /** the relay terminates TLS itself (Cloudflare Origin CA certificate): RELAY_TLS_CERT / RELAY_TLS_KEY (PEM files).
   * clientCa (RELAY_TLS_CLIENT_CA): only TLS clients with a certificate from this CA get in (Cloudflare Authenticated
   * Origin Pulls with our own zone certificate). null = plain HTTP (behind a tunnel / in development). */
  tls: { cert: string; key: string; clientCa: string | null } | null
  /** private listener (RELAY_PRIVATE_LISTEN=<tailnet ip>:8090): operator API /ops/v1/* and /metrics. null = none */
  privateListen: { host: string; port: number } | null
  /** loopback health port of THIS process (RELAY_HEALTH_LISTEN=127.0.0.1:18091): the a/b deploy script asks the new
   * instance directly (both instances share the public port through reusePort). null = none */
  healthListen: { host: string; port: number } | null
  /** operator-keys.json (RELAY_OPERATOR_KEYS_FILE): [{ keyId, publicKey, label, scopes }]; re-read when it changes */
  operatorKeysFile: string | null
  /** Strict-Transport-Security on team responses that have none (only for https team addresses) */
  hsts: boolean
  /** F2 sleep: where the relay asks the control plane to wake a sleeping hosted team (RELAY_WAKE_URL, the CP base
   * URL; POST <url>/relay/v1/wake). null = off: a sleeping team gets the offline page as before. */
  wake: { url: string; keyFile: string; keyId: string; holdMs: number; pageMs: number } | null
}

/** "host:port", "[v6]:port" or ":port" (all addresses) */
export function parseListen(v: string | undefined, what: string): { host: string; port: number } | null {
  if (v === undefined || v === '' || v === 'none') return null
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|([^:\s]*)):(\d{1,5})$/.exec(v.trim())
  if (!m) throw new Error(`${what} must be host:port (got ${v})`)
  const port = Number(m[3])
  if (port < 0 || port > 65535) throw new Error(`${what}: bad port ${m[3]}`)
  return { host: m[1] ?? (m[2] || '0.0.0.0'), port }
}

function flag01(v: string | undefined, d: boolean): boolean {
  if (v === undefined || v === '') return d
  if (v === '1' || v === 'true') return true
  if (v === '0' || v === 'false') return false
  throw new Error(`expected 0 or 1, got ${v}`)
}

function num(v: string | undefined, d: number): number {
  if (v === undefined || v === '') return d
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) throw new Error(`not a number: ${v}`)
  return n
}

export function loadRelayConfig(argv: string[] = process.argv.slice(2), env: Record<string, string | undefined> = process.env): RelayConfig {
  const flags = new Map<string, string>()
  const bool = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const [k, v] = a.slice(2).split('=', 2)
    if (v !== undefined) flags.set(k, v)
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags.set(k, argv[++i])
    else bool.add(k)
  }
  const get = (flag: string, envName: string) => flags.get(flag) ?? env[envName]
  const dev = bool.has('dev') || env.RELAY_DEV === '1'
  const domains = (get('domain', 'RELAY_DOMAIN') ?? env.RELAY_DOMAINS ?? (dev ? 'localhost' : '')).toLowerCase().split(',').map((d) => d.trim().replace(/\.$/, '')).filter(Boolean)
  const domain = domains[0] ?? ''
  if (!domain) throw new Error('set the team address domain: --domain treesoop.com (or RELAY_DOMAIN), or --dev')
  for (const d of domains) if (!/^[a-z0-9.-]{1,253}$/.test(d)) throw new Error(`not a domain name: ${d}`)
  const tlsCert = get('tls-cert', 'RELAY_TLS_CERT'), tlsKey = get('tls-key', 'RELAY_TLS_KEY'), tlsCa = get('tls-client-ca', 'RELAY_TLS_CLIENT_CA')
  if (!!tlsCert !== !!tlsKey) throw new Error('RELAY_TLS_CERT and RELAY_TLS_KEY go together')
  if (tlsCa && !tlsCert) throw new Error('RELAY_TLS_CLIENT_CA needs RELAY_TLS_CERT / RELAY_TLS_KEY')
  const port = num(get('port', 'RELAY_PORT'), dev ? DEV_RELAY_PORT : 8080)
  const local = domain === 'localhost' || domain.endsWith('.localhost')
  const publicProto = (get('public-proto', 'RELAY_PUBLIC_PROTO') ?? (local ? 'http' : 'https')) as 'http' | 'https'
  if (publicProto !== 'http' && publicProto !== 'https') throw new Error('public proto must be http or https')
  const pp = get('public-port', 'RELAY_PUBLIC_PORT')
  return {
    dev,
    host: get('host', 'RELAY_HOST') ?? (dev ? '127.0.0.1' : '0.0.0.0'),
    port,
    domain,
    domains,
    publicProto,
    publicPort: pp !== undefined ? (pp === '' || pp === 'none' ? null : num(pp, 0)) : local ? port : null,
    dataDir: path.resolve(get('data', 'RELAY_DATA_DIR') ?? (dev ? path.join(REPO_ROOT, '.dev', 'relay') : '/var/lib/mycel-relay')),
    clientIpHeader: (get('client-ip-header', 'RELAY_CLIENT_IP_HEADER') ?? (local ? '' : 'cf-connecting-ip')).toLowerCase() || null,
    trustedProxies: parseTrustedProxies(get('trusted-proxies', 'RELAY_TRUSTED_PROXIES') ?? 'cloudflare'),
    powBits: num(get('pow-bits', 'RELAY_POW_BITS'), dev ? 8 : DEFAULT_POW_BITS),
    holdMs: num(env.RELAY_HOLD_MS, 5000),
    silenceMs: num(env.RELAY_SILENCE_MS, DEFAULTS.silenceMs),
    responseTimeoutMs: num(env.RELAY_RESPONSE_TIMEOUT_MS, 100_000),
    bodyIdleMs: num(env.RELAY_BODY_IDLE_MS, 60_000),
    wsOpenTimeoutMs: num(env.RELAY_WS_OPEN_TIMEOUT_MS, 10_000),
    stallMs: num(env.RELAY_STALL_MS, 5000),
    pongTimeoutMs: num(env.RELAY_PONG_TIMEOUT_MS, 10_000),
    clientPingMs: num(env.RELAY_CLIENT_PING_MS, 20_000),
    initialWindow: num(env.RELAY_WINDOW, DEFAULTS.initialWindow),
    maxStreamsPerConn: num(env.RELAY_MAX_STREAMS, DEFAULTS.maxStreams),
    maxConnsPerTeam: num(env.RELAY_MAX_CONNS, DEFAULTS.maxConnections),
    clientWsCap: num(env.RELAY_CLIENT_WS_CAP, DEFAULTS.clientWsCap),
    stats: bool.has('stats') || env.RELAY_STATS === '1' || dev,
    reserved: (env.RELAY_RESERVED ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    devNames: dev ? (env.RELAY_DEV_NAMES ?? 'demo').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : [],
    registerPerIpPerHour: num(env.RELAY_REGISTER_PER_IP, dev ? 1000 : 10),
    openRegistration: flag01(get('open-registration', 'RELAY_OPEN_REGISTRATION'), dev),
    tls: tlsCert && tlsKey ? { cert: path.resolve(tlsCert), key: path.resolve(tlsKey), clientCa: tlsCa ? path.resolve(tlsCa) : null } : null,
    privateListen: parseListen(get('private-listen', 'RELAY_PRIVATE_LISTEN'), 'RELAY_PRIVATE_LISTEN'),
    healthListen: parseListen(get('health-listen', 'RELAY_HEALTH_LISTEN'), 'RELAY_HEALTH_LISTEN'),
    operatorKeysFile: (() => { const f = get('operator-keys', 'RELAY_OPERATOR_KEYS_FILE'); return f ? path.resolve(f) : null })(),
    hsts: flag01(env.RELAY_HSTS, true) && publicProto === 'https',
    wake: wakeConfig(env),
  }
}

/** RELAY_WAKE_URL + RELAY_WAKE_KEY_FILE (Ed25519 private key, PEM PKCS#8) + RELAY_WAKE_KEY_ID; hold times in ms. */
function wakeConfig(env: Record<string, string | undefined>): RelayConfig['wake'] {
  const url = env.RELAY_WAKE_URL?.trim()
  if (!url || url === 'none') return null
  let u: URL
  try { u = new URL(url) } catch { throw new Error(`RELAY_WAKE_URL is not a URL: ${url}`) }
  // http only to loopback or a Tailscale address (100.64.0.0/10): the request is signed, and it carries a team id only
  const tailnet = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(u.hostname)
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (tailnet || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)))) throw new Error('RELAY_WAKE_URL must be https (http only for loopback or a Tailscale address)')
  const keyFile = env.RELAY_WAKE_KEY_FILE, keyId = env.RELAY_WAKE_KEY_ID
  if (!keyFile || !keyId) throw new Error('RELAY_WAKE_URL needs RELAY_WAKE_KEY_FILE and RELAY_WAKE_KEY_ID')
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) throw new Error('RELAY_WAKE_KEY_ID: 1-64 of A-Z a-z 0-9 . _ -')
  return { url: url.replace(/\/+$/, ''), keyFile: path.resolve(keyFile), keyId, holdMs: num(env.RELAY_WAKE_HOLD_MS, 20_000), pageMs: num(env.RELAY_WAKE_PAGE_MS, 2500) }
}

/** Public address of a team, e.g. https://acme.treesoop.com or http://acme.localhost:19161 (`domain`: one of the
 * relay's domains, default the first) */
export function teamAddress(cfg: Pick<RelayConfig, 'domain' | 'publicProto' | 'publicPort'>, name: string, domain: string = cfg.domain): string {
  const def = cfg.publicProto === 'https' ? 443 : 80
  const port = cfg.publicPort && cfg.publicPort !== def ? `:${cfg.publicPort}` : ''
  return `${cfg.publicProto}://${name}.${domain}${port}`
}

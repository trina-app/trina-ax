// Relay configuration: command-line flags win over RELAY_* environment variables, which win over the defaults.
// `--dev` (bun run dev:relay): 127.0.0.1:19161, domain localhost (teams at http://<team>.localhost:19161), registry in
// <repo>/.dev/relay, light proof of work.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULTS, DEFAULT_POW_BITS } from '@mycel/shared/relay-protocol'

export const DEV_RELAY_PORT = 19161
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export interface RelayConfig {
  dev: boolean
  host: string
  port: number
  /** team addresses are <team>.<domain> */
  domain: string
  /** scheme and port of the public team address (dev: http + 19161; production: https behind Cloudflare) */
  publicProto: 'http' | 'https'
  publicPort: number | null
  /** registry database folder */
  dataDir: string
  /** take the client IP from this header (production behind Cloudflare: cf-connecting-ip); null = socket peer */
  clientIpHeader: string | null
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
  const domain = (get('domain', 'RELAY_DOMAIN') ?? (dev ? 'localhost' : '')).toLowerCase()
  if (!domain) throw new Error('set the team address domain: --domain treesoop.com (or RELAY_DOMAIN), or --dev')
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
    publicProto,
    publicPort: pp !== undefined ? (pp === '' || pp === 'none' ? null : num(pp, 0)) : local ? port : null,
    dataDir: path.resolve(get('data', 'RELAY_DATA_DIR') ?? (dev ? path.join(REPO_ROOT, '.dev', 'relay') : '/var/lib/mycel-relay')),
    clientIpHeader: (get('client-ip-header', 'RELAY_CLIENT_IP_HEADER') ?? (local ? '' : 'cf-connecting-ip')).toLowerCase() || null,
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
  }
}

/** Public address of a team, e.g. https://acme.treesoop.com or http://acme.localhost:19161 */
export function teamAddress(cfg: Pick<RelayConfig, 'domain' | 'publicProto' | 'publicPort'>, name: string): string {
  const def = cfg.publicProto === 'https' ? 443 : 80
  const port = cfg.publicPort && cfg.publicPort !== def ? `:${cfg.publicPort}` : ''
  return `${cfg.publicProto}://${name}.${cfg.domain}${port}`
}

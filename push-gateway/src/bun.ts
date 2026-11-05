// The push gateway's server (README.md): Bun, APNs over node:http2 (APNs speaks only HTTP/2), FCM and Google OAuth
// through fetch, state in one SQLite file (bun:sqlite, built in). Runs behind a TLS terminator.
//
//   bun push-gateway/src/bun.ts                 serve (PUSH_GATEWAY_HOST, default 127.0.0.1; PUSH_GATEWAY_PORT, 8787)
//   bun push-gateway/src/bun.ts block <keyId>   block a team key (403); unblock <keyId> takes it back
//   bun push-gateway/src/bun.ts key-id <spki>   the key id of a base64 SPKI public key
//
// Environment (README.md): APP_TITLE, APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC, APNS_PRIVATE_KEY (or _FILE), APNS_SANDBOX,
// FCM_SERVICE_ACCOUNT (or _FILE), TRUST_PROXY_HEADER, PUSH_GATEWAY_DB (default ./push-gateway.sqlite).
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import http2 from 'node:http2'
import { APNS_PRODUCTION, APNS_SANDBOX } from './apns.ts'
import { importTeamKey, type FetchLike } from './crypto.ts'
import { createGateway, type GatewayDeps, type GatewayEnv, type LogLine } from './gateway.ts'
import { ShardedState, type ShardStorage } from './state.ts'

const APNS_HOSTS = [new URL(APNS_PRODUCTION).host, new URL(APNS_SANDBOX).host]
const H2_TIMEOUT_MS = 15_000

/**
 * A fetch that sends requests for `h2Hosts` over HTTP/2 (node:http2, one kept-open session per origin) and everything
 * else to `fallback`. Only what the gateway uses: string bodies, a buffered answer. `close()` ends the sessions.
 */
export function http2Fetch(h2Hosts: string[] = APNS_HOSTS, fallback: FetchLike = (url, init) => fetch(url, init)): FetchLike & { close(): void } {
  const sessions = new Map<string, http2.ClientHttp2Session>()
  const session = (origin: string) => {
    const open = sessions.get(origin)
    if (open && !open.closed && !open.destroyed) return open
    const s = http2.connect(origin)
    const drop = () => { if (sessions.get(origin) === s) sessions.delete(origin) }
    s.on('error', drop)
    s.on('goaway', drop)
    s.on('close', drop)
    s.setTimeout(10 * 60_000, () => s.close())
    sessions.set(origin, s)
    return s
  }
  const f = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input)
    if (!h2Hosts.includes(url.host)) return fallback(input, init)
    const headers: Record<string, string> = { ':method': init?.method ?? 'GET', ':path': url.pathname + url.search }
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v })
    const body = init?.body == null ? null : Buffer.from(await new Response(init.body).arrayBuffer())
    return await new Promise<Response>((resolve, reject) => {
      const req = session(url.origin).request(headers)
      const chunks: Buffer[] = []
      let status = 0
      let settled = false
      const resHeaders = new Headers()
      const fail = (e: Error) => { if (!settled) { settled = true; reject(e) } }
      req.setTimeout(H2_TIMEOUT_MS, () => { req.close(http2.constants.NGHTTP2_CANCEL); fail(new Error('http2: timeout')) })
      req.on('response', (h) => {
        status = Number(h[':status'])
        for (const [k, v] of Object.entries(h)) if (!k.startsWith(':') && v !== undefined) resHeaders.set(k, Array.isArray(v) ? v.join(', ') : String(v))
      })
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        if (settled) return
        if (!status) return fail(new Error('http2: no answer'))
        settled = true
        resolve(new Response(chunks.length ? Buffer.concat(chunks) : null, { status, headers: resHeaders }))
      })
      req.on('error', fail)
      req.on('close', () => fail(new Error('http2: closed')))
      req.end(body ?? undefined)
    })
  }
  return Object.assign(f, { close: () => { for (const s of sessions.values()) s.close(); sessions.clear() } })
}

/** SQLite tables: shard records (state.ts) and the operator's blocklist. */
export function openSqlite(path: string) {
  const db = new Database(path, { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('CREATE TABLE IF NOT EXISTS shard (shard TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, until INTEGER, PRIMARY KEY (shard, k))')
  db.exec('CREATE TABLE IF NOT EXISTS blocked (key_id TEXT PRIMARY KEY, at INTEGER NOT NULL)')
  const get = db.query<{ v: string }, [string, string]>('SELECT v FROM shard WHERE shard = ? AND k = ?')
  const put = db.query('INSERT INTO shard (shard, k, v, until) VALUES (?, ?, ?, ?) ON CONFLICT (shard, k) DO UPDATE SET v = excluded.v, until = excluded.until')
  const del = db.query('DELETE FROM shard WHERE shard = ? AND k = ?')
  const sweep = db.query('DELETE FROM shard WHERE until IS NOT NULL AND until <= ?')
  const isBlocked = db.query<{ n: number }, [string]>('SELECT 1 AS n FROM blocked WHERE key_id = ?')
  const open = (shard: string): ShardStorage => ({
    get: async <T>(k: string) => {
      const row = get.get(shard, k)
      return row ? (JSON.parse(row.v) as T) : undefined
    },
    put: async (k: string, v: unknown) => {
      const until = (v as { until?: unknown } | null)?.until
      put.run(shard, k, JSON.stringify(v), typeof until === 'number' ? until : null)
    },
    delete: async (k: string) => del.run(shard, k).changes > 0,
  })
  return {
    db,
    open,
    blocked: async (keyId: string) => isBlocked.get(keyId) !== null,
    block: (keyId: string, at: number) => { db.query('INSERT OR IGNORE INTO blocked (key_id, at) VALUES (?, ?)').run(keyId, at) },
    unblock: (keyId: string) => { db.query('DELETE FROM blocked WHERE key_id = ?').run(keyId) },
    sweep: (now: number) => { sweep.run(now) },
  }
}

const ADDRESS_RE = /^[0-9A-Fa-f.:]{2,45}$/

/**
 * The caller's address: the socket's, or with `trustHeader` (TRUST_PROXY_HEADER, for a TLS proxy in front) that
 * header's right-most entry, the address the proxy itself saw (x-forwarded-for: "<what the client sent>, <peer>";
 * cf-connecting-ip: one address). A missing or odd header falls back to the socket address.
 */
export function clientAddress(req: Request, socket: string | undefined, trustHeader: string | null): string {
  if (trustHeader) {
    const hop = (req.headers.get(trustHeader) ?? '').split(',').map((x) => x.trim()).filter(Boolean).pop()
    if (hop && ADDRESS_RE.test(hop)) return hop
  }
  return socket ?? 'unknown'
}

export interface ServeOptions {
  env: GatewayEnv
  dbPath: string
  port?: number
  hostname?: string
  /** a header the TLS proxy in front sets to the client address (x-forwarded-for, cf-connecting-ip); null = socket */
  trustProxyHeader?: string | null
  /** tests: provider fetch and origins; default http2Fetch() and the real hosts */
  fetch?: FetchLike
  endpoints?: GatewayDeps['endpoints']
  now?: () => number
  log?: (line: LogLine) => void
}

export function serve(opts: ServeOptions) {
  const trust = opts.trustProxyHeader || null
  if (trust && !/^[A-Za-z0-9-]{1,64}$/.test(trust)) throw new Error('TRUST_PROXY_HEADER must be a header name')
  const store = openSqlite(opts.dbPath)
  const state = new ShardedState(store.open, store.blocked)
  const now = opts.now ?? (() => Date.now())
  const h2 = opts.fetch ? null : http2Fetch()
  const gateway = createGateway(opts.env, {
    fetch: opts.fetch ?? (h2 as FetchLike),
    now,
    log: opts.log ?? ((line) => console.log(JSON.stringify(line))),
    state,
    endpoints: opts.endpoints,
  })
  const timer = setInterval(() => { store.sweep(now()); state.sweep(now()) }, 60_000)
  const server = Bun.serve({
    port: opts.port ?? 8787,
    hostname: opts.hostname ?? '127.0.0.1',
    maxRequestBodySize: 64 * 1024,
    fetch: (req, srv) => gateway.handle(req, clientAddress(req, srv.requestIP(req)?.address, trust)),
  })
  return {
    server,
    store,
    state,
    stop() {
      clearInterval(timer)
      h2?.close()
      server.stop(true)
      store.db.close()
    },
  }
}

function secret(name: 'APNS_PRIVATE_KEY' | 'FCM_SERVICE_ACCOUNT'): string | undefined {
  const file = process.env[`${name}_FILE`]
  return file ? fs.readFileSync(file, 'utf8') : process.env[name]
}

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2)
  const dbPath = process.env.PUSH_GATEWAY_DB || './push-gateway.sqlite'
  if (cmd === 'block' || cmd === 'unblock') {
    if (!arg || !/^[0-9a-f]{64}$/.test(arg)) throw new Error('usage: bun.ts block|unblock <key id: 64 hex>')
    const store = openSqlite(dbPath)
    if (cmd === 'block') store.block(arg, Date.now())
    else store.unblock(arg)
    store.db.close()
  } else if (cmd === 'key-id') {
    const k = arg ? await importTeamKey(arg) : null
    if (!k) throw new Error('usage: bun.ts key-id <base64 SPKI Ed25519 public key>')
    console.log(k.keyId)
  } else if (cmd === undefined) {
    const env = process.env
    const { server } = serve({
      dbPath,
      port: Number(env.PUSH_GATEWAY_PORT || 8787),
      hostname: env.PUSH_GATEWAY_HOST || '127.0.0.1',
      trustProxyHeader: env.TRUST_PROXY_HEADER || null,
      env: {
        APP_TITLE: env.APP_TITLE, APNS_KEY_ID: env.APNS_KEY_ID, APNS_TEAM_ID: env.APNS_TEAM_ID, APNS_TOPIC: env.APNS_TOPIC,
        APNS_SANDBOX: env.APNS_SANDBOX, APNS_PRIVATE_KEY: secret('APNS_PRIVATE_KEY'), FCM_SERVICE_ACCOUNT: secret('FCM_SERVICE_ACCOUNT'),
      },
    })
    console.log(JSON.stringify({ evt: 'listen', port: server.port }))
  } else {
    throw new Error(`unknown command ${cmd}`)
  }
}

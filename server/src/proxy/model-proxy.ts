// Model proxy (design tab 1 "모델 프록시 예산" / "프록시 동작", tab 3 "모델 호출" / "프록시 전달 규칙"). The engine gets
// ANTHROPIC_BASE_URL=<this proxy> and a per-turn proxy token instead of the real credential. The proxy checks the
// token (turn + user, expiry, revocation), the TCP peer (the launcher finds the process; it must belong to the turn's
// engine session), the budgets, and what is asked for (forwarding rules below); then it puts the real credential on
// the request (the owner's `claude setup-token` subscription token as a Bearer, or a company key), streams the answer
// back without buffering and counts the usage itself (authoritative numbers in `turns`, usage_source 'proxy').
// Subscription mode (owner 2026-10-21: subscriptions only) runs it in production; company-key mode stays code only.
import crypto from 'node:crypto'
import net from 'node:net'
import type { IncomingMessage } from 'node:http'
import type { Database } from 'bun:sqlite'
import { audit } from '../admin/audit'
import { budgetBlock } from '../admin/budgets'
import { codexConnectHandler, type ConnectOpts } from './connect'

const h = (t: string) => crypto.createHash('sha256').update(t).digest('hex')

export function issueProxyToken(db: Database, turnId: string, userId: string, o: { ttlMs?: number; budgetUsd?: number } = {}) {
  const token = 'mpx_' + crypto.randomBytes(32).toString('base64url')
  db.query('INSERT INTO proxy_tokens (token_hash, turn_id, user_id, expires_at, budget_usd) VALUES (?,?,?,?,?)')
    .run(h(token), turnId, userId, new Date(Date.now() + (o.ttlMs ?? 30 * 60_000)).toISOString(), o.budgetUsd ?? null)
  return token
}
export function revokeProxyTokens(db: Database, turnId: string) {
  db.query('UPDATE proxy_tokens SET revoked_at = ? WHERE turn_id = ? AND revoked_at IS NULL').run(new Date().toISOString(), turnId)
}

/** USD per million tokens (approximate list prices; input, output). Cache reads 0.1x input, cache writes 1.25x input.
 * Company-key mode only: a subscription has no per-request price, its turns carry cost 0 (design tab 1 "비용"). */
const PRICES: [RegExp, number, number][] = [[/opus/i, 15, 75], [/sonnet/i, 3, 15], [/haiku/i, 1, 5]]
export function costUsd(model: string, u: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }) {
  const [, pi, po] = PRICES.find(([re]) => re.test(model)) ?? [null, 15, 75]
  return ((u.input_tokens ?? 0) * pi + (u.output_tokens ?? 0) * po + (u.cache_read_input_tokens ?? 0) * pi * 0.1 + (u.cache_creation_input_tokens ?? 0) * pi * 1.25) / 1e6
}

/** What the proxy tells the turn that owns a request (the chat runtime stops the turn and shows the reason). */
export type ProxyTurnEvent =
  | { type: 'auth' }
  | { type: 'budget' }
  | { type: 'rate_limit'; retryAt: string | null }

export interface ProxyOpts {
  db: Database
  /** the real credential: a company API key (x-api-key) or the owner's long-lived subscription OAuth token
   * (Authorization: Bearer). A function is asked on every request (the token file can change while the server runs);
   * null = no credential stored (401 + auth event, nothing goes upstream). upstream null = this proxy has no Claude
   * path at all (503; Codex tunnels still work). */
  upstream: { baseUrl: string; kind: 'api-key' | 'oauth'; secret: string | (() => string | null) } | null
  /** return false to refuse (TCP peer not in the turn's engine session; the launcher finds the process) */
  peerCheck?: (clientPort: number, serverPort: number, turnId: string) => Promise<boolean>
  /** a turn's request hit an upstream 401, a used-up budget or the subscription limit */
  onTurnEvent?: (turnId: string, ev: ProxyTurnEvent) => void
  /** the upstream refused the credential itself (401): the owner has to connect the subscription again */
  onAuthRejected?: (secret: string | null) => void
  /** Codex turns' HTTPS tunnels on the same port (CONNECT, ./connect.ts); absent = CONNECT is refused */
  connect?: Omit<ConnectOpts, 'db'>
  port?: number
  hostname?: string
  /** why a request was refused or failed: status, path and the error's type + message only (never a body, a header
   * or a credential). Without it the reason is lost: the engine shows most refusals as an authentication failure. */
  log?: { warn(msg: string, f?: Record<string, unknown>): void }
}

// ---------------- forwarding rules (design tab 7 "모델 프록시를 통한 외부 전송", tab 3 "프록시 전달 규칙") ----------------
// The proxy holds the real credential. A broken or new-version engine could ask the model company to send data out for
// it: an MCP connector (mcp_servers), code execution (container), server tools such as web_fetch, or image / document
// blocks the API downloads from a URL. Only what Claude Code needs passes: POST /v1/messages (and count_tokens),
// custom tools plus the web_search server tool, and content blocks whose data is inline. Anything else is a 403.

/** content block types that carry nothing the API would fetch or run */
const BLOCK_TYPES = new Set(['text', 'image', 'document', 'tool_use', 'tool_result', 'thinking', 'redacted_thinking', 'server_tool_use', 'web_search_tool_result', 'tool_reference', 'search_result'])
/** image / document sources that are inline data */
const INLINE_SOURCES = new Set(['base64', 'text', 'content'])
export const PROXY_PATHS = new Set(['/v1/messages', '/v1/messages/count_tokens'])
const MODEL_RE = /^claude-[a-z0-9][a-z0-9.-]{0,79}$/
/** request headers that reach the upstream (everything else, the engine's credential included, is dropped). Besides
 * the design's anthropic-version / anthropic-beta / content-type: accept, and user-agent + x-app, which name the client
 * as Claude Code (the subscription endpoint may check them; they carry nothing of the team). */
const FORWARD_HEADERS = ['anthropic-version', 'anthropic-beta', 'content-type', 'accept', 'user-agent', 'x-app']
/** beta flags look like name-YYYY-MM-DD; anything else is dropped */
const BETA_RE = /^[a-z0-9][a-z0-9-]{0,80}-\d{4}-\d{2}-\d{2}$/
/** response headers never passed back (hop-by-hop, encodings Bun already undid, cookies) */
const DROP_RESPONSE = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'set-cookie', 'proxy-authenticate', 'upgrade'])
/** a 429 with retry-after above this is the subscription's 5-hour / weekly limit, not a short burst limit */
export const SHORT_RETRY_S = 60

function checkBlocks(v: unknown, depth: number): string | null {
  if (typeof v === 'string') return null
  if (!Array.isArray(v)) return 'content must be a string or a list of blocks'
  if (depth > 8) return 'content nested too deep'
  for (const b of v as Record<string, unknown>[]) {
    if (!b || typeof b !== 'object') return 'bad content block'
    const type = String(b.type)
    if (!BLOCK_TYPES.has(type)) return `content block type ${type.slice(0, 40)} is not allowed`
    if (type === 'image' || type === 'document') {
      const src = b.source as Record<string, unknown> | undefined
      if (!src || !INLINE_SOURCES.has(String(src.type))) return `${type} blocks must carry their data inline (no url / file sources)`
      if (src.type === 'content') { const r = checkBlocks(src.content, depth + 1); if (r) return r }
    }
    if (type === 'server_tool_use' && b.name !== 'web_search') return `server tool ${String(b.name).slice(0, 40)} is not allowed`
    if ((type === 'tool_result' || type === 'search_result') && b.content !== undefined) { const r = checkBlocks(b.content, depth + 1); if (r) return r }
  }
  return null
}

/** null = forward; else why the request is refused. `body` is the parsed JSON (null when there is none / not JSON). */
export function checkProxyRequest(method: string, url: URL, body: unknown): string | null {
  if (method !== 'POST' || !PROXY_PATHS.has(url.pathname)) return `${method} ${url.pathname.slice(0, 80)} is not forwarded`
  for (const [k, v] of url.searchParams) if (k !== 'beta' || v !== 'true') return 'unexpected query parameter'
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'the body must be a JSON object'
  const b = body as Record<string, unknown>
  for (const k of ['mcp_servers', 'container']) if (k in b) return `${k} is not allowed`
  if (typeof b.model !== 'string' || !MODEL_RE.test(b.model)) return 'model is not a Claude model name'
  if (b.tools !== undefined) {
    if (!Array.isArray(b.tools)) return 'tools must be a list'
    for (const t of b.tools as Record<string, unknown>[]) {
      const type = t && typeof t === 'object' ? t.type : undefined
      if (type === undefined || type === null || type === 'custom') continue
      if (typeof type === 'string' && /^web_search_\d+$/.test(type)) continue
      return `tool type ${String(type).slice(0, 40)} is not allowed`
    }
  }
  if (b.system !== undefined) { const r = checkBlocks(b.system, 0); if (r) return r }
  if (!Array.isArray(b.messages)) return 'messages must be a list'
  for (const m of b.messages as Record<string, unknown>[]) {
    if (!m || typeof m !== 'object') return 'bad message'
    const r = checkBlocks(m.content, 0)
    if (r) return r
  }
  return null
}

function apiError(status: number, type: string, message: string, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), { status, headers: { 'content-type': 'application/json', ...extra } })
}

/** Why this request may not spend: the token's own cap (turn budget) or a used-up "block" budget of the person
 * (team / their groups / them; the same rule the chat routes check before a turn starts). */
export function overBudget(db: Database, userId: string, turnId: string, tokenBudget: number | null): string | null {
  if (tokenBudget !== null) {
    const c = (db.query('SELECT cost_usd FROM turns WHERE id = ?').get(turnId) as { cost_usd: number | null } | null)?.cost_usd ?? 0
    if (c >= tokenBudget) return 'turn budget reached'
  }
  return budgetBlock(db, userId, 'en') ? 'budget reached' : null
}

/** Seconds of a Retry-After header (delta-seconds or an HTTP date); null when absent or unreadable. */
export function retryAfterSeconds(v: string | null, now = Date.now()): number | null {
  if (!v) return null
  if (/^\d+$/.test(v.trim())) return Number(v.trim())
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : Math.max(0, Math.round((t - now) / 1000))
}

export interface ModelProxy { url: string; port: number; stop(): Promise<void> }

/** Listens on 127.0.0.1:<port> (Claude requests and Codex CONNECT tunnels, see below); rejects when the port is taken
 * (no reusePort). */
export async function startModelProxy(o: ProxyOpts): Promise<ModelProxy> {
  const { db } = o
  const add = db.query("UPDATE turns SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cost_usd = COALESCE(cost_usd, 0) + ?, usage_source = 'proxy' WHERE id = ?")
  const record = (turnId: string, model: string, u: Record<string, number | undefined>) => {
    if (!Object.keys(u).length) return
    add.run((u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), u.output_tokens ?? 0,
      o.upstream?.kind === 'api-key' ? costUsd(model, u) : 0, turnId)
  }
  const secret = () => (!o.upstream ? null : typeof o.upstream.secret === 'function' ? o.upstream.secret() : o.upstream.secret)
  /** subscription 5-hour / weekly limit reached: nothing goes upstream until then (design tab 1 "업스트림 오류") */
  let limitedUntil = 0
  const limited = (turnId: string) => {
    const retryAt = new Date(limitedUntil).toISOString()
    o.onTurnEvent?.(turnId, { type: 'rate_limit', retryAt })
    return apiError(403, 'permission_error', 'subscription_limited', { 'retry-after': String(Math.max(1, Math.ceil((limitedUntil - Date.now()) / 1000))) })
  }

  let serverPort = 0
  // the Claude path: `req` carries a signal that fires when the engine hangs up
  async function handle(req: Request, clientPort: number): Promise<Response> {
      const url = new URL(req.url)
      if (!url.pathname.startsWith('/v1/')) return apiError(404, 'not_found_error', 'not found')
      // the engine sends its per-turn token as x-api-key (company key mode) or as a Bearer (subscription mode)
      const tok = (req.headers.get('x-api-key') || req.headers.get('authorization')?.replace(/^Bearer\s*/i, '') || '').trim()
      if (!tok) return apiError(401, 'authentication_error', 'missing proxy token')
      const row = db.query('SELECT * FROM proxy_tokens WHERE token_hash = ?').get(h(tok)) as { turn_id: string; user_id: string; revoked_at: string | null; expires_at: string; budget_usd: number | null } | null
      if (!row || row.revoked_at || row.expires_at < new Date().toISOString()) return apiError(401, 'authentication_error', 'invalid proxy token')
      // the Claude path is for Claude turns only: a Codex turn's token (its HTTPS_PROXY) or the codex-login token must
      // not reach the Anthropic API with the owner's Claude credential (the Codex turn's process passes the peer check)
      if (String(row.turn_id).startsWith('codex-login:') || (db.query('SELECT engine FROM turns WHERE id = ?').get(row.turn_id) as { engine: string } | null)?.engine === 'codex') {
        audit(db, { actor: row.user_id ?? null, action: 'proxy.refused', target: row.turn_id, detail: { reason: 'not a Claude turn', path: url.pathname.slice(0, 120) } })
        return apiError(403, 'permission_error', 'this token is not for the Claude API')
      }
      if (o.peerCheck) {
        if (!clientPort || !(await o.peerCheck(clientPort, serverPort, row.turn_id))) return apiError(403, 'permission_error', 'caller is not part of this turn')
      }
      if (!o.upstream) return apiError(503, 'api_error', 'no Claude credential is configured on the team server')
      const upstream = o.upstream
      const body = await req.arrayBuffer()
      let parsed: unknown = null
      try { if (body.byteLength) parsed = JSON.parse(new TextDecoder().decode(body)) } catch {}
      const refused = checkProxyRequest(req.method, url, parsed)
      if (refused) {
        audit(db, { actor: row.user_id, action: 'proxy.refused', target: row.turn_id, detail: { reason: refused } })
        return apiError(403, 'permission_error', `refused by the team server: ${refused}`)
      }
      // 403, not 429: the SDK retries a 429 by itself (design tab 1 "예산 초과")
      if (overBudget(db, row.user_id, row.turn_id, row.budget_usd)) {
        o.onTurnEvent?.(row.turn_id, { type: 'budget' })
        return apiError(403, 'permission_error', 'budget_exceeded')
      }
      if (limitedUntil > Date.now()) return limited(row.turn_id)
      const real = secret()
      if (!real) {
        o.onTurnEvent?.(row.turn_id, { type: 'auth' })
        return apiError(401, 'authentication_error', 'the team server has no model credential (the owner has to connect the subscription)')
      }

      const headers = new Headers()
      for (const k of FORWARD_HEADERS) { const v = req.headers.get(k); if (v) headers.set(k, v) }
      // the body that goes out is the one checked above, written again: a raw body could say more than JSON.parse
      // saw (a duplicate key: JSON.parse keeps the last, another parser the first, e.g. a refused tool list)
      headers.set('content-type', 'application/json')
      const outBody = JSON.stringify(parsed)
      const beta = new Set((headers.get('anthropic-beta') ?? '').split(',').map((s) => s.trim()).filter((s) => BETA_RE.test(s)))
      if (upstream.kind === 'api-key') headers.set('x-api-key', real)
      else {
        headers.set('authorization', 'Bearer ' + real)
        beta.add('oauth-2025-04-20')
      }
      if (beta.size) headers.set('anthropic-beta', [...beta].join(','))
      else headers.delete('anthropic-beta')

      let model = String((parsed as { model?: unknown }).model ?? 'unknown')
      // the engine hanging up (turn stopped) cancels the upstream request too
      const abort = new AbortController()
      req.signal.addEventListener('abort', () => abort.abort(), { once: true })
      let up: Response
      try {
        // never follow a redirect: it would carry the request (and an x-api-key, which fetch keeps across origins) to
        // another host, or the real credential to a path the rules above do not allow
        up = await fetch(upstream.baseUrl.replace(/\/$/, '') + url.pathname + url.search, { method: 'POST', headers, body: outBody, signal: abort.signal, redirect: 'manual' })
      } catch {
        return apiError(502, 'api_error', 'the model service could not be reached')
      }
      if (up.status >= 300 && up.status < 400) {
        await up.body?.cancel().catch(() => {})
        return apiError(502, 'api_error', 'the model service answered with a redirect; it is not followed')
      }
      const outHeaders = new Headers()
      for (const [k, v] of up.headers) if (!DROP_RESPONSE.has(k.toLowerCase())) outHeaders.set(k, v)

      if (up.status === 401) {
        o.onTurnEvent?.(row.turn_id, { type: 'auth' })
        o.onAuthRejected?.(real)
      }
      if (up.status === 429) {
        const s = retryAfterSeconds(up.headers.get('retry-after'))
        if (s !== null && s > SHORT_RETRY_S) {
          // the subscription's own limit: say so once, keep further requests from going out until it resets
          await up.body?.cancel().catch(() => {})
          limitedUntil = Date.now() + s * 1000
          return limited(row.turn_id)
        }
        // a short burst limit: status and retry-after as they came, the SDK retries
      }
      const counts = url.pathname === '/v1/messages' && up.status < 400
      if (counts && (up.headers.get('content-type') ?? '').includes('text/event-stream') && up.body) {
        // pass the stream through as it arrives while reading usage from message_start / message_delta. Input and
        // cache numbers come from message_start, output from the last message_delta (a running total, not added up).
        const usage: Record<string, number | undefined> = {}
        let buf = ''
        let recorded = false
        const done = () => { if (!recorded) { recorded = true; record(row.turn_id, model, usage) } }
        const dec = new TextDecoder()
        const reader = up.body.getReader()
        const scan = (chunk: Uint8Array) => {
          buf += dec.decode(chunk, { stream: true })
          let i
          while ((i = buf.indexOf('\n')) >= 0) {
            const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
            if (!l.startsWith('data:')) continue
            try {
              const ev = JSON.parse(l.slice(5))
              if (ev.type === 'message_start') { Object.assign(usage, ev.message?.usage ?? {}); model = ev.message?.model ?? model }
              if (ev.type === 'message_delta' && ev.usage) Object.assign(usage, ev.usage)
            } catch {}
          }
          if (buf.length > 1 << 20) buf = '' // no line that long in a real stream
        }
        const stream = new ReadableStream<Uint8Array>({
          async pull(ctl) {
            try {
              const { value, done: end } = await reader.read()
              if (end) { done(); ctl.close(); return }
              ctl.enqueue(value)
              scan(value)
            } catch (e) {
              done() // the stream broke off: what was seen so far still counts
              ctl.error(e)
            }
          },
          cancel() { done(); abort.abort(); reader.cancel().catch(() => {}) },
        }, { highWaterMark: 0 })
        return new Response(stream, { status: up.status, headers: outHeaders })
      }
      const text = await up.text()
      if (counts) try { const j = JSON.parse(text); if (j.usage) record(row.turn_id, j.model ?? model, j.usage) } catch {}
      return new Response(text, { status: up.status, headers: outHeaders })
  }

  // One port, two kinds of callers (design tab 1 '리슨'): Codex tunnels (CONNECT) and Claude's HTTP requests. A small
  // TCP front reads the first bytes of each connection: CONNECT goes to the tunnel handler (./connect.ts), anything
  // else is piped to an internal Bun.serve on another loopback port. Not node:http: Bun's node:http server never
  // reports a caller that hung up (no 'close'), so a stopped turn would keep the upstream request streaming; Bun.serve
  // aborts req.signal, and the pipe closes it when the engine's connection closes. Bun.serve alone cannot take a
  // CONNECT. The internal port answers only connections the front opened (it maps them back to the engine's port for
  // the peer check), so reaching it directly gets a 403; pf and the sandbox do not let the engine reach it anyway.
  const MAX_HEAD = 16 * 1024
  const links = new Map<number, number>() // internal client port -> the engine's client port on the front
  const inner = Bun.serve({
    hostname: '127.0.0.1', port: 0, reusePort: false,
    // a long answer can stream for many minutes; Bun's default idle timeout (10 s) would cut a quiet stream
    idleTimeout: 0,
    maxRequestBodySize: 32 * 1024 * 1024,
    async fetch(req, srv) {
      const ip = srv.requestIP(req)
      const clientPort = ip ? links.get(ip.port) : undefined
      if (clientPort === undefined) return apiError(403, 'permission_error', 'not through the model proxy port')
      let res: Response
      try { res = await handle(req, clientPort) } catch (e) {
        o.log?.warn('model proxy: request failed', { err: String((e as Error)?.message ?? e).slice(0, 200) })
        return apiError(502, 'api_error', 'the team server could not reach the model API')
      }
      // our refusals carry the message written above, the model service's its own error type and message
      if (res.status >= 400 && o.log) {
        let reason = ''
        try {
          const j = await res.clone().json() as { error?: { type?: unknown; message?: unknown } }
          reason = `${String(j.error?.type ?? '')}: ${String(j.error?.message ?? '')}`.slice(0, 200)
        } catch {}
        o.log.warn('model proxy: request not ok', { status: res.status, path: new URL(req.url).pathname.slice(0, 120), reason })
      }
      return res
    },
  })
  const onConnect = o.connect ? codexConnectHandler({ db, ...o.connect }) : null
  const sockets = new Set<net.Socket>()
  let closing = false

  function connectRequest(sock: net.Socket, first: Buffer) {
    let buf = first
    const go = () => {
      const end = buf.indexOf('\r\n\r\n')
      if (end < 0) {
        if (buf.length > MAX_HEAD) { sock.end('HTTP/1.1 431 Request Header Fields Too Large\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return }
        sock.once('data', (d: Buffer) => { buf = Buffer.concat([buf, d]); go() })
        return
      }
      const lines = buf.subarray(0, end).toString('latin1').split('\r\n')
      const m = /^CONNECT (\S+) HTTP\/1\.[01]$/.exec(lines[0] ?? '')
      if (!m) { sock.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return }
      const headers: Record<string, string> = {}
      for (const l of lines.slice(1)) { const i = l.indexOf(':'); if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim() }
      const head = buf.subarray(end + 4)
      sock.pause()
      if (onConnect) { void onConnect({ url: m[1], headers } as unknown as IncomingMessage, sock, head); return }
      audit(db, { actor: null, action: 'proxy.connect_refused', target: null, detail: { reason: 'no tunnels on this proxy', host: m[1]!.slice(0, 120) } })
      sock.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
    }
    go()
  }
  function pipeToInner(sock: net.Socket, first: Buffer) {
    sock.pause()
    const up = net.connect(inner.port!, '127.0.0.1')
    let localPort = 0
    up.on('error', () => sock.destroy())
    up.on('connect', () => {
      if (sock.destroyed) { up.destroy(); return }
      localPort = up.localPort ?? 0
      links.set(localPort, sock.remotePort ?? 0)
      up.write(first)
      sock.pipe(up)
      up.pipe(sock)
    })
    sock.on('close', () => up.destroy())
    up.on('close', () => { if (localPort) links.delete(localPort); sock.destroy() })
  }
  const front = net.createServer((sock) => {
    if (closing) { sock.destroy(); return }
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    sock.on('error', () => {})
    let buf = Buffer.alloc(0)
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d])
      // "CONNECT " decides; a shorter first chunk that could still become it waits for more
      if (buf.length < 8 && 'CONNECT '.startsWith(buf.toString('latin1'))) return
      sock.off('data', onData)
      if (buf.subarray(0, 8).toString('latin1') === 'CONNECT ') connectRequest(sock, buf)
      else pipeToInner(sock, buf)
    }
    sock.on('data', onData)
  })
  try {
    await new Promise<void>((ok, fail) => {
      front.once('error', fail)
      front.listen({ port: o.port ?? 0, host: o.hostname ?? '127.0.0.1', exclusive: true }, () => { front.off('error', fail); ok() })
    })
  } catch (e) {
    inner.stop(true)
    throw e
  }
  serverPort = (front.address() as net.AddressInfo).port
  return {
    port: serverPort,
    url: `http://${o.hostname ?? '127.0.0.1'}:${serverPort}`,
    stop: () => new Promise<void>((ok) => {
      closing = true
      onConnect?.closeAll()
      for (const s of sockets) s.destroy()
      inner.stop(true)
      front.close(() => ok())
    }),
  }
}

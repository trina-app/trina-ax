// The public listener (cloudflared delivers https://demo.trina.app here): the gate's pages, POST /__demo/start, the
// status and health endpoints, and the reverse proxy that sends a visitor (by the gate's cookie) to their instance,
// HTTP and WebSocket alike. Paths the demo never offers (admin, setup, AI connections, invites, team links, password
// resets, OAuth callbacks, the MCP endpoint, persona switching) are refused here, before any instance sees them.
import crypto from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { isLocale, type GateConfig, type Locale } from './config.ts'
import { readSecretFile } from './config.ts'
import { ipTag, type GateLog } from './log.ts'
import { PAGE_CSP, localeOf, renderPage, type LimitReason, type PageKind } from './pages.ts'
import type { Instance, Pool } from './pool.ts'
import type { GateState } from './state.ts'
import type { GateStats } from './stats.ts'
import type { UpstreamStatus } from './upstream.ts'

export const VISITOR_COOKIE = '__Host-tdg'
/** the language cookie the web app writes (web/src/i18n/index.ts); the gate reads it and sets it on a start */
export const LOCALE_COOKIE = 'mycel_locale'
/** Sent only on a successful new start, so the next visitor in the same browser never sees the last one's drafts,
 * attachments or send queue (every demo copy has the same user id, and the web app keys those by user id). Exactly
 * "storage": origin-scoped, cookies untouched (the session cookies set in the same response survive). Never "*",
 * "cookies" or "cache": in Chrome "cookies" clears the whole registrable domain (trina.app). */
export const CLEAR_STORAGE = '"storage"'
/** where a successful new start lands: the web app sees `fresh=1` and runs its sign-out cleanup of the tab's storage */
export const FRESH_START_PATH = '/?fresh=1'
const MAX_FORM = 16 * 1024
/** a question the visitor asks in the demo (a chat message), counted when the instance answers 2xx */
const QUESTION_RE = /^\/api\/chats\/[^/]+\/messages$/

/** Paths a visitor never reaches (lower-cased path). The instance fences these too (PR A); this is the outer wall. */
export const DENY_PATHS: RegExp[] = [
  /^\/api\/admin(\/|$)/,
  /^\/api\/setup(\/|$)/,
  /^\/api\/credential/, // credentials, credential settings
  /^\/api\/me\/credential/, // members' own AI connections and sign-ins
  /^\/api\/invites(\/|$)/,
  /^\/api\/guest-invites(\/|$)/,
  /^\/api\/team-link(\/|$)/,
  /^\/api\/password-resets(\/|$)/,
  /^\/api\/auth\/password(\/|$)/,
  /^\/api\/demo\/persona(\/|$)/, // only the gate signs a visitor in, as Mina
  /^\/api\/integrations\/(.*\/)?(oauth|callback)(\/|$)/,
  /^\/oauth(\/|$)/,
  /^\/\.well-known\/oauth/,
  /^\/mcp(\/|$)/,
  /^\/connector-uploads(\/|$)/,
  /^\/connector-downloads(\/|$)/,
  // the web app's pages for the same flows
  /^\/invite(\/|$)/,
  /^\/join(\/|$)/,
  /^\/reset-password(\/|$)/,
  /^\/setup(\/|$)/,
]

/** 'bad' = a path that could mean something else to the instance (encoded slashes, dot segments); else denied or not */
export function pathVerdict(rawUrl: string): 'ok' | 'deny' | 'bad' {
  const q = rawUrl.indexOf('?')
  const raw = q >= 0 ? rawUrl.slice(0, q) : rawUrl
  if (!raw.startsWith('/') || raw.includes('\\') || /%(5c|00)/i.test(raw)) return 'bad'
  let p: string
  try { p = decodeURIComponent(raw).toLowerCase() } catch { return 'bad' }
  if (p.includes('\\') || p.split('/').some((s) => s === '..' || s === '.')) return 'bad'
  // checked decoded and with repeated slashes folded, so /api%2Fadmin and //api/admin are /api/admin too
  const folded = p.replace(/\/{2,}/g, '/')
  const r = raw.toLowerCase().replace(/\/{2,}/g, '/')
  return DENY_PATHS.some((re) => re.test(folded) || re.test(r)) ? 'deny' : 'ok'
}

/** The eight 16-bit groups of an IPv6 address (a dotted IPv4 tail counts as two), or null when it is not one. */
export function ipv6Groups(s: string): number[] | null {
  let a = s.replace(/^\[|\]$/g, '').replace(/%.*$/, '').toLowerCase()
  if (!net.isIPv6(a)) return null
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a)
  if (v4) {
    const b = v4.slice(1).map(Number)
    a = a.slice(0, v4.index) + ((b[0]! << 8) | b[1]!).toString(16) + ':' + ((b[2]! << 8) | b[3]!).toString(16)
  }
  const [head, tail] = a.includes('::') ? a.split('::') as [string, string] : [a, null]
  const h = head ? head.split(':') : []
  const t = tail === null ? [] : tail ? tail.split(':') : []
  const fill = tail === null ? 0 : 8 - h.length - t.length
  const all = [...h, ...Array(Math.max(0, fill)).fill('0'), ...t].map((x) => parseInt(x, 16))
  return all.length === 8 && all.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? all : null
}

/** The address a visitor is counted by: IPv4 as it is (IPv4-mapped IPv6 too), IPv6 as its /64, written out in full
 * (2001:db8::1 and 2001:0db8:0:0::2 are the same visitor). */
export function visitorAddress(raw: string): string {
  const s = raw.trim()
  if (net.isIPv4(s)) return s
  const g = ipv6Groups(s)
  if (!g) return s
  // ::ffff:a.b.c.d (IPv4-mapped) is that IPv4 visitor
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255].join('.')
  return g.slice(0, 4).map((x) => x.toString(16).padStart(4, '0')).join(':') + '::/64'
}

export function parseCookies(h: string | undefined): Map<string, string> {
  const m = new Map<string, string>()
  for (const part of (h ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) m.set(part.slice(0, i).trim(), part.slice(i + 1).trim())
  }
  return m
}
/** the visitor's Cookie header without the gate's own cookie (the instance never sees it) */
export function cookiesForInstance(h: string | undefined): string | null {
  const kept = (h ?? '').split(';').map((s) => s.trim()).filter((s) => s && !s.startsWith(VISITOR_COOKIE + '='))
  return kept.length ? kept.join('; ') : null
}
/** an instance cookie as the browser gets it: host-only, Secure (the visitor is on https; the instance on plain http).
 * A __Host- cookie (the instance's session, __Host-sid) also needs Path=/, or the browser drops it. */
export function secureCookie(c: string): string {
  let parts = c.split(';').map((s) => s.trim()).filter((s) => s && !/^domain=/i.test(s))
  if (parts[0]?.startsWith('__Host-') && !parts.some((s) => /^path=\/$/i.test(s))) parts = [parts[0], 'Path=/', ...parts.slice(1).filter((s) => !/^path=/i.test(s))]
  if (!parts.some((s) => /^secure$/i.test(s))) parts.push('Secure')
  return parts.join('; ')
}

/** Cache-Control with `no-transform` added (kept as it was when it is already there). demo.trina.app sits behind
 * Cloudflare, which injects its Web Analytics beacon into HTML; the strict CSP blocks it and the console shows an
 * error. Cloudflare leaves a response with no-transform as it is. */
export function withNoTransform(v: string | string[] | undefined): string {
  const parts = (Array.isArray(v) ? v.join(',') : v ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!parts.some((s) => s.toLowerCase() === 'no-transform')) parts.push('no-transform')
  return parts.join(', ')
}
const isHtml = (ct: string | string[] | undefined) => /^\s*text\/html\b/i.test(Array.isArray(ct) ? ct[0] ?? '' : ct ?? '')

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host'])
/** request headers that say who the visitor is to the tunnel, never to the instance */
const EDGE = (k: string) => k.startsWith('cf-') || k.startsWith('x-forwarded-') || k === 'x-real-ip' || k === 'true-client-ip' || k === 'cdn-loop' || k === 'forwarded'

function requestHeaders(req: http.IncomingMessage, port: number, upgrade: boolean): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || EDGE(k) || k === 'cookie') continue
    if (HOP.has(k) && !(upgrade && (k === 'connection' || k === 'upgrade'))) continue
    out[k] = v
  }
  out.host = `127.0.0.1:${port}`
  const c = cookiesForInstance(req.headers.cookie)
  if (c) out.cookie = c
  return out
}

export interface PublicDeps {
  cfg: GateConfig
  log: GateLog
  pool: Pool
  state: GateState
  stats: GateStats
  paused: () => boolean
  upstreamStatus: () => UpstreamStatus
}

export function createPublic(d: PublicDeps) {
  const { cfg, log, pool, state, stats } = d
  /** visitor cookie value -> instance id (memory: a gate restart ends every session; the sweeper removes the rest) */
  const visitors = new Map<string, string>()
  const publicHost = new URL(cfg.publicOrigin).hostname

  const isLoopback = (a: string | undefined) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
  const ipOf = (req: http.IncomingMessage): string => {
    const peer = req.socket.remoteAddress ?? ''
    const h = cfg.clientIpHeader ? req.headers[cfg.clientIpHeader] : undefined
    return visitorAddress(isLoopback(peer) && typeof h === 'string' && h.trim() ? h.split(',')[0]!.trim() : peer)
  }
  const visitorOf = (req: http.IncomingMessage): { token: string | null; inst: Instance | null } => {
    const token = parseCookies(req.headers.cookie).get(VISITOR_COOKIE) ?? null
    if (!token) return { token: null, inst: null }
    const id = visitors.get(token)
    const inst = id ? pool.instances.get(id) ?? null : null
    if (inst && inst.state === 'live') return { token, inst }
    if (id) visitors.delete(token)
    return { token, inst: null }
  }
  const visitorCookie = (v: string, maxAge: number) => `${VISITOR_COOKIE}=${v}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`
  /** not HttpOnly: the web app writes the same cookie with the same attributes. `locale` is a checked Locale (localeOf) */
  const localeCookie = (locale: Locale) => `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`
  const cookieLocale = (req: http.IncomingMessage) => parseCookies(req.headers.cookie).get(LOCALE_COOKIE) ?? null

  const page = (res: http.ServerResponse, status: number, kind: PageKind, locale: Locale, extra: Record<string, string | string[]> = {}, limit?: LimitReason) => {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': withNoTransform('no-store'), 'content-security-policy': PAGE_CSP,
      'x-content-type-options': 'nosniff',
      // same-origin, never no-referrer: with no-referrer browsers send `Origin: null` on the Start and Continue forms,
      // and start()/resume() refuse that (403). Other sites still get no referrer.
      'referrer-policy': 'same-origin', 'x-robots-tag': 'noindex', ...extra,
    })
    res.end(renderPage(kind, locale, { siteKey: cfg.turnstile.siteKey, links: cfg.links, limit, locales: cfg.pool.locales }))
  }
  const json = (res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra })
    res.end(JSON.stringify(body))
  }
  const notInDemo = (res: http.ServerResponse) => json(res, 404, { error: { code: 'not_found', message: 'Not available in the demo.' } })

  async function readForm(req: http.IncomingMessage): Promise<URLSearchParams | null> {
    let size = 0
    const chunks: Buffer[] = []
    for await (const c of req) { size += (c as Buffer).length; if (size > MAX_FORM) return null; chunks.push(c as Buffer) }
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
  }

  async function turnstileOk(token: string, ip: string): Promise<boolean> {
    if (!token || token.length > 4096) return false
    try {
      const secret = readSecretFile(cfg.turnstile.secretFile)
      const r = await fetch(cfg.turnstile.verifyUrl, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret, response: token, remoteip: ip.endsWith('/64') ? '' : ip }), signal: AbortSignal.timeout(10_000),
      })
      const j = await r.json() as { success?: unknown; hostname?: unknown }
      if (j.success !== true) return false
      return typeof j.hostname !== 'string' || j.hostname === publicHost
    } catch (e) {
      log.warn('turnstile check failed', { error: String((e as Error)?.message ?? e).slice(0, 120) })
      return false
    }
  }

  /** sign the visitor in as the demo's new hire on their instance: the instance's own Set-Cookie, Secure forced */
  async function persona(inst: Instance): Promise<string[] | null> {
    try {
      const r = await fetch(`http://127.0.0.1:${inst.port}/api/demo/persona`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: cfg.publicOrigin, 'x-mycel-csrf': '1', 'sec-fetch-site': 'same-origin', 'x-mycel-demo-gate': inst.gateKey },
        body: JSON.stringify({ key: cfg.pool.personaKey }), redirect: 'manual', signal: AbortSignal.timeout(15_000),
      })
      await r.body?.cancel().catch(() => {})
      if (!r.ok) { log.warn('persona sign-in refused', { instance: inst.id, status: r.status }); return null }
      const cookies = r.headers.getSetCookie()
      return cookies.length ? cookies.map(secureCookie) : null
    } catch (e) {
      log.warn('persona sign-in failed', { instance: inst.id, error: String((e as Error)?.message ?? e).slice(0, 120) })
      return null
    }
  }

  async function start(req: http.IncomingMessage, res: http.ServerResponse) {
    const origin = req.headers.origin
    if ((origin && origin !== cfg.publicOrigin) || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: { code: 'forbidden' } })
    const form = await readForm(req)
    if (!form) return json(res, 413, { error: { code: 'too_large' } })
    const locale = localeOf(form.get('lang'), req.headers['accept-language'], cfg.pool.locales, cookieLocale(req))
    const ip = ipOf(req)
    const tag = ipTag(ip)
    const { inst: current } = visitorOf(req)
    if (current) { res.writeHead(303, { location: '/', 'cache-control': 'no-store' }); return res.end() }
    if (d.paused()) { stats.bump(locale, 'refusedPaused'); return page(res, 503, 'busy', locale) }
    if (pool.liveCount() >= cfg.pool.maxLive) { stats.bump(locale, 'refusedFull'); return page(res, 503, 'busy', locale) }
    const exempt = state.isExempt(ip, cfg.limits.exemptIpHashes)
    const limit = exempt ? null : state.startRefusal(ip, cfg.limits.startsPerHour, cfg.limits.startsPerDay)
    if (limit) { stats.bump(locale, 'refusedLimit'); log.info('start refused: limit', { visitor: tag, limit }); return page(res, 429, 'limit', locale, {}, limit) }
    if (!(await turnstileOk(form.get('cf-turnstile-response') ?? '', ip))) { stats.bump(locale, 'turnstileFail'); log.info('start refused: turnstile', { visitor: tag }); return page(res, 400, 'check', locale) }
    stats.bump(locale, 'turnstilePass')
    const got = pool.take(locale, ip, exempt ? cfg.limits.exemptLivePerIp : cfg.limits.livePerIp)
    if (typeof got === 'string') {
      log.info('start refused', { visitor: tag, reason: got })
      stats.bump(locale, got === 'ip_live' ? 'refusedLimit' : got === 'paused' ? 'refusedPaused' : 'refusedFull')
      return got === 'ip_live' ? page(res, 429, 'limit', locale, {}, 'ip_live') : page(res, 503, 'busy', locale)
    }
    state.noteStart(ip)
    const cookies = await persona(got)
    if (!cookies) { stats.bump(locale, 'startFailed'); await pool.end(got, 'persona_failed'); return page(res, 502, 'error', locale) }
    const token = crypto.randomBytes(32).toString('base64url')
    visitors.set(token, got.id)
    stats.bump(locale, 'starts')
    log.info('visitor started', { visitor: tag, instance: got.id, locale, exempt: exempt || undefined })
    // `fresh=1`: the web app clears the tab's own per-user keys on this first load and drops the parameter. Clear-Site-Data
    // is not enough on its own: WebKit (Safari) ignores it on this redirect (checked by hand 2026-11-22; Chrome honours it)
    res.writeHead(303, {
      location: FRESH_START_PATH, 'cache-control': 'no-store', 'clear-site-data': CLEAR_STORAGE,
      'set-cookie': [visitorCookie(token, Math.round(cfg.pool.ttlHours * 3600)), localeCookie(locale), ...cookies],
    })
    res.end()
  }

  /** "Continue as Mina": a visitor whose instance session ended (signed out, or the session was revoked) is signed in
   * as the demo's new hire again on THEIR OWN live instance. The instance's persona switch stays closed to visitors
   * (DENY_PATHS); this is the only way back, since sign-in with a password is fenced in the demo. */
  async function resume(req: http.IncomingMessage, res: http.ServerResponse) {
    const origin = req.headers.origin
    if ((origin && origin !== cfg.publicOrigin) || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: { code: 'forbidden' } })
    await readForm(req)
    const { inst } = visitorOf(req)
    if (!inst) { res.writeHead(303, { location: '/', 'cache-control': 'no-store' }); return res.end() }
    const cookies = await persona(inst)
    if (!cookies) return json(res, 502, { error: { code: 'internal' } })
    stats.bump(inst.locale, 'resumes')
    log.info('visitor resumed', { instance: inst.id })
    res.writeHead(303, { location: '/', 'cache-control': 'no-store', 'set-cookie': cookies })
    res.end()
  }

  function health(res: http.ServerResponse) {
    const now = Date.now()
    const snapshotAgeMs: Record<string, number | null> = {}
    for (const l of cfg.pool.locales) snapshotAgeMs[l] = pool.snapshotAgeMs(l)
    const up = d.upstreamStatus()
    json(res, 200, {
      ok: true, paused: d.paused(), pool: pool.counts(), maxLive: cfg.pool.maxLive, live: pool.liveCount(),
      streams: up.streams, waitingStreams: up.waiting, dailyTokens: state.dailyTokens(), dailyCap: cfg.limits.dailyWeightedTokens,
      snapshotAgeMs, upstream: up,
      instances: [...pool.instances.values()].map((i) => ({ id: i.id, locale: i.locale, state: i.state, tokens: i.tokens, expiresInMs: i.expiresAt ? i.expiresAt - now : null })),
    })
  }

  function proxyHttp(req: http.IncomingMessage, res: http.ServerResponse, inst: Instance, onStatus?: (status: number) => void) {
    inst.lastSeenAt = Date.now()
    const up = http.request({ host: '127.0.0.1', port: inst.port, method: req.method, path: req.url, headers: requestHeaders(req, inst.port, false) }, (r) => {
      try { onStatus?.(r.statusCode ?? 502) } catch {}
      const headers: Record<string, string | string[]> = {}
      for (const [k, v] of Object.entries(r.headers)) {
        if (v === undefined || HOP.has(k)) continue
        headers[k] = k === 'set-cookie' ? (v as string[]).map(secureCookie) : v
      }
      headers['x-robots-tag'] = 'noindex'
      if (isHtml(headers['content-type'])) headers['cache-control'] = withNoTransform(headers['cache-control'])
      res.writeHead(r.statusCode ?? 502, headers)
      r.pipe(res)
    })
    up.on('error', () => { if (!res.headersSent) json(res, 502, { error: { code: 'unavailable', message: 'The demo is busy, try again in a bit.' } }); else res.destroy() })
    res.on('close', () => { if (!res.writableFinished) up.destroy() })
    req.pipe(up)
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/__demo/health') {
      // local operators only: through the tunnel every request carries the client IP header
      if (req.method === 'GET' && isLoopback(req.socket.remoteAddress) && !(cfg.clientIpHeader && req.headers[cfg.clientIpHeader])) return health(res)
      return notInDemo(res)
    }
    if (url.pathname === '/__demo/stats') {
      // the same check as health: local operators only
      if (req.method === 'GET' && isLoopback(req.socket.remoteAddress) && !(cfg.clientIpHeader && req.headers[cfg.clientIpHeader])) {
        return json(res, 200, { days: stats.read(Number(url.searchParams.get('days') ?? 30)), distinctStarters24h: state.distinctStarters() })
      }
      return notInDemo(res)
    }
    if (url.pathname === '/__demo/go/start-free') {
      // the free-roam app's "Start free" button (the demo file's signupUrl): counted, then on to pricing
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: { code: 'method_not_allowed' } })
      if (req.method === 'GET') stats.bump(visitorOf(req).inst?.locale, 'startFree')
      res.writeHead(302, { location: cfg.links.pricing, 'cache-control': 'no-store', 'referrer-policy': 'same-origin' })
      return res.end()
    }
    if (url.pathname === '/__demo/status') {
      const o = req.headers.origin
      const cors: Record<string, string> = o && cfg.links.statusOrigins.includes(o) ? { 'access-control-allow-origin': o, vary: 'Origin' } : {}
      const l = url.searchParams.get('lang')
      return json(res, 200, { available: pool.available(isLocale(l) ? l : undefined) }, cors)
    }
    if (url.pathname === '/__demo/start') {
      if (req.method !== 'POST') { res.writeHead(303, { location: '/' }); return res.end() }
      return start(req, res)
    }
    if (url.pathname === '/__demo/resume') {
      if (req.method !== 'POST') { res.writeHead(303, { location: '/' }); return res.end() }
      return resume(req, res)
    }
    const verdict = pathVerdict(req.url ?? '/')
    if (verdict === 'bad') return json(res, 400, { error: { code: 'bad_request' } })
    if (verdict === 'deny') return notInDemo(res)
    const { token, inst } = visitorOf(req)
    if (inst) {
      const question = req.method === 'POST' && QUESTION_RE.test(url.pathname)
      return proxyHttp(req, res, inst, question ? (s) => { if (s >= 200 && s < 300) stats.bump(inst.locale, 'questions') } : undefined)
    }
    const locale = localeOf(url.searchParams.get('lang'), req.headers['accept-language'], cfg.pool.locales, cookieLocale(req))
    if (url.pathname !== '/') {
      if (url.pathname.startsWith('/api/')) return json(res, 401, { error: { code: 'unauthorized' } })
      res.writeHead(303, { location: '/', 'cache-control': 'no-store' }); return res.end()
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: { code: 'method_not_allowed' } })
    if (token) return page(res, 200, 'ended', locale, { 'set-cookie': visitorCookie('', 0) })
    if (!pool.available(locale)) { if (req.method === 'GET') stats.bump(locale, 'busyShown'); return page(res, 200, 'busy', locale) }
    if (req.method === 'GET') stats.bump(locale, 'landing')
    return page(res, 200, 'landing', locale)
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log.error('request failed', { error: String((e as Error)?.message ?? e).slice(0, 200) })
      try { if (!res.headersSent) json(res, 500, { error: { code: 'internal' } }); else res.destroy() } catch {}
    })
  })
  server.on('upgrade', (req: http.IncomingMessage, sock: net.Socket, head: Buffer) => {
    const refuse = (status: string) => { sock.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`) }
    sock.on('error', () => {})
    const verdict = pathVerdict(req.url ?? '/')
    if (verdict !== 'ok') return refuse(verdict === 'bad' ? '400 Bad Request' : '404 Not Found')
    const { inst } = visitorOf(req)
    if (!inst) return refuse('401 Unauthorized')
    // the upgrade request goes on as it came (minus the gate cookie and the edge headers); then bytes both ways
    const up = net.connect(inst.port, '127.0.0.1')
    inst.lastSeenAt = Date.now()
    inst.sockets = (inst.sockets ?? 0) + 1
    let open = true
    const closed = () => { if (open) { open = false; inst.sockets = Math.max(0, (inst.sockets ?? 1) - 1); inst.lastSeenAt = Date.now() } }
    sock.on('close', closed)
    up.on('error', () => sock.destroy())
    up.on('connect', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`]
      for (const [k, v] of Object.entries(requestHeaders(req, inst.port, true))) for (const x of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${x}`)
      up.write(lines.join('\r\n') + '\r\n\r\n')
      if (head.length) up.write(head)
      sock.pipe(up)
      up.pipe(sock)
    })
    sock.on('close', () => up.destroy())
    up.on('close', () => sock.destroy())
  })
  server.headersTimeout = 30_000
  server.requestTimeout = 0

  /** drop cookies of instances that are gone (a returning visitor then sees "session ended" all the same) */
  const prune = setInterval(() => { for (const [t, id] of visitors) if (pool.instances.get(id)?.state !== 'live') visitors.delete(t) }, 60_000)
  prune.unref?.()
  return { server, visitors, close() { clearInterval(prune) } }
}

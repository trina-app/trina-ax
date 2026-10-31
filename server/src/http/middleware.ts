// App-wide middleware, in order: request context -> security headers -> session -> CSRF -> (routes) -> access log.
import type { Context, MiddlewareHandler } from 'hono'
import { isInAppBrowserUserAgent } from '@mycel/shared'
import { CSRF_HEADER, DEFAULT_LOCALE, LOCALE_HEADER, asLocale, uuidv7, type Locale } from '@mycel/shared/api'
import { teamDefaultLocale } from '../admin/settings'
import type { AppEnv } from './env'
import { fail } from './errors'
import type { AppContext } from '../context'
import { touchActivity } from '../system/activity'

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Request path for logs: one-time secrets in the path (invite and password reset links: the API and the web pages
 * /invite/<token>, /reset-password/<token> that the links open) are replaced by "***". */
export function loggablePath(p: string): string {
  return p.replace(/^(\/(?:api\/(?:invites|password-resets)|invite|reset-password|api\/connectors\/remote\/requests|connector-uploads)\/)[^/]+/, '$1***')
}

/**
 * Set a response header after the handler ran WITHOUT re-wrapping the response. Hono's c.header() on a finished
 * response does new Response(res.body, res): that turns a Bun.file() body (sent with sendfile, constant memory)
 * into a JS stream (Bun.serve has no backpressure for those: a 600 MB download grew the server to 1.6 GB) and,
 * with Bun 1.3.12, a Bun.file().slice() body loses its end (Range responses sent the rest of the file).
 */
function setHeader(c: Context<AppEnv>, name: string, value: string) {
  if (c.finalized) { try { c.res.headers.set(name, value); return } catch { /* immutable headers (fetched response) */ } }
  c.header(name, value)
}

/**
 * Language of a request without a session: the one the page shows (X-Mycel-Locale, the visitor picked it on the
 * sign-in screen), else the team default, else English. The browser's Accept-Language does not decide: the team
 * default does (docs/DECISIONS.md "언어"). The session middleware replaces it with the person's language.
 */
export function anonymousLocale(ctx: AppContext, header: string | undefined): Locale {
  const picked = header && header.length <= 16 ? asLocale(header) : null
  if (picked) return picked
  try { return teamDefaultLocale(ctx.db) } catch { return DEFAULT_LOCALE }
}

/** request id, transport info, logger, default locale. Client-sent X-Forwarded-For / CF-Connecting-IP / X-Real-IP
 * are never read here: the real IP comes only from whoever called app.fetch (socket peer, relay OPEN metadata, or
 * CF-Connecting-IP of a request that came through the office public address: http/tunnel.ts decides that). */
export function requestContext(ctx: AppContext): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const requestId = uuidv7()
    c.set('requestId', requestId)
    const info = { ip: c.env?.ip ?? null, via: c.env?.via ?? 'direct', port: c.env?.port ?? null, ...(c.env?.tunnel ? { tunnel: true } : {}) } as const
    c.set('info', info)
    c.set('log', ctx.log.child({ rid: requestId }))
    c.set('auth', null)
    c.set('locale', anonymousLocale(ctx, c.req.header(LOCALE_HEADER)))
    const t0 = performance.now()
    await next()
    setHeader(c, 'X-Request-Id', requestId)
    const auth = c.get('auth')
    c.get('log').debug('http', { method: c.req.method, path: loggablePath(c.req.path), status: c.res.status, ms: Math.round(performance.now() - t0), user: auth?.user.id ?? null, via: info.via })
  }
}

export function securityHeaders(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next()
    setHeader(c, 'X-Content-Type-Options', 'nosniff')
    // the office public address is https only (Cloudflare's certificate): browsers stay on https for this name
    if (c.get('info')?.tunnel) setHeader(c, 'Strict-Transport-Security', 'max-age=31536000')
    // OAuth callbacks carry one-use codes: retain an explicit, stricter route policy.
    if (c.res.headers.get('Referrer-Policy') !== 'no-referrer') setHeader(c, 'Referrer-Policy', 'same-origin')
    if (c.req.path.startsWith('/api/')) {
      if (!c.res.headers.has('Cache-Control')) setHeader(c, 'Cache-Control', 'no-store')
      // Every team address is the same site (<team>.treesoop.com), so SameSite=Lax sends the session cookie with an
      // <img> / <video> / <script> another team's page points at this team's API. The response cannot be read
      // there, but its size, type, dimensions or load / error events can (whether a file exists, an image's size),
      // and Spectre-class reads need nothing more. CORP keeps every API response to this origin (design tab 7).
      setHeader(c, 'Cross-Origin-Resource-Policy', 'same-origin')
    } else {
      // a page that says who may frame it (CSP frame-ancestors: the artifact receiver /sandbox/frame) keeps that rule;
      // browsers ignore X-Frame-Options next to frame-ancestors anyway, so DENY there would only mislead
      const ancestors = /(?:^|;)\s*frame-ancestors\s+([^;]*)/.exec(c.res.headers.get('content-security-policy') ?? '')?.[1]?.trim()
      if (!ancestors || ancestors === "'none'") setHeader(c, 'X-Frame-Options', 'DENY')
      setHeader(c, 'Cross-Origin-Opener-Policy', 'same-origin')
    }
  }
}

/** The port of a host[:port] / origin authority, or null when it has none. */
function portOf(host: string): number | null {
  const m = /:(\d{1,5})$/.exec(host)
  return m ? Number(m[1]) : null
}

/** Is this Host header one of the configured names (host:port, compared in lower case)? No list = any Host. With
 * `port` (the listener the request came in on) the Host must also name that port: the loopback app port's names
 * are not answered on the office port and the other way round. */
export function hostAllowed(host: string | null | undefined, allowed: readonly string[] | undefined, port?: number | null): boolean {
  if (!allowed || allowed.length === 0) return true
  if (!host) return false
  const h = host.toLowerCase()
  return allowed.includes(h) && (port == null || portOf(h) === port)
}

/** The public origins a direct request may name (CSRF Origin, WebSocket Origin): with a Host allow-list (office
 * mode) only those of the listener's own port, so the office port never accepts http://localhost:<app port>. */
export function originsFor(config: AppContext['config'], info: { via: string; port?: number | null; tunnel?: boolean }): string[] {
  // through the office public address only that address (never the LAN or localhost origins)
  if (info.via === 'direct' && info.tunnel && config.tunnel) return [`https://${config.tunnel.host}`]
  if (info.via !== 'direct' || info.port == null || !config.allowedHosts?.length) return config.publicOrigins
  return config.publicOrigins.filter((o) => { try { return portOf(new URL(o).host) === info.port } catch { return false } })
}

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const v4n = (ip: string) => { const m = V4.exec(ip); return m ? m.slice(1).reduce((n, o) => ((n << 8) | Number(o)) >>> 0, 0) : null }

/** Is this socket peer in one of the IPv4 CIDRs? Loopback always is (the Mac itself). No list = any peer. */
export function peerAllowed(ip: string | null | undefined, cidrs: readonly string[] | undefined): boolean {
  if (!cidrs || cidrs.length === 0) return true
  if (!ip) return false
  const a = v4n(ip)
  if (a === null) return false // office mode is IPv4 only
  if (a >>> 24 === 127) return true
  return inCidrs(ip, cidrs)
}

/** Is this IPv4 address in one of the IPv4 CIDRs? IPv6 and anything else: no. */
export function inCidrs(ip: string | null | undefined, cidrs: readonly string[]): boolean {
  const a = ip ? v4n(ip) : null
  if (a === null) return false
  return cidrs.some((c) => {
    const [base, bits] = c.split('/')
    const b = v4n(base ?? ''), n = Number(bits)
    if (b === null || !Number.isInteger(n) || n < 0 || n > 32) return false
    const mask = n === 0 ? 0 : (0xffffffff << (32 - n)) >>> 0
    return ((a & mask) >>> 0) === ((b & mask) >>> 0)
  })
}

/**
 * Office mode (docs/OFFICE.md) lists the server's own names and addresses in config.allowedHosts: a direct request
 * (socket peer: the loopback port or the office-network TLS port) with any other Host, a Host of the other
 * listener's port, or no Host at all gets 421. A web page whose name an attacker re-points at the office Mac (DNS
 * rebinding) still sends its own name as Host, so it never reaches the API or the cookies' origin. config.allowedPeers
 * keeps the office port to the office subnet (a VPN peer gets 403). Relayed requests are routed by the relay's own
 * host check.
 */
export function hostCheck(ctx: AppContext): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const info = c.get('info')
    if (info.via === 'direct' && info.tunnel) {
      // the office public address (http/tunnel.ts already matched the Host): https only, then the optional allow-list
      const blocked = publicAddressRefusal(ctx.config.tunnel, info.ip, visitorScheme(c.req.header('cf-visitor'), c.req.header('x-forwarded-proto')), c.req.header('cf-ipcountry'))
      if (blocked === 'http') {
        if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return c.text('Use https\n', 403)
        return c.redirect(c.req.url, 308) // c.req.url is already https://<host>/...
      }
      if (blocked) return c.text('Forbidden: this address is not open to your network\n', 403)
      await next()
      return
    }
    if (info.via === 'direct') {
      if (!peerAllowed(info.ip, ctx.config.allowedPeers)) return c.text('Forbidden: this server answers only the office network\n', 403)
      // the header as the browser sent it (never parsed from the request URL: no Host means no answer)
      if (!hostAllowed(c.req.header('host'), ctx.config.allowedHosts, info.port)) {
        return c.text('Misdirected request: this server answers only on its own addresses\n', 421)
      }
    }
    await next()
  }
}

/** The scheme the visitor used to reach Cloudflare: CF-Visitor {"scheme":"http"}, else X-Forwarded-Proto. */
export function visitorScheme(cfVisitor: string | undefined, xfp: string | undefined): string | null {
  if (cfVisitor) { try { const v = JSON.parse(cfVisitor) as { scheme?: unknown }; if (typeof v.scheme === 'string') return v.scheme.toLowerCase() } catch {} }
  return xfp ? xfp.split(',')[0]!.trim().toLowerCase() : null
}

/**
 * Why a request through the office public address is refused, or null: 'http' when the visitor used plain http
 * (Cloudflare forwards that too unless the zone forces https; these headers are Cloudflare's: only cloudflared
 * reaches this branch), 'ip' / 'country' when an allow-list is set (config.tunnel.allowFrom: IPv4 CIDRs, so an IPv6
 * visitor is refused; countries: CF-IPCountry).
 */
export function publicAddressRefusal(t: AppContext['config']['tunnel'], ip: string | null, scheme: string | null, country: string | undefined): 'http' | 'ip' | 'country' | null {
  if (scheme === 'http') return 'http'
  if (!t) return null
  if (t.allowFrom.length && !inCidrs(ip, t.allowFrom)) return 'ip'
  if (t.countries.length && !t.countries.includes((country ?? '').toUpperCase())) return 'country'
  return null
}

/** Resolve the session (cookie or bearer) through the session service of component A. The desktop app's in-app
 * browser (the pane the AI drives) marks its User-Agent; it never gets the team server, signed in or not (tab 5
 * "앱 안 브라우저 분리": the desktop blocks team addresses, this is the second fence). */
export function session(ctx: AppContext): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (isInAppBrowserUserAgent(c.req.header('user-agent'))) fail('unauthorized')
    if (c.req.path.startsWith('/api/')) {
      try {
        const auth = await ctx.services.sessions.resolve(c.req.raw, c.get('info'))
        c.set('auth', auth)
        if (auth) { c.set('locale', auth.user.locale); touchActivity() }
      } catch (e) {
        c.get('log').error('session lookup failed', { err: e })
        c.set('auth', null)
      }
    }
    await next()
  }
}

/** Is this Origin the server's own origin (scheme and host) or one of the configured public origins? */
export function originAllowed(origin: string, requestUrl: string, allowed: string[]): boolean {
  let o: URL
  try { o = new URL(origin) } catch { return false }
  const self = new URL(requestUrl)
  // same scheme too: http://<public host> is not the https office internet address
  if (o.host === self.host && o.protocol === self.protocol) return true
  return allowed.some((a) => { try { return new URL(a).origin === o.origin } catch { return false } })
}

/**
 * CSRF for state-changing /api requests that are not bearer-authenticated (cookie sessions and the public login /
 * invite / setup forms): the custom header must be present, Sec-Fetch-Site must not say cross-site, and an Origin,
 * when sent, must be this server or a configured public origin.
 */
export function csrf(ctx: AppContext): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!SAFE.has(c.req.method) && c.req.path.startsWith('/api/') && c.get('auth')?.via !== 'bearer') {
      if (!c.req.header(CSRF_HEADER)) fail('csrf')
      if (c.req.header('sec-fetch-site') === 'cross-site') fail('csrf')
      const origin = c.req.header('origin')
      if (origin && origin !== 'null' && !originAllowed(origin, c.req.url, originsFor(ctx.config, c.get('info')))) fail('csrf')
      if (origin === 'null') fail('csrf')
    }
    await next()
  }
}

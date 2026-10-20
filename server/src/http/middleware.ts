// App-wide middleware, in order: request context -> security headers -> session -> CSRF -> (routes) -> access log.
import type { Context, MiddlewareHandler } from 'hono'
import { isInAppBrowserUserAgent } from '@mycel/shared'
import { CSRF_HEADER, localeFromAcceptLanguage, uuidv7 } from '@mycel/shared/api'
import type { AppEnv } from './env'
import { fail } from './errors'
import type { AppContext } from '../context'

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Request path for logs: one-time secrets in the path (invite and password reset links) are replaced by "***". */
export function loggablePath(p: string): string {
  return p.replace(/^(\/api\/(?:invites|password-resets)\/)[^/]+/, '$1***')
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

/** request id, transport info, logger, default locale. Client-sent X-Forwarded-For / CF-Connecting-IP / X-Real-IP
 * are never read: the real IP comes only from whoever called app.fetch (socket peer or relay OPEN metadata). */
export function requestContext(ctx: AppContext): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const requestId = uuidv7()
    c.set('requestId', requestId)
    const info = { ip: c.env?.ip ?? null, via: c.env?.via ?? 'direct' } as const
    c.set('info', info)
    c.set('log', ctx.log.child({ rid: requestId }))
    c.set('auth', null)
    c.set('locale', localeFromAcceptLanguage(c.req.header('accept-language')))
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
    setHeader(c, 'Referrer-Policy', 'same-origin')
    if (c.req.path.startsWith('/api/')) {
      if (!c.res.headers.has('Cache-Control')) setHeader(c, 'Cache-Control', 'no-store')
    } else {
      // a page that says who may frame it (CSP frame-ancestors: the artifact receiver /sandbox/frame) keeps that rule;
      // browsers ignore X-Frame-Options next to frame-ancestors anyway, so DENY there would only mislead
      const ancestors = /(?:^|;)\s*frame-ancestors\s+([^;]*)/.exec(c.res.headers.get('content-security-policy') ?? '')?.[1]?.trim()
      if (!ancestors || ancestors === "'none'") setHeader(c, 'X-Frame-Options', 'DENY')
      setHeader(c, 'Cross-Origin-Opener-Policy', 'same-origin')
    }
  }
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
        if (auth) c.set('locale', auth.user.locale)
      } catch (e) {
        c.get('log').error('session lookup failed', { err: e })
        c.set('auth', null)
      }
    }
    await next()
  }
}

/** Is this Origin the server's own host or one of the configured public origins? */
export function originAllowed(origin: string, requestUrl: string, allowed: string[]): boolean {
  let o: URL
  try { o = new URL(origin) } catch { return false }
  const self = new URL(requestUrl)
  if (o.host === self.host) return true
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
      if (origin && origin !== 'null' && !originAllowed(origin, c.req.url, ctx.config.publicOrigins)) fail('csrf')
      if (origin === 'null') fail('csrf')
    }
    await next()
  }
}

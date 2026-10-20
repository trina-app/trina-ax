// App-wide middleware, in order: request context -> security headers -> session -> CSRF -> (routes) -> access log.
import type { MiddlewareHandler } from 'hono'
import { CSRF_HEADER, localeFromAcceptLanguage, uuidv7 } from '@mycel/shared/api'
import type { AppEnv } from './env'
import { fail } from './errors'
import type { AppContext } from '../context'

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS'])

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
    c.header('X-Request-Id', requestId)
    const auth = c.get('auth')
    c.get('log').debug('http', { method: c.req.method, path: c.req.path, status: c.res.status, ms: Math.round(performance.now() - t0), user: auth?.user.id ?? null, via: info.via })
  }
}

export function securityHeaders(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next()
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Referrer-Policy', 'same-origin')
    if (c.req.path.startsWith('/api/')) {
      if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store')
    } else {
      c.header('X-Frame-Options', 'DENY')
      c.header('Cross-Origin-Opener-Policy', 'same-origin')
    }
  }
}

/** Resolve the session (cookie or bearer) through the session service of component A. */
export function session(ctx: AppContext): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
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

// The HTTP app: middleware, error handling, and every route module from routes/index.ts.
// Callers: main.ts (Bun.serve / TLS listener), the relay client (in-process app.fetch with the real client IP),
// tests (app.fetch with via 'test').
import { Hono } from 'hono'
import { DEFAULT_LOCALE, SERVER_DISK_FULL } from '@mycel/shared/api'
import type { AppContext } from './context'
import type { AppEnv } from './http/env'
import { HttpError } from './http/errors'
import { csrf, hostCheck, loggablePath, requestContext, securityHeaders, session } from './http/middleware'
import { RouteKit } from './http/route'
import { ROUTE_MODULES, type RouteModule } from './routes'
import { isDiskFullError } from './system/storage'

export async function buildApp(ctx: AppContext, modules: readonly RouteModule[] = ROUTE_MODULES): Promise<Hono<AppEnv>> {
  const app = new Hono<AppEnv>()

  app.use('*', requestContext(ctx))
  app.use('*', securityHeaders())
  app.use('*', hostCheck(ctx))
  app.use('*', session(ctx))
  app.use('*', csrf(ctx))

  app.onError((err, c) => {
    const locale = c.get('locale') ?? DEFAULT_LOCALE
    const rid = c.get('requestId')
    if (err instanceof HttpError) {
      if (err.retryAfter !== undefined) c.header('Retry-After', String(err.retryAfter))
      return c.json({ error: err.body(locale, rid) }, err.status as 400)
    }
    // the server's disk is full (ENOSPC, SQLite full): say that, not "서버 오류" (sign-in, sending, any write; QA TC-209)
    if (isDiskFullError(err)) {
      ;(c.get('log') ?? ctx.log).error('disk full', { err, method: c.req.method, path: loggablePath(c.req.path) })
      return c.json({ error: new HttpError('storage_full', SERVER_DISK_FULL[locale], { params: { reason: 'server_disk_full' } }).body(locale, rid) }, 507)
    }
    ;(c.get('log') ?? ctx.log).error('unhandled error', { err, method: c.req.method, path: loggablePath(c.req.path) })
    return c.json({ error: new HttpError('internal').body(locale, rid) }, 500)
  })
  app.notFound((c) => {
    const locale = c.get('locale') ?? DEFAULT_LOCALE
    if (c.req.path.startsWith('/api/') || c.req.path === '/api') return c.json({ error: new HttpError('not_found').body(locale, c.get('requestId')) }, 404)
    return c.text('Not found', 404)
  })

  for (const m of modules) await m.init?.(ctx)
  for (const m of modules) m.register(new RouteKit(app, ctx, m.name), ctx)
  ctx.appFetch = async (req, env) => app.fetch(req, env)
  return app
}

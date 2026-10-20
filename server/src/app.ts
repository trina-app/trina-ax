// The HTTP app: middleware, error handling, and every route module from routes/index.ts.
// Callers: main.ts (Bun.serve / TLS listener), the relay client (in-process app.fetch with the real client IP),
// tests (app.fetch with via 'test').
import { Hono } from 'hono'
import type { AppContext } from './context'
import type { AppEnv } from './http/env'
import { HttpError } from './http/errors'
import { csrf, requestContext, securityHeaders, session } from './http/middleware'
import { RouteKit } from './http/route'
import { ROUTE_MODULES, type RouteModule } from './routes'

export async function buildApp(ctx: AppContext, modules: readonly RouteModule[] = ROUTE_MODULES): Promise<Hono<AppEnv>> {
  const app = new Hono<AppEnv>()

  app.use('*', requestContext(ctx))
  app.use('*', securityHeaders())
  app.use('*', session(ctx))
  app.use('*', csrf(ctx))

  app.onError((err, c) => {
    const locale = c.get('locale') ?? 'ko'
    const rid = c.get('requestId')
    if (err instanceof HttpError) {
      if (err.retryAfter !== undefined) c.header('Retry-After', String(err.retryAfter))
      return c.json({ error: err.body(locale, rid) }, err.status as 400)
    }
    ;(c.get('log') ?? ctx.log).error('unhandled error', { err, method: c.req.method, path: c.req.path })
    return c.json({ error: new HttpError('internal').body(locale, rid) }, 500)
  })
  app.notFound((c) => {
    const locale = c.get('locale') ?? 'ko'
    if (c.req.path.startsWith('/api/') || c.req.path === '/api') return c.json({ error: new HttpError('not_found').body(locale, c.get('requestId')) }, 404)
    return c.text('Not found', 404)
  })

  for (const m of modules) await m.init?.(ctx)
  for (const m of modules) m.register(new RouteKit(app, ctx, m.name), ctx)
  return app
}

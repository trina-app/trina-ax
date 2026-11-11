// Route module "web" — owner: component D (docs/WORKPLAN.md).
// Serves the built web app (web/dist) with SPA fallback: every non-/api GET that is not a file gets index.html.
//   /assets/*       hashed Vite output: cached forever
//   /vendor/*       libraries for artifact frames (web/scripts/build-vendor.ts). Artifact frames have an opaque
//                   origin, so these answer with Access-Control-Allow-Origin: * (module scripts need CORS);
//                   hashed chunks are immutable, the entry files (react.js, …) revalidate
//   /sandbox/frame  the fixed receiver document of artifact / HTML preview frames, with the sandbox CSP header
//   /sw.js          service worker: never cached, scope /
//   /team-icon      the team's logo (Admin > Team settings, admin/team-icon.ts) or the default icon, public (the image
//                   only, nothing else about the team), shown in the computer's sidebar header; /favicon.ico,
//                   /apple-touch-icon.png, /manifest.webmanifest and index.html's icon links stay the product's
//   /downloads/*    desktop app installers in <data>/downloads (index.json lists them: the owner's, the office updater's,
//                   a Linux server's Windows app from the feed), for signed-in people only, with Range for resumed
//                   downloads (./downloads.ts)
//   /licenses/manifest.json  the notice manifest (exact release and package versions): signed-out callers from the
//                   internet (through the relay or the office internet address) get 404, like /api/health gives them no
//                   version; LICENSE, NOTICE, README.txt and the package notices stay public. Never stored by a cache.
//   a missing file with an extension: 404 (never the app page as an icon, image or script)
//   everything else index.html with the app's Content-Security-Policy (no-cache, so a new build shows up)
// In dev without a build, it points to the Vite dev server (bun run --cwd web dev, port 19140) instead.
import path from 'node:path'
import type { Context } from 'hono'
import { PRODUCT } from '@mycel/shared'
import { REPO_ROOT } from '../app-config'
import type { AppEnv } from '../http/env'
import type { AppContext } from '../context'
import type { RouteModule } from './module'
import { downloadRoute } from './downloads'
import { isNoticeManifest, serveWeb, type WebOptions } from './web-static'
import { readTeamIcon } from '../admin/team-icon'
import { downloadsDirOf } from '../system/windows-app'

export { appCsp, safeFile, serveWeb, WEB_DEV_URL, type WebOptions } from './web-static'
export const WEB_DIST_DEFAULT = path.join(REPO_ROOT, 'web', 'dist')
const envDist = () => process.env[PRODUCT.envPrefix + 'WEB_DIST']

export const webRoutes: RouteModule = {
  name: 'web',
  owner: 'D',
  register(kit, ctx) {
    const opts: WebOptions = {
      dist: envDist() ?? WEB_DIST_DEFAULT,
      dev: ctx.config.mode === 'dev',
      devPort: ctx.config.listen.port,
      teamIcon: () => readTeamIcon(ctx.config.dataDir),
    }
    const downloads = downloadsDirOf(ctx.config.dataDir)
    kit.raw('GET', '*', async (c, next) => {
      if (c.req.path.startsWith('/downloads/')) return downloadRoute(c as unknown as Context<AppEnv>, ctx, downloads)
      if (isNoticeManifest(opts.dist, new URL(c.req.url).pathname)) {
        const hc = c as unknown as Context<AppEnv>
        const info = hc.get('info')
        if ((info.tunnel || info.via === 'relay') && !(await signedIn(hc, ctx))) {
          return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'private, no-store' } })
        }
        const res = serveWeb(c.req.raw, opts)
        res?.headers.set('cache-control', 'private, no-store')
        return res ?? next()
      }
      const res = serveWeb(c.req.raw, opts)
      if (!res) return next()
      return res
    })
  },
}

/** A session (cookie or bearer), as /api/health counts one: the session middleware resolves it only under /api/. */
async function signedIn(c: Context<AppEnv>, ctx: AppContext): Promise<boolean> {
  try { return !!(await ctx.services.sessions.resolve(c.req.raw, c.get('info'))) } catch (e) {
    c.get('log').error('session lookup failed', { err: e })
    return false
  }
}

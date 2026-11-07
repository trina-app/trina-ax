// Route module "web" — owner: component D (docs/WORKPLAN.md).
// Serves the built web app (web/dist) with SPA fallback: every non-/api GET that is not a file gets index.html.
//   /assets/*       hashed Vite output: cached forever
//   /vendor/*       libraries for artifact frames (web/scripts/build-vendor.ts). Artifact frames have an opaque
//                   origin, so these answer with Access-Control-Allow-Origin: * (module scripts need CORS);
//                   hashed chunks are immutable, the entry files (react.js, …) revalidate
//   /sandbox/frame  the fixed receiver document of artifact / HTML preview frames, with the sandbox CSP header
//   /sw.js          service worker: never cached, scope /
//   /team-icon      the team's logo (Admin > Team settings, admin/team-icon.ts) or the default icon, public (the sign-in
//                   page shows it too); /favicon.ico and index.html's tab icon link follow it; /apple-touch-icon.png,
//                   the home-screen link and /manifest.webmanifest only when it is square and at least 512 px
//   /downloads/*    desktop app installers in <data>/downloads (index.json lists them: the owner's, the office updater's,
//                   a Linux server's Windows app from the feed), for signed-in people only, with Range for resumed
//                   downloads (./downloads.ts)
//   a missing file with an extension: 404 (never the app page as an icon, image or script)
//   everything else index.html with the app's Content-Security-Policy (no-cache, so a new build shows up)
// In dev without a build, it points to the Vite dev server (bun run --cwd web dev, port 19140) instead.
import path from 'node:path'
import type { Context } from 'hono'
import { PRODUCT } from '@mycel/shared'
import { REPO_ROOT } from '../app-config'
import type { AppEnv } from '../http/env'
import type { RouteModule } from './module'
import { downloadRoute } from './downloads'
import { serveWeb, type WebOptions } from './web-static'
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
      const res = serveWeb(c.req.raw, opts)
      if (!res) return next()
      return res
    })
  },
}

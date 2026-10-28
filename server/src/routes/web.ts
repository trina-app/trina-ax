// Route module "web" — owner: component D (docs/WORKPLAN.md).
// Serves the built web app (web/dist) with SPA fallback: every non-/api GET that is not a file gets index.html.
//   /assets/*       hashed Vite output: cached forever
//   /vendor/*       libraries for artifact frames (web/scripts/build-vendor.ts). Artifact frames have an opaque
//                   origin, so these answer with Access-Control-Allow-Origin: * (module scripts need CORS);
//                   hashed chunks are immutable, the entry files (react.js, …) revalidate
//   /sandbox/frame  the fixed receiver document of artifact / HTML preview frames, with the sandbox CSP header
//   /sw.js          service worker: never cached, scope /
//   /team-icon      the team's logo (Admin > Team settings, admin/team-icon.ts) or the default icon, public (the sign-in
//                   page shows it too); /favicon.ico, /apple-touch-icon.png and /manifest.webmanifest follow it, and
//                   index.html's icon links point at it
//   /downloads/*    desktop app installers the owner put in <data>/downloads (index.json lists them), for signed-in
//                   people only, with Range for resumed downloads (./downloads.ts)
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

export { appCsp, safeFile, serveWeb, WEB_DEV_URL, type WebOptions } from './web-static'
export const WEB_DIST_DEFAULT = path.join(REPO_ROOT, 'web', 'dist')
const envDist = () => process.env[PRODUCT.envPrefix + 'WEB_DIST']
const envDownloads = () => process.env[PRODUCT.envPrefix + 'DOWNLOADS_DIR']

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
    const downloads = envDownloads() ?? path.join(ctx.config.dataDir, 'downloads')
    kit.raw('GET', '*', async (c, next) => {
      if (c.req.path.startsWith('/downloads/')) return downloadRoute(c as unknown as Context<AppEnv>, ctx, downloads)
      const res = serveWeb(c.req.raw, opts)
      if (!res) return next()
      return res
    })
  },
}

// Route module "web" — owner: component D (docs/WORKPLAN.md).
// Serves the built web app (web/dist) with SPA fallback: every non-/api GET that is not a file gets index.html.
//   /assets/*       hashed Vite output: cached forever
//   /vendor/*       libraries for artifact frames (web/scripts/build-vendor.ts). Artifact frames have an opaque
//                   origin, so these answer with Access-Control-Allow-Origin: * (module scripts need CORS);
//                   hashed chunks are immutable, the entry files (react.js, …) revalidate
//   /sw.js          service worker: never cached, scope /
//   /downloads/*    desktop app installers the owner put in <data>/downloads (index.json lists them)
//   everything else index.html with the app's Content-Security-Policy (no-cache, so a new build shows up)
// In dev without a build, it points to the Vite dev server (bun run --cwd web dev, port 19140) instead.
import path from 'node:path'
import { PRODUCT } from '@mycel/shared'
import { REPO_ROOT } from '../app-config'
import type { RouteModule } from './module'
import { serveWeb, type WebOptions } from './web-static'

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
      downloads: envDownloads() ?? path.join(ctx.config.dataDir, 'downloads'),
      dev: ctx.config.mode === 'dev',
      devPort: ctx.config.listen.port,
    }
    kit.raw('GET', '*', async (c, next) => {
      const res = serveWeb(c.req.raw, opts)
      if (!res) return next()
      return res
    })
  },
}

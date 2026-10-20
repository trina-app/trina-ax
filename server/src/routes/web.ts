// Route module "web" — owner: component D (docs/WORKPLAN.md).
// Serves the built web app (web/dist) with SPA fallback: every non-/api GET that is not a file gets index.html.
// In dev without a build, it points to the Vite dev server (bun run dev:web, port 19140) instead.
import fs from 'node:fs'
import path from 'node:path'
import { PRODUCT } from '@mycel/shared'
import { REPO_ROOT } from '../app-config'
import type { RouteModule } from './module'

export const WEB_DIST = process.env[PRODUCT.envPrefix + 'WEB_DIST'] ?? path.join(REPO_ROOT, 'web', 'dist')
export const WEB_DEV_URL = 'http://localhost:19140'

const devPage = (port: number) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${PRODUCT.displayName}</title></head><body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.6">
<h1>${PRODUCT.displayName} — dev server</h1>
<p>The API is running on port ${port}. The web app is not built yet.</p>
<p>Run <code>bun run dev:web</code> and open <a href="${WEB_DEV_URL}">${WEB_DEV_URL}</a> (it proxies <code>/api</code> here), or build it with <code>bun run --cwd web build</code>.</p>
</body></html>`

export const webRoutes: RouteModule = {
  name: 'web',
  owner: 'D',
  register(kit, ctx) {
    const root = path.resolve(WEB_DIST)
    kit.raw('GET', '*', async (c, next) => {
      if (c.req.path.startsWith('/api/') || c.req.path === '/api') return next()
      const index = path.join(root, 'index.html')
      if (!fs.existsSync(index)) {
        if (ctx.config.mode === 'dev') return c.html(devPage(ctx.config.listen.port))
        return c.text(`${PRODUCT.displayName}: web app missing (${root})`, 500)
      }
      const rel = decodeURIComponent(c.req.path).replace(/^\/+/, '')
      const file = path.resolve(root, rel)
      if (rel && file.startsWith(root + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const res = new Response(Bun.file(file))
        // hashed assets can be cached forever; everything else revalidates
        if (/\/assets\//.test(c.req.path)) res.headers.set('Cache-Control', 'public, max-age=31536000, immutable')
        return res
      }
      return new Response(Bun.file(index), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } })
    })
  },
}

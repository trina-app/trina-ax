// The demo walk's static server (web/test/demo/playwright.config.ts): dist-demo mounted at DEMO_BASE (default /), as
// a site would host it: every address under the base that is not a file gets index.html (deep links, reloads), and
// each answer carries the CSP the demo needs (DEMO_CSP below; the site sends the same header for its /demo/ path).
// Run: DEMO_BASE=/demo/ bun test/demo/serve.ts (from web/)
import path from 'node:path'

const PORT = Number(process.env.DEMO_PORT ?? 19243)
const BASE = `/${(process.env.DEMO_BASE ?? '/').replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/')
const ROOT = path.resolve(import.meta.dir, '../../dist-demo')

/** what the demo needs: its own scripts and styles (plus the app's inline style attributes and index.html's one style
 * block), pictures from the page's own server as blob:/data: URLs, its worker (sw.js) and the PDF viewer's worker */
export const DEMO_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  "media-src 'self' blob: data:",
  "connect-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "frame-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ')

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    if (BASE !== '/' && url.pathname === BASE.slice(0, -1)) return Response.redirect(`${url.origin}${BASE}${url.search}`, 301)
    if (!url.pathname.startsWith(BASE)) return new Response('not here', { status: 404 })
    const rel = decodeURIComponent(url.pathname.slice(BASE.length))
    const file = path.resolve(ROOT, rel)
    const inside = file.startsWith(ROOT + path.sep)
    const f = inside ? Bun.file(file) : null
    const found = f && rel && (await f.exists())
    const headers: Record<string, string> = { 'content-security-policy': DEMO_CSP }
    if (found) {
      if (rel === 'sw.js') headers['cache-control'] = 'no-cache'
      return new Response(f, { headers })
    }
    // an address of the app under the base (a deep link, a reload): the page; a missing file stays missing
    if (/\.[a-z0-9]+$/i.test(rel) || rel.startsWith('assets/')) return new Response('not found', { status: 404, headers })
    return new Response(Bun.file(path.join(ROOT, 'index.html')), { headers: { ...headers, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } })
  },
})
console.log(`demo at http://localhost:${PORT}${BASE}`)

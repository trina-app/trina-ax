// Static serving of the built web app for route module "web" (component D), kept free of server context imports so
// the web client's mock server (web/test/mock) serves the build with exactly the same headers.
import fs from 'node:fs'
import path from 'node:path'
import { PRODUCT } from '@mycel/shared'

export const WEB_DEV_URL = 'http://localhost:19140'

/**
 * CSP of the app shell (tab 5). Artifact and HTML-preview frames are srcdoc documents, which inherit this policy on
 * top of their own (artifactCsp in web/src/lib/artifacts.ts), so script-src keeps 'unsafe-inline' and data: (React
 * artifacts run as data: modules) — the frame's own CSP is the strict one. frame-src limits where a frame may
 * navigate (no external pages inside the app); connect-src only this server (REST + WebSocket); img-src keeps
 * external images out of answers.
 */
export function appCsp(host: string | null): string {
  const ws = host && /^[A-Za-z0-9.\-:[\]]+$/.test(host) ? ` wss://${host} ws://${host}` : ''
  return [
    "default-src 'self'",
    // 'wasm-unsafe-eval' lets the page compile WebAssembly (sha256 of large uploads) — not JavaScript eval
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // blob: = files the page itself already holds (pdf.js reads the preview's blob URL from its worker)
    `connect-src 'self' blob:${ws}`,
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "frame-src 'self' blob:",
    "child-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ')
}

const devPage = (port: number) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${PRODUCT.displayName}</title></head><body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.6">
<h1>${PRODUCT.displayName} — dev server</h1>
<p>The API is running on port ${port}. The web app is not built yet.</p>
<p>Run <code>bun run --cwd web dev</code> and open <a href="${WEB_DEV_URL}">${WEB_DEV_URL}</a> (it proxies <code>/api</code> here), or build it with <code>bun run --cwd web build</code>.</p>
</body></html>`

/** Resolve a URL path inside `root` without leaving it (no "..", no dotfiles, no symlink escapes). Null if not a file. */
export function safeFile(root: string, urlPath: string): string | null {
  let rel: string
  try {
    rel = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  rel = rel.replace(/^\/+/, '')
  if (!rel || rel.includes('\0') || rel.includes('\\')) return null
  const parts = rel.split('/')
  if (parts.some((p) => p === '' || p === '..' || p.startsWith('.'))) return null
  const file = path.resolve(root, ...parts)
  if (!file.startsWith(root + path.sep)) return null
  try {
    const real = fs.realpathSync(file)
    const realRoot = fs.realpathSync(root)
    if (!real.startsWith(realRoot + path.sep)) return null
    return fs.statSync(real).isFile() ? real : null
  } catch {
    return null
  }
}

export interface WebOptions {
  dist: string
  downloads: string | null
  dev: boolean
  devPort: number
}

/** The handler behind GET * (also used by the web client's mock server in its end-to-end tests). */
export function serveWeb(req: Request, o: WebOptions): Response | null {
  const url = new URL(req.url)
  const p = url.pathname
  if (p === '/api' || p.startsWith('/api/')) return null
  const root = path.resolve(o.dist)

  if (p.startsWith('/downloads/')) return serveDownload(p.slice('/downloads'.length), o.downloads)

  const index = path.join(root, 'index.html')
  if (!fs.existsSync(index)) {
    if (o.dev) return new Response(devPage(o.devPort), { headers: { 'content-type': 'text/html; charset=utf-8' } })
    return new Response(`${PRODUCT.displayName}: web app missing (${root})`, { status: 500 })
  }

  const file = p === '/' ? null : safeFile(root, p)
  if (file) {
    const res = new Response(Bun.file(file))
    const h = res.headers
    if (p.startsWith('/assets/')) h.set('cache-control', 'public, max-age=31536000, immutable')
    else if (p.startsWith('/vendor/')) {
      h.set('access-control-allow-origin', '*')
      h.set('cross-origin-resource-policy', 'cross-origin')
      h.set('cache-control', /\/vendor\/(chunk|asset)-[a-z0-9]+\.\w+$/.test(p) ? 'public, max-age=31536000, immutable' : 'no-cache')
    } else if (p === '/sw.js') {
      h.set('cache-control', 'no-cache')
      h.set('service-worker-allowed', '/')
    } else {
      h.set('cache-control', 'no-cache')
      if (p.endsWith('.webmanifest')) h.set('content-type', 'application/manifest+json')
    }
    if (p.endsWith('.html')) h.set('content-security-policy', appCsp(url.host))
    return res
  }
  // a missing hashed asset is a 404, not the app shell (a stale page would otherwise get HTML as JavaScript)
  if (p.startsWith('/assets/') || p.startsWith('/vendor/') || p.startsWith('/icons/')) return new Response('Not found', { status: 404 })
  return new Response(Bun.file(index), {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'content-security-policy': appCsp(url.host) },
  })
}

function serveDownload(sub: string, dir: string | null): Response {
  if (!dir || !fs.existsSync(dir)) return new Response('Not found', { status: 404 })
  const file = safeFile(path.resolve(dir), sub)
  if (!file) return new Response('Not found', { status: 404 })
  const res = new Response(Bun.file(file))
  if (path.basename(file) === 'index.json') {
    res.headers.set('content-type', 'application/json; charset=utf-8')
    res.headers.set('cache-control', 'no-cache')
  } else {
    res.headers.set('content-disposition', `attachment; filename="${path.basename(file).replace(/["\\\r\n]/g, '_')}"`)
    res.headers.set('content-type', 'application/octet-stream')
    res.headers.set('cache-control', 'no-cache')
  }
  return res
}


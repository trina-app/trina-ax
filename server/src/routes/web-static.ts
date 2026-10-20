// Static serving of the built web app for route module "web" (component D), kept free of server context imports so
// the web client's mock server (web/test/mock) serves the build with exactly the same headers.
import fs from 'node:fs'
import path from 'node:path'
import { PRODUCT } from '@mycel/shared'

export const WEB_DEV_URL = 'http://localhost:19140'

const HOST_RE = /^[A-Za-z0-9.\-:[\]]+$/
/** The request's Host when it is a plain host[:port] (never a header value that could add directives). */
export const cleanHost = (host: string | null | undefined): string | null => (host && HOST_RE.test(host) ? host : null)

/**
 * CSP of the app shell (tab 5 "부모 앱 CSP"). No inline scripts, no data:/blob: scripts and no eval: answers, file
 * names and Office previews are drawn into this page, and this policy is the backstop against XSS there. Artifact and
 * HTML / SVG preview frames are not srcdoc documents (those would inherit this policy and need it loosened): they load
 * /sandbox/frame, which has its own policy (frameCsp). 'wasm-unsafe-eval' lets the page compile WebAssembly (sha256 of
 * large uploads), not JavaScript. frame-src 'self': a frame may not navigate to another site inside the app.
 */
export function appCsp(host: string | null): string {
  const h = cleanHost(host)
  const ws = h ? ` wss://${h} ws://${h}` : ''
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // blob: = files the page itself already holds (pdf.js reads the preview's blob URL from its worker)
    `connect-src 'self' blob:${ws}`,
    "media-src 'self' data: blob:",
    "worker-src 'self'",
    "frame-src 'self'",
    "child-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ')
}

/** Path of the fixed receiver document artifact and HTML / SVG preview frames load (tab 5 "아티팩트 격리 규칙"). */
export const SANDBOX_FRAME_PATH = '/sandbox/frame'

/**
 * The policy of everything that runs in a sandbox frame, minus the parts that depend on how it is delivered.
 * web/src/lib/artifacts.ts (artifactCsp) builds the same directives for the meta tag it puts first in every frame
 * document; tests/unit/d-web.test.ts checks the two stay equal.
 */
export function sandboxPolicy(vendor: string[]): string {
  const v = vendor.join(' ')
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' data: blob: ${v}`,
    `style-src 'unsafe-inline' ${v}`,
    'img-src data: blob:',
    `font-src ${v}`,
    "connect-src 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    'media-src data: blob:',
    "base-uri 'none'",
  ].join('; ')
}

/**
 * Response CSP of /sandbox/frame: `sandbox allow-scripts` (an opaque origin even if someone opens the URL directly or
 * frames it without the attribute), the sandbox policy with this server's /vendor/ (the origin the request came in
 * on: relay address or the office address; http and https both, the TLS may end before this server), and only this
 * server may frame it. frame-ancestors also makes browsers ignore the X-Frame-Options: DENY every page gets.
 */
export function frameCsp(host: string): string {
  const origins = [`https://${host}`, `http://${host}`]
  return `sandbox allow-scripts; ${sandboxPolicy(origins.map((o) => `${o}/vendor/`))}; frame-ancestors ${origins.join(' ')}`
}

/**
 * The receiver: a fixed document with no content of its own. It says "ready" to its parent, takes one document from
 * the parent (event.source === parent only) and writes it over itself; the document keeps this response's CSP.
 * Everything the AI or a file wrote arrives only through postMessage, never through the URL.
 */
export const SANDBOX_RECEIVER = `<!doctype html><html><head><meta charset="utf-8"><title></title></head><body><script>
(function () {
  var done = false;
  window.addEventListener("message", function (e) {
    if (done || e.source !== window.parent) return;
    var d = e.data;
    if (!d || d.source !== "mycel-host" || d.type !== "render" || typeof d.html !== "string") return;
    done = true;
    document.open();
    document.write(d.html);
    document.close();
  });
  window.parent.postMessage({ source: "mycel-frame", type: "ready" }, "*");
})();
</script></body></html>`

function serveSandboxFrame(host: string | null): Response {
  const h = cleanHost(host)
  if (!h) return new Response('Bad Host header', { status: 400 })
  return new Response(SANDBOX_RECEIVER, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': frameCsp(h),
      'cache-control': 'no-cache',
      'referrer-policy': 'no-referrer',
      'cross-origin-resource-policy': 'same-origin',
    },
  })
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
  if (p === SANDBOX_FRAME_PATH) return serveSandboxFrame(url.host)

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


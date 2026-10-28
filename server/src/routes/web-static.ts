// Static serving of the built web app for route module "web" (component D), kept free of server context imports so
// the web client's mock server (web/test/mock) serves the build with exactly the same headers.
import fs from 'node:fs'
import path from 'node:path'
import { iconLinks, manifestWithIcon, PRODUCT, TEAM_ICON_PATH, withIconLinks, type TeamIconFile } from '@mycel/shared'

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
 * Everything the AI or a file wrote arrives only through postMessage, never through the URL. A "ping" from the parent
 * gets "ready" again: a parent that missed the first one (its listener came after a fast, cached load) showed an empty
 * frame for good.
 */
export const SANDBOX_RECEIVER = `<!doctype html><html><head><meta charset="utf-8"><title></title></head><body><script>
(function () {
  var done = false;
  window.addEventListener("message", function (e) {
    if (done || e.source !== window.parent) return;
    var d = e.data;
    if (d && d.source === "mycel-host" && d.type === "ping") { window.parent.postMessage({ source: "mycel-frame", type: "ready" }, "*"); return; }
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

const devPage = (port: number) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
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
  dev: boolean
  devPort: number
  /** the team's logo (the server: <data>/team-icon, admin/team-icon.ts; the mock: in memory). Absent or null: the
   * default icon everywhere. */
  teamIcon?: () => TeamIconFile | null
}

// ---------------- the tab icon (shared/src/team-icon.ts) ----------------
/** The policy of the logo and the default icon: an image only, never a document that runs anything. */
export const ICON_CSP = "default-src 'none'; sandbox"
/** /team-icon?v=<the current version> is cached for good; anything else (no or an older version) only briefly */
const ICON_CACHE_LONG = 'public, max-age=31536000, immutable'
const ICON_CACHE_SHORT = 'public, max-age=300'
/** the default when no logo is set: the mark the PWA uses (web/public/icons) */
const DEFAULT_TEAM_ICON = 'icons/icon-512.png'
/**
 * Icon addresses browsers and systems ask for on their own (bookmarks, Safari, Windows, iOS home screen): the logo when
 * one is set, else this default file of the build.
 */
const WELL_KNOWN_ICONS: Record<string, string> = {
  '/favicon.ico': 'favicon.ico',
  '/apple-touch-icon.png': 'icons/apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png': 'icons/apple-touch-icon.png',
}

function iconHeaders(type: string, cache: string): Record<string, string> {
  return {
    'content-type': type,
    'x-content-type-options': 'nosniff',
    'content-security-policy': ICON_CSP,
    'content-disposition': 'inline',
    'cache-control': cache,
    'cross-origin-resource-policy': 'same-origin',
  }
}

/** The logo with its exact type and nothing else about the team (no name, no dates). */
function logoResponse(req: Request, url: URL, icon: TeamIconFile): Response {
  const headers = { ...iconHeaders(icon.type, url.searchParams.get('v') === icon.version ? ICON_CACHE_LONG : ICON_CACHE_SHORT), etag: `"${icon.version}"` }
  if (req.headers.get('if-none-match')?.split(',').some((t) => t.trim().replace(/^W\//, '') === headers.etag)) return new Response(null, { status: 304, headers })
  return new Response(icon.bytes, { headers })
}

/** GET /team-icon: the logo, or the default icon when none is set. */
function serveTeamIcon(req: Request, url: URL, icon: TeamIconFile | null, root: string): Response {
  if (icon) return logoResponse(req, url, icon)
  const file = safeFile(root, '/' + DEFAULT_TEAM_ICON)
  if (!file) return new Response('Not found', { status: 404 })
  return new Response(Bun.file(file), { headers: iconHeaders('image/png', ICON_CACHE_SHORT) })
}

/** A path whose last part has a file extension (a static file, not a page of the app). */
const hasExtension = (p: string) => /\.[A-Za-z0-9]{1,10}$/.test(p.slice(p.lastIndexOf('/') + 1))

/** The handler behind GET * (also used by the web client's mock server in its end-to-end tests). */
export function serveWeb(req: Request, o: WebOptions): Response | null {
  const url = new URL(req.url)
  const p = url.pathname
  if (p === '/api' || p.startsWith('/api/')) return null
  const root = path.resolve(o.dist)

  // desktop installers: routes/downloads.ts (signed-in people only) answers these before this handler runs
  if (p.startsWith('/downloads/')) return new Response('Not found', { status: 404 })
  if (p === SANDBOX_FRAME_PATH) return serveSandboxFrame(url.host)

  // the tab icon: the team's logo when an admin set one (also where browsers look on their own), else the default
  const icon = o.teamIcon?.() ?? null
  if (p === TEAM_ICON_PATH) return serveTeamIcon(req, url, icon, root)
  const wellKnown = WELL_KNOWN_ICONS[p]
  if (wellKnown && icon) return logoResponse(req, url, icon)

  const index = path.join(root, 'index.html')
  if (!fs.existsSync(index)) {
    if (o.dev) return new Response(devPage(o.devPort), { headers: { 'content-type': 'text/html; charset=utf-8' } })
    return new Response(`${PRODUCT.displayName}: web app missing (${root})`, { status: 500 })
  }

  const file = p === '/' || p === '/index.html' ? null : safeFile(root, wellKnown ? '/' + wellKnown : p)
  if (file && p === '/manifest.webmanifest' && icon) {
    // an installed app (PWA) shows the logo too
    let text: string
    try { text = manifestWithIcon(fs.readFileSync(file, 'utf8'), icon) } catch { text = fs.readFileSync(file, 'utf8') }
    return new Response(text, { headers: { 'content-type': 'application/manifest+json', 'cache-control': 'no-cache' } })
  }
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
  // a missing hashed asset is a 404, not the app shell (a stale page would otherwise get HTML as JavaScript); so is any
  // other missing file (favicon.png, robots.txt …): an icon or a crawler must not get the app page as its file
  if (p.startsWith('/assets/') || p.startsWith('/vendor/') || p.startsWith('/icons/') || (hasExtension(p) && p !== '/index.html')) {
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' } })
  }
  // the app shell; with a logo set, its icon links point at it from the first load (browsers keep tab icons long)
  let body: BodyInit = Bun.file(index)
  if (icon) {
    try { body = withIconLinks(fs.readFileSync(index, 'utf8'), iconLinks(icon.version)) } catch { /* the default links */ }
  }
  return new Response(body, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'content-security-policy': appCsp(url.host) },
  })
}

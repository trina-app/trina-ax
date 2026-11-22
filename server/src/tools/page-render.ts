// A web page drawn by its own scripts, for its text: the company profile draft's last try when a site's HTML is an
// empty shell (a Vite or Create React App site, a client-rendered Next.js page). web_fetch calls it (tools/web-fetch.ts,
// the `render` hook) after its own guarded fetch gave almost no text; the result is the drawn page's markup, read like
// any page (htmlToText), its links included.
//
// The browser is HTML to PDF's (files/html-pdf.ts runBrowser: the pinned chrome-headless-shell of
// scripts/system/packages.json, found by findPdfBrowser, in the converters' isolation with no network, as the server
// account, never root, killed with all its processes at the end). The one difference: JavaScript runs, because drawing
// the page is the point. What keeps that safe:
// - The browser reaches nothing by itself: no network in its isolation, a host resolver that resolves nothing, and every
//   request of the page paused (DevTools Fetch) and answered by the server. The page itself is the HTML web_fetch already
//   read (no second fetch), served at its real address so its scripts route as in a browser.
// - Everything else the page asks for is fetched by the server through web_fetch's own guard for that one request
//   (resolveTarget: http(s), ports 80/443, one lookup, public unicast addresses only, not this server's own or its
//   networks, not its public exit addresses; then pinnedRequest to that address): a request to 10.x, 169.254.169.254,
//   localhost or the office network is refused, also when a public name points there. A redirect goes back to the
//   browser, whose next request is checked again.
// - Only GET, HEAD and CORS preflights (no POST: the server never sends a stranger's page's forms or API writes), only
//   scripts, data requests and stylesheets (no pictures, fonts, media, frames, other pages, sockets), no cookies either
//   way, at most RENDER_LIMITS.maxRequests requests and maxBytes bytes.
// - One time limit for the whole render (RENDER_LIMITS.timeoutMs, inside web_fetch's 15 s budget for a thin page), at
//   most RENDER_PARALLEL renders on the server (a busy server skips the render), HTML to PDF's memory and disk limits.
// Without a browser or the isolation (a development Mac without one, a Docker image without bwrap) there is no render:
// renderUnavailable says why and web_fetch goes on with the page's markup and sitemap (tools/page-data.ts).
import path from 'node:path'
import { ToolError } from '../policy/errors'
import { findPdfBrowser, htmlPdfUnavailable, HtmlPdfError, runBrowser, serverFontDirs, type Cdp } from '../files/html-pdf'
import { makeWorkDir } from './isolate'
import { decode, pinnedRequest, precheckTarget, resolveTarget, type ResolveOptions } from './web-fetch'
import fs from 'node:fs'
import os from 'node:os'

export const RENDER_LIMITS = {
  timeoutMs: 10_000,
  maxRequests: 150,
  /** bytes the server fetches for the page in all (decoded) */
  maxBytes: 20 * 1024 * 1024,
  /** one answer */
  maxOneBytes: 5 * 1024 * 1024,
  /** the drawn page's markup taken back */
  maxHtmlChars: 3 * 1024 * 1024,
  maxRssMiB: 1536,
  maxWorkBytes: 256 * 1024 * 1024,
}
export type RenderLimits = typeof RENDER_LIMITS
export const RENDER_PARALLEL = 2
let rendering = 0

/** Why no page is drawn here (null: it can be). */
export function renderUnavailable(env: NodeJS.ProcessEnv = process.env): string | null {
  return htmlPdfUnavailable(env)
}

export interface RenderRequest extends Pick<ResolveOptions, 'lookup' | 'testAllow' | 'blockedIps'> {
  /** the page's address (after web_fetch's redirects) and the HTML web_fetch read there */
  url: string
  html: string
  contentType?: string
  acceptLanguage?: string
  /** where the work folder is made (the server's data folder, as for HTML to PDF; default: the system's temporary folder) */
  workBase?: string
  signal?: AbortSignal
  limits?: Partial<RenderLimits>
  /** tests only: the test server's self-signed certificate */
  insecureTlsForTests?: boolean
  browser?: string | null
}

/** Request types the page may load: its scripts, its data requests and stylesheets (the text depends on them). */
const ALLOWED_TYPES = new Set(['Script', 'XHR', 'Fetch', 'Stylesheet', 'Preflight'])
/** Request headers never passed on: the connection's own, cookies, and what the server sets itself. */
const DROP_REQUEST = /^(?:host|connection|keep-alive|proxy-.*|te|trailer|transfer-encoding|upgrade|content-length|cookie|cookie2|expect|accept-encoding|sec-.*|priority)$/i
/** Answer headers never handed to the browser: cookies, the body's encoding (the body is decoded), the connection's. */
const DROP_RESPONSE = /^(?:set-cookie|set-cookie2|content-encoding|content-length|transfer-encoding|connection|keep-alive|alt-svc|strict-transport-security|public-key-pins.*|report-to|nel|clear-site-data)$/i
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** The page as its scripts draw it (its markup), or null when it could not be drawn (no browser, busy, a failure: web_fetch
 * goes on without it). Never throws. */
export async function renderPage(req: RenderRequest): Promise<string | null> {
  const L = { ...RENDER_LIMITS, ...req.limits }
  const browser = req.browser === undefined ? (renderUnavailable() ? null : findPdfBrowser()) : req.browser
  if (!browser || req.signal?.aborted) return null
  if (rendering >= RENDER_PARALLEL) return null
  rendering++
  let work: string | null = null
  try {
    work = makeWorkDir(path.join(req.workBase ?? os.tmpdir(), 'work'))
    const { value } = await runBrowser(work, {
      browser, fonts: serverFontDirs(), signal: req.signal, limits: { timeoutMs: L.timeoutMs + 2_000, maxRssMiB: L.maxRssMiB, maxWorkBytes: L.maxWorkBytes }, scripts: true,
      maxMessage: 4 * L.maxHtmlChars + 4 * 1024 * 1024, tooLarge: () => new HtmlPdfError('protocol', 'the drawn page is too large'),
      timeoutText: 'the page took too long to draw', memoryText: 'the page needs too much memory to draw',
    }, (cdp, race) => drawPage(cdp, race, req, L))
    return value
  } catch {
    return null
  } finally {
    rendering--
    if (work) fs.rmSync(work, { recursive: true, force: true })
  }
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function drawPage(cdp: Cdp, race: <T>(x: Promise<T>) => Promise<T>, req: RenderRequest, L: RenderLimits): Promise<string | null> {
  const deadline = Date.now() + L.timeoutMs
  const pageUrl = new URL(req.url)
  pageUrl.hash = ''
  let pageServed = false
  let requests = 0, bytes = 0
  const life = new Map<string, Set<string>>()
  cdp.on('Page.lifecycleEvent', (e: { name: string; loaderId: string }) => { const s = life.get(e.loaderId) ?? new Set(); s.add(e.name); life.set(e.loaderId, s) })
  const { targetId } = await race(cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' }))
  const { sessionId } = await race(cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true }))
  const s = <T = unknown>(method: string, params: Record<string, unknown> = {}) => race(cdp.send<T>(method, params, sessionId))
  // a page's alert() or confirm() would stop it: dismissed
  cdp.on('Page.javascriptDialogOpening', () => { void cdp.send('Page.handleJavaScriptDialog', { accept: false }, sessionId).catch(() => {}) })
  cdp.on('Fetch.requestPaused', (e: { requestId: string; request: { url: string; method: string; headers: Record<string, string> }; resourceType: string }, sid) => {
    const refuse = (reason = 'BlockedByClient') => cdp.send('Fetch.failRequest', { requestId: e.requestId, errorReason: reason }, sid)
    const answer = async (): Promise<unknown> => {
      let url: URL
      try { url = new URL(e.request.url) } catch { return refuse() }
      url.hash = ''
      if (e.resourceType === 'Document') {
        // the page itself, once (a script that sends the window elsewhere, a frame, a reload: nothing)
        if (pageServed || url.href !== pageUrl.href || e.request.method !== 'GET') return refuse('Aborted')
        pageServed = true
        const ct = req.contentType && /html/i.test(req.contentType) ? req.contentType : 'text/html; charset=utf-8'
        const body = Buffer.from(req.html, 'utf8')
        return cdp.send('Fetch.fulfillRequest', { requestId: e.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: /charset/i.test(ct) ? ct.replace(/charset\s*=\s*["']?[\w-]+/i, 'charset=utf-8') : `${ct}; charset=utf-8` }, { name: 'Cache-Control', value: 'no-store' }], body: body.toString('base64') }, sid)
      }
      if (!ALLOWED_TYPES.has(e.resourceType)) return refuse()
      const method = e.request.method.toUpperCase()
      if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') return refuse()
      if (++requests > L.maxRequests || bytes >= L.maxBytes || Date.now() >= deadline) return refuse()
      // web_fetch's guard for this one request: the name rules, one lookup, public addresses only
      const guard = { lookup: req.lookup, testAllow: req.testAllow, blockedIps: req.blockedIps, deadline }
      let r
      try {
        precheckTarget(url.href, guard)
        const t = await resolveTarget(url.href, guard)
        const headers: [string, string][] = []
        for (const [k, v] of Object.entries(e.request.headers ?? {})) {
          if (DROP_REQUEST.test(k) || !TOKEN.test(k) || /[\r\n\0]/.test(String(v))) continue
          headers.push([k, String(v)])
        }
        headers.push(['Accept-Encoding', 'gzip, deflate, br'])
        if (req.acceptLanguage && !headers.some(([k]) => k.toLowerCase() === 'accept-language')) headers.push(['Accept-Language', req.acceptLanguage])
        r = await pinnedRequest(t, { method, headers, deadline, maxBytes: Math.min(L.maxOneBytes, L.maxBytes - bytes), insecureTlsForTests: req.insecureTlsForTests })
      } catch (err) {
        if (!(err instanceof ToolError)) throw err
        return refuse(/did not answer|stopped sending/.test(err.message) ? 'TimedOut' : 'AddressUnreachable')
      }
      if (r.truncated) return refuse()
      const { data, truncated } = await decode(r.body, r.headers['content-encoding'], L.maxOneBytes).catch(() => ({ data: Buffer.alloc(0), truncated: true }))
      if (truncated) return refuse()
      bytes += data.length
      const responseHeaders = Object.entries(r.headers).filter(([k]) => !DROP_RESPONSE.test(k)).map(([name, value]) => ({ name, value }))
      return cdp.send('Fetch.fulfillRequest', { requestId: e.requestId, responseCode: r.status, responseHeaders, body: data.toString('base64') }, sid)
    }
    answer().catch(() => { void refuse().catch(() => {}) })
  })
  await race(cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {}))
  await s('Page.enable')
  await s('Page.setLifecycleEventsEnabled', { enabled: true })
  // no cookies kept between requests either (none come back: DROP_RESPONSE)
  await s('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
  if (req.acceptLanguage) await s('Emulation.setLocaleOverride', { locale: req.acceptLanguage.split(',')[0]! }).catch(() => {})
  const nav = await s<{ errorText?: string; loaderId?: string }>('Page.navigate', { url: pageUrl.href })
  if (nav.errorText || !nav.loaderId) return null
  const has = (name: string) => life.get(nav.loaderId!)?.has(name) ?? false
  // drawn: loaded, then the network quiet (its data requests answered), or the time is up
  while (!has('load') && Date.now() < deadline) await race(wait(50))
  while (!has('networkIdle') && Date.now() < deadline) await race(wait(50))
  // a moment for the last data to be drawn
  await race(wait(Math.max(0, Math.min(300, deadline - Date.now()))))
  const r = await s<{ result?: { value?: unknown } }>('Runtime.evaluate', {
    expression: `(() => { const h = document.documentElement ? document.documentElement.outerHTML : ''; return h.length > ${L.maxHtmlChars} ? h.slice(0, ${L.maxHtmlChars}) : h })()`,
    returnByValue: true, timeout: 2_000,
  })
  const html = r.result?.value
  return typeof html === 'string' && html ? html : null
}

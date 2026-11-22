// The AI's web page opened in a browser before it says it is done (scenario QA S-102: a dashboard opened blank with
// "Uncaught SyntaxError: Identifier 'top' has already been declared" and the AI said it was done without opening it).
// The artifact tool (tools/index.ts) calls checkPage after it saved an `html` page; what the page throws, logs as an
// error or fails to load, and whether it shows anything at all, goes back to the AI in the tool's result.
//
// The browser is HTML to PDF's (files/html-pdf.ts runBrowser: the pinned chrome-headless-shell of
// scripts/system/packages.json, found by findPdfBrowser, in the converters' isolation with no network, as the server
// account, never root, killed with all its processes at the end), with JavaScript on as for tools/page-render.ts:
// running the page is the point. What keeps that safe:
// - The browser reaches nothing by itself: no network in its isolation, a host resolver that resolves nothing, and every
//   request of the page paused (DevTools Fetch) and answered here, with what the panel's preview gives the page
//   (web/src/lib/artifacts.ts artifactCsp, frame-files.ts, frame-scripts.ts): the page itself once, at a reserved address
//   that never resolves; team pictures the person may read (the caller's `asset`: their permissions and the
//   quarantine), and in a shared chat only a grey placeholder for each (the page's script could otherwise copy another
//   person's picture into an error the AI reads out in the chat); team script files only where the preview runs them
//   too (`scripts`: not in a shared chat, frame-scripts.ts withhold); this server's /vendor/ libraries. Nothing else: no
//   web address, no team stylesheet or font (the preview's CSP allows neither), no data request (connect-src 'none'),
//   no other page or frame; each such load is told to the AI as a problem of the page.
// - One time limit for the whole check, PAGE_CHECK_MS with the browser's start (then "could not check"); it takes one
//   of HTML to PDF's print slots without waiting (tryRenderSlot): a busy server skips the check.
// What it does not cover: React artifacts (compiled in the person's browser), a phone-width layout, and how the page
// looks (no picture).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findPdfBrowser, htmlPdfUnavailable, HtmlPdfError, runBrowser, serverFontDirs, tryRenderSlot, type Cdp } from '../files/html-pdf'
import { makeWorkDir } from './isolate'

/** the whole check, the browser's start included */
export const PAGE_CHECK_MS = 5_000
/** problems told to the AI at most, and the length of each */
export const PAGE_CHECK_MAX_PROBLEMS = 10
const PROBLEM_CHARS = 300
/** the page's address in the browser: a reserved name (RFC 2606) that never resolves */
export const CHECK_ORIGIN = 'https://page-check.invalid'

export type AssetKind = 'image' | 'style' | 'font' | 'script'
export interface PageCheckRequest {
  html: string
  /** A team file the page refers to (its team path, decoded), or null when the person may not use it: a picture, or a
   * script while `shared` is false */
  asset: (teamPath: string, maxBytes: number, kind: AssetKind) => Buffer | null | Promise<Buffer | null>
  /** this server's /vendor/ library of that name (web/dist/vendor), or null */
  vendor?: (name: string) => Buffer | null | Promise<Buffer | null>
  /** a chat other people see (or one whose kind is not known): no team scripts, and pictures only as placeholders */
  shared: boolean
  workBase?: string
  signal?: AbortSignal
  timeoutMs?: number
  /** tests: the browser to use (null: none) */
  browser?: string | null
}
export type PageCheck =
  | { status: 'checked'; problems: string[]; more: number; empty: boolean; textChars: number; ms: number }
  | { status: 'unchecked'; reason: string }

const MIME: Record<string, [string, AssetKind]> = {
  png: ['image/png', 'image'], jpg: ['image/jpeg', 'image'], jpeg: ['image/jpeg', 'image'], gif: ['image/gif', 'image'], webp: ['image/webp', 'image'],
  avif: ['image/avif', 'image'], svg: ['image/svg+xml', 'image'], ico: ['image/x-icon', 'image'], bmp: ['image/bmp', 'image'],
  css: ['text/css', 'style'], woff: ['font/woff', 'font'], woff2: ['font/woff2', 'font'], ttf: ['font/ttf', 'font'], otf: ['font/otf', 'font'],
  js: ['text/javascript', 'script'], mjs: ['text/javascript', 'script'], cjs: ['text/javascript', 'script'],
}
const VENDOR_MIME: Record<string, string> = { js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', woff2: 'font/woff2', woff: 'font/woff', json: 'application/json', wasm: 'application/wasm' }
/** the preview's grey box for a picture it may not show (web/src/lib/frame-files.ts PLACEHOLDER) */
/** Base64 of a file's bytes in pieces, yielding between them, so a large picture or script does not hold the server
 * while it is encoded (review of batch 3, #379). Pieces are a multiple of 3 bytes: joined, they are the whole's base64. */
async function base64(b: Buffer): Promise<string> {
  const PIECE = 3 * 1024 * 1024
  if (b.length <= PIECE) return b.toString('base64')
  const out: string[] = []
  for (let i = 0; i < b.length; i += PIECE) {
    out.push(b.subarray(i, i + PIECE).toString('base64'))
    await new Promise((r) => setImmediate(r))
  }
  return out.join('')
}
const PLACEHOLDER_B64 = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' width='160' height='120' viewBox='0 0 160 120'><rect width='160' height='120' fill='#e7e5e4'/></svg>").toString('base64')
const ASSET_BYTES = 10 * 1024 * 1024
const ASSETS_BYTES = 40 * 1024 * 1024
const MAX_REQUESTS = 300

/** The page's own folder in the browser: a relative path in the page resolves under it and means a team path from the
 * root (an artifact has no folder: web/src/lib/frame-files.ts), so "vendor/x.js" stays a team path while "/vendor/x.js"
 * is this server's library, as in the preview (frame-scripts.ts) */
export const PAGE_DIR = '/~page/'
/** The preview's policy for the page (web/src/lib/artifacts.ts artifactCsp, an opaque origin: sandbox allow-scripts),
 * with the sources opened so that every load reaches the interception below, which answers or reports it: no eval or
 * new Function, no storage or cookies, no workers or frames, as in the panel. */
export const CHECK_CSP = [
  "default-src 'none'", "script-src 'unsafe-inline' data: blob: *", "style-src 'unsafe-inline' *", 'img-src * data: blob:', 'font-src *',
  'connect-src *', "form-action 'none'", "frame-src 'none'", "child-src 'none'", "worker-src 'none'", "manifest-src 'none'", 'media-src * data: blob:', "base-uri 'none'",
].join('; ')

/** What an address of CHECK_ORIGIN names: a team path (decoded; never above the team root), this server's library
 * (`vendor: true`), or null. */
export function checkPathOf(url: string): { path: string; vendor: boolean } | null {
  let u: URL
  try { u = new URL(url) } catch { return null }
  if (u.origin !== CHECK_ORIGIN || u.username || u.password) return null
  const inPage = u.pathname.startsWith(PAGE_DIR)
  const vendor = !inPage && u.pathname.startsWith('/vendor/')
  const segs: string[] = []
  for (const s of (inPage ? u.pathname.slice(PAGE_DIR.length) : vendor ? u.pathname.slice('/vendor/'.length) : u.pathname).split('/')) {
    if (!s) continue
    let d: string
    try { d = decodeURIComponent(s) } catch { return null }
    if (d === '.' || d === '..' || d.includes('/') || d.includes('\\') || /[\u0000-\u001f]/.test(d)) return null
    segs.push(d)
  }
  return segs.length ? { path: segs.join('/'), vendor } : null
}

const clip = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > PROBLEM_CHARS ? `${t.slice(0, PROBLEM_CHARS - 1)}…` : t
}
const shortUrl = (u: string) => (u.startsWith(CHECK_ORIGIN) ? u.slice(CHECK_ORIGIN.length + 1) || '/' : u.length > 120 ? `${u.slice(0, 119)}…` : u)

/** Why no page is checked here (null: it can be). */
export const pageCheckUnavailable = (env: NodeJS.ProcessEnv = process.env): string | null => htmlPdfUnavailable(env)?.replace(/, so HTML (?:cannot be|is not) printed to PDF here$/, '').replace(/ to print HTML to PDF/, ' to open pages') ?? null

let checks = 0

/** Open the page in the locked-down browser and say what went wrong. Never throws. */
export async function checkPage(req: PageCheckRequest): Promise<PageCheck> {
  const started = Date.now()
  const timeoutMs = req.timeoutMs ?? PAGE_CHECK_MS
  const browser = req.browser === undefined ? (pageCheckUnavailable() ? null : findPdfBrowser()) : req.browser
  if (!browser) return { status: 'unchecked', reason: pageCheckUnavailable() ?? 'no headless browser is installed on this server' }
  if (req.signal?.aborted) return { status: 'unchecked', reason: 'the answer was stopped' }
  const release = tryRenderSlot(`page-check:${++checks}`)
  if (!release) return { status: 'unchecked', reason: 'the server is busy printing other pages' }
  let work: string | null = null
  try {
    work = makeWorkDir(path.join(req.workBase ?? os.tmpdir(), 'work'))
    const { value } = await runBrowser(work, {
      browser, fonts: serverFontDirs(), signal: req.signal, limits: { timeoutMs, maxRssMiB: 1536, maxWorkBytes: 256 * 1024 * 1024 }, scripts: true,
      maxMessage: 4 * Buffer.byteLength(req.html) + 8 * 1024 * 1024, tooLarge: () => new HtmlPdfError('protocol', 'the page sent too much to the check'),
      timeoutText: `it took longer than ${Math.round(timeoutMs / 1000)} s`, memoryText: 'the page needs too much memory',
    }, (cdp, race) => openPage(cdp, race, req, started + timeoutMs))
    return { ...value, ms: Date.now() - started }
  } catch (e) {
    return { status: 'unchecked', reason: e instanceof HtmlPdfError ? e.message : 'the browser failed' }
  } finally {
    release()
    if (work) fs.rmSync(work, { recursive: true, force: true })
  }
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** what the page shows once loaded: its text and the pictures, drawings and controls with an area */
const LOOK = `(() => {
  const b = document.body
  const text = b ? (b.innerText || '').replace(/\\s+/g, ' ').trim().length : 0
  let visual = 0
  for (const el of document.querySelectorAll('img,svg,canvas,video,input,button,select,textarea,iframe,object,embed')) {
    const r = el.getBoundingClientRect()
    if (r.width * r.height < 16) continue
    const s = getComputedStyle(el)
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) continue
    visual++
    if (visual > 3) break
  }
  return { text, visual }
})()`

async function openPage(cdp: Cdp, race: <T>(x: Promise<T>) => Promise<T>, req: PageCheckRequest, deadline: number): Promise<Omit<Extract<PageCheck, { status: 'checked' }>, 'ms'>> {
  const pageUrl = `${CHECK_ORIGIN}${PAGE_DIR}`
  const problems: string[] = []
  let total = 0
  const add = (p: string) => {
    const c = clip(p)
    if (!c || problems.includes(c)) return
    total++
    if (problems.length < PAGE_CHECK_MAX_PROBLEMS) problems.push(c)
  }
  let sessionId = ''
  let pageServed = false
  let requests = 0
  let assetBytes = 0
  const webPictures = new Set<string>()
  const life = new Map<string, Set<string>>()
  cdp.on('Page.lifecycleEvent', (e: { name: string; loaderId: string }, sid) => { if (sid !== sessionId) return; const s = life.get(e.loaderId) ?? new Set(); s.add(e.name); life.set(e.loaderId, s) })
  // an uncaught error: "Uncaught SyntaxError: Identifier 'top' has already been declared (line 120)"
  cdp.on('Runtime.exceptionThrown', (e: { exceptionDetails?: { text?: string; lineNumber?: number; url?: string; exception?: { description?: string } } }, sid) => {
    if (sid !== sessionId) return
    const d = e.exceptionDetails ?? {}
    const what = (d.exception?.description ?? '').split('\n')[0] || d.text || 'an error'
    const where = typeof d.lineNumber === 'number' ? ` (line ${d.lineNumber + 1}${d.url && d.url !== pageUrl ? ` of ${shortUrl(d.url)}` : ''})` : ''
    add(`${/^Uncaught\b/.test(what) ? '' : 'Uncaught '}${what}${where}`)
  })
  cdp.on('Runtime.consoleAPICalled', (e: { type?: string; args?: { value?: unknown; description?: string }[] }, sid) => {
    if (sid !== sessionId || (e.type !== 'error' && e.type !== 'assert')) return
    add(`console.error: ${(e.args ?? []).map((a) => (typeof a.value === 'string' ? a.value : a.description ?? (a.value === undefined ? '' : JSON.stringify(a.value)))).join(' ')}`)
  })
  // a page's alert() or confirm() would stop it: dismissed
  cdp.on('Page.javascriptDialogOpening', () => { void cdp.send('Page.handleJavaScriptDialog', { accept: false }, sessionId).catch(() => {}) })
  cdp.on('Fetch.requestPaused', (e: { requestId: string; request: { url: string; method: string }; resourceType: string }, sid) => {
    const refuse = (reason = 'BlockedByClient') => cdp.send('Fetch.failRequest', { requestId: e.requestId, errorReason: reason }, sid).catch(() => {})
    const answer = async (): Promise<unknown> => {
      const url = e.request.url
      if (e.resourceType === 'Document') {
        if (pageServed || url !== pageUrl) return refuse('Aborted')
        pageServed = true
        return cdp.send('Fetch.fulfillRequest', { requestId: e.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }, { name: 'Cache-Control', value: 'no-store' }, { name: 'Content-Security-Policy', value: CHECK_CSP }, { name: 'Content-Security-Policy', value: 'sandbox allow-scripts' }], body: Buffer.from(req.html, 'utf8').toString('base64') }, sid)
      }
      const at = checkPathOf(url)
      // Chromium asks for /favicon.ico by itself: nothing the page did
      if (at && !at.vendor && at.path === 'favicon.ico' && !url.includes(PAGE_DIR)) return refuse()
      const team = at && !at.vendor ? at.path : null
      if (++requests > MAX_REQUESTS || e.request.method !== 'GET') return refuse()
      // (the page's origin is opaque, as the preview's sandbox makes it: a module script needs the CORS header)
      const fulfill = (mime: string, b64: string) => cdp.send('Fetch.fulfillRequest', { requestId: e.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: mime }, { name: 'X-Content-Type-Options', value: 'nosniff' }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: b64 }, sid)
      const dataRequest = e.resourceType === 'XHR' || e.resourceType === 'Fetch' || e.resourceType === 'EventSource' || e.resourceType === 'WebSocket'
      // this server's libraries for pages (/vendor/: the preview's CSP allows them)
      if (at?.vendor) {
        let b: Buffer | null = null
        try { b = (await req.vendor?.(at.path)) ?? null } catch { b = null }
        const mime = VENDOR_MIME[/\.([a-z0-9]+)$/i.exec(at.path)?.[1]?.toLowerCase() ?? '']
        if (!b || !mime) { add(`/vendor/${at.path} does not load: this server has no such library`); return refuse() }
        return fulfill(mime, await base64(b))
      }
      if (team === null) {
        // the preview loads nothing from the web either: a script, stylesheet or font there is a problem the AI can fix;
        // a web picture shows as the preview's grey box (counted, one line)
        if (e.resourceType === 'Image' || e.resourceType === 'Media') { if (/^https?:/i.test(url)) webPictures.add(url); return refuse() }
        if (dataRequest) add(`a data request to ${shortUrl(url)} was refused: the preview lets a page fetch nothing (put the data inside the page)`)
        else if (e.resourceType === 'Script' || e.resourceType === 'Stylesheet' || e.resourceType === 'Font') add(`the ${e.resourceType === 'Script' ? 'script' : e.resourceType === 'Font' ? 'font' : 'stylesheet'} ${shortUrl(url)} does not load: the preview reaches no web address (${e.resourceType === 'Script' ? 'save the file into the team folder with save_url and use its team path' : 'put the CSS inside the page in a <style> element'})`)
        return refuse()
      }
      if (dataRequest) { add(`a data request to ${team} was refused: the preview lets a page fetch nothing (put the data inside the page)`); return refuse() }
      // a team clip: the preview puts it in as data; nothing a check needs (not reported)
      if (e.resourceType === 'Media') return refuse()
      const ext = /\.([a-z0-9]+)$/i.exec(team)?.[1]?.toLowerCase() ?? ''
      const m = MIME[ext]
      const kind = m?.[1]
      if (e.resourceType === 'Image' && kind === 'image') {
        if (req.shared) return fulfill('image/svg+xml', PLACEHOLDER_B64)
      } else if (e.resourceType === 'Script' && kind === 'script') {
        if (req.shared) { add(`the team script ${team} does not run in a shared chat's preview: put the script inside the page`); return refuse() }
      } else {
        add(kind === 'style' || kind === 'font'
          ? `the team ${kind === 'style' ? 'stylesheet' : 'font'} ${team} does not load in the preview: put the CSS inside the page in a <style> element`
          : `${team} does not load in the preview (only team pictures and script files)`)
        return refuse()
      }
      let bytes: Buffer | null = null
      try { bytes = await req.asset(team, ASSET_BYTES, kind!) } catch { bytes = null }
      if (!bytes || assetBytes + bytes.length > ASSETS_BYTES) {
        if (kind === 'image') return fulfill('image/svg+xml', PLACEHOLDER_B64)
        add(`${team} does not load: it is not in the team folder, or this person cannot open it`)
        return refuse()
      }
      assetBytes += bytes.length
      return fulfill(m![0], await base64(bytes))
    }
    answer().catch(() => { void refuse() })
  })
  const { targetId } = await race(cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' }))
  sessionId = (await race(cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true }))).sessionId
  const s = <T = unknown>(method: string, params: Record<string, unknown> = {}) => race(cdp.send<T>(method, params, sessionId))
  await race(cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {}))
  await s('Page.enable')
  await s('Page.setLifecycleEventsEnabled', { enabled: true })
  await s('Runtime.enable')
  await s('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }).catch(() => {})
  await s('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
  const nav = await s<{ errorText?: string; loaderId?: string }>('Page.navigate', { url: pageUrl })
  if (nav.errorText || !nav.loaderId) throw new HtmlPdfError('browser', `the page did not open (${nav.errorText ?? 'no document'})`)
  const has = (name: string) => life.get(nav.loaderId!)?.has(name) ?? false
  // loaded (its scripts ran), then a moment for what they start (timers, a first frame), within the time limit
  const leave = () => deadline - Date.now() - 400
  while (!has('load') && leave() > 0) await race(wait(25))
  // the browser ran and the page never finished loading: a problem of the page (a script in an endless loop, a load
  // that never ends), told as one; its main thread may be stuck, so nothing more is asked of it
  if (!has('load')) {
    add('the page did not finish loading within the check\'s few seconds: a script may be stuck in a loop, or something it loads never ends')
    return { status: 'checked', problems, more: Math.max(0, total - problems.length), empty: false, textChars: 0 }
  }
  await race(wait(Math.max(0, Math.min(500, leave()))))
  const r = await s<{ result?: { value?: { text?: number; visual?: number } } }>('Runtime.evaluate', { expression: LOOK, returnByValue: true, timeout: 1_000 })
  const look = r.result?.value ?? {}
  const textChars = Number(look.text ?? 0)
  if (webPictures.size) add(`${webPictures.size} picture${webPictures.size === 1 ? '' : 's'} from web addresses show as grey boxes in the preview (save each with save_url and use its team path), e.g. ${shortUrl([...webPictures][0]!)}`)
  return { status: 'checked', problems, more: Math.max(0, total - problems.length), empty: textChars === 0 && !Number(look.visual ?? 0), textChars }
}

/** The check as the AI reads it after "saved as version N". */
export function pageCheckText(c: PageCheck): string {
  if (c.status === 'unchecked') return `Not checked in a browser (${c.reason}). Do not say you opened or checked the page; say it was not checked, or ask the person to look.`
  if (!c.problems.length && !c.empty) return `Opened in a browser: no errors, and it shows ${c.textChars} characters of text.`
  const lines = [
    ...(c.empty ? ['- The page shows nothing: no text, picture, drawing or control after it loaded (people see a blank page).'] : []),
    ...c.problems.map((p) => `- ${p}`),
    ...(c.more ? [`- (${c.more} more)`] : []),
  ]
  return `Opened in a browser, and it has problems people will see:\n${lines.join('\n')}\nFix them on this key (update or rewrite: each fix is checked again) before you tell the person it is done; never say it works while these remain.`
}

/** The check in the audit line (tool_events). */
export const pageCheckSummary = (c: PageCheck): string => (c.status === 'unchecked' ? 'check skipped' : c.empty ? `check empty${c.problems.length ? ` errors ${c.problems.length + c.more}` : ''}` : c.problems.length ? `check errors ${c.problems.length + c.more}` : 'check ok')

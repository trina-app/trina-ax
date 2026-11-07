// HTML -> PDF, printed by a headless Chromium on the team server exactly as a browser prints the page (docs/DECISIONS.md
// "HTML to PDF"): make_file with an .html `source` and format pdf (tools/make-file.ts), and the file preview's
// "PDF로 저장" (POST /api/files/html-pdf, team-files/html-pdf-save.ts). Backgrounds and colours on, the page's own
// `@page` size and margins (A4 when it names none), its page breaks, merged cells, the server's Korean fonts.
//
// The page is untrusted (a file from the web, an email, another person), so the browser is locked down in layers:
// - It runs in the converters' isolation (tools/isolate.ts): sandbox-exec with no network on macOS, bwrap with its own
//   empty network namespace on Linux (inside the converter cgroup in production), as the server account, never root.
//   Its only writable place is an empty work folder; it reads neither the team folder nor the server's data.
// - It never loads anything by itself. The page is served from a made-up origin (ORIGIN, the reserved .invalid name)
//   through the DevTools protocol's Fetch interception: the server answers every request. The page's own address gives
//   the page; a path under it gives a team file only when it is an image, a stylesheet or a font and `asset()` (the
//   caller: the person's normal authorize path) gives it. Everything else is refused: other origins, localhost and the
//   server's own API, file:, a path that leaves the person's access. data: and blob: stay (they load nothing).
// - The host resolver resolves nothing (`MAP * ~NOTFOUND`), so not even a host name leaves (link hints, prefetch).
// - The page gets a CSP that allows only ORIGIN, data: and blob:, no scripts, frames only from ORIGIN, no forms.
// - JavaScript is off (`scriptEnabled=false`, Emulation.setScriptExecutionDisabled, CSP script-src 'none'): a quote or a
//   report is HTML and CSS; scripts are the browser's largest attack surface (V8) and could only add content the server
//   cannot check. A page that has scripts is still printed; the result says they did not run.
// - Limits (HTML_PDF_LIMITS): one render per person at a time and renderParallel() on the server (one more per person
//   may wait, QUEUE_MAX in all), a time limit for the whole render, memory and disk limits for the browser, at most
//   200 pages (one page more is asked for, so a longer page is refused, not cut), at most 50 MB of PDF, make_file's image
//   limits for the page's files, and a budget for every byte and request the server answers (repeats counted).
// - Only a browser in a folder nobody else can change (trustedBrowser), and never as root.
// The browser is found, not shipped (findPdfBrowser): an explicit MYCEL_HTML_PDF_BROWSER, the promo video's
// chrome-headless-shell (HYPERFRAMES_BROWSER_PATH, or the one its CLI fetched on a development Mac), or Debian's
// chromium (the hosted image and a server with the dev environment have it: scripts/dev-env/srt/install-srt.sh).
// Without one, HTML -> PDF is not offered and says why.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { REPO_ROOT } from '../app-config'
import { bundledFontDir } from '../config'
import { dirBytes, isolatedCommand, isolation, makeWorkDir, treeRssKiB } from '../tools/isolate'
import { converterCgroup } from '../system/cgroups'
import { killTree } from '../system/kill-tree'

/** The address the page has in the browser: a reserved name (RFC 2606) that never resolves. */
export const ORIGIN = 'https://html-pdf.invalid'
export const HTML_PDF_LIMITS = {
  timeoutMs: 60_000,
  maxPages: 200,
  maxPdfBytes: 50 * 1024 * 1024,
  maxHtmlBytes: 10 * 1024 * 1024,
  maxAssets: 200,
  maxAssetBytes: 20 * 1024 * 1024,
  maxAssetsBytes: 100 * 1024 * 1024,
  /** bytes handed to the browser in all, every repeat of a file counted (the page asking for one picture under many
   * addresses), and the requests answered */
  maxSentBytes: 200 * 1024 * 1024,
  maxRequests: 2_000,
  /** the browser's processes' resident memory added up (shared pages count once per process: about twice what they
   * really use, measured with Debian's chromium); in production the converter cgroup's memory.max is the real limit */
  maxRssMiB: 2048,
  /** the work folder (the browser's profile and temporary files) */
  maxWorkBytes: 256 * 1024 * 1024,
}
export type HtmlPdfLimits = typeof HTML_PDF_LIMITS
/** renders running at the same time on the server at most; more wait */
export const RENDER_PARALLEL = 2
/** Measured on Debian 13 (a 12-page table, PSS of all its processes): chromium about 500 MiB, chromium-headless-shell
 * about 240 MiB. In production the converters share one cgroup (system/cgroups.ts, 512–1536 MiB), so a small budget
 * prints one page at a time. */
export const renderParallel = (): number => {
  const conv = converterCgroup()
  return conv ? Math.max(1, Math.min(RENDER_PARALLEL, Math.floor(conv.memoryMiB / 768))) : RENDER_PARALLEL
}
/** renders waiting; more are refused as busy */
export const QUEUE_MAX = 10
const WAIT_MAX_MS = 120_000

/** What a page may load from the team folder, by extension: pictures, stylesheets and fonts. Never another page, a
 * script or a document (an iframe of another team file would print it). */
const ASSET_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp',
  ico: 'image/x-icon', svg: 'image/svg+xml', css: 'text/css', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
}
export const assetMime = (p: string): string | null => {
  const m = /\.([a-z0-9]+)$/i.exec(p)
  return m ? ASSET_MIME[m[1]!.toLowerCase()] ?? null : null
}

/** The page's own CSP (a second layer under the interception): only ORIGIN, data: and blob:, no scripts, no forms.
 * Pictures from anywhere reach the interception, which answers them with the preview's grey placeholder (never the
 * network), so the PDF shows what the file preview shows (web/src/lib/frame-files.ts) and not a broken-image mark. */
export const PAGE_CSP = [
  "default-src 'none'", 'img-src * data: blob:', `style-src ${ORIGIN} 'unsafe-inline'`, `font-src ${ORIGIN} data: blob:`,
  `media-src ${ORIGIN} data: blob:`, `frame-src ${ORIGIN}`, "script-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
  "connect-src 'none'", "worker-src 'none'", "manifest-src 'none'",
].join('; ')

/** The grey box with a picture mark that stands in for a picture the page may not have (the file preview's
 * PLACEHOLDER, web/src/lib/frame-files.ts) */
export const PLACEHOLDER_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='160' height='120' viewBox='0 0 160 120'><rect width='160' height='120' fill='#e7e5e4'/>" +
  "<circle cx='66' cy='48' r='7' fill='#a8a29e'/><path d='M52 82l18-22 12 14 9-10 17 18z' fill='#a8a29e'/></svg>"
const PLACEHOLDER_B64 = Buffer.from(PLACEHOLDER_SVG).toString('base64')

export class HtmlPdfError extends Error {
  constructor(public code: 'unavailable' | 'busy' | 'timeout' | 'pages' | 'too_large' | 'memory' | 'aborted' | 'browser' | 'html_too_large', message: string) { super(message) }
}

// ---------------- finding the browser ----------------

const isExe = (p: string | undefined | null): p is string => { try { return !!p && fs.statSync(p).isFile() && (fs.accessSync(p, fs.constants.X_OK), true) } catch { return false } }

/** The newest chrome-headless-shell the promo video's HyperFrames CLI fetched (~/.cache/hyperframes/chrome). */
function hyperframesBrowser(home: string): string | null {
  const root = path.join(home, '.cache', 'hyperframes', 'chrome', 'chrome-headless-shell')
  let builds: string[]
  try { builds = fs.readdirSync(root).sort().reverse() } catch { return null }
  for (const b of builds) {
    let inner: string[]
    try { inner = fs.readdirSync(path.join(root, b)) } catch { continue }
    for (const d of inner) {
      const p = path.join(root, b, d, 'chrome-headless-shell')
      if (isExe(p)) return p
    }
  }
  return null
}

/**
 * The Chromium that prints HTML, or null. In this order: MYCEL_HTML_PDF_BROWSER (an admin's or a test's choice;
 * "none" turns it off), HYPERFRAMES_BROWSER_PATH (the promo video's chrome-headless-shell, DECISIONS "V"), the one the
 * HyperFrames CLI fetched on a development Mac, Debian's chromium (the real binary, not the /usr/bin/chromium shell
 * wrapper). Only one in a folder of its own that nobody else can change (trustedBrowser). Read on every call: an
 * install shows without a restart.
 */
export function findPdfBrowser(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = os.homedir()): string | null {
  const ok = (p: string | undefined | null): p is string => isExe(p) && trustedBrowser(p)
  const explicit = env.MYCEL_HTML_PDF_BROWSER
  if (explicit === 'none') return null
  if (explicit) return ok(explicit) ? explicit : null
  if (ok(env.HYPERFRAMES_BROWSER_PATH)) return env.HYPERFRAMES_BROWSER_PATH
  const hf = hyperframesBrowser(home)
  if (ok(hf)) return hf
  // Linux: Debian's packages, the real binaries (not the /usr/bin shell wrappers). Not Google Chrome on a Mac: it
  // needs a Unix socket of its own (ProcessSingleton) that the isolation's "no network" refuses, and it stops.
  const system = platform === 'linux' ? ['/usr/lib/chromium/chromium-headless-shell', '/usr/lib/chromium/headless_shell', '/usr/lib/chromium/chromium'] : []
  return system.find(ok) ?? null
}

/** The folder whose files the browser may run as its helpers: a macOS app's bundle, else the binary's own folder. */
export function browserHome(bin: string): string {
  const real = fs.realpathSync(bin)
  const app = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(real)
  return app ? app[1]! : path.dirname(real)
}

/** Folders of many programs (and their direct parents): a browser there would let the macOS isolation exec all of
 * them (helpersIn). A browser's own folder is one level below these at least (/usr/lib/chromium, an .app bundle, a
 * download folder of its own). */
const SHARED_DIRS = new Set(['/', '/bin', '/sbin', '/usr', '/usr/bin', '/usr/sbin', '/usr/lib', '/usr/lib64', '/usr/libexec', '/usr/local',
  '/usr/local/bin', '/usr/local/sbin', '/usr/local/lib', '/usr/local/libexec', '/opt', '/opt/homebrew', '/opt/homebrew/bin', '/opt/homebrew/sbin',
  '/opt/homebrew/lib', '/opt/homebrew/libexec', '/opt/homebrew/opt', '/opt/homebrew/Cellar', '/private/tmp', '/tmp', '/var/tmp', '/Applications',
  '/usr/lib/x86_64-linux-gnu', '/usr/lib/aarch64-linux-gnu'])
/**
 * A browser the server may run: its binary, its own folder (browserHome) and every folder above it are owned by root
 * or the server's account and nobody else can write them, and its folder is not a shared one such as /usr/bin. Anyone
 * who could change those files could run code as the server account inside the isolation, and the macOS profile lets
 * the browser exec every file of its folder.
 */
export function trustedBrowser(bin: string, uid = process.getuid?.() ?? -1): boolean {
  try {
    const real = fs.realpathSync(bin)
    const home = browserHome(real)
    if (SHARED_DIRS.has(home)) return false
    // a folder above it may be writable by all when it is sticky (/tmp): nobody can rename what is not theirs there
    const owned = (p: string, sticky = false) => {
      const st = fs.statSync(p)
      return (st.uid === 0 || st.uid === uid) && (!(st.mode & 0o022) || (sticky && !!(st.mode & 0o1000)))
    }
    if (!owned(real) || !owned(home)) return false
    for (let d = path.dirname(home); ; d = path.dirname(d)) {
      if (!owned(d, true)) return false
      if (d === path.dirname(d)) break
    }
    return true
  } catch { return false }
}

/** The fonts the server ships for Korean output, for the browser on Linux (fontconfig): a Linux bundle's fonts/ (Noto
 * Sans CJK and Pretendard, config.ts bundledFontDir) and the repository's Pretendard (a source checkout). A Mac's
 * browser uses the Mac's own fonts (Apple SD Gothic Neo for Hangul), as its typst PDFs do. */
export function serverFontDirs(): string[] {
  const dirs = [bundledFontDir(), path.join(REPO_ROOT, 'resources', 'fonts', 'pretendard')]
  return [...new Set(dirs.filter((d): d is string => { try { return !!d && fs.statSync(d).isDirectory() } catch { return false } }))]
}

/** Why HTML cannot be printed here (null: it can). */
export function htmlPdfUnavailable(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!findPdfBrowser(env)) return 'no headless browser is installed on this server, so HTML cannot be printed to PDF here'
  // a browser without isolation would read what the server account can read: never, not even in development
  if (isolation() === 'none') return 'the converter isolation (bwrap) is missing on this server, so HTML is not printed to PDF here'
  // the browser runs without a sandbox of its own (the isolation is its sandbox): never as root. Only this repository's
  // container check of the Linux print (bwrap cannot make its network as a plain account in some VMs) runs it as root.
  if (process.getuid?.() === 0 && !(env.NODE_ENV === 'test' && env.MYCEL_HTML_PDF_TEST_AS_ROOT === '1')) return 'the server runs as root, and a browser is never run as root, so HTML is not printed to PDF here'
  return null
}

// ---------------- the queue ----------------

interface Waiter { user: string; grant: () => void; fail: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
const runningUsers = new Map<string, number>()
let running = 0
const waiting: Waiter[] = []

function pump() {
  const max = renderParallel()
  for (let i = 0; i < waiting.length && running < max; ) {
    const w = waiting[i]!
    if (runningUsers.has(w.user)) { i++; continue }
    waiting.splice(i, 1)
    clearTimeout(w.timer)
    running++
    runningUsers.set(w.user, 1)
    w.grant()
  }
}

/** A render slot for `user`: one per person, renderParallel() on the server; the caller must call the returned release. */
export function renderSlot(user: string, signal?: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    let done = false
    const release = () => { if (done) return; done = true; running--; runningUsers.delete(user); pump() }
    if (running < renderParallel() && !runningUsers.has(user)) { running++; runningUsers.set(user, 1); resolve(release); return }
    // one waiting print per person: nobody fills the wait list for everyone else
    if (waiting.length >= QUEUE_MAX || waiting.some((w) => w.user === user)) { reject(new HtmlPdfError('busy', 'the server is printing other pages to PDF; try again in a minute')); return }
    const w: Waiter = {
      user,
      grant: () => { signal?.removeEventListener('abort', onAbort); resolve(release) },
      fail: (e) => { const i = waiting.indexOf(w); if (i >= 0) waiting.splice(i, 1); clearTimeout(w.timer); signal?.removeEventListener('abort', onAbort); reject(e) },
      timer: setTimeout(() => w.fail(new HtmlPdfError('busy', 'the server is printing other pages to PDF; try again in a minute')), WAIT_MAX_MS),
    }
    const onAbort = () => w.fail(new HtmlPdfError('aborted', 'stopped'))
    if (signal?.aborted) { clearTimeout(w.timer); reject(new HtmlPdfError('aborted', 'stopped')); return }
    signal?.addEventListener('abort', onAbort, { once: true })
    waiting.push(w)
  })
}
/** tests: the queue's state */
export const _queueForTest = () => ({ running, waiting: waiting.length })

// ---------------- the DevTools protocol over the browser's pipes ----------------

/**
 * The DevTools protocol, each message ending with a NUL byte. The browser reads it on its fd 3 and writes on its fd 4;
 * a shell in front of it maps those to its stdin and stdout (browserCommand), which the server writes and reads.
 * Not node:child_process's extra pipes: under Bun 1.3 (the bundled runtime) each of those descriptors has two owners
 * (the subprocess, which closes it when the child exits, and a socket over it, which closes it again when collected), so
 * a later print whose pipe had taken the number lost it and its browser quit.
 */
class Cdp {
  private next = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private listeners = new Map<string, ((params: any, sessionId?: string) => void)[]>()
  private chunks: Buffer[] = []
  private size = 0
  closed: Error | null = null
  /** called when the protocol breaks (a message over `maxMessage`): the render fails at once */
  onFatal: (e: HtmlPdfError) => void = () => {}
  /** `write` sends one message and gives the moment it has left the server (the pipe took it); `maxMessage`: the
   * largest message taken; a larger one closes the protocol with `tooLarge()` and nothing more is kept */
  constructor(private w: (s: string) => Promise<unknown>, private maxMessage: number, private tooLarge: () => HtmlPdfError) {}
  /** the moment the last message written has left the server */
  flushed: Promise<unknown> = Promise.resolve()
  read(b: Buffer) {
    if (this.closed) return
    let start = 0
    for (let i = b.indexOf(0); i >= 0; i = b.indexOf(0, start)) {
      this.chunks.push(b.subarray(start, i))
      const msg = Buffer.concat(this.chunks).toString('utf8')
      this.chunks = []
      this.size = 0
      start = i + 1
      this.dispatch(msg)
    }
    if (start < b.length) {
      this.chunks.push(b.subarray(start))
      this.size += b.length - start
      if (this.size > this.maxMessage) { this.chunks = []; this.size = 0; const e = this.tooLarge(); this.close(e); this.onFatal(e) }
    }
  }
  private dispatch(msg: string) {
    let m: { id?: number; method?: string; params?: unknown; sessionId?: string; result?: unknown; error?: { message?: string } }
    try { m = JSON.parse(msg) } catch { return }
    if (typeof m.id === 'number') {
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      if (m.error) p.reject(new HtmlPdfError('browser', String(m.error.message ?? 'protocol error')))
      else p.resolve(m.result)
    } else if (m.method) for (const f of this.listeners.get(m.method) ?? []) f(m.params, m.sessionId)
  }
  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(this.closed)
    const id = this.next++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.flushed = this.w(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0').catch(() => {
        this.close(new HtmlPdfError('browser', 'the browser closed'))
      })
    })
  }
  on(method: string, f: (params: any, sessionId?: string) => void) { this.listeners.set(method, [...(this.listeners.get(method) ?? []), f]) }
  close(e: Error) {
    if (this.closed) return
    this.closed = e
    for (const p of this.pending.values()) p.reject(e)
    this.pending.clear()
  }
}

// ---------------- one render ----------------

export interface HtmlPdfRequest {
  browser: string
  html: Buffer
  /** the page's team path (actual names), e.g. "sales/견적서.html": relative references resolve against its folder */
  page: string
  /** A team file the page refers to (its team path, decoded and normalized), or null when it may not be used: the
   * caller's authorize path for the person, plus its own rules. Only called for image, stylesheet and font paths. */
  asset: (teamPath: string, maxBytes: number) => Buffer | null
  /** font folders the browser may use besides the system's (Linux: given to fontconfig; read-only in the isolation) */
  fonts?: string[]
  /** where the work folder is made (the server's data folder) */
  workBase: string
  signal?: AbortSignal
  limits?: Partial<HtmlPdfLimits>
}
export interface HtmlPdfResult {
  pdf: Buffer
  pages: number
  /** team paths the page used */
  assets: string[]
  /** addresses that were not loaded (web addresses, files the person cannot read, other kinds of files), at most 20 */
  blocked: string[]
  blockedCount: number
  /** the page has <script> or on…= handlers; they did not run */
  scripts: boolean
  ms: number
}

const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/')
/** The team path a URL of ORIGIN names (decoded, normalized by the URL parser), or null. */
export function teamPathOf(url: string): string | null {
  let u: URL
  try { u = new URL(url) } catch { return null }
  if (u.origin !== ORIGIN || u.username || u.password) return null
  const segs: string[] = []
  for (const s of u.pathname.split('/')) {
    if (!s) continue
    let d: string
    try { d = decodeURIComponent(s) } catch { return null }
    if (d === '.' || d === '..' || d.includes('/') || d.includes('\\') || /[\u0000-\u001f]/.test(d)) return null
    segs.push(d)
  }
  return segs.length ? segs.join('/') : null
}

/** Does the HTML name its own charset (a BOM, or <meta charset> / http-equiv in its first 1024 bytes)? */
function namesCharset(html: Buffer): boolean {
  if ((html[0] === 0xef && html[1] === 0xbb && html[2] === 0xbf) || (html[0] === 0xfe && html[1] === 0xff) || (html[0] === 0xff && html[1] === 0xfe)) return true
  return /<meta[^>]+charset\s*=/i.test(html.subarray(0, 1024).toString('latin1'))
}
const hasScripts = (html: Buffer) => /<script\b|<[a-z][^>]*\son[a-z]+\s*=/i.test(html.toString('latin1'))

/**
 * Pages in a PDF Chromium wrote (Skia: a classic cross-reference table, the page tree's dictionaries uncompressed),
 * read the way a reader does: the last `startxref` → the table → the trailer's /Root → the catalog's /Pages → its /Count.
 * Never by searching the text: the page's own title is written into the file and could say "/Type /Pages /Count 150".
 * 0 when the file does not read that way.
 */
export function pdfPageCount(pdf: Buffer): number {
  const s = pdf.toString('latin1')
  const sx = s.lastIndexOf('startxref')
  if (sx < 0) return 0
  const xref = Number(/^\s*(\d+)/.exec(s.slice(sx + 9, sx + 40))?.[1] ?? NaN)
  if (!Number.isInteger(xref) || !s.startsWith('xref', xref)) return 0
  // the table: subsections "first count" then count lines "offset generation n|f"
  const offsets = new Map<number, number>()
  const lines = /^xref\s*\n([\s\S]*?)trailer/.exec(s.slice(xref, sx))
  if (!lines) return 0
  const rows = lines[1]!.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  for (let i = 0; i < rows.length;) {
    const head = /^(\d+)\s+(\d+)$/.exec(rows[i]!)
    if (!head) return 0
    const first = Number(head[1]), count = Number(head[2])
    for (let k = 0; k < count; k++) {
      const row = /^(\d{10})\s+(\d{5})\s+([nf])$/.exec(rows[i + 1 + k] ?? '')
      if (!row) return 0
      if (row[3] === 'n') offsets.set(first + k, Number(row[1]))
    }
    i += 1 + count
  }
  const trailer = s.slice(s.indexOf('trailer', xref), sx)
  const obj = (n: number): string | null => {
    const at = offsets.get(n)
    if (at === undefined || !new RegExp(`^${n}\\s+\\d+\\s+obj\\b`).test(s.slice(at, at + 32))) return null
    const end = s.indexOf('endobj', at)
    return end < 0 ? null : s.slice(at, end)
  }
  // the page's own text (its language, its title) is in strings: never read as keys
  const keys = (o: string) => o.replace(/\((?:\\[\s\S]|[^\\)])*\)/g, '()').replace(/<[0-9A-Fa-f\s]*>/g, '<>')
  const root = /\/Root\s+(\d+)\s+\d+\s+R/.exec(keys(trailer))
  const catalog = root ? obj(Number(root[1])) : null
  const pagesRef = catalog ? /\/Pages\s+(\d+)\s+\d+\s+R/.exec(keys(catalog)) : null
  const pages = pagesRef ? obj(Number(pagesRef[1])) : null
  // the root of the page tree: a /Pages node without a /Parent
  if (!pages || !/\/Type\s*\/Pages\b/.test(keys(pages)) || /\/Parent\b/.test(keys(pages))) return 0
  const count = /\/Count\s+(\d+)/.exec(keys(pages))
  return count ? Number(count[1]) : 0
}

/** fontconfig for the browser on Linux: the system's settings plus the server's own font folders. */
function fontsConf(work: string, dirs: string[]): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  return ['<?xml version="1.0"?>', '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">', '<fontconfig>',
    '  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>',
    ...dirs.map((d) => `  <dir>${esc(d)}</dir>`),
    `  <cachedir>${esc(path.join(work, 'fc-cache'))}</cachedir>`, '</fontconfig>', ''].join('\n')
}

/** The browser's command line: headless, no sandbox of its own (the isolation is the sandbox; it cannot make namespaces
 * inside bwrap), nothing in the background, a host resolver that resolves nothing, JavaScript off, the DevTools pipes. */
export function browserArgs(work: string): string[] {
  return [
    '--headless', '--remote-debugging-pipe', '--no-sandbox', '--no-zygote', '--disable-gpu', '--disable-dev-shm-usage',
    `--user-data-dir=${path.join(work, 'profile')}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
    '--disable-domain-reliability', '--disable-client-side-phishing-detection', '--disable-breakpad', '--disable-crash-reporter',
    '--no-proxy-server', '--dns-prefetch-disable', '--host-resolver-rules=MAP * ~NOTFOUND', '--mute-audio', '--hide-scrollbars',
    '--disable-site-isolation-trials', '--disable-features=IsolateOrigins,site-per-process,Translate,MediaRouter,OptimizationHints,AutofillServerCommunication,DialMediaRouteProvider',
    '--blink-settings=scriptEnabled=false', '--metrics-recording-only', '--password-store=basic', '--use-mock-keychain',
    'about:blank',
  ]
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const short = (url: string) => (url.length > 200 ? url.slice(0, 200) + '…' : url)
/** Only this repository's container check of the Linux print runs it as root (see htmlPdfUnavailable). */
const rootRefused = () => process.getuid?.() === 0 && !(process.env.NODE_ENV === 'test' && process.env.MYCEL_HTML_PDF_TEST_AS_ROOT === '1')

/** Print one HTML page to PDF (see the top of this file). Throws HtmlPdfError. */
export async function renderHtmlPdf(req: HtmlPdfRequest): Promise<HtmlPdfResult> {
  const L = { ...HTML_PDF_LIMITS, ...req.limits }
  if (req.html.length > L.maxHtmlBytes) throw new HtmlPdfError('html_too_large', `the HTML file is larger than ${L.maxHtmlBytes / 1024 / 1024} MB`)
  if (req.signal?.aborted) throw new HtmlPdfError('aborted', 'stopped')
  if (rootRefused()) throw new HtmlPdfError('unavailable', 'a browser is never run as root')
  const work = makeWorkDir(path.join(req.workBase, 'work'))
  try { return await printIn(work, req, L) } finally { fs.rmSync(work, { recursive: true, force: true }) }
}

async function printIn(work: string, req: HtmlPdfRequest, L: HtmlPdfLimits): Promise<HtmlPdfResult> {
  const started = Date.now()
  const fonts = (req.fonts ?? []).filter((d) => { try { return fs.statSync(d).isDirectory() } catch { return false } })
  const home = browserHome(req.browser)
  // Chromium on macOS keeps its temporary files in the user's temp folder, which the isolation hides, unless
  // MAC_CHROMIUM_TMPDIR names another one (base/files/file_util_apple.mm)
  const env: Record<string, string> = process.platform === 'darwin' ? { MAC_CHROMIUM_TMPDIR: work } : {}
  if (process.platform === 'linux') {
    fs.writeFileSync(path.join(work, 'fonts.conf'), fontsConf(work, fonts), { mode: 0o600 })
    env.FONTCONFIG_FILE = path.join(work, 'fonts.conf')
  }
  // /bin/sh in front of the browser maps its stdin and stdout to the DevTools pipes (fd 3 and 4; see Cdp) and then
  // becomes the browser (exec); macOS's /bin/sh starts the shell /private/var/select/sh names, so that one may run too
  const shell = '/bin/sh'
  const execAlso = process.platform === 'darwin' ? (() => { try { return [fs.realpathSync('/private/var/select/sh')] } catch { return [] } })() : []
  const { argv, env: fullEnv } = isolatedCommand({ cmd: shell, args: ['-c', BROWSER_SHELL, req.browser, ...browserArgs(work)], workDir: work, readPaths: [home, ...fonts], helpersIn: home, execAlso, env, timeoutMs: L.timeoutMs, background: false, cpuThreads: 2 })
  // its own process group: the time limit, an abort and the end of the render kill it with every helper it started
  const p = Bun.spawn(argv, { cwd: work, env: fullEnv, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', detached: true })
  let failure: HtmlPdfError | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let watch: ReturnType<typeof setInterval> | undefined
  let onAbort: (() => void) | undefined
  let cdp: Cdp | undefined
  try {
    const tooLarge = () => new HtmlPdfError('too_large', `the PDF would be larger than ${Math.round(L.maxPdfBytes / 1024 / 1024)} MB`)
    const sink = p.stdin
    // one message out; the promise is the moment the pipe has taken it (the next large one waits for it, printPage)
    const write = async (s: string) => { sink.write(s); await sink.flush() }
    // the largest message the browser sends: one read of the PDF stream (1 MiB, base64) with room to spare
    const c = cdp = new Cdp(write, 8 * 1024 * 1024, tooLarge)
    let stderr = ''
    let finish!: () => void
    const failed = new Promise<never>((_, reject) => { finish = () => reject(failure) })
    failed.catch(() => {})
    const fail = (e: HtmlPdfError) => { if (!failure) { failure = e; c.close(e); finish() } }
    c.onFatal = fail
    void (async () => {
      try { for await (const ch of p.stdout) c.read(Buffer.from(ch)) } catch { /* ended */ }
      c.close(new HtmlPdfError('browser', 'the browser closed'))
    })()
    void (async () => {
      const dec = new TextDecoder()
      try { for await (const ch of p.stderr) if (stderr.length < 16 * 1024) stderr += dec.decode(ch, { stream: true }) } catch { /* ended */ }
    })()
    void p.exited.then((code) => fail(new HtmlPdfError('browser', `the browser stopped (${code ?? p.signalCode}): ${stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300)}`)))
    timer = setTimeout(() => fail(new HtmlPdfError('timeout', `printing took longer than ${Math.round(L.timeoutMs / 1000)} s`)), L.timeoutMs)
    // memory of the browser's processes, and the work folder (Chromium writes its profile and temporary files there;
    // macOS has no file size limit for it)
    watch = setInterval(() => {
      if (p.pid) void treeRssKiB(p.pid).then((kib) => { if (kib > L.maxRssMiB * 1024) fail(new HtmlPdfError('memory', 'the page needs too much memory to print')) })
      if (dirBytes(work) > L.maxWorkBytes) fail(new HtmlPdfError('too_large', 'the print needs too much disk space'))
    }, 250)
    onAbort = () => fail(new HtmlPdfError('aborted', 'stopped'))
    req.signal?.addEventListener('abort', onAbort, { once: true })
    const race = <T>(x: Promise<T>) => Promise.race([x, failed])
    return await printPage(c, race, req, L, started)
  } catch (e) {
    if (failure) throw failure
    if (e instanceof HtmlPdfError) throw e
    throw new HtmlPdfError('browser', e instanceof Error ? e.message : String(e))
  } finally {
    clearTimeout(timer)
    clearInterval(watch)
    if (onAbort) req.signal?.removeEventListener('abort', onAbort)
    if (!failure) failure = new HtmlPdfError('aborted', 'done')
    cdp?.close(failure)
    try { void p.stdin.end() } catch { /* closed */ }
    if (p.pid && p.exitCode === null && p.signalCode === null) killTree(p.pid)
    await Promise.race([p.exited, wait(3000)])
  }
}

/** The shell line in front of the browser: its stdin becomes fd 3 and its stdout fd 4 (the DevTools pipes), stdin and
 * stdout themselves /dev/null, then the shell becomes the browser ("$0" "$@"). */
export const BROWSER_SHELL = 'exec "$0" "$@" 3<&0 4>&1 0</dev/null 1>/dev/null'

/** The page through the browser and back as a PDF; `race` ends with the render's failure (time, memory, abort). */
async function printPage(cdp: Cdp, race: <T>(x: Promise<T>) => Promise<T>, req: HtmlPdfRequest, L: HtmlPdfLimits, started: number): Promise<HtmlPdfResult> {
  const pageUrl = `${ORIGIN}/${encodePath(req.page)}`
  /** each team file once (base64), whatever address it was asked by */
  const assets = new Map<string, { b64: string; mime: string } | null>()
  const blocked = new Set<string>()
  let assetBytes = 0
  /** bytes handed to the browser, every repeat counted, and requests answered: a page that asks for one picture under
   * many addresses (?1, ?2 …) must not make the server send it without end */
  let sent = 0, requests = 0
  let pageServed = false
  const block = (url: string) => { if (blocked.size < 1000) blocked.add(short(url)) }
  const html = req.html
  const charset = namesCharset(html)
  // requests the page's CSP (or Chromium itself: file: from a web page) stopped before they reached the interception
  const urls = new Map<string, string>()
  const stoppedEarly = new Set<string>()
  cdp.on('Network.requestWillBeSent', (e: { requestId: string; request: { url: string } }) => { if (urls.size < 2_000) urls.set(e.requestId, short(e.request.url)) })
  cdp.on('Network.loadingFailed', (e: { blockedReason?: string; requestId: string }) => { if (e.blockedReason && e.blockedReason !== 'inspector' && stoppedEarly.size < 2_000) stoppedEarly.add(e.requestId) })
  // the navigation's own lifecycle (an event of the blank page before it does not count)
  const life = new Map<string, Set<string>>()
  cdp.on('Page.lifecycleEvent', (e: { name: string; loaderId: string }) => { const s = life.get(e.loaderId) ?? new Set(); s.add(e.name); life.set(e.loaderId, s) })
  const { targetId } = await race(cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' }))
  const { sessionId } = await race(cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true }))
  const s = (method: string, params: Record<string, unknown> = {}) => race(cdp.send(method, params, sessionId))
  // The answers go out one at a time: each waits until the pipe has taken the one before (Chromium asks for every
  // picture at once, and a dozen large photos written together would sit in the server's memory). The byte and request
  // budgets bound the total; the server holds about one answer at a time.
  let outgoing: Promise<unknown> = Promise.resolve()
  /** `f` writes its message at once (Cdp.send) and resolves with the browser's answer later: the next one waits until
   * the pipe has taken the message before it (Cdp.flushed), not for the answer */
  const inTurn = <T>(f: () => Promise<T>): Promise<T> => {
    const written = outgoing.then(() => race(cdp.flushed)).then(() => ({ answer: f() }))
    outgoing = written.catch(() => {})
    return written.then((w) => w.answer)
  }
  // every request of the page, answered here
  cdp.on('Fetch.requestPaused', (e: { requestId: string; request: { url: string; method: string }; resourceType: string }, sid) => {
    const fulfill = (mime: string, b64: string, size: number, extra: { name: string; value: string }[] = []) => {
      sent += size
      return inTurn(() => cdp.send('Fetch.fulfillRequest', { requestId: e.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: mime }, { name: 'X-Content-Type-Options', value: 'nosniff' }, ...extra], body: b64 }, sid))
    }
    const answer = async (): Promise<unknown> => {
      const url = e.request.url
      // a picture: the grey placeholder; another page in a frame or the window: aborted, so the frame stays empty and
      // the page stays (no error page is printed); anything else: blocked
      const refuse = () => {
        block(url)
        if (e.resourceType === 'Image' && requests <= L.maxRequests) return fulfill('image/svg+xml', PLACEHOLDER_B64, PLACEHOLDER_SVG.length)
        return cdp.send('Fetch.failRequest', { requestId: e.requestId, errorReason: e.resourceType === 'Document' ? 'Aborted' : 'BlockedByClient' }, sid)
      }
      const team = teamPathOf(url)
      // Chromium asks for /favicon.ico by itself: no reference of the page, not counted or reported
      if (e.resourceType === 'Other' && team === 'favicon.ico') return cdp.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'BlockedByClient' }, sid)
      if (++requests > L.maxRequests) return refuse()
      if (e.request.method !== 'GET') return refuse()
      if (team === null) return refuse()
      if (team === req.page) {
        // once: a meta refresh to itself or a frame of itself gets nothing (no reload loop, no page in a page)
        if (pageServed) return refuse()
        pageServed = true
        return fulfill(charset ? 'text/html' : 'text/html; charset=utf-8', html.toString('base64'), html.length, [{ name: 'Content-Security-Policy', value: PAGE_CSP }, { name: 'Cache-Control', value: 'no-store' }])
      }
      // a team file only as a picture, a stylesheet or a font (never in a frame)
      const mime = assetMime(team)
      if (!mime || !['Image', 'Stylesheet', 'Font'].includes(e.resourceType)) return refuse()
      let a = assets.get(team)
      if (a === undefined) {
        a = null
        if (assets.size < L.maxAssets) {
          let bytes: Buffer | null = null
          try { bytes = req.asset(team, L.maxAssetBytes) } catch { bytes = null }
          if (bytes && bytes.length <= L.maxAssetBytes && assetBytes + bytes.length <= L.maxAssetsBytes) { assetBytes += bytes.length; a = { b64: bytes.toString('base64'), mime } }
        }
        assets.set(team, a)
      }
      if (!a || sent + a.b64.length * 0.75 > L.maxSentBytes) return refuse()
      return fulfill(a.mime, a.b64, Math.round(a.b64.length * 0.75))
    }
    answer().catch(() => {})
  })
  await race(cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {}))
  await s('Page.enable')
  await s('Page.setLifecycleEventsEnabled', { enabled: true })
  // only to hear what the CSP stopped: no copies of the page's files kept for the protocol
  await s('Network.enable', { maxTotalBufferSize: 64 * 1024, maxResourceBufferSize: 16 * 1024 })
  await s('Emulation.setScriptExecutionDisabled', { value: true })
  // laid out for print from the start, so the fonts and pictures print media needs are loaded before printing
  await s('Emulation.setEmulatedMedia', { media: 'print' })
  await s('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
  const nav = await s('Page.navigate', { url: pageUrl }) as { errorText?: string; loaderId?: string }
  if (nav.errorText || !nav.loaderId) throw new HtmlPdfError('browser', `the page did not open (${nav.errorText ?? 'no document'})`)
  const has = (name: string) => life.get(nav.loaderId!)?.has(name) ?? false
  // the page and what it loads (fonts, pictures); then a quiet moment for late fonts, at most 5 s
  while (!has('load')) await race(wait(25))
  const idleBy = Date.now() + 5_000
  while (!has('networkIdle') && Date.now() < idleBy) await race(wait(25))
  for (const id of stoppedEarly) { const u = urls.get(id); if (u) block(u) }
  // the PDF as a stream (a temporary file in the work folder, whose size the watch above bounds), read 1 MiB at a time
  // and refused past its size limit: never the whole PDF in one message
  const r = await s('Page.printToPDF', {
    printBackground: true, preferCSSPageSize: true, paperWidth: 8.27, paperHeight: 11.69, displayHeaderFooter: false,
    pageRanges: `1-${L.maxPages + 1}`, transferMode: 'ReturnAsStream',
  }) as { stream: string }
  const parts: Buffer[] = []
  let total = 0
  for (;;) {
    const c = await s('IO.read', { handle: r.stream, size: 1024 * 1024 }) as { data: string; eof: boolean; base64Encoded?: boolean }
    const b = Buffer.from(c.data, c.base64Encoded ? 'base64' : 'latin1')
    total += b.length
    if (total > L.maxPdfBytes) throw new HtmlPdfError('too_large', `the PDF would be larger than ${Math.round(L.maxPdfBytes / 1024 / 1024)} MB`)
    parts.push(b)
    if (c.eof) break
  }
  await s('IO.close', { handle: r.stream }).catch(() => {})
  const pdf = Buffer.concat(parts)
  const pages = pdfPageCount(pdf)
  if (pages > L.maxPages) throw new HtmlPdfError('pages', `the page prints to more than ${L.maxPages} PDF pages`)
  if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-')) || pages < 1) throw new HtmlPdfError('browser', 'the browser did not produce a PDF')
  return {
    pdf, pages, assets: [...assets.entries()].filter(([, a]) => a).map(([p]) => p),
    blocked: [...blocked].slice(0, 20), blockedCount: blocked.size, scripts: hasScripts(html), ms: Date.now() - started,
  }
}


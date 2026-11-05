// Brand assets a company profile draft collects while it reads the website (docs/DECISIONS.md "N — The first result is
// the company's card news"). The AI only reads pages; the server, which opened each page itself (web_fetch in a draft
// turn, onboarding/draft.ts), also looks at the page's markup for the company's own pictures and colours:
//   - the logo (apple-touch-icon, a large PNG icon, the JSON-LD / itemprop logo, an <img> named or labelled "logo"),
//   - pictures the page itself shows (og:image / twitter:image, <img> with srcset or lazy-load attributes, inline
//     background images), largest first,
//   - colours (the theme-color meta, brand-like CSS custom properties of the page's own style blocks and of at most
//     two style sheets of the same site, the logo's dominant colour, saturated colours the page uses often).
// Only addresses the page itself embeds are fetched (never one the AI wrote), with web_fetch's own network rules: public
// addresses only, never this server's exit address, the connection pinned to the checked address, every redirect hop
// checked again, ports 80 and 443. An image may sit on another host (site builders keep pictures on their CDN:
// imweb, Naver smartstore, Wix, Shopify); a style sheet only on the site's own scope. What is kept is decided by the
// bytes, never the content type: PNG, JPEG or WebP whose header gives a real size (no SVG, so no script can come in;
// no GIF), at most BRAND_IMAGE_BYTES, content pictures at least 300 px on the short side and not a thin strip. Large
// ones are made into a 1,600 px JPEG by the isolated ffmpeg (tools/isolate.ts), when there is one.
//
// The files wait in the server's data folder (<data>/onboarding-assets/<chat>/), listed in onboarding_brand_assets,
// with the text of each page read (cut), until the first result starts: then they go into the team's brand folder as
// the owner's saves (placeBrandAssets) and the page texts make 회사 소개.md when no file was given (welcome-result.ts).
// Nothing here reaches the AI of the draft: it keeps reading pages as before.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import { PROFILE_LIMITS } from '@mycel/shared/api'
import type { Logger } from '../log'
import { which } from '../config'
import { imageSize } from '../uploads/image'
import { makeWorkDir, runIsolated } from '../tools/isolate'
import { decode, decodeEntities, pinnedGet, resolveTarget, type ResolveOptions } from '../tools/web-fetch'

/** Images kept aside per draft chat (the logo among them). */
export const BRAND_IMAGES_MAX = 8
/** Bytes per image, as fetched. */
export const BRAND_IMAGE_BYTES = 6 * 1024 * 1024
/** Image addresses tried per draft chat (a page full of broken pictures stops here). */
const FETCH_TRIES_MAX = 24
const STYLESHEETS_MAX = 2
const STYLESHEET_BYTES = 512 * 1024
/** Characters of each page's text kept for 회사 소개.md. */
export const BRAND_PAGE_TEXT_MAX = 4000
const FETCH_TIMEOUT_MS = 12_000
/** A content picture smaller than this on its short side is an icon, a thumbnail or a badge. */
const MIN_SIDE = 300
const LOGO_MIN_SIDE = 64
/** Made into a 1,600 px JPEG above these. */
const RESIZE_SIDE = 2000
const RESIZE_BYTES = 1.5 * 1024 * 1024

export interface Candidate { url: string; kind: 'logo' | 'image'; alt: string; weight: number }
export interface ColorHit { hex: string; weight: number }
export interface PageAssets { logos: Candidate[]; images: Candidate[]; colors: ColorHit[]; stylesheets: string[] }

const TAG = /<(img|meta|link|source|body|header|section|div|a|figure)\b([^>]*)>/gi
const ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g

/** The attributes of one tag (names lower case, values with entities decoded). */
export function attrsOf(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  ATTR.lastIndex = 0
  for (let m = ATTR.exec(s); m; m = ATTR.exec(s)) {
    if (m[0] === '') { ATTR.lastIndex++; continue }
    const k = m[1]!.toLowerCase()
    if (!(k in out)) out[k] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '')
  }
  return out
}

/** An absolute http(s) address from a page's reference, or null (data:, javascript:, broken). */
function absolute(raw: string, base: URL): string | null {
  const s = raw.trim()
  if (!s || /^(data|blob|javascript|about|mailto|tel):/i.test(s)) return null
  try {
    const u = new URL(s, base)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    u.hash = ''
    return u.href.length > 2000 ? null : u.href
  } catch { return null }
}

/** The largest candidate of a srcset ("a.jpg 640w, b.jpg 1280w" → b.jpg). */
export function largestSrc(srcset: string): string | null {
  let best: { url: string; w: number } | null = null
  for (const part of srcset.split(/,\s+(?=\S)/)) {
    const [url, d] = part.trim().split(/\s+/)
    if (!url) continue
    const w = d ? parseFloat(d) * (d.endsWith('x') ? 1000 : 1) : 1
    if (!best || w > best.w) best = { url, w: Number.isFinite(w) ? w : 1 }
  }
  return best?.url ?? null
}

const LOGO_WORD = /(^|[^a-z])(logo|brand[-_]?mark|ci|bi|symbol)([^a-z]|$)|로고/i
const NOT_PICTURE = /(sprite|pixel|tracking|spacer|blank|loading|loader|spinner|placeholder|avatar|badge|icon[-_]|[-_]icon|emoji|flag|arrow|btn|button|banner[-_]?ad|1x1|facebook|kakao|naver[-_]?(blog|band)|instagram|youtube|twitter|appstore|google[-_]?play)/i
const IMAGE_EXT = /\.(jpe?g|png|webp)(\?|$)/i
const NOT_IMAGE_EXT = /\.(svg|gif|ico|avif|bmp|tiff?)(\?|$)/i

const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
/** "#abc", "#aabbcc", "rgb(1, 2, 3)" → "#aabbcc"; null otherwise (or transparent). */
export function normColor(raw: string): string | null {
  const s = raw.trim().toLowerCase()
  let m = /^#([0-9a-f]{3})$/.exec(s)
  if (m) return '#' + m[1]!.split('').map((c) => c + c).join('')
  m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(s)
  if (m) return '#' + m[1]!
  const r = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(s)
  if (r) {
    if (r[4] !== undefined && parseFloat(r[4]) < (r[4].endsWith('%') ? 50 : 0.5)) return null
    return '#' + hex2(+r[1]!) + hex2(+r[2]!) + hex2(+r[3]!)
  }
  return null
}

const rgbOf = (hex: string) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)] as const
/** Saturation and lightness (0..1) of a colour. */
export function satLight(hex: string): { s: number; l: number } {
  const [r, g, b] = rgbOf(hex).map((v) => v / 255) as [number, number, number]
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  return { s: d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)), l }
}
/** A colour that can carry a brand: not white, black or grey (dark navy and deep green count). From a strong source
 * (the theme colour, the logo) a near-black charcoal counts too: a black-and-white brand's colour is its black. */
export const brandish = (hex: string, strong = false) => {
  const { s, l } = satLight(hex)
  return (s >= 0.18 && l > 0.1 && l < 0.92) || (strong && l >= 0.06 && l <= 0.3)
}
/** Hits at least this strong are brand colours by themselves (the theme colour, the logo, a brand-named variable). */
const STRONG = 80
/** Weaker hits (a design system's palette, colours the CSS uses often) make the list only from this weight. */
const KEEP = 30
const close = (a: string, b: string) => { const x = rgbOf(a), y = rgbOf(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) < 36 }

/** Merge colour hits (close ones are one colour, weights add up), the strongest first, at most `max`. */
export function rankColors(hits: ColorHit[], max: number = PROFILE_LIMITS.colors): string[] {
  // a group is as strong as its strongest hit, a little more when other hits agree (a colour every page repeats); a
  // palette of many variables does not add up to a brand colour
  const groups: { hex: string; best: number; n: number }[] = []
  for (const h of hits) {
    if (!brandish(h.hex, h.weight >= STRONG)) continue
    const g = groups.find((x) => close(x.hex, h.hex))
    if (g) { g.n++; if (h.weight > g.best) { g.best = h.weight; g.hex = h.hex } } else groups.push({ hex: h.hex, best: h.weight, n: 1 })
  }
  return groups.map((g) => ({ hex: g.hex, weight: g.best + Math.min(20, (g.n - 1) * 4) }))
    .filter((g) => g.weight >= KEEP).sort((a, b) => b.weight - a.weight).slice(0, max).map((g) => g.hex)
}

const VAR_NAME = /(primary|brand|main|accent|point|key|theme|corporate|signature)/i
/** Colours in CSS text: brand-like custom properties (strong), then saturated colours the CSS uses often (weak). */
export function cssColors(css: string, weight = 1): ColorHit[] {
  const out: ColorHit[] = []
  const text = css.slice(0, STYLESHEET_BYTES)
  const vars = new Set<string>()
  for (const m of text.matchAll(/--([a-z0-9_-]{1,60})\s*:\s*(#[0-9a-f]{3,8}|rgba?\([^)]{5,40}\))/gi)) {
    if (!VAR_NAME.test(m[1]!) || /(text|font|border|shadow|bg-light|gray|grey|white|black|neutral|red|orange|yellow|green|blue|purple|pink|cyan|teal|olive|success|danger|warning|error|info)/i.test(m[1]!)) continue
    const hex = normColor(m[2]!)
    if (hex) vars.add(hex)
  }
  // one or a few brand-named colours are the brand's; many are a design system's palette
  for (const hex of vars) out.push({ hex, weight: (vars.size <= 3 ? 90 : 20) * weight })
  const count = new Map<string, number>()
  for (const m of text.matchAll(/(?:background(?:-color)?|color|fill|border-color)\s*:\s*(#[0-9a-f]{3,8}|rgba?\([^)]{5,40}\))/gi)) {
    const hex = normColor(m[1]!)
    if (hex && brandish(hex)) count.set(hex, (count.get(hex) ?? 0) + 1)
  }
  for (const [hex, n] of count) if (n >= 2) out.push({ hex, weight: Math.min(30, 4 + n * 2) * weight })
  return out
}

/** What one page's markup offers: logo and picture candidates (absolute addresses, best first), colours, and its
 * style sheets. Linear in the page size (one pass of a non-backtracking tag pattern). */
export function extractPageAssets(html: string, base: URL): PageAssets {
  const logos = new Map<string, Candidate>()
  const images = new Map<string, Candidate>()
  const colors: ColorHit[] = []
  const stylesheets: string[] = []
  const add = (map: Map<string, Candidate>, kind: Candidate['kind'], raw: string | undefined, weight: number, alt = '') => {
    const url = raw ? absolute(raw, base) : null
    if (!url || NOT_IMAGE_EXT.test(new URL(url).pathname)) return
    if (kind === 'image' && NOT_PICTURE.test(url + ' ' + alt)) return
    const had = map.get(url)
    if (!had || had.weight < weight) map.set(url, { url, kind, alt: alt.slice(0, 200), weight })
  }
  const page = html.slice(0, 3 * 1024 * 1024)
  let order = 0
  TAG.lastIndex = 0
  for (let m = TAG.exec(page); m; m = TAG.exec(page)) {
    const name = m[1]!.toLowerCase()
    const a = attrsOf(m[2]!)
    order++
    if (name === 'meta') {
      const key = (a.property ?? a.name ?? a.itemprop ?? '').toLowerCase()
      if (key === 'og:image' || key === 'og:image:url' || key === 'og:image:secure_url') add(images, 'image', a.content, 90)
      else if (key === 'twitter:image' || key === 'twitter:image:src') add(images, 'image', a.content, 85)
      else if (key === 'og:logo' || key === 'logo') add(logos, 'logo', a.content, 85)
      else if (key === 'theme-color' || key === 'msapplication-tilecolor') { const hex = normColor(a.content ?? ''); if (hex) colors.push({ hex, weight: key === 'theme-color' ? 120 : 85 }) }
      continue
    }
    if (name === 'link') {
      const rel = (a.rel ?? '').toLowerCase()
      const size = Math.max(0, ...((a.sizes ?? '').match(/\d+/g) ?? ['0']).map(Number))
      // an app icon is a logo of last resort: the site's own logo picture (JSON-LD, an <img> named logo) reads better
      if (/apple-touch-icon/.test(rel)) add(logos, 'logo', a.href, 60 + Math.min(10, size / 20))
      else if (/\bicon\b/.test(rel) && size >= 96) add(logos, 'logo', a.href, 50 + Math.min(8, size / 30))
      else if (/\bstylesheet\b/.test(rel) && a.href && stylesheets.length < 8) { const u = absolute(a.href, base); if (u) stylesheets.push(u) }
      else if (rel === 'image_src') add(images, 'image', a.href, 80)
      continue
    }
    if (name === 'img' || name === 'source') {
      const src = largestSrc(a.srcset ?? a['data-srcset'] ?? '') ?? a['data-src'] ?? a['data-original'] ?? a['data-lazy-src'] ?? a.src
      const alt = a.alt ?? a.title ?? ''
      const hint = `${a.class ?? ''} ${a.id ?? ''} ${alt} ${src ?? ''}`
      if (name === 'img' && LOGO_WORD.test(hint)) { add(logos, 'logo', src, order < 400 ? 80 : 65, alt); continue }
      const w = Number(a.width) || 0, h = Number(a.height) || 0
      if ((w && w < MIN_SIDE / 2) || (h && h < MIN_SIDE / 2)) continue
      const sized = w >= 600 || h >= 600 ? 15 : w >= 400 || h >= 400 ? 8 : 0
      add(images, 'image', src, 50 + sized + (a.srcset ? 5 : 0) + (IMAGE_EXT.test(src ?? '') ? 3 : 0) - Math.min(20, order / 60), alt)
      continue
    }
    // inline background pictures of hero sections
    const style = a.style ?? ''
    const bg = /background(?:-image)?\s*:[^;]*url\(\s*['"]?([^'")]+)['"]?\s*\)/i.exec(style)
    if (bg) add(images, 'image', bg[1], 62 - Math.min(20, order / 60))
    const dataBg = a['data-bg'] ?? a['data-background'] ?? a['data-background-image']
    if (dataBg) add(images, 'image', dataBg.replace(/^url\(\s*['"]?|['"]?\s*\)$/g, ''), 60 - Math.min(20, order / 60))
  }
  // the JSON-LD organization's logo
  for (const m of page.matchAll(/"logo"\s*:\s*(?:\{[^{}]{0,400}?"url"\s*:\s*)?"(https?:[^"\s]{1,1000})"/gi)) add(logos, 'logo', m[1]!.replace(/\\\//g, '/'), 88)
  // the page's own style blocks (custom properties, often-used colours)
  for (const m of page.matchAll(/<style\b[^>]*>([\s\S]{0,200000}?)<\/style>/gi)) colors.push(...cssColors(m[1]!))
  const sort = (m: Map<string, Candidate>) => [...m.values()].sort((x, y) => y.weight - x.weight)
  return { logos: sort(logos), images: sort(images), colors, stylesheets }
}

// ---------------- fetching ----------------

export interface FetchedImage { bytes: Buffer; ext: 'png' | 'jpg' | 'webp'; width: number; height: number; url: string }

/** The format by the bytes (PNG, JPEG, WebP), never the content type. */
export function imageKind(b: Buffer): 'png' | 'jpg' | 'webp' | null {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  return null
}

/** GET with web_fetch's network rules (public addresses, this server's exit address refused, pinned, every redirect hop
 * checked again, at most 3), at most `max` bytes. Throws on anything else. */
export async function fetchBytes(raw: string, max: number, o: ResolveOptions & { insecureTlsForTests?: boolean; hop?: (url: string) => boolean } = {}): Promise<{ body: Buffer; url: string; type: string }> {
  const deadline = Date.now() + FETCH_TIMEOUT_MS
  let current = raw
  for (let hop = 0; hop <= 3; hop++) {
    if (hop > 0 && o.hop && !o.hop(current)) throw new Error('redirect outside')
    const t = await resolveTarget(current, { ...o, deadline })
    const r = await pinnedGet(t, { deadline, maxBytes: max + 1, insecureTlsForTests: o.insecureTlsForTests })
    if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.location) { current = new URL(r.headers.location, t.url).href; continue }
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`)
    if (r.truncated || r.body.length > max) throw new Error('too large')
    const { data, truncated } = await decode(r.body, r.headers['content-encoding'], max)
    if (truncated) throw new Error('too large')
    return { body: data, url: t.url.href, type: (r.headers['content-type'] ?? '').toLowerCase() }
  }
  throw new Error('too many redirects')
}

/** A picture worth keeping: the right kind and size by its bytes. */
export function acceptImage(b: Buffer, kind: Candidate['kind']): { ext: 'png' | 'jpg' | 'webp'; width: number; height: number } | null {
  const ext = imageKind(b)
  const size = ext ? imageSize(b) : null
  if (!ext || !size) return null
  const short = Math.min(size.width, size.height), long = Math.max(size.width, size.height)
  if (kind === 'logo') return short >= LOGO_MIN_SIDE ? { ext, ...size } : null
  if (short < MIN_SIDE || long / short > 3.2 || size.width * size.height < 160_000) return null
  return { ext, ...size }
}

/** Run the isolated ffmpeg on `bytes` and return what it writes to stdout (null without ffmpeg or on failure). */
async function ffmpegPipe(bytes: Buffer, ext: string, args: string[], maxStdout: number, ffmpeg = which('ffmpeg')): Promise<Buffer | null> {
  if (!ffmpeg) return null
  const work = makeWorkDir()
  try {
    fs.writeFileSync(path.join(work, `in.${ext}`), bytes, { mode: 0o600 })
    const r = await runIsolated({ cmd: ffmpeg, workDir: work, timeoutMs: 20_000, maxStdout, args: ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', `in.${ext}`, ...args] })
    return r.code === 0 ? r.stdout : null
  } catch { return null } finally { fs.rmSync(work, { recursive: true, force: true }) }
}

/** A large picture as a 1,600 px JPEG (the card news needs no more, and the preview inlines every picture). */
export async function downsize(img: { bytes: Buffer; ext: string; width: number; height: number }, max = 1600): Promise<{ bytes: Buffer; ext: 'jpg'; width: number; height: number } | null> {
  const jpeg = await ffmpegPipe(img.bytes, img.ext, ['-frames:v', '1', '-vf', `scale='min(${max},iw)':'min(${max},ih)':force_original_aspect_ratio=decrease`, '-q:v', '3', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'], 8 * 1024 * 1024)
  if (!jpeg || imageKind(jpeg) !== 'jpg') return null
  const size = imageSize(jpeg)
  return size ? { bytes: jpeg, ext: 'jpg', ...size } : null
}

/** The logo's dominant colours (opaque pixels that are not white, black or grey), strongest first. */
export async function logoColors(bytes: Buffer, ext: string): Promise<ColorHit[]> {
  const raw = await ffmpegPipe(bytes, ext, ['-frames:v', '1', '-vf', 'scale=32:32', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], 64 * 1024)
  if (!raw || raw.length < 32 * 32 * 4) return []
  const buckets = new Map<string, { n: number; r: number; g: number; b: number }>()
  for (let i = 0; i + 3 < raw.length; i += 4) {
    if (raw[i + 3]! < 160) continue
    const r = raw[i]!, g = raw[i + 1]!, b = raw[i + 2]!
    const hex = '#' + hex2(r) + hex2(g) + hex2(b)
    if (!brandish(hex)) continue
    const key = `${r >> 5}-${g >> 5}-${b >> 5}`
    const k = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 }
    k.n++; k.r += r; k.g += g; k.b += b
    buckets.set(key, k)
  }
  return [...buckets.values()].filter((k) => k.n >= 12).sort((a, b) => b.n - a.n).slice(0, 2)
    .map((k, i) => ({ hex: '#' + hex2(k.r / k.n) + hex2(k.g / k.n) + hex2(k.b / k.n), weight: i === 0 ? 150 : 60 }))
}

// ---------------- the collector of one draft answer ----------------

/** The rows of onboarding_brand_assets (migration 233). */
export interface BrandAssetRow {
  chat_id: string; seq: number; kind: 'logo' | 'image' | 'page' | 'color'; url: string; page_url: string | null; title: string | null
  file: string | null; bytes: number | null; width: number | null; height: number | null; sha256: string | null; text: string | null
  weight: number; placed_path: string | null; created_at: string
}

/** The network rules of the web_fetch call that read the page (this server's exit address refused; tests: the local
 * server allowed), used for everything fetched from that page. */
export type NetOptions = ResolveOptions & { insecureTlsForTests?: boolean }

export interface CollectorOptions {
  dataDir: string
  log: Pick<Logger, 'warn'>
  /** is this address on the site the draft reads (style sheets only come from there) */
  inScope: (url: string) => boolean
}

const ASSETS_DIR = 'onboarding-assets'
export const assetDir = (dataDir: string, chatId: string) => path.join(dataDir, ASSETS_DIR, chatId.replace(/[^A-Za-z0-9_-]/g, ''))

/**
 * Collects the brand assets of one draft chat as its pages open (DraftPages calls `page` for each page it read). Work
 * runs in the background, never holding up the answer; `idle()` resolves when nothing is left (tests). A failure is
 * logged and skipped: the assets are a bonus, not a rule.
 */
export class BrandCollector {
  private queue: Promise<void> = Promise.resolve()
  private tries = 0
  private sheets = 0
  private seen = new Set<string>()
  private hashes = new Set<string>()
  private pages = new Set<string>()
  constructor(private db: Database, private chatId: string, private o: CollectorOptions) {
    try {
      const rows = db.query("SELECT url, sha256 FROM onboarding_brand_assets WHERE chat_id = ? AND kind IN ('logo', 'image')").all(chatId) as { url: string; sha256: string | null }[]
      for (const r of rows) { this.seen.add(r.url); if (r.sha256) this.hashes.add(r.sha256) }
      for (const r of db.query("SELECT url FROM onboarding_brand_assets WHERE chat_id = ? AND kind = 'page'").all(chatId) as { url: string }[]) this.pages.add(r.url)
    } catch { /* no table (a test database of another component): rows are skipped below */ }
  }

  idle(): Promise<void> { return this.queue }

  /** A page the draft read: its text for 회사 소개.md now, its pictures and colours in the background. */
  page(r: { url: string; title?: string; text: string; html?: string }, net: NetOptions = {}): void {
    // the same page again (a second answer): its text once, its pictures already looked at
    if (this.pages.has(r.url)) return
    this.pages.add(r.url)
    this.insert({ kind: 'page', url: r.url, page_url: r.url, title: r.title ?? null, text: r.text.slice(0, BRAND_PAGE_TEXT_MAX), weight: 0 })
    if (!r.html) return
    let found: PageAssets
    try { found = extractPageAssets(r.html, new URL(r.url)) } catch { return }
    this.queue = this.queue.then(() => this.collect(r.url, found, net)).catch((err) => this.o.log.warn('brand assets not collected', { err }))
  }

  private count(kind: 'logo' | 'image'): number {
    try { return (this.db.query('SELECT count(*) AS n FROM onboarding_brand_assets WHERE chat_id = ? AND kind = ?').get(this.chatId, kind) as { n: number }).n } catch { return 0 }
  }

  private async collect(pageUrl: string, found: PageAssets, net: NetOptions): Promise<void> {
    const colors: ColorHit[] = [...found.colors]
    // at most one logo per draft: the best one that is a real picture
    if (this.count('logo') === 0) {
      for (const c of found.logos.slice(0, 4)) {
        const got = await this.fetchImage(c, pageUrl, net)
        if (!got) continue
        colors.push(...await logoColors(got.bytes, got.ext))
        break
      }
    }
    for (const c of found.images) {
      if (this.count('logo') + this.count('image') >= BRAND_IMAGES_MAX || this.tries >= FETCH_TRIES_MAX) break
      await this.fetchImage(c, pageUrl, net)
    }
    for (const sheet of found.stylesheets) {
      if (this.sheets >= STYLESHEETS_MAX) break
      if (!this.o.inScope(sheet) || this.seen.has(sheet)) continue
      this.seen.add(sheet)
      this.sheets++
      try {
        const r = await fetchBytes(sheet, STYLESHEET_BYTES, { ...net, hop: this.o.inScope })
        colors.push(...cssColors(r.body.toString('utf8'), 0.8))
      } catch { /* a style sheet that does not load: its colours are missing */ }
    }
    for (const c of colors) this.insert({ kind: 'color', url: c.hex, page_url: pageUrl, weight: c.weight })
  }

  private async fetchImage(c: Candidate, pageUrl: string, net: NetOptions): Promise<FetchedImage | null> {
    if (this.seen.has(c.url) || this.tries >= FETCH_TRIES_MAX) return null
    this.seen.add(c.url)
    this.tries++
    let got: { body: Buffer; url: string }
    try { got = await fetchBytes(c.url, BRAND_IMAGE_BYTES, net) } catch { return null }
    const ok = acceptImage(got.body, c.kind)
    if (!ok) return null
    let img: FetchedImage = { bytes: got.body, ...ok, url: got.url }
    if (c.kind === 'image' && (Math.max(ok.width, ok.height) > RESIZE_SIDE || got.body.length > RESIZE_BYTES)) {
      const small = await downsize(img)
      if (small) img = { ...small, url: got.url }
    }
    const sha = createHash('sha256').update(img.bytes).digest('hex')
    if (this.hashes.has(sha)) return null
    this.hashes.add(sha)
    const dir = assetDir(this.o.dataDir, this.chatId)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const seq = this.insert({ kind: c.kind, url: c.url, page_url: pageUrl, title: c.alt || null, bytes: img.bytes.length, width: img.width, height: img.height, sha256: sha, weight: c.weight })
    if (seq === null) return null
    const file = `${seq}.${img.ext}`
    fs.writeFileSync(path.join(dir, file), img.bytes, { mode: 0o600 })
    try { this.db.query('UPDATE onboarding_brand_assets SET file = ? WHERE chat_id = ? AND seq = ?').run(file, this.chatId, seq) } catch { return null }
    return img
  }

  private insert(r: Partial<BrandAssetRow> & Pick<BrandAssetRow, 'kind' | 'url' | 'weight'>): number | null {
    try {
      const seq = ((this.db.query('SELECT max(seq) AS m FROM onboarding_brand_assets WHERE chat_id = ?').get(this.chatId) as { m: number | null }).m ?? 0) + 1
      this.db.query(`INSERT INTO onboarding_brand_assets (chat_id, seq, kind, url, page_url, title, bytes, width, height, sha256, text, weight, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(this.chatId, seq, r.kind, r.url.slice(0, 2000), r.page_url ?? null, r.title?.slice(0, 300) ?? null,
        r.bytes ?? null, r.width ?? null, r.height ?? null, r.sha256 ?? null, r.text ?? null, r.weight, new Date().toISOString())
      return seq
    } catch (err) {
      if (!/no such table/.test(String((err as Error)?.message))) this.o.log.warn('brand asset row not written', { err })
      return null
    }
  }
}

/** What a draft chat collected so far (GET draft): images kept, whether a logo is among them, and the colours. */
export function brandAssetsOf(db: Database, chatId: string): { images: number; logo: boolean; colors: string[] } {
  try {
    const rows = db.query("SELECT kind, url, weight FROM onboarding_brand_assets WHERE chat_id = ? AND (kind = 'color' OR file IS NOT NULL)").all(chatId) as { kind: string; url: string; weight: number }[]
    return {
      images: rows.filter((r) => r.kind === 'logo' || r.kind === 'image').length,
      logo: rows.some((r) => r.kind === 'logo'),
      colors: rankColors(rows.filter((r) => r.kind === 'color').map((r) => ({ hex: r.url, weight: r.weight }))),
    }
  } catch { return { images: 0, logo: false, colors: [] } }
}

/** The kept images of a draft chat (logo first, then by weight) and the pages it read, for placing them. */
export function stagedAssets(db: Database, chatId: string): { images: BrandAssetRow[]; pages: BrandAssetRow[] } {
  try {
    const rows = db.query('SELECT * FROM onboarding_brand_assets WHERE chat_id = ? ORDER BY seq').all(chatId) as BrandAssetRow[]
    return {
      images: rows.filter((r) => (r.kind === 'logo' || r.kind === 'image') && r.file).sort((a, b) => (a.kind === 'logo' ? -1 : b.kind === 'logo' ? 1 : b.weight - a.weight)),
      pages: rows.filter((r) => r.kind === 'page'),
    }
  } catch { return { images: [], pages: [] } }
}

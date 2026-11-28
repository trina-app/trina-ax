// The team logo from the company website (docs/decisions/20261128-team-icon-from-site.md). The 회사 소개 step reads
// the website; its square app icon can be the team logo (the top left of the rail, admin/team-icon.ts) without the owner
// finding and uploading a file. This is the picker: a square icon for a 36 px tile, not the document logo that
// brand-assets.ts ranks for a deck (a JSON-LD wordmark beats the app icon there, and is often wide).
//
// Where it looks, in order (the first candidate that passes wins):
//   1. the web app manifest's icons ("any" before "maskable", largest first),
//   2. apple-touch-icon (largest first; the site root's /apple-touch-icon.png when the page names none),
//   3. <link rel="icon"> of at least 64 px or without sizes (never sizes="any": that is SVG),
//   4. the JSON-LD / og:logo logo, or an <img> in the page's header whose class, id or file name says logo (never its
//      alt text alone: product photos are described as "… Logo Hoodie"), only when it is near-square by its bytes,
//   5. the page's .ico or the site root's /favicon.ico: its largest embedded PNG of at least 64 px.
// Never SVG (an SVG can carry scripts and we do not rasterise one) and never og:image / twitter:image (a banner).
//
// Network: only fetchBytes (web_fetch's rules: public addresses only, this server's exit address refused, the
// connection pinned to the checked address, every redirect hop checked again, ports 80 and 443, no cookies). Only
// addresses the site's own markup or manifest names, plus its fixed /favicon.ico and /apple-touch-icon.png; never an
// address the AI wrote or the request carries. Budget: one manifest (64 KiB) and at most six images (6 MiB each on the
// wire), 30 s in all. What is kept is decided by the bytes (imageInfo), never the content type or the name: PNG, JPEG or
// WebP, at least 64 px on the short side (no upscaling: a 16–48 px favicon is no logo), long/short at most 1.25, at
// most 40 megapixels before any decode. The isolated ffmpeg (memory-capped) crops it square, scales it to 256 px (never
// up), puts a see-through mark on a white or near-black tile by its brightness and writes a fresh PNG; without ffmpeg
// only an original that is already near-square, at most 1 MiB and cannot be see-through is used. The result passes
// checkTeamIcon exactly as an upload does.
import { checkTeamIcon, imageInfo, TEAM_ICON_MAX_BYTES, type TeamIconType } from '@mycel/shared'
import { which } from '../config'
import { mayHaveAlpha } from '../uploads/image'
import { attrsOf, BRAND_IMAGE_BYTES, ffmpegPipe, fetchBytes, largestSrc, MAX_PIXELS, startTags, type NetOptions } from './brand-assets'

/** The short side an icon needs (32 px passes checkTeamIcon but is blurry at 72 device pixels). */
export const SITE_ICON_MIN_SIDE = 64
/** long / short at most: a wordmark cropped square reads as random letters at 36 px. */
export const SITE_ICON_MAX_RATIO = 1.25
/** The side of the stored icon (never scaled up to it). */
export const SITE_ICON_SIDE = 256
export const SITE_ICON_MANIFEST_BYTES = 64 * 1024
/** Image fetches per pick, at most (the manifest is one more). */
export const SITE_ICON_IMAGE_FETCHES = 6
/** All the fetches of one pick, at most. */
export const SITE_ICON_TOTAL_MS = 30_000
const FETCH_MS = 12_000
const HOME_BYTES = 3 * 1024 * 1024
const ICO_ENTRIES_MAX = 16
const MANIFEST_ICONS_MAX = 32
/** A see-through mark darker than this (mean luminance of its opaque pixels, 0..1) goes on white, else on near-black. */
const DARK_MARK = 0.6
const TILE_LIGHT = [0xff, 0xff, 0xff] as const
const TILE_DARK = [0x1d, 0x19, 0x16] as const

export type IconSource = 'manifest' | 'apple' | 'icon' | 'logo' | 'ico'
export interface IconCandidate { url: string; source: IconSource; size: number }
export interface SiteIcon { bytes: Uint8Array<ArrayBuffer>; type: TeamIconType; width: number; height: number; url: string; source: IconSource }

/** An absolute http(s) address from a reference, or null (data:, javascript:, broken, too long). */
function absolute(raw: string | undefined, base: URL): string | null {
  const s = (raw ?? '').trim()
  if (!s || /^(data|blob|javascript|about|mailto|tel):/i.test(s)) return null
  try {
    const u = new URL(s, base)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    u.hash = ''
    return u.href.length > 2000 ? null : u.href
  } catch { return null }
}
const pathOf = (url: string) => { try { return new URL(url).pathname.toLowerCase() } catch { return '' } }
const isSvgUrl = (url: string) => pathOf(url).endsWith('.svg') || pathOf(url).endsWith('.svgz')
const isIcoUrl = (url: string) => pathOf(url).endsWith('.ico')

/** The largest size of a `sizes` attribute ("16x16 32x32" → 32); -1 for "any"; 0 without one. */
export function parseSizes(raw: string | undefined): number {
  const s = (raw ?? '').trim().toLowerCase()
  if (!s) return 0
  if (s.split(/\s+/).includes('any')) return -1
  let best = 0
  for (const part of s.split(/\s+/).slice(0, 20)) {
    const m = /^(\d{1,5})x(\d{1,5})$/.exec(part)
    if (m) best = Math.max(best, Math.min(Number(m[1]), Number(m[2])))
  }
  return best
}

const bySize = (a: IconCandidate, b: IconCandidate) => (b.size || 0) - (a.size || 0)
/** A logo by the page's structure: the class, id or file name says so. Never the alt text alone: a shop's product
 * photo is often described as "… Logo Hoodie" (QA 2026-11-28: a portrait product photo passed as the logo). */
const LOGO_MARK = /(^|[^a-z])(logo|brand[-_]?mark|symbol)([^a-z]|$)|로고/i
/** an <img> logo is looked for among the page's first tags only (its header), as brand-assets.ts weighs it */
const LOGO_TAGS_MAX = 400

/**
 * What a page offers as a square icon, best first (manifest icons come after the manifest is fetched), and its
 * manifest's address. Pure: no fetch. `<base href>` is followed for relative addresses; the root fallbacks are on the
 * page's own origin.
 */
export function iconCandidates(html: string, pageUrl: string): { manifest: string | null; candidates: IconCandidate[] } {
  const page = new URL(pageUrl)
  const text = html.slice(0, 3 * 1024 * 1024)
  let base = page
  for (const tag of startTags(text)) {
    if (tag.name !== 'base') continue
    const href = absolute(attrsOf(tag.attrs).href, page)
    if (href) base = new URL(href)
    break
  }
  let manifest: string | null = null
  const apple: IconCandidate[] = [], icon: IconCandidate[] = [], ico: IconCandidate[] = [], logos: IconCandidate[] = []
  let order = 0
  for (const tag of startTags(text)) {
    order++
    if (tag.name === 'meta') {
      const a = attrsOf(tag.attrs)
      const key = (a.property ?? a.name ?? a.itemprop ?? '').toLowerCase()
      const url = key === 'og:logo' || key === 'logo' ? absolute(a.content, base) : null
      if (url) logos.push({ url, source: 'logo', size: 0 })
      continue
    }
    if (tag.name === 'img' && order <= LOGO_TAGS_MAX) {
      const a = attrsOf(tag.attrs)
      const src = largestSrc(a.srcset ?? a['data-srcset'] ?? '') ?? a['data-src'] ?? a['data-lazy-src'] ?? a.src
      const url = absolute(src, base)
      if (url && LOGO_MARK.test(`${a.class ?? ''} ${a.id ?? ''} ${pathOf(url).split('/').pop() ?? ''}`)) logos.push({ url, source: 'logo', size: 0 })
      continue
    }
    if (tag.name !== 'link') continue
    const a = attrsOf(tag.attrs)
    const rel = (a.rel ?? '').toLowerCase().split(/\s+/)
    const url = absolute(a.href, base)
    if (!url) continue
    const type = (a.type ?? '').toLowerCase()
    if (rel.includes('manifest')) { manifest ??= url; continue }
    if (isSvgUrl(url) || type.includes('svg')) continue
    const size = parseSizes(a.sizes)
    if (rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed')) { apple.push({ url, source: 'apple', size: size > 0 ? size : 180 }); continue }
    if (!rel.includes('icon')) continue
    if (size < 0) continue
    if (isIcoUrl(url) || type.includes('icon')) { ico.push({ url, source: 'ico', size }); continue }
    if (size === 0 || size >= SITE_ICON_MIN_SIDE) icon.push({ url, source: 'icon', size })
  }
  const origin = page.origin
  if (!apple.length) apple.push({ url: `${origin}/apple-touch-icon.png`, source: 'apple', size: 180 })
  if (!ico.length) ico.push({ url: `${origin}/favicon.ico`, source: 'ico', size: 0 })
  // the JSON-LD organization's logo first (the company says it is its logo), then og:logo and the <img> logos
  for (const m of text.matchAll(/"logo"\s{0,20}:\s{0,20}(?:\{[^{}]{0,400}?"url"\s{0,20}:\s{0,20})?"(https?:[^"\s]{1,1000})"/gi)) {
    const url = absolute(m[1]!.replace(/\\\//g, '/'), base)
    if (url) logos.unshift({ url, source: 'logo', size: 0 })
  }
  const out: IconCandidate[] = []
  const seen = new Set<string>()
  for (const c of [...apple.sort(bySize), ...icon.sort(bySize), ...logos, ...ico.sort(bySize)]) {
    if (seen.has(c.url) || isSvgUrl(c.url)) continue
    seen.add(c.url)
    out.push(c)
  }
  return { manifest, candidates: out }
}

/** A web app manifest's icons, best first: "any" before "maskable" (a maskable one has a safe-zone margin), largest
 * first; never "monochrome" alone, never SVG, never "any" size, nothing named smaller than 64 px. Bad JSON or no icons: none. */
export function manifestIcons(json: string, manifestUrl: string): IconCandidate[] {
  let raw: unknown
  try { raw = JSON.parse(json) } catch { return [] }
  const icons = (raw && typeof raw === 'object' && Array.isArray((raw as { icons?: unknown }).icons)) ? (raw as { icons: unknown[] }).icons.slice(0, MANIFEST_ICONS_MAX) : []
  let base: URL
  try { base = new URL(manifestUrl) } catch { return [] }
  const any: IconCandidate[] = [], maskable: IconCandidate[] = []
  for (const i of icons) {
    if (!i || typeof i !== 'object') continue
    const { src, sizes, type, purpose } = i as Record<string, unknown>
    if (typeof src !== 'string') continue
    const url = absolute(src, base)
    if (!url || isSvgUrl(url)) continue
    const t = typeof type === 'string' ? type.toLowerCase() : ''
    if (t && !['image/png', 'image/webp', 'image/jpeg', 'image/jpg'].includes(t)) continue
    const size = parseSizes(typeof sizes === 'string' ? sizes : '')
    if (size < 0 || (size > 0 && size < SITE_ICON_MIN_SIDE)) continue
    const p = (typeof purpose === 'string' ? purpose : '').toLowerCase().split(/\s+/).filter(Boolean)
    // "monochrome" alone is a one-colour silhouette for the system to tint, not the brand's mark
    if (p.length > 0 && !p.includes('any') && !p.includes('maskable')) continue
    ;(p.length === 0 || p.includes('any') ? any : maskable).push({ url, source: 'manifest', size })
  }
  return [...any.sort(bySize), ...maskable.sort(bySize)]
}

const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8)
const u32le = (b: Uint8Array, i: number) => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)) + b[i + 3]! * 0x1000000
export const isIco = (b: Uint8Array) => b.length >= 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0

/**
 * The largest embedded PNG of an ICO file whose short side is at least 64 px, or null. Pure bytes, bounds-checked: at
 * most 16 entries, every offset and length inside the buffer, a malformed directory is no icon (never a throw).
 * BMP entries (the 16–48 px favicons) are skipped.
 */
export function icoPngEntry(b: Uint8Array): Uint8Array<ArrayBuffer> | null {
  if (!isIco(b)) return null
  const count = u16le(b, 4)
  if (count === 0 || count > ICO_ENTRIES_MAX || 6 + 16 * count > b.length) return null
  let best: { at: number; len: number; side: number } | null = null
  for (let k = 0; k < count; k++) {
    const e = 6 + 16 * k
    const len = u32le(b, e + 8), at = u32le(b, e + 12)
    if (len < 33 || at < 6 + 16 * count || at + len > b.length) continue
    const info = imageInfo(b.subarray(at, at + len))
    if (!info || info.type !== 'image/png') continue
    const side = Math.min(info.width, info.height)
    if (side >= SITE_ICON_MIN_SIDE && (!best || side > best.side)) best = { at, len, side }
  }
  return best ? new Uint8Array(b.slice(best.at, best.at + best.len)) : null
}

export type IconVerdict = { ok: true; type: TeamIconType; width: number; height: number } | { ok: false; why: 'type' | 'huge' | 'small' | 'shape' }

/** Is it a usable square icon, by its bytes alone: PNG / JPEG / WebP, at most 40 MP, short side at least 64 px,
 * long/short at most 1.25. */
export function judgeIcon(b: Uint8Array): IconVerdict {
  const info = imageInfo(b)
  if (!info) return { ok: false, why: 'type' }
  if (info.width * info.height > MAX_PIXELS) return { ok: false, why: 'huge' }
  const short = Math.min(info.width, info.height), long = Math.max(info.width, info.height)
  if (short < SITE_ICON_MIN_SIDE) return { ok: false, why: 'small' }
  if (long / short > SITE_ICON_MAX_RATIO) return { ok: false, why: 'shape' }
  return { ok: true, ...info }
}

const EXT: Record<TeamIconType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }

/** The mean luminance (0..1) of the opaque pixels of RGBA pixels, and whether any pixel is see-through; null for a
 * picture with no opaque pixel. */
export function markLook(rgba: Uint8Array): { seeThrough: boolean; luminance: number } | null {
  let n = 0, sum = 0, see = false
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const a = rgba[i + 3]!
    if (a < 250) see = true
    if (a < 160) continue
    n++
    sum += (0.2126 * rgba[i]! + 0.7152 * rgba[i + 1]! + 0.0722 * rgba[i + 2]!) / 255
  }
  return n ? { seeThrough: see, luminance: sum / n } : null
}

/**
 * The icon as the team logo: square, at most 256 px, a see-through mark on a tile, a fresh PNG (no metadata, no bytes
 * of the original survive), by the isolated ffmpeg. Without ffmpeg (`ffmpeg` null) the original when it cannot be
 * see-through and is at most 1 MiB, else null. The caller has judged it (judgeIcon) first.
 */
export async function normaliseIcon(b: Uint8Array, info: { type: TeamIconType; width: number; height: number }, ffmpeg: string | null = which('ffmpeg')): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: TeamIconType } | null> {
  const alpha = mayHaveAlpha(b.subarray(0, 64 * 1024))
  if (!ffmpeg) return !alpha && b.byteLength <= TEAM_ICON_MAX_BYTES ? { bytes: new Uint8Array(b), type: info.type } : null
  const ext = EXT[info.type]
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength)
  const side = Math.min(SITE_ICON_SIDE, info.width, info.height)
  const square = `crop='min(iw,ih)':'min(iw,ih)'`
  let vf = `${square},scale=${side}:${side}:flags=lanczos,format=rgb24`
  if (alpha) {
    const raw = await ffmpegPipe(buf, ext, ['-frames:v', '1', '-vf', 'scale=32:32:flags=neighbor', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], 32 * 32 * 4 + 1024, ffmpeg)
    if (!raw || raw.length < 32 * 32 * 4) return null
    const look = markLook(raw.subarray(0, 32 * 32 * 4))
    if (!look) return null
    if (look.seeThrough) {
      const [r, g, bl] = look.luminance < DARK_MARK ? TILE_LIGHT : TILE_DARK
      const inner = Math.max(2, Math.round(side * 0.8)), pad = Math.floor((side - inner) / 2)
      // the mark scaled into the middle 80 %, laid over a copy of the frame painted the tile's colour
      vf = `format=rgba,${square},scale=${inner}:${inner}:flags=lanczos,pad=${side}:${side}:${pad}:${pad}:color=black@0,split[m][t];[t]lutrgb=r=${r}:g=${g}:b=${bl}:a=255[bg];[bg][m]overlay=format=auto,format=rgb24`
    }
  }
  const out = await ffmpegPipe(buf, ext, ['-frames:v', '1', '-vf', vf, '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], 2 * 1024 * 1024, ffmpeg)
  if (!out) return null
  const got = imageInfo(out)
  if (!got || got.type !== 'image/png' || got.width !== got.height) return null
  return { bytes: new Uint8Array(out), type: 'image/png' }
}

export interface PickOptions {
  /** the isolated ffmpeg (default: which('ffmpeg')); null: none */
  ffmpeg?: string | null
  /** epoch ms: nothing is fetched after this (default: 30 s from now) */
  deadline?: number
  /** tests: the time limit of one fetch */
  fetchMs?: number
  /** how many fetches were made (tests) */
  onFetch?: (url: string) => void
}

/** Fetch with web_fetch's rules, within the pick's deadline. */
async function get(url: string, max: number, net: NetOptions, deadline: number, o: PickOptions): Promise<Buffer | null> {
  const left = deadline - Date.now()
  if (left <= 0) return null
  o.onFetch?.(url)
  try { return (await fetchBytes(url, max, { ...net, timeoutMs: Math.min(o.fetchMs ?? FETCH_MS, left) })).body } catch { return null }
}

/** The best square icon of a page (its markup and address), or null. At most one manifest and six image fetches, 30 s. */
export async function pickSiteIcon(html: string, pageUrl: string, net: NetOptions, o: PickOptions = {}): Promise<SiteIcon | null> {
  const deadline = o.deadline ?? Date.now() + SITE_ICON_TOTAL_MS
  const ffmpeg = o.ffmpeg === undefined ? which('ffmpeg') : o.ffmpeg
  let found: ReturnType<typeof iconCandidates>
  try { found = iconCandidates(html, pageUrl) } catch { return null }
  const list: IconCandidate[] = []
  if (found.manifest) {
    const body = await get(found.manifest, SITE_ICON_MANIFEST_BYTES, net, deadline, o)
    if (body) list.push(...manifestIcons(body.toString('utf8'), found.manifest))
  }
  const seen = new Set<string>()
  let fetches = 0
  for (const c of [...list, ...found.candidates]) {
    if (seen.has(c.url) || isSvgUrl(c.url)) continue
    seen.add(c.url)
    if (fetches >= SITE_ICON_IMAGE_FETCHES || Date.now() >= deadline) break
    fetches++
    let bytes: Uint8Array | null = await get(c.url, BRAND_IMAGE_BYTES, net, deadline, o)
    if (!bytes) continue
    if (isIco(bytes)) bytes = icoPngEntry(bytes)
    if (!bytes) continue
    const v = judgeIcon(bytes)
    if (!v.ok) continue
    const n = await normaliseIcon(bytes, v, ffmpeg)
    if (!n) continue
    const check = checkTeamIcon(n.bytes, n.type)
    if (!check.ok) continue
    return { bytes: n.bytes, type: check.type, width: check.width, height: check.height, url: c.url, source: c.source }
  }
  return null
}

/** The admin button: the website's home page (web_fetch's rules), then its icon. A home page that does not open (a bot
 * check, a 403) still gets the site root's /apple-touch-icon.png and /favicon.ico tried. */
export async function fetchSiteIcon(website: string, net: NetOptions, o: PickOptions = {}): Promise<SiteIcon | null> {
  const deadline = o.deadline ?? Date.now() + SITE_ICON_TOTAL_MS
  let html = '', pageUrl = website
  const left = deadline - Date.now()
  o.onFetch?.(website)
  try {
    const r = await fetchBytes(website, HOME_BYTES, { ...net, timeoutMs: Math.min(o.fetchMs ?? FETCH_MS, left) })
    pageUrl = r.url
    // a page, not a picture or a file (judged by the bytes, never the type)
    if (!imageInfo(r.body) && !isIco(r.body)) html = r.body.toString('utf8')
  } catch { /* the root fallbacks below */ }
  return pickSiteIcon(html, pageUrl, net, { ...o, deadline })
}

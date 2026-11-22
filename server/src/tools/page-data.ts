// What a page's own markup says about it when its visible text is almost nothing (a site that draws everything with
// JavaScript: a Vite or Create React App shell, a client-rendered Next.js, Nuxt or site-builder page). web_fetch adds it
// below such a page's text (tools/web-fetch.ts), so the AI reading it (a company profile draft, onboarding/draft.ts, or
// any chat) has more than the title: the meta description, the Open Graph and Twitter card, names and descriptions in
// JSON-LD, and the prose strings of an embedded data blob (Next.js __NEXT_DATA__, the App Router's RSC payload, Nuxt's
// __NUXT_DATA__). Every line is a string copied from the page as it is written there (entities decoded), so a quote of it
// is a true quote of the page. Nothing is fetched and nothing runs here.
//
// Pages come from anyone: one forward scan with indexOf (no backtracking regex over the page), the markup looked at
// capped (SCAN_MAX), each blob parsed at most BLOB_MAX, the JSON walked to a bounded depth and count, and the result capped
// in characters (PAGE_DATA_MAX).
//
// sitemapPages: the likely pages of a site from its sitemap.xml (for a company profile draft, web_fetch's sitePages).
import { decodeEntities } from './web-fetch'

/** Visible text of fewer characters than this (spaces not counted): the page shows almost nothing without its scripts. */
export const THIN_TEXT_CHARS = 200
export const PAGE_DATA_MAX = 6000
const SCAN_MAX = 3 * 1024 * 1024
const BLOB_MAX = 1024 * 1024
const BLOBS_MAX = 20
const WALK_MAX = 20_000
const DEPTH_MAX = 40
const STRING_MAX = 1000
const META_ATTRS_MAX = 4000

/** Visible text so short the page needs its scripts to show anything. */
export const thinText = (text: string) => text.replace(/\s+/g, '').length < THIN_TEXT_CHARS

/** The value of one attribute in a tag's attributes (quoted or not), or null. Linear: one indexOf walk per name. */
export function attrOf(attrs: string, name: string): string | null {
  const low = attrs.toLowerCase()
  let from = 0
  for (;;) {
    const i = low.indexOf(name, from)
    if (i < 0) return null
    from = i + name.length
    const before = i === 0 ? ' ' : low[i - 1]!
    if (!/[\s"'/]/.test(before)) continue
    let j = from
    while (j < low.length && /\s/.test(low[j]!)) j++
    if (low[j] !== '=') continue
    j++
    while (j < low.length && /\s/.test(low[j]!)) j++
    const q = attrs[j]
    if (q === '"' || q === "'") { const e = attrs.indexOf(q, j + 1); return e < 0 ? null : decodeEntities(attrs.slice(j + 1, e)) }
    let e = j
    while (e < attrs.length && !/[\s>]/.test(attrs[e]!)) e++
    return decodeEntities(attrs.slice(j, e))
  }
}

/** One line of text as it is shown: runs of spaces one space, trimmed, at most STRING_MAX characters. */
const tidy = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, STRING_MAX)

/** Is this string prose a person reads (not an id, an address, a class name, a colour, code)? */
export function proseLike(s: string): boolean {
  const t = s.trim()
  if (t.length < 4) return false
  const letters = (t.match(/\p{L}/gu) ?? []).length
  if (letters < 3) return false
  if (/^(?:https?:|mailto:|tel:|data:|\/|#|\.\.?\/)/i.test(t)) return false
  // one word in code style: an id, a key, a class list, a file name
  if (!/\s/.test(t) && !/[぀-鿿가-힣]/.test(t) && (/[_$./\\=:{}<>]|[a-z][A-Z]|\d/.test(t) || t.length > 30)) return false
  // markup or code
  if (/[{}<>]|=>|function\s*\(|\$\{/.test(t)) return false
  // a class list ("flex items-center px-4")
  if (/^[a-z0-9:_\-/[\]. ]+$/.test(t) && /(?:^|\s)[a-z]+-[a-z0-9]/.test(t) && !/[.!?]$/.test(t)) return false
  return true
}

/** Keys of embedded data whose strings are never prose (ids, addresses, styles, technical fields). */
const SKIP_KEY = /^(?:id|_id|key|slug|href|url|uri|src|srcset|image|images|img|icon|logo|thumbnail|avatar|video|file|path|pathname|route|asPath|query|className|class|style|styles|color|colour|variant|type|__typename|_type|locale|locales|defaultLocale|buildId|runtimeConfig|assetPrefix|scriptLoader|gssp|gsp|isFallback|dynamicIds|appGip|nextExport|autoExport|mimeType|format|width|height|createdAt|updatedAt|publishedAt|date|datetime|email|phone|hash|token|sha|etag|version|lang|dir|target|rel|component|template|layout|font|fontFamily)$/i

/** Prose strings of a JSON value, in order, without repeats: walked to DEPTH_MAX, at most WALK_MAX values looked at. */
export function proseStrings(v: unknown, out: string[] = [], seen = new Set<string>()): string[] {
  let looked = 0
  const walk = (x: unknown, depth: number, key: string) => {
    if (looked++ > WALK_MAX || depth > DEPTH_MAX) return
    if (typeof x === 'string') {
      if (SKIP_KEY.test(key) || !proseLike(x)) return
      const s = tidy(x)
      const k = s.toLowerCase()
      if (seen.has(k)) return
      seen.add(k)
      out.push(s)
      return
    }
    if (!x || typeof x !== 'object') return
    if (Array.isArray(x)) { for (const y of x) walk(y, depth + 1, key); return }
    for (const [k, y] of Object.entries(x as Record<string, unknown>)) walk(y, depth + 1, k)
  }
  walk(v, 0, '')
  return out
}

/** JSON-LD: the names, alternate names, descriptions and slogans of the things a site says it is or sells, each value on
 * its own line exactly as written there (no labels or joins added: a quote of a line is a quote of the page). */
export function jsonLdLines(v: unknown): string[] {
  const out: string[] = []
  let looked = 0
  const str = (x: unknown) => (typeof x === 'string' ? tidy(decodeEntities(x)) : Array.isArray(x) && typeof x[0] === 'string' ? tidy(decodeEntities(x[0])) : '')
  const walk = (x: unknown, depth: number) => {
    if (looked++ > WALK_MAX || depth > DEPTH_MAX || !x || typeof x !== 'object') return
    if (Array.isArray(x)) { for (const y of x) walk(y, depth + 1); return }
    const o = x as Record<string, unknown>
    for (const x of [str(o.name) || str(o.headline), str(o.alternateName), str(o.description), str(o.slogan), str(o.disambiguatingDescription)]) {
      if (x.length >= 2 && !out.includes(x)) out.push(x)
    }
    for (const [k, y] of Object.entries(o)) {
      if (k === '@context' || k === '@id' || k === '@type' || SKIP_KEY.test(k)) continue
      if (y && typeof y === 'object') walk(y, depth + 1)
    }
  }
  walk(v, 0)
  return out
}

/** The App Router's RSC payload (self.__next_f.push([1,"..."])): the text children of its elements. */
export function rscStrings(script: string, out: string[], seen: Set<string>): void {
  let from = 0
  for (let n = 0; n < BLOBS_MAX * 10; n++) {
    const i = script.indexOf('__next_f.push(', from)
    if (i < 0) return
    const end = script.indexOf('])', i)
    if (end < 0) return
    from = end + 2
    let arr: unknown
    try { arr = JSON.parse(script.slice(i + '__next_f.push('.length, end + 1)) } catch { continue }
    const payload = Array.isArray(arr) && typeof arr[1] === 'string' ? arr[1] : ''
    if (!payload) continue
    // "children":"text" pairs; the alternation cannot overlap (no backtracking)
    for (const m of payload.slice(0, BLOB_MAX).matchAll(/"children":"((?:[^"\\]|\\.){1,2000})"/g)) {
      let s: string
      try { s = JSON.parse(`"${m[1]}"`) as string } catch { continue }
      if (!proseLike(s)) continue
      const t = tidy(s)
      if (seen.has(t.toLowerCase())) continue
      seen.add(t.toLowerCase())
      out.push(t)
    }
  }
}

/** Nuxt 3's __NUXT_DATA__: a flat JSON array of values (references are numbers), its strings in order. */
const nuxtStrings = (v: unknown, out: string[], seen: Set<string>) => {
  if (!Array.isArray(v)) return
  for (const x of v.slice(0, WALK_MAX)) {
    if (typeof x !== 'string' || !proseLike(x)) continue
    const t = tidy(x)
    if (seen.has(t.toLowerCase())) continue
    seen.add(t.toLowerCase())
    out.push(t)
  }
}

const parse = (s: string): unknown => { try { return JSON.parse(s) } catch { return undefined } }

/**
 * The lines a page's markup gives about it, under their headings; '' when it gives nothing. Linear in the page, capped
 * at `max` characters (cut at a line).
 */
export function pageData(html: string, max = PAGE_DATA_MAX): string {
  const h = html.length > SCAN_MAX ? html.slice(0, SCAN_MAX) : html
  const low = h.toLowerCase()
  const meta: Record<string, string> = {}
  const ld: string[] = []
  const blob: string[] = []
  const seen = new Set<string>()
  let blobs = 0
  let i = 0
  for (;;) {
    const lt = low.indexOf('<', i)
    if (lt < 0) break
    i = lt + 1
    if (low.startsWith('<meta', lt) && /[\s/>]/.test(low[lt + 5] ?? '')) {
      const gt = low.indexOf('>', lt)
      if (gt < 0) break
      const attrs = h.slice(lt + 5, Math.min(gt, lt + 5 + META_ATTRS_MAX))
      i = gt + 1
      const key = (attrOf(attrs, 'property') ?? attrOf(attrs, 'name') ?? '').toLowerCase().trim()
      const content = attrOf(attrs, 'content')
      if (key && content && !(key in meta)) meta[key] = tidy(content)
      continue
    }
    if (low.startsWith('<script', lt) && /[\s>]/.test(low[lt + 7] ?? '')) {
      const gt = low.indexOf('>', lt)
      if (gt < 0) break
      const attrs = h.slice(lt + 7, gt)
      const close = low.indexOf('</script', gt)
      const end = close < 0 ? h.length : close
      i = end
      if (blobs >= BLOBS_MAX) continue
      const body = h.slice(gt + 1, Math.min(end, gt + 1 + BLOB_MAX))
      const type = (attrOf(attrs, 'type') ?? '').toLowerCase()
      const id = attrOf(attrs, 'id') ?? ''
      if (type === 'application/ld+json') { blobs++; const v = parse(body.trim()); if (v !== undefined) ld.push(...jsonLdLines(v)) }
      else if (id === '__NEXT_DATA__') { blobs++; const v = parse(body.trim()) as { props?: unknown } | undefined; if (v) proseStrings(v.props ?? v, blob, seen) }
      else if (id === '__NUXT_DATA__') { blobs++; nuxtStrings(parse(body.trim()), blob, seen) }
      else if (body.includes('__next_f.push(')) { blobs++; rscStrings(body, blob, seen) }
    }
  }
  const sections: [string, string[]][] = []
  const said = new Set<string>()
  const once = (s: string | undefined) => { if (!s) return ''; const k = s.toLowerCase(); if (said.has(k)) return ''; said.add(k); return s }
  // each value on its own line as the page writes it: no labels or joins, so a quote of a line is page text
  const head = [meta.description, meta['og:site_name'], meta['og:title'] ?? meta['twitter:title'], meta['og:description'] ?? meta['twitter:description'], meta.keywords].map(once).filter(Boolean)
  if (head.length) sections.push(['From the page head (description, social card, keywords)', head])
  const ldU = [...new Set(ld)].filter((x) => !said.has(x.toLowerCase()))
  if (ldU.length) sections.push(['Structured data (JSON-LD)', ldU])
  const blobU = blob.filter((s) => !said.has(s.toLowerCase()))
  if (blobU.length) sections.push(['Text in the page\'s embedded data', blobU])
  if (!sections.length) return ''
  const lines: string[] = []
  let used = 0
  for (const [title, rows] of sections) {
    const t = `## ${title}`
    if (used + t.length + 1 > max) break
    lines.push(t)
    used += t.length + 1
    for (const r of rows) {
      const line = `- ${r}`
      if (used + line.length + 1 > max) { used = max; break }
      lines.push(line)
      used += line.length + 1
    }
    if (used >= max) break
  }
  return lines.join('\n')
}

/** Paths that usually describe the company, its products or its customers, best first. */
const LIKELY = [
  /(?:^|[/_-])(?:about|about-us|company|corporate|intro|introduction|who-we-are|overview|회사소개|회사|소개|기업소개|会社概要|会社|关于|关于我们|tentang|empresa|nosotros)(?:$|[/_.-])/i,
  /(?:^|[/_-])(?:services?|products?|solutions?|business|offerings?|features|pricing|서비스|제품|사업|솔루션|事業|サービス|製品|产品|服务|layanan|produk|servicios|productos)(?:$|[/_.-])/i,
  /(?:^|[/_-])(?:customers?|clients?|cases?|case-studies|portfolio|works?|references?|success|고객|사례|포트폴리오|導入事例|案例|klien|clientes)(?:$|[/_.-])/i,
  /(?:^|[/_-])(?:team|brand|mission|vision|story|history|팀|브랜드|연혁)(?:$|[/_.-])/i,
]
/** Pages that are rarely about the company itself. */
const UNLIKELY = /(?:^|\/)(?:blog|news|article|articles|post|posts|tag|tags|category|categories|author|search|login|signin|signup|register|cart|checkout|account|privacy|terms|policy|legal|cookie|refund|faq|contact|careers?|jobs?|recruit|event|events|notice|board|press|feed)(?:$|[/_.-])/i
export const SITEMAP_PAGES_MAX = 10
const SITEMAP_LOCS_MAX = 5000

/** The <loc> addresses of a sitemap (or a sitemap index), in order, at most SITEMAP_LOCS_MAX. Linear. */
export function sitemapLocs(xml: string): { index: boolean; locs: string[] } {
  const index = /<sitemapindex[\s>]/i.test(xml.slice(0, 4096))
  const locs: string[] = []
  let i = 0
  while (locs.length < SITEMAP_LOCS_MAX) {
    const a = xml.indexOf('<loc>', i)
    if (a < 0) break
    const b = xml.indexOf('</loc>', a + 5)
    if (b < 0) break
    i = b + 6
    const v = decodeEntities(xml.slice(a + 5, Math.min(b, a + 5 + 2000)).replace(/^<!\[CDATA\[|\]\]>$/g, '').trim())
    if (v) locs.push(v)
  }
  return { index, locs }
}

/** Up to `max` pages of the same host as `base` that likely describe the company (LIKELY first, then other short paths;
 * never the page itself, a query, a file or an UNLIKELY section). */
export function sitemapPages(locs: readonly string[], base: URL, max = SITEMAP_PAGES_MAX): string[] {
  const host = base.hostname.toLowerCase()
  const seen = new Set<string>([base.origin + base.pathname.replace(/\/$/, '')])
  const scored: { url: string; score: number; depth: number; at: number }[] = []
  locs.forEach((raw, at) => {
    let u: URL
    try { u = new URL(raw) } catch { return }
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.hostname.toLowerCase() !== host || u.username || u.password || u.port !== base.port) return
    if (u.search) return
    let path: string
    try { path = decodeURIComponent(u.pathname) } catch { path = u.pathname }
    if (/\.(?:xml|pdf|jpe?g|png|gif|webp|svg|zip|txt|json|js|css)$/i.test(path)) return
    const key = u.origin + u.pathname.replace(/\/$/, '')
    if (seen.has(key)) return
    seen.add(key)
    const depth = path.split('/').filter(Boolean).length
    if (!depth || UNLIKELY.test(path)) return
    const hit = LIKELY.findIndex((r) => r.test(path))
    if (hit < 0 && depth > 1) return
    scored.push({ url: u.href, score: hit < 0 ? LIKELY.length : hit, depth, at })
  })
  scored.sort((a, b) => a.score - b.score || a.depth - b.depth || a.at - b.at)
  return scored.slice(0, max).map((s) => s.url)
}

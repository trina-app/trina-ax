// What the longer deck tiers read from the web (tiers.ts; docs/DECISIONS.md "D2", round 2). The server reads, never the
// AI's words alone, so every fact a slide takes from the web is checked against a page the server itself fetched:
//   - the company's own site: pages inside the scope of the website saved in the company profile (a person saved it:
//     like the address typed for the setup draft, onboarding/draft.ts webScope: that host and its subdomains), the
//     pages the AI names plus the site's about, product, case, news and history pages linked from its home page,
//     fetched like web_fetch (public addresses only, this server's exit address refused, redirects kept in scope);
//   - outside articles: only addresses the AI opened with web_fetch in this answer (each went through the URL gate
//     there), fetched again here; their outlet and date go into the speaker notes of every slide that uses them.
import type { AppContext } from '../context'
import type { ToolCtx } from '../files/service'
import { readCompanyProfile } from '../onboarding/profile'
import { inWebScope, webScope } from '../onboarding/draft'
import { redirectGuard } from '../tools/connection-urls'
import { egressOf } from '../tools/egress'
import { TEXT as GATE_TEXT } from '../tools/url-gate'
import { webFetch, wrapExternal, type FetchOptions } from '../tools/web-fetch'

export interface WebPart { url: string; label: string; text: string; kind: 'page' | 'article'; title?: string }
/** Characters kept of each page (the fact check reads them; the AI gets a shorter excerpt). */
export const WEB_TEXT_MAX = 12_000
const EXCERPT = 2_400

const WANT = /(about|company|introduc|intro|overview|story|history|vision|mission|business|product|service|solution|platform|feature|case|customer|client|success|news|press|media|award|brand|ir|investor|회사|기업|소개|연혁|역사|비전|사업|제품|서비스|솔루션|사례|고객|뉴스|보도|소식|수상|브랜드|인증)/i
const SKIP = /(login|logout|signin|sign-in|signup|join|cart|checkout|privacy|terms|policy|cookie|sitemap|search|recruit|career|job|faq|help|support|contact|mailto:|tel:|javascript:|\.(pdf|zip|jpg|jpeg|png|gif|webp|svg|mp4|xlsx?|docx?|pptx?)(\?|$))/i

/** The markup looked at for links (a page's head and first screens; more is never needed for a site's menu). */
export const LINK_HTML_MAX = 256 * 1024
const TAG_MAX = 2000, LABEL_MAX = 400

/** Links of a page inside the scope, the most telling first. Scanned by hand in one pass with bounded lookups (no
 * regular expression over the whole page: an unclosed `<a href` repeated over megabytes must not take seconds). */
export function siteLinks(htmlIn: string, base: URL, inScope: (u: string) => boolean): string[] {
  const html = htmlIn.slice(0, LINK_HTML_MAX)
  const low = html.toLowerCase()
  const n = low.length
  // the next ">" from every position, and every "</a" in order (one pass each)
  const nextGt = new Int32Array(n + 1)
  let nx = -1
  for (let i = n - 1; i >= 0; i--) { if (low.charCodeAt(i) === 62) nx = i; nextGt[i] = nx }
  nextGt[n] = -1
  const closes: number[] = []
  for (let i = low.indexOf('</a', 0); i >= 0; i = low.indexOf('</a', i + 3)) closes.push(i)
  const closeAfter = (pos: number) => { let lo = 0, hi = closes.length; while (lo < hi) { const m = (lo + hi) >> 1; if (closes[m]! < pos) lo = m + 1; else hi = m } return lo < closes.length ? closes[lo]! : -1 }
  const out = new Map<string, number>()
  for (let i = low.indexOf('<a', 0); i >= 0; i = low.indexOf('<a', i + 2)) {
    const c = low.charCodeAt(i + 2)
    if (!(c === 32 || c === 9 || c === 10 || c === 13 || c === 12)) continue
    const gt = nextGt[i + 2]!
    if (gt < 0) break
    if (gt - i > TAG_MAX) continue
    const href = /\bhref\s*=\s*(["'])([^"']{1,2000})\1/i.exec(html.slice(i, gt))?.[2]
    if (!href) continue
    const close = closeAfter(gt)
    const label = close >= 0 && close - gt <= LABEL_MAX ? html.slice(gt + 1, close).replace(/<[^>]{0,400}>/g, ' ') : ''
    let u: URL
    try { u = new URL(href.trim(), base) } catch { continue }
    u.hash = ''
    const url = u.toString()
    if (!inScope(url) || SKIP.test(url) || url === base.toString()) continue
    const score = (WANT.test(u.pathname) ? 2 : 0) + (WANT.test(label) ? 1 : 0) - u.pathname.split('/').filter(Boolean).length * 0.1 - (u.search ? 0.5 : 0)
    if (score <= 0) continue
    out.set(url, Math.max(out.get(url) ?? -Infinity, score))
  }
  return [...out.entries()].sort((a, b) => b[1] - a[1]).map(([u]) => u)
}

/** Fetch options of this server (tests give their own: a local server counts as public). */
export interface WebOptions { fetch?: FetchOptions }

async function fetchText(ctx: AppContext, t: ToolCtx, url: string, inScope: ((u: string) => boolean) | null, o: WebOptions): Promise<{ url: string; title?: string; text: string; html?: string } | null> {
  try {
    const chatId = t.turnId ? (ctx.db.query('SELECT chat_id FROM turns WHERE id = ?').get(t.turnId) as { chat_id: string } | null)?.chat_id ?? null : null
    // a redirect to an address that echoes what the AI sent in this chat is refused here (nobody is asked inside this
    // step), as web_fetch and save_url treat it; a site's page never leaves the site
    const echo = redirectGuard(ctx.db, chatId, url, null, {
      ask: GATE_TEXT.redirectEcho,
      unattended: 'the page redirected to an address that matches what the AI had sent to a tool earlier in this chat, so it was not read',
      declined: 'the page was not read',
    })
    const r = await webFetch(url, {
      ...o.fetch, blockedIps: () => egressOf(ctx).ips, maxChars: WEB_TEXT_MAX, pdftotext: ctx.engineConfig.pdftotext, keepHtml: true,
      onRedirect: async (next: string) => { if (inScope && !inScope(next)) throw new Error('off site'); await echo.check(next) },
    })
    return { url: r.url, title: r.title, text: r.text.slice(0, WEB_TEXT_MAX), html: r.html }
  } catch { return null }
}

/** Up to `max` pages of the company's own site (the home page first). */
export async function readSite(ctx: AppContext, t: ToolCtx, max: number, asked: string[] = [], o: WebOptions & { website?: string } = {}): Promise<{ site: string | null; pages: WebPart[]; refused: string[] }> {
  const profile = (() => { try { return readCompanyProfile(ctx.files, t.user) } catch { return null } })()
  const saved = o.website ?? profile?.website
  const website = saved ? (/^https?:\/\//i.test(saved) ? saved : `https://${saved}`) : null
  const scope = website ? webScope(website) : null
  if (!website || !scope) return { site: null, pages: [], refused: asked }
  const inScope = (u: string) => inWebScope(scope, u)
  const refused = asked.filter((u) => !inScope(u))
  const pages: WebPart[] = []
  const home = await fetchText(ctx, t, website, inScope, o)
  const queue = [...new Set(asked.filter(inScope))]
  if (home) {
    pages.push({ url: home.url, label: home.url, text: home.text, kind: 'page', ...(home.title ? { title: home.title } : {}) })
    if (home.html) for (const u of siteLinks(home.html, new URL(home.url), inScope)) if (!queue.includes(u)) queue.push(u)
  }
  const seen = new Set(pages.map((p) => p.url))
  // four at a time, until the budget is spent
  while (pages.length < max && queue.length) {
    const batch = queue.splice(0, Math.min(4, max - pages.length)).filter((u) => !seen.has(u))
    const got = await Promise.all(batch.map((u) => fetchText(ctx, t, u, inScope, o)))
    for (const g of got) {
      if (!g || seen.has(g.url) || g.text.trim().length < 200) continue
      seen.add(g.url)
      pages.push({ url: g.url, label: g.url, text: g.text, kind: 'page', ...(g.title ? { title: g.title } : {}) })
      if (g.html && queue.length < max * 2) for (const u of siteLinks(g.html, new URL(g.url), inScope)) if (!queue.includes(u) && !seen.has(u)) queue.push(u)
    }
  }
  return { site: scope.label, pages: pages.slice(0, max), refused }
}

/** The outside articles the outline names: each opened with web_fetch in this answer (the very address, compared
 * exactly), read again here. One whose date's year does not appear on the page is dropped with its facts (`dropped`). */
export async function readArticles(ctx: AppContext, t: ToolCtx, list: { url: string; outlet: string; date: string }[], problems: string[], o: WebOptions = {}, dropped: string[] = []): Promise<WebPart[]> {
  const out: WebPart[] = []
  for (const [i, a] of list.entries()) {
    const prefix = `web_fetch ${a.url} -> `
    const opened = t.turnId ? ctx.db.query("SELECT 1 FROM tool_events WHERE turn_id = ? AND tool = 'web_fetch' AND ok = 1 AND (summary = ? OR substr(summary, 1, ?) = ?) LIMIT 1").get(t.turnId, `web_fetch ${a.url}`, prefix.length, prefix) : null
    if (!opened) { problems.push(`web_sources[${i}]: "${a.url}" was not opened with web_fetch in this answer; open it first, or leave the article and its facts out`); continue }
    const r = await fetchText(ctx, t, a.url, null, o)
    if (!r || r.text.trim().length < 200) { problems.push(`web_sources[${i}]: "${a.url}" could not be read again; leave the article and its facts out`); continue }
    const year = /(?:19|20)\d{2}/.exec(a.date)?.[0]
    if (!year || !(r.text.includes(year) || (r.title ?? '').includes(year) || r.url.includes(year))) { dropped.push(`web_sources[${i}] "${a.url}": its date "${a.date}" is not on the page, so the article and its facts are left out`); continue }
    out.push({ url: r.url, label: `${a.outlet} · ${a.date} · ${r.url}`, text: r.text, kind: 'article', ...(r.title ? { title: r.title } : {}) })
  }
  return out
}

/** The pages as the AI is shown them: title, address, an excerpt (external data). */
export function excerpts(pages: WebPart[]): string {
  // each page as quoted external data, exactly as web_fetch hands it over (its own <external_data> tags defused)
  return pages.map((p) => wrapExternal({ url: p.url, ...(p.title ? { title: p.title } : {}), text: p.text.slice(0, EXCERPT), truncated: p.text.length > EXCERPT })).join('\n\n')
}

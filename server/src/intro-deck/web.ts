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
import { egressOf } from '../tools/egress'
import { webFetch } from '../tools/web-fetch'

export interface WebPart { url: string; label: string; text: string; kind: 'page' | 'article'; title?: string }
/** Characters kept of each page (the fact check reads them; the AI gets a shorter excerpt). */
export const WEB_TEXT_MAX = 12_000
const EXCERPT = 2_400

const WANT = /(about|company|introduc|intro|overview|story|history|vision|mission|business|product|service|solution|platform|feature|case|customer|client|success|news|press|media|award|brand|ir|investor|회사|기업|소개|연혁|역사|비전|사업|제품|서비스|솔루션|사례|고객|뉴스|보도|소식|수상|브랜드|인증)/i
const SKIP = /(login|logout|signin|sign-in|signup|join|cart|checkout|privacy|terms|policy|cookie|sitemap|search|recruit|career|job|faq|help|support|contact|mailto:|tel:|javascript:|\.(pdf|zip|jpg|jpeg|png|gif|webp|svg|mp4|xlsx?|docx?|pptx?)(\?|$))/i

/** Links of a page inside the scope, the most telling first. */
export function siteLinks(html: string, base: URL, inScope: (u: string) => boolean): string[] {
  const out = new Map<string, number>()
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let u: URL
    try { u = new URL(m[1]!.trim(), base) } catch { continue }
    u.hash = ''
    const s = u.toString()
    if (!inScope(s) || SKIP.test(s) || s === base.toString()) continue
    const label = m[2]!.replace(/<[^>]+>/g, ' ')
    const score = (WANT.test(u.pathname) ? 2 : 0) + (WANT.test(label) ? 1 : 0) - u.pathname.split('/').filter(Boolean).length * 0.1 - (u.search ? 0.5 : 0)
    if (score <= 0) continue
    out.set(s, Math.max(out.get(s) ?? -Infinity, score))
  }
  return [...out.entries()].sort((a, b) => b[1] - a[1]).map(([u]) => u)
}

async function fetchText(ctx: AppContext, url: string, inScope: ((u: string) => boolean) | null): Promise<{ url: string; title?: string; text: string; html?: string } | null> {
  try {
    const r = await webFetch(url, {
      blockedIps: () => egressOf(ctx).ips, maxChars: WEB_TEXT_MAX, pdftotext: ctx.engineConfig.pdftotext, keepHtml: true,
      onRedirect: async (next: string) => { if (inScope && !inScope(next)) throw new Error('off site') },
    })
    return { url: r.url, title: r.title, text: r.text.slice(0, WEB_TEXT_MAX), html: r.html }
  } catch { return null }
}

/** Up to `max` pages of the company's own site (the home page first). */
export async function readSite(ctx: AppContext, t: ToolCtx, max: number, asked: string[] = []): Promise<{ site: string | null; pages: WebPart[]; refused: string[] }> {
  const profile = (() => { try { return readCompanyProfile(ctx.files, t.user) } catch { return null } })()
  const website = profile?.website ? (/^https?:\/\//i.test(profile.website) ? profile.website : `https://${profile.website}`) : null
  const scope = website ? webScope(website) : null
  if (!website || !scope) return { site: null, pages: [], refused: asked }
  const inScope = (u: string) => inWebScope(scope, u)
  const refused = asked.filter((u) => !inScope(u))
  const pages: WebPart[] = []
  const home = await fetchText(ctx, website, inScope)
  const queue = [...new Set(asked.filter(inScope))]
  if (home) {
    pages.push({ url: home.url, label: home.url, text: home.text, kind: 'page', ...(home.title ? { title: home.title } : {}) })
    if (home.html) for (const u of siteLinks(home.html, new URL(home.url), inScope)) if (!queue.includes(u)) queue.push(u)
  }
  const seen = new Set(pages.map((p) => p.url))
  // four at a time, until the budget is spent
  while (pages.length < max && queue.length) {
    const batch = queue.splice(0, Math.min(4, max - pages.length)).filter((u) => !seen.has(u))
    const got = await Promise.all(batch.map((u) => fetchText(ctx, u, inScope)))
    for (const g of got) {
      if (!g || seen.has(g.url) || g.text.trim().length < 200) continue
      seen.add(g.url)
      pages.push({ url: g.url, label: g.url, text: g.text, kind: 'page', ...(g.title ? { title: g.title } : {}) })
      if (g.html && queue.length < max * 2) for (const u of siteLinks(g.html, new URL(g.url), inScope)) if (!queue.includes(u) && !seen.has(u)) queue.push(u)
    }
  }
  return { site: scope.label, pages: pages.slice(0, max), refused }
}

/** The outside articles the outline names: each opened with web_fetch in this answer, read again here. */
export async function readArticles(ctx: AppContext, t: ToolCtx, list: { url: string; outlet: string; date: string }[], problems: string[]): Promise<WebPart[]> {
  const out: WebPart[] = []
  for (const [i, a] of list.entries()) {
    const opened = t.turnId ? ctx.db.query("SELECT 1 FROM tool_events WHERE turn_id = ? AND tool = 'web_fetch' AND ok = 1 AND (summary = ? OR summary LIKE ?) LIMIT 1").get(t.turnId, `web_fetch ${a.url}`, `web_fetch ${a.url} -> %`) : null
    if (!opened) { problems.push(`web_sources[${i}]: "${a.url}" was not opened with web_fetch in this answer; open it first, or leave the article and its facts out`); continue }
    const r = await fetchText(ctx, a.url, null)
    if (!r || r.text.trim().length < 200) { problems.push(`web_sources[${i}]: "${a.url}" could not be read again; leave the article and its facts out`); continue }
    out.push({ url: r.url, label: `${a.outlet} · ${a.date} · ${r.url}`, text: r.text, kind: 'article', ...(r.title ? { title: r.title } : {}) })
  }
  return out
}

/** The pages as the AI is shown them: title, address, an excerpt (external data). */
export function excerpts(pages: WebPart[]): string {
  return pages.map((p, i) => `--- page ${i + 1}: ${p.title ?? ''} <${p.url}>\n${p.text.slice(0, EXCERPT)}`).join('\n\n')
}

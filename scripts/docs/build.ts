// Builds the documentation site in docs/site/ into a static folder (default dist/docs-site/). `bun run docs:build`.
//   bun scripts/docs/build.ts [--out DIR] [--base /docs] [--site-url https://docs.example.com] [--site-nav nav.json]
// --site-nav puts a website's own navigation bar on top of every page instead of the docs' header bar (ax.trina.app
// passes its header, rendered by its own build). The file is SiteNav JSON: `html` is the bar's markup with the
// `<!--docs-tools-->` marker where the docs search goes, `css` and `assets` are files next to the JSON that are copied
// to assets/site-nav/, and `themeKey` is the localStorage key the website keeps the light or dark choice under.
// `htmlByLang` (optional) holds the bar in another language, e.g. { "zh": "…" } for the Chinese pages.
// The public copy is ax.trina.app/docs: --base /docs --site-url https://ax.trina.app (the website repository's
// scripts/sync-docs.mjs runs that). Pages carry no inline script or style attribute, so they work under that site's
// Content-Security-Policy (script-src 'self'; style-src 'self'; img-src 'self').
// Output: <slug>/index.html for every page, <slug>.md (plain Markdown for agents), llms.txt, llms-full.txt,
// search-index.json, 404.html and assets/. No dependencies beyond the repository's own: Bun's Markdown renderer,
// plus highlight.js and lucide icons from web/node_modules when they are installed.
//
// Layout (like Claude Code Docs): a sticky header with the logo, search and links, a second row of section tabs
// (each with a menu of its pages), a left sidebar with the active tab's groups, the page, and "On this page".
//
// Components in the Markdown sources (containers may nest, e.g. steps inside tabs):
//   :::note / :::tip / :::warning … :::      a callout
//   :::steps … :::                          steps; each starts with a "#### Title" line
//   :::cards cols=2 … :::                   cards; each line "- icon=name | [Title](link.md) | One sentence."
//   :::tabs … :::                           tabs; each panel starts with an "@tab Title" line
// Screenshots: ![alt text](../images/<page>/<name>.webp "Optional caption") on a line of its own (docs:screenshots).
// Languages: English is docs/site/; Simplified Chinese is docs/site/zh/ (same slugs, its own nav.json with translated
// titles) and is built under <base>/zh/ with lang="zh-CN", translated labels, its own llms.txt and search index. A page
// with a twin in the other language links to it (hreflang and a language switch); a zh nav entry with no zh page links
// to the English page, marked （英文）. --site-nav html may hold a <!--docs-lang--> marker for where the switch goes.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { HREFLANG, HTML_LANG, LANGS, ROOT, langDir, loadPages, readNav, type Lang, type Nav, type NavTab, type Page } from './site'

type MarkdownApi = { html: (md: string, opts?: Record<string, unknown>) => string }
const markdown = (Bun as unknown as { markdown?: MarkdownApi }).markdown
if (!markdown?.html) throw new Error('This build needs Bun.markdown (Bun 1.3.8 or newer).')
const md = (text: string) => markdown.html(text, { headings: { ids: true }, autolinks: true })
const mdInline = (text: string) => md(text).trim().replace(/^<p>([\s\S]*)<\/p>$/, '$1')

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
const strip = (html: string) => unesc(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()

// ---------------- options ----------------
function options(argv: string[]) {
  const o = { out: path.join(ROOT, 'dist/docs-site'), base: '', siteUrl: '', siteNav: '' }
  for (let i = 0; i < argv.length; i += 2) {
    const [k, v] = [argv[i], argv[i + 1]]
    if (v === undefined) throw new Error(`${k} needs a value`)
    if (k === '--out') o.out = path.resolve(v)
    else if (k === '--base') o.base = v.replace(/\/+$/, '')
    else if (k === '--site-url') o.siteUrl = v.replace(/\/+$/, '')
    else if (k === '--site-nav') o.siteNav = path.resolve(v)
    else throw new Error('Usage: bun scripts/docs/build.ts [--out DIR] [--base /path] [--site-url https://host] [--site-nav nav.json]')
  }
  return o
}

// ---------------- optional helpers from web/node_modules ----------------
const webRequire = createRequire(path.join(ROOT, 'web/package.json'))
type Hljs = { getLanguage: (l: string) => unknown; highlight: (code: string, o: { language: string }) => { value: string } }
let hljs: Hljs | null = null
try { hljs = webRequire('highlight.js') as Hljs } catch { hljs = null }

const iconCache = new Map<string, string>()
function icon(name: string): string {
  if (iconCache.has(name)) return iconCache.get(name)!
  let svg = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/></svg>'
  try {
    const dir = path.dirname(webRequire.resolve('lucide-react/package.json'))
    let src = fs.readFileSync(path.join(dir, 'dist/esm/icons', `${name}.mjs`), 'utf8')
    const alias = /export \{ default \} from '\.\/([\w-]+)\.mjs'/.exec(src)?.[1] // a renamed icon points to its new name
    if (alias) src = fs.readFileSync(path.join(dir, 'dist/esm/icons', `${alias}.mjs`), 'utf8')
    const lit = /const __iconData = (\{[\s\S]*?\n\});/.exec(src)?.[1]
    const data = lit ? (new Function(`return (${lit})`)() as { node: [string, Record<string, string>][] }) : null
    if (data) {
      const parts = data.node.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).filter(([k]) => k !== 'key').map(([k, v]) => `${k}="${esc(String(v))}"`).join(' ')}/>`)
      svg = `<svg viewBox="0 0 24 24" aria-hidden="true">${parts.join('')}</svg>`
    }
  } catch { /* lucide not installed: a plain circle */ }
  iconCache.set(name, svg)
  return svg
}

// ---------------- links ----------------
/** A website's navigation bar to show instead of the docs' own (see --site-nav). */
export interface SiteNav { html: string; htmlByLang?: Partial<Record<Lang, string>>; css?: string[]; assets?: string[]; themeKey?: string }
export const DOCS_TOOLS_MARKER = '<!--docs-tools-->'
export const DOCS_LANG_MARKER = '<!--docs-lang-->'
/** One language of the site. `root` is the site's base (/docs), `base` this language's (/docs or /docs/zh); `alt` is the
 * other language, for twins and for nav entries this language has not translated. */
interface Ctx { nav: Nav; pages: Page[]; base: string; root: string; siteUrl: string; siteNav: SiteNav | null; lang: Lang; ui: Ui; alt: Ctx | null }

// ---------------- labels ----------------
const UI_EN = {
  note: 'Note', tip: 'Tip', warning: 'Warning', copyCode: 'Copy code', anchor: 'Link to this section', pages: (t: string) => `${t} pages`,
  docs: 'Docs', openDocsNav: 'Open the docs navigation', sections: 'Sections', openNav: 'Open navigation', links: 'Links',
  theme: 'Switch light and dark theme', search: 'Search…', searchLabel: 'Search the docs', onThisPage: 'On this page',
  hideToc: 'Hide On this page', prevNext: 'Previous and next', prev: 'Previous', next: 'Next', copyPage: 'Copy page',
  moreCopy: 'More copy options', copyMd: 'Copy page as Markdown', copyMdSub: 'For pasting into an AI chat', viewMd: 'View as Markdown',
  viewMdSub: 'This page as plain text', copyLlms: 'Copy llms.txt link', copyLlmsSub: 'The index of every page, for agents',
  skip: 'Skip to content', footer: 'Trina AX is free software under AGPL-3.0-only. Icons: Lucide (ISC).', edit: 'Edit this page',
  enlarge: 'Enlarge', screenshot: 'Screenshot', close: 'Close', notFound: 'Page not found', notFoundDesc: 'This page does not exist.',
  notFoundBody: (home: string) => `<p><a href="${home}">Go to the intro</a>, or search above.</p>`, english: '',
  llmsIntro: 'Every page is also plain Markdown: add `.md` to its address. All pages in one file: `llms-full.txt`.', rootUrl: 'Root URL',
  switchTo: 'English', switchLabel: 'Read this page in English',
}
type Ui = typeof UI_EN
const UI: Record<Lang, Ui> = {
  en: UI_EN,
  zh: {
    note: '注意', tip: '提示', warning: '警告', copyCode: '复制代码', anchor: '链接到此部分', pages: (t: string) => `${t}：页面`,
    docs: '文档', openDocsNav: '打开文档导航', sections: '栏目', openNav: '打开导航', links: '链接',
    theme: '切换浅色和深色主题', search: '搜索…', searchLabel: '搜索文档', onThisPage: '本页内容',
    hideToc: '隐藏“本页内容”', prevNext: '上一页和下一页', prev: '上一页', next: '下一页', copyPage: '复制本页',
    moreCopy: '更多复制选项', copyMd: '以 Markdown 复制本页', copyMdSub: '用于粘贴到 AI 对话中', viewMd: '以 Markdown 查看',
    viewMdSub: '本页的纯文本', copyLlms: '复制 llms.txt 链接', copyLlmsSub: '所有页面的索引，供 AI 智能体使用',
    skip: '跳到内容', footer: 'Trina AX 是采用 AGPL-3.0-only 许可的自由软件。图标：Lucide（ISC）。', edit: '编辑此页',
    enlarge: '放大', screenshot: '截图', close: '关闭', notFound: '页面不存在', notFoundDesc: '此页面不存在。',
    notFoundBody: (home: string) => `<p><a href="${home}">前往简介</a>，或在上方搜索。</p>`, english: '（英文）',
    llmsIntro: '每个页面也有纯 Markdown 版本：在地址后加上 `.md`。所有页面合在一个文件中：`llms-full.txt`。其余页面只有英文。', rootUrl: '根地址',
    switchTo: '中文', switchLabel: '阅读本页的中文版',
  },
}

/** Where a nav entry points in this language: its own page, or else the other language's page with a note. */
function navLink(ctx: Ctx, slug: string): { url: string; title: string } {
  const own = ctx.pages.find((p) => p.slug === slug)
  if (own) return { url: pageUrl(ctx, slug), title: own.title }
  const alt = ctx.alt?.pages.find((p) => p.slug === slug)
  if (!alt || !ctx.alt) throw new Error(`nav entry ${slug} has no page`)
  return { url: pageUrl(ctx.alt, slug), title: `${alt.title}${ctx.ui.english}` }
}
/** The same page in the other language, when there is one. */
const twin = (ctx: Ctx, page: Page | null) => (page && ctx.alt?.pages.some((p) => p.slug === page.slug) ? ctx.alt : null)
function langSwitch(ctx: Ctx, page: Page | null, cls: string): string {
  const other = twin(ctx, page)
  if (!other || !page) return ''
  return `<a class="${cls}" href="${pageUrl(other, page.slug)}" hreflang="${HREFLANG[other.lang]}" lang="${HTML_LANG[other.lang]}" aria-label="${esc(other.ui.switchLabel)}">${icon('languages')}<span>${esc(other.ui.switchTo)}</span></a>`
}

function readSiteNav(file: string): SiteNav | null {
  if (!file) return null
  const n = JSON.parse(fs.readFileSync(file, 'utf8')) as SiteNav
  for (const html of [n.html, ...Object.values(n.htmlByLang ?? {})]) {
    if (typeof html !== 'string' || !html.includes(DOCS_TOOLS_MARKER)) throw new Error(`${file}: html needs the ${DOCS_TOOLS_MARKER} marker`)
    // the docs page is the page's only <header>; the website's bar sits inside it
    if (/<\/?header[\s>]/i.test(html)) throw new Error(`${file}: html must not contain a <header> element`)
    if (/<script[\s>]|\son[a-z]+=|\sstyle=/i.test(html)) throw new Error(`${file}: html must not carry scripts, event handlers or inline styles`)
  }
  for (const f of [...(n.css ?? []), ...(n.assets ?? [])]) {
    if (!/^[\w.-]+$/.test(f)) throw new Error(`${file}: ${f} must be a plain file name next to the JSON`)
  }
  return n
}
const pageUrl = (ctx: Ctx, slug: string) => (slug === 'index' ? `${ctx.base}/` : `${ctx.base}/${slug}/`)
const pageMdUrl = (ctx: Ctx, slug: string) => `${ctx.base}/${slug}.md`

/** Resolves a link written in a page's Markdown: other site pages become site URLs, other repository files GitHub URLs. */
function resolveLink(ctx: Ctx, page: Page, href: string, forMarkdown: boolean): string {
  if (/^([a-z]+:|#|\/)/i.test(href)) return href
  const [raw, frag] = href.split('#')
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(page.file), decodeURIComponent(raw!)))
  const hash = frag ? `#${frag}` : ''
  if (target.startsWith('docs/site/') && target.endsWith('.md')) {
    // docs/site/<slug>.md is English, docs/site/zh/<slug>.md Chinese: find the language that has the page
    for (const c of [ctx, ctx.alt]) {
      const dir = c ? langDir(c.lang) : ''
      const prefix = dir ? `docs/site/${dir}/` : 'docs/site/'
      if (!c || !target.startsWith(prefix)) continue
      const slug = target.slice(prefix.length, -3)
      if (!dir && LANGS.some((l) => l !== 'en' && slug.startsWith(`${langDir(l)}/`))) continue
      if (c.pages.some((p) => p.slug === slug)) return (forMarkdown ? pageMdUrl(c, slug) : pageUrl(c, slug)) + hash
    }
  }
  if (target.startsWith('docs/site/images/')) return `${ctx.siteUrl && forMarkdown ? ctx.siteUrl : ''}${ctx.root}/${target.slice('docs/site/'.length)}`
  return `${ctx.nav.repo}/blob/main/${target}${hash}`
}

// ---------------- components ----------------
type Kind = 'note' | 'tip' | 'warning' | 'steps' | 'cards' | 'tabs'
type Block = { kind: 'md'; text: string } | { kind: Kind; args: string; text: string }
const OPEN = /^:::(note|tip|warning|steps|cards|tabs)\b\s*(.*)$/
const CLOSE = /^:::\s*$/
const FENCE = /^\s*```/

/** Splits Markdown into plain parts and components. Components may contain components (counted by depth). */
function splitBlocks(text: string): Block[] {
  const out: Block[] = []
  let buf: string[] = []
  let comp: { kind: Kind; args: string; lines: string[] } | null = null
  let depth = 0, fence = false
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) fence = !fence
    if (!fence) {
      const open = OPEN.exec(line)
      if (!comp && open) {
        if (buf.length) out.push({ kind: 'md', text: buf.join('\n') })
        buf = []
        comp = { kind: open[1] as Kind, args: open[2] ?? '', lines: [] }
        continue
      }
      if (comp && open) depth++
      else if (comp && CLOSE.test(line)) {
        if (depth === 0) { out.push({ kind: comp.kind, args: comp.args, text: comp.lines.join('\n') }); comp = null; continue }
        depth--
      }
    }
    if (comp) comp.lines.push(line)
    else buf.push(line)
  }
  if (comp) throw new Error(`unclosed :::${comp.kind}`)
  if (buf.length) out.push({ kind: 'md', text: buf.join('\n') })
  return out
}

/** Splits a container's text at top-level marker lines ("#### Title" for steps, "@tab Title" for tabs). */
function sections(text: string, marker: RegExp): { title: string; body: string }[] {
  const out: { title: string; body: string }[] = []
  let depth = 0, fence = false
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) fence = !fence
    if (!fence) {
      if (OPEN.test(line)) depth++
      else if (CLOSE.test(line)) depth--
    }
    const m = !fence && depth === 0 ? marker.exec(line) : null
    if (m) out.push({ title: m[1]!.trim(), body: '' })
    else if (out.length) out.at(-1)!.body += `${line}\n`
  }
  return out
}
const steps = (text: string) => sections(text, /^####\s+(.+)$/)
const tabPanels = (text: string) => sections(text, /^@tab\s+(.+)$/)

function cards(text: string): { icon: string; title: string; href: string; desc: string }[] {
  return text.split('\n').filter((l) => l.startsWith('- ')).map((l) => {
    const parts = l.slice(2).split(' | ').map((s) => s.trim())
    const iconPart = parts[0]!.startsWith('icon=') ? parts.shift()!.slice(5) : 'circle'
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(parts[0] ?? '')
    if (!link) throw new Error(`card needs [Title](link): ${l}`)
    return { icon: iconPart, title: link[1]!, href: link[2]!, desc: parts[1] ?? '' }
  })
}

const CALLOUT_ICON = { note: 'info', tip: 'lightbulb', warning: 'triangle-alert' } as const

function renderBlocks(ctx: Ctx, page: Page, text: string, ids: { n: number }): string {
  return splitBlocks(text).map((b) => {
    if (b.kind === 'md') return md(b.text)
    if (b.kind === 'note' || b.kind === 'tip' || b.kind === 'warning') {
      return `<div class="callout callout-${b.kind}" role="note"><div class="callout-label">${icon(CALLOUT_ICON[b.kind])}${ctx.ui[b.kind]}</div>${renderBlocks(ctx, page, b.text, ids)}</div>`
    }
    if (b.kind === 'steps') {
      return `<ol class="steps">${steps(b.text).map((s) => `<li class="step"><div class="step-title">${mdInline(s.title)}</div>${renderBlocks(ctx, page, s.body, ids)}</li>`).join('')}</ol>`
    }
    if (b.kind === 'tabs') {
      const id = `tabs-${ids.n++}`
      const panels = tabPanels(b.text)
      const list = panels.map((p, i) => `<button type="button" role="tab" id="${id}-t${i}" aria-controls="${id}-p${i}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${esc(p.title)}</button>`).join('')
      const bodies = panels.map((p, i) => `<div class="tab-panel" role="tabpanel" id="${id}-p${i}" aria-labelledby="${id}-t${i}" tabindex="0"${i === 0 ? '' : ' hidden'}>${renderBlocks(ctx, page, p.body, ids)}</div>`).join('')
      return `<div class="tabs"><div class="tab-list" role="tablist">${list}</div>${bodies}</div>`
    }
    const cols = /cols=(\d)/.exec(b.args)?.[1] ?? '2'
    return `<div class="cards cols-${cols}">${cards(b.text).map((c) => `<a class="card" href="${esc(resolveLink(ctx, page, c.href, false))}"><span class="card-icon">${icon(c.icon)}</span><span class="card-title">${esc(c.title)}</span><span class="card-desc">${mdInline(c.desc)}</span></a>`).join('')}</div>`
  }).join('\n')
}

/** Plain Markdown for agents: callouts as quotes, steps as a numbered list, tabs as labelled sections, cards as links. */
function renderMarkdownBlocks(ctx: Ctx, page: Page, text: string): string {
  const fix = (t: string) => t.replace(/(!?\[[^\]]*\])\(([^)\s]+)\)/g, (_m, label: string, href: string) => `${label}(${resolveLink(ctx, page, href, true)})`)
  const indent = (t: string) => t.split('\n').map((l) => (l ? `   ${l}` : l)).join('\n')
  return splitBlocks(text).map((b) => {
    if (b.kind === 'md') return fix(b.text).trim()
    if (b.kind === 'note' || b.kind === 'tip' || b.kind === 'warning') {
      return `**${ctx.ui[b.kind]}:** ${renderMarkdownBlocks(ctx, page, b.text)}`.split('\n').map((l) => `> ${l}`.trimEnd()).join('\n')
    }
    if (b.kind === 'steps') return steps(b.text).map((s, i) => `${i + 1}. **${s.title}**\n\n${indent(renderMarkdownBlocks(ctx, page, s.body))}`).join('\n\n')
    if (b.kind === 'tabs') return tabPanels(b.text).map((p) => `**${p.title}**\n\n${renderMarkdownBlocks(ctx, page, p.body)}`).join('\n\n')
    return cards(b.text).map((c) => `- [${c.title}](${resolveLink(ctx, page, c.href, true)}): ${fix(c.desc)}`).join('\n')
  }).filter(Boolean).join('\n\n')
}
const renderMarkdown = (ctx: Ctx, page: Page) => `# ${page.title}\n\n> ${page.description}\n\n${renderMarkdownBlocks(ctx, page, page.body)}\n`

// ---------------- page assembly ----------------
type Toc = { level: number; id: string; text: string }[]
function postProcess(ctx: Ctx, page: Page, html: string): { html: string; toc: Toc } {
  html = html.replace(/href="([^"]+)"/g, (_m, href: string) => {
    const r = resolveLink(ctx, page, unesc(href), false)
    const ext = /^https?:/i.test(r) && !(ctx.siteUrl && r.startsWith(ctx.siteUrl))
    return `href="${esc(r)}"${ext ? ' rel="noopener"' : ''}`
  })
  html = html.replace(/<pre><code(?: class="language-([\w+-]+)")?>([\s\S]*?)<\/code><\/pre>/g, (_m, lang: string | undefined, code: string) => {
    let inner = code
    if (hljs && lang && hljs.getLanguage(lang)) { try { inner = hljs.highlight(unesc(code), { language: lang }).value } catch { inner = code } }
    return `<div class="code"><button class="copy-code" type="button" aria-label="${ctx.ui.copyCode}">${icon('copy')}</button><pre><code${lang ? ` class="hljs language-${lang}"` : ''}>${inner}</code></pre></div>`
  })
  if (ctx.lang !== 'en') {
    // Bun drops CJK letters from heading ids: build them from the whole heading text, as the link check does
    const seen = new Map<string, number>()
    html = html.replace(/<h([1-6]) id="[^"]*">([\s\S]*?)<\/h\1>/g, (_m, level: string, inner: string) => {
      const slug = headingId(strip(inner)) || 'section'
      const n = seen.get(slug) ?? 0
      seen.set(slug, n + 1)
      return `<h${level} id="${esc(n ? `${slug}-${n}` : slug)}">${inner}</h${level}>`
    })
  }
  const toc: Toc = []
  html = html.replace(/<h([23]) id="([^"]+)">([\s\S]*?)<\/h\1>/g, (_m, level: string, id: string, inner: string) => {
    toc.push({ level: Number(level), id, text: strip(inner) })
    return `<h${level} id="${id}"><a class="anchor" href="#${id}" aria-label="${ctx.ui.anchor}">#</a>${inner}</h${level}>`
  })
  html = html.replace(/<table>/g, '<div class="table"><table>').replace(/<\/table>/g, '</table></div>')
  // an image alone in a paragraph is a screenshot: a figure, its title as the caption, larger on click
  html = html.replace(/<p><img src="([^"]+)" alt="([^"]*)"(?: title="([^"]*)")?\s*\/?><\/p>/g, (_m, src: string, alt: string, title: string | undefined) => {
    const url = esc(resolveLink(ctx, page, unesc(src), false))
    // shots are taken at twice the size: shown at their own width at most, so a narrow list or a phone stays narrow
    const size = imageSize(path.join(ROOT, path.dirname(page.file), unesc(src)))
    const dims = size ? ` width="${Math.round(size.width / 2)}" height="${Math.round(size.height / 2)}"` : ''
    return `<figure class="shot"><button class="shot-zoom" type="button" data-src="${url}" aria-label="${ctx.ui.enlarge}: ${alt}"><img src="${url}" alt="${alt}"${dims} loading="lazy" decoding="async"></button>${title ? `<figcaption>${title}</figcaption>` : ''}</figure>`
  })
  return { html, toc }
}

const themeKey = (ctx: Ctx) => ctx.siteNav?.themeKey || 'trina-docs-theme'
const firstSlug = (t: NavTab) => t.groups[0]!.pages[0]!
const pageCount = (t: NavTab) => t.groups.reduce((n, g) => n + g.pages.length, 0)

function header(ctx: Ctx, page: Page | null): string {
  const ui = ctx.ui
  const tabs = ctx.nav.tabs.map((t, i) => {
    const active = page?.tab === t.title
    const menu = pageCount(t) > 1
      ? `<button class="tab-caret" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="tab-menu-${i}" aria-label="${esc(ui.pages(t.title))}">${icon('chevron-down')}</button><div class="tab-menu" id="tab-menu-${i}">${t.groups.map((g) => `<div class="tab-menu-group"><div class="tab-menu-title">${esc(g.title)}</div>${g.pages.map((slug) => { const l = navLink(ctx, slug); return `<a href="${l.url}">${esc(l.title)}</a>` }).join('')}</div>`).join('')}</div>`
      : ''
    return `<div class="section-tab${active ? ' active' : ''}"><a href="${navLink(ctx, firstSlug(t)).url}"${active ? ' aria-current="true"' : ''}>${esc(t.title)}</a>${menu}</div>`
  }).join('')
  if (ctx.siteNav) {
    // the website's own bar, with the docs search in it; on phones a second row holds the docs menu and the search.
    // The language switch goes where the bar has the <!--docs-lang--> marker, or else after the search.
    const sw = langSwitch(ctx, page, 'lang-switch')
    const siteHtml = ctx.siteNav.htmlByLang?.[ctx.lang] ?? ctx.siteNav.html
    const hasMarker = siteHtml.includes(DOCS_LANG_MARKER)
    const bar = siteHtml.replace(DOCS_TOOLS_MARKER, `<div class="docs-tools" data-slot="bar">${searchBox(ctx)}${hasMarker ? '' : sw}</div>`).replace(DOCS_LANG_MARKER, sw)
    return `<header class="site-header with-site-nav">
  <div class="sitenav">${bar}</div>
  <div class="docs-row">
    <button class="menu-button docs-menu" type="button" aria-label="${ui.openDocsNav}" aria-controls="sidebar" aria-expanded="false">${icon('panel-left')}<span>${ui.docs}</span></button>
    <div class="docs-tools" data-slot="row"></div>
  </div>
  <nav class="section-tabs" aria-label="${ui.sections}">${tabs}</nav>
</header>`
  }
  return `<header class="site-header">
  <div class="bar">
    <button class="menu-button icon-button" type="button" aria-label="${ui.openNav}" aria-controls="sidebar" aria-expanded="false">${icon('menu')}</button>
    <a class="brand" href="${pageUrl(ctx, 'index')}"><img src="${ctx.root}/assets/favicon.svg" alt="" width="24" height="24"><span>${esc(ctx.nav.title)}</span></a>
    ${searchBox(ctx)}
    <nav class="bar-links" aria-label="${ui.links}">
      ${langSwitch(ctx, page, 'lang-switch quiet-link')}<a class="quiet-link" href="${ctx.nav.repo}" rel="noopener">GitHub</a>
      <a class="open-product" href="${esc(ctx.nav.product.url)}" rel="noopener">${esc(ctx.nav.product.label)}${icon('chevron-right')}</a>
      <button class="theme-button icon-button" type="button" aria-label="${ui.theme}">${icon('sun-moon')}</button>
    </nav>
  </div>
  <nav class="section-tabs" aria-label="${ui.sections}">${tabs}</nav>
</header>`
}

function searchBox(ctx: Ctx): string {
  return `<div class="search" role="search">
      ${icon('search')}
      <input id="search-input" type="search" placeholder="${ctx.ui.search}" aria-label="${ctx.ui.searchLabel}" autocomplete="off" aria-controls="search-results" aria-expanded="false">
      <kbd>⌘K</kbd>
      <ul id="search-results" class="search-results" role="listbox" hidden></ul>
    </div>`
}

function sidebar(ctx: Ctx, page: Page | null): string {
  const tab = ctx.nav.tabs.find((t) => t.title === page?.tab) ?? ctx.nav.tabs[0]!
  const groups = tab.groups.map((g) => `<div class="nav-group"><div class="nav-group-title">${esc(g.title)}</div><ul>${g.pages.map((slug) => {
    const l = navLink(ctx, slug)
    return `<li><a href="${l.url}"${slug === page?.slug ? ' aria-current="page"' : ''}>${esc(l.title)}</a></li>`
  }).join('')}</ul></div>`).join('')
  // on phones the section tabs and header links live in the drawer
  const drawerTabs = `<div class="drawer-only"><div class="nav-group-title">${ctx.ui.sections}</div><ul class="drawer-tabs">${ctx.nav.tabs.map((t) => `<li><a href="${navLink(ctx, firstSlug(t)).url}"${t === tab ? ' aria-current="true"' : ''}>${esc(t.title)}</a></li>`).join('')}</ul><div class="drawer-links">${langSwitch(ctx, page, 'lang-switch')}<a href="${ctx.nav.repo}" rel="noopener">GitHub</a><a href="${esc(ctx.nav.product.url)}" rel="noopener">${esc(ctx.nav.product.label)}</a></div></div>`
  return `<aside id="sidebar" class="sidebar" aria-label="${esc(tab.title)}">${drawerTabs}${groups}</aside>`
}

function layout(ctx: Ctx, page: Page | null, content: string, toc: Toc, meta: { title: string; description: string; eyebrow: string }): string {
  const i = page ? ctx.pages.indexOf(page) : -1
  const prev = i > 0 ? ctx.pages[i - 1] : undefined
  const next = i >= 0 ? ctx.pages[i + 1] : undefined
  const ui = ctx.ui
  const tocHtml = toc.length ? `<nav class="toc" aria-label="${ui.onThisPage}"><div class="toc-head">${icon('text')}<span>${ui.onThisPage}</span><button class="toc-toggle icon-button" type="button" aria-expanded="true" aria-controls="toc-list" aria-label="${ui.hideToc}">${icon('chevron-right')}</button></div><ul id="toc-list">${toc.map((t) => `<li class="toc-${t.level}"><a href="#${t.id}">${esc(t.text)}</a></li>`).join('')}</ul></nav>` : '<div class="toc"></div>'
  const pager = page ? `<nav class="pager" aria-label="${ui.prevNext}">${prev ? `<a class="pager-prev" href="${pageUrl(ctx, prev.slug)}"><span>${ui.prev}</span>${esc(prev.title)}</a>` : '<span></span>'}${next ? `<a class="pager-next" href="${pageUrl(ctx, next.slug)}"><span>${ui.next}</span>${esc(next.title)}</a>` : '<span></span>'}</nav>` : ''
  const copy = page ? `<div class="copy-page" data-md="${pageMdUrl(ctx, page.slug)}" data-llms="${ctx.siteUrl}${ctx.base}/llms.txt">
        <button class="copy-main" type="button">${icon('copy')}<span>${ui.copyPage}</span></button><button class="copy-caret" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="copy-menu" aria-label="${ui.moreCopy}">${icon('chevron-down')}</button>
        <div class="copy-menu" id="copy-menu" role="menu" hidden>
          <button type="button" role="menuitem" data-action="copy-md">${icon('copy')}<span><b>${ui.copyMd}</b><small>${ui.copyMdSub}</small></span></button>
          <a role="menuitem" href="${pageMdUrl(ctx, page.slug)}">${icon('file-text')}<span><b>${ui.viewMd}</b><small>${ui.viewMdSub}</small></span></a>
          <button type="button" role="menuitem" data-action="copy-llms">${icon('link')}<span><b>${ui.copyLlms}</b><small>${ui.copyLlmsSub}</small></span></button>
        </div>
      </div>` : ''
  const canonical = ctx.siteUrl && page ? `<link rel="canonical" href="${ctx.siteUrl}${pageUrl(ctx, page.slug)}">\n` : ''
  const alt = page ? `<link rel="alternate" type="text/markdown" href="${pageMdUrl(ctx, page.slug)}">\n` : ''
  // a page with a twin in the other language names both (and English as the default)
  const other = twin(ctx, page)
  const langs = other && page ? [ctx, other].sort((a, b) => LANGS.indexOf(a.lang) - LANGS.indexOf(b.lang)) : []
  const hreflang = langs.map((c) => `<link rel="alternate" hreflang="${HREFLANG[c.lang]}" href="${c.siteUrl}${pageUrl(c, page!.slug)}">\n`).join('')
    + (langs.length ? `<link rel="alternate" hreflang="x-default" href="${langs[0]!.siteUrl}${pageUrl(langs[0]!, page!.slug)}">\n` : '')
  return `<!doctype html>
<html lang="${HTML_LANG[ctx.lang]}"${ctx.siteNav ? ' class="has-site-nav"' : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page?.slug === 'index' ? ctx.nav.title : `${meta.title} · ${ctx.nav.title}`)}</title>
<meta name="description" content="${esc(meta.description)}">
${canonical}${hreflang}${alt}<link rel="icon" href="${ctx.root}/assets/favicon.svg">
<link rel="stylesheet" href="${ctx.root}/assets/site.css">
${(ctx.siteNav?.css ?? []).map((f) => `<link rel="stylesheet" href="${ctx.root}/assets/site-nav/${f}">\n`).join('')}<script src="${ctx.root}/assets/theme.js" data-key="${esc(themeKey(ctx))}"></script>
</head>
<body data-base="${esc(ctx.base)}" data-theme-key="${esc(themeKey(ctx))}">
<a class="skip" href="#content">${ui.skip}</a>
${header(ctx, page)}
<div class="shell">
  ${sidebar(ctx, page)}
  <main id="content" class="content">
    ${meta.eyebrow ? `<div class="eyebrow">${esc(meta.eyebrow)}</div>` : ''}
    <div class="title-row"><h1>${esc(meta.title)}</h1>${copy}</div>
    <p class="lead">${esc(meta.description)}</p>
    <article class="prose">${content}</article>
    ${pager}
    <footer class="footer">${ui.footer}${page ? ` <a href="${ctx.nav.repo}/edit/main/${page.file}" rel="noopener">${ui.edit}</a>` : ''}</footer>
  </main>
  ${tocHtml}
</div>
<div class="scrim" hidden></div>
<dialog class="lightbox" aria-label="${ui.screenshot}"><button class="lightbox-close icon-button" type="button" aria-label="${ui.close}">${icon('x')}</button><img alt=""></dialog>
<script src="${ctx.root}/assets/site.js" defer></script>
</body>
</html>
`
}

// ---------------- build ----------------
export function build(argv: string[]) {
  const o = options(argv)
  const siteNav = readSiteNav(o.siteNav)
  const ctxs = LANGS.map((lang): Ctx => {
    const nav = readNav(lang)
    const pages = loadPages(nav, lang)
    for (const p of pages) if (!p.title || !p.description) throw new Error(`${p.file}: front matter needs title and description`)
    return { nav, pages, base: lang === 'en' ? o.base : `${o.base}/${langDir(lang)}`, root: o.base, siteUrl: o.siteUrl, siteNav, lang, ui: UI[lang], alt: null }
  })
  // two languages: each is the other's twin (English is the fallback for pages a translation does not have)
  ctxs[0]!.alt = ctxs[1]!
  ctxs[1]!.alt = ctxs[0]!
  fs.rmSync(o.out, { recursive: true, force: true })
  fs.mkdirSync(path.join(o.out, 'assets'), { recursive: true })
  for (const ctx of ctxs) buildLang(ctx, langDir(ctx.lang) ? path.join(o.out, langDir(ctx.lang)) : o.out)

  const assets = path.join(import.meta.dir, 'assets')
  for (const f of fs.readdirSync(assets)) fs.copyFileSync(path.join(assets, f), path.join(o.out, 'assets', f))
  fs.copyFileSync(path.join(ROOT, 'web/public/favicon.svg'), path.join(o.out, 'assets/favicon.svg'))
  if (siteNav) {
    fs.mkdirSync(path.join(o.out, 'assets/site-nav'), { recursive: true })
    for (const f of [...(siteNav.css ?? []), ...(siteNav.assets ?? [])]) fs.copyFileSync(path.join(path.dirname(o.siteNav), f), path.join(o.out, 'assets/site-nav', f))
  }
  const images = path.join(ROOT, 'docs/site/images')
  if (fs.existsSync(images)) fs.cpSync(images, path.join(o.out, 'images'), { recursive: true })
  return { out: o.out, pages: ctxs[0]!.pages.length, translated: Object.fromEntries(ctxs.slice(1).map((c) => [c.lang, c.pages.length])) }
}

/** Pages, Markdown copies, llms.txt, llms-full.txt, search index and 404 of one language, into `out`. */
function buildLang(ctx: Ctx, out: string) {
  const { nav, pages, ui } = ctx
  fs.mkdirSync(out, { recursive: true })
  const index: { t: string; u: string; g: string; d: string; h: string[]; x: string }[] = []
  const full: string[] = [`# ${nav.title}\n\n> ${nav.description}\n`]
  for (const page of pages) {
    const { html, toc } = postProcess(ctx, page, renderBlocks(ctx, page, page.body, { n: 0 }))
    const dir = page.slug === 'index' ? out : path.join(out, page.slug)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'index.html'), layout(ctx, page, html, toc, { title: page.title, description: page.description, eyebrow: page.group }))
    const mdText = renderMarkdown(ctx, page)
    fs.mkdirSync(path.dirname(path.join(out, `${page.slug}.md`)), { recursive: true })
    fs.writeFileSync(path.join(out, `${page.slug}.md`), mdText)
    full.push(`\n---\n\nSource: ${ctx.siteUrl}${pageMdUrl(ctx, page.slug)}\n\n${mdText}`)
    index.push({ t: page.title, u: pageUrl(ctx, page.slug), g: `${page.tab} › ${page.group}`, d: page.description, h: toc.map((t) => t.text), x: strip(html).slice(0, 4000) })
  }

  const llms = [`# ${nav.title}`, '', `> ${nav.description}`, '', `## ${ui.rootUrl}`, '', `${ctx.siteUrl}${ctx.base}/`, '', ui.llmsIntro, '']
  for (const t of nav.tabs) {
    llms.push(`### ${t.title}`, '')
    for (const g of t.groups) for (const slug of g.pages) {
      const own = pages.find((x) => x.slug === slug)
      const c = own ? ctx : ctx.alt!
      const p = own ?? c.pages.find((x) => x.slug === slug)!
      llms.push(`- [${p.title}${own ? '' : ui.english}](${ctx.siteUrl}${pageMdUrl(c, slug)}) - ${p.description}`)
    }
    llms.push('')
  }
  fs.writeFileSync(path.join(out, 'llms.txt'), llms.join('\n'))
  fs.writeFileSync(path.join(out, 'llms-full.txt'), full.join('\n'))
  fs.writeFileSync(path.join(out, 'search-index.json'), JSON.stringify(index))
  fs.writeFileSync(path.join(out, '404.html'), layout(ctx, null, ui.notFoundBody(pageUrl(ctx, 'index')), [],
    { title: ui.notFound, description: ui.notFoundDesc, eyebrow: '' }))
}

/** A heading's id from its text, the way the link check (check-onboarding-docs.ts) reads an anchor: lower case,
 * letters and digits of any script, '-' and '_', spaces as '-'. */
export const headingId = (text: string) => text.replace(/`/g, '').toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/ /g, '-')

if (import.meta.main) {
  const r = build(process.argv.slice(2))
  console.log(`Docs site: ${r.pages} pages (${Object.entries(r.translated).map(([l, n]) => `${l}: ${n}`).join(', ')}) → ${path.relative(process.cwd(), r.out) || r.out}`)
}

/** The pixel size of a WebP or PNG screenshot, from its header; null for anything else or a file that is not there. */
export function imageSize(file: string): { width: number; height: number } | null {
  let b: Buffer
  try { b = fs.readFileSync(file) } catch { return null }
  if (b.toString('ascii', 1, 4) === 'PNG') return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null
  const kind = b.toString('ascii', 12, 16)
  if (kind === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) }
  if (kind === 'VP8L') { const n = b.readUInt32LE(21); return { width: 1 + (n & 0x3fff), height: 1 + ((n >> 14) & 0x3fff) } }
  if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
  return null
}

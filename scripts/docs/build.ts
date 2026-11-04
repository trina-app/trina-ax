// Builds the documentation site in docs/site/ into a static folder (default dist/docs-site/). `bun run docs:build`.
//   bun scripts/docs/build.ts [--out DIR] [--base /docs] [--site-url https://docs.example.com]
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
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { ROOT, loadPages, readNav, type Nav, type NavTab, type Page } from './site'

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
  const o = { out: path.join(ROOT, 'dist/docs-site'), base: '', siteUrl: '' }
  for (let i = 0; i < argv.length; i += 2) {
    const [k, v] = [argv[i], argv[i + 1]]
    if (v === undefined) throw new Error(`${k} needs a value`)
    if (k === '--out') o.out = path.resolve(v)
    else if (k === '--base') o.base = v.replace(/\/+$/, '')
    else if (k === '--site-url') o.siteUrl = v.replace(/\/+$/, '')
    else throw new Error('Usage: bun scripts/docs/build.ts [--out DIR] [--base /path] [--site-url https://host]')
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
interface Ctx { nav: Nav; pages: Page[]; base: string; siteUrl: string }
const pageUrl = (ctx: Ctx, slug: string) => (slug === 'index' ? `${ctx.base}/` : `${ctx.base}/${slug}/`)
const pageMdUrl = (ctx: Ctx, slug: string) => `${ctx.base}/${slug}.md`

/** Resolves a link written in a page's Markdown: other site pages become site URLs, other repository files GitHub URLs. */
function resolveLink(ctx: Ctx, page: Page, href: string, forMarkdown: boolean): string {
  if (/^([a-z]+:|#|\/)/i.test(href)) return href
  const [raw, frag] = href.split('#')
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(page.file), decodeURIComponent(raw!)))
  const hash = frag ? `#${frag}` : ''
  if (target.startsWith('docs/site/') && target.endsWith('.md')) {
    const slug = target.slice('docs/site/'.length, -3)
    if (ctx.pages.some((p) => p.slug === slug)) return (forMarkdown ? pageMdUrl(ctx, slug) : pageUrl(ctx, slug)) + hash
  }
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

const LABEL = { note: 'Note', tip: 'Tip', warning: 'Warning' } as const
const CALLOUT_ICON = { note: 'info', tip: 'lightbulb', warning: 'triangle-alert' } as const

function renderBlocks(ctx: Ctx, page: Page, text: string, ids: { n: number }): string {
  return splitBlocks(text).map((b) => {
    if (b.kind === 'md') return md(b.text)
    if (b.kind === 'note' || b.kind === 'tip' || b.kind === 'warning') {
      return `<div class="callout callout-${b.kind}" role="note"><div class="callout-label">${icon(CALLOUT_ICON[b.kind])}${LABEL[b.kind]}</div>${renderBlocks(ctx, page, b.text, ids)}</div>`
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
      return `**${LABEL[b.kind]}:** ${renderMarkdownBlocks(ctx, page, b.text)}`.split('\n').map((l) => `> ${l}`.trimEnd()).join('\n')
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
    return `<div class="code"><button class="copy-code" type="button" aria-label="Copy code">${icon('copy')}</button><pre><code${lang ? ` class="hljs language-${lang}"` : ''}>${inner}</code></pre></div>`
  })
  const toc: Toc = []
  html = html.replace(/<h([23]) id="([^"]+)">([\s\S]*?)<\/h\1>/g, (_m, level: string, id: string, inner: string) => {
    toc.push({ level: Number(level), id, text: strip(inner) })
    return `<h${level} id="${id}"><a class="anchor" href="#${id}" aria-label="Link to this section">#</a>${inner}</h${level}>`
  })
  html = html.replace(/<table>/g, '<div class="table"><table>').replace(/<\/table>/g, '</table></div>')
  return { html, toc }
}

const firstSlug = (t: NavTab) => t.groups[0]!.pages[0]!
const pageCount = (t: NavTab) => t.groups.reduce((n, g) => n + g.pages.length, 0)

function header(ctx: Ctx, page: Page | null): string {
  const tabs = ctx.nav.tabs.map((t, i) => {
    const active = page?.tab === t.title
    const menu = pageCount(t) > 1
      ? `<button class="tab-caret" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="tab-menu-${i}" aria-label="${esc(t.title)} pages">${icon('chevron-down')}</button><div class="tab-menu" id="tab-menu-${i}">${t.groups.map((g) => `<div class="tab-menu-group"><div class="tab-menu-title">${esc(g.title)}</div>${g.pages.map((slug) => `<a href="${pageUrl(ctx, slug)}">${esc(ctx.pages.find((p) => p.slug === slug)!.title)}</a>`).join('')}</div>`).join('')}</div>`
      : ''
    return `<div class="section-tab${active ? ' active' : ''}"><a href="${pageUrl(ctx, firstSlug(t))}"${active ? ' aria-current="true"' : ''}>${esc(t.title)}</a>${menu}</div>`
  }).join('')
  return `<header class="site-header">
  <div class="bar">
    <button class="menu-button icon-button" type="button" aria-label="Open navigation" aria-controls="sidebar" aria-expanded="false">${icon('menu')}</button>
    <a class="brand" href="${pageUrl(ctx, 'index')}"><img src="${ctx.base}/assets/favicon.svg" alt="" width="24" height="24"><span>${esc(ctx.nav.title)}</span></a>
    <div class="search" role="search">
      ${icon('search')}
      <input id="search-input" type="search" placeholder="Search…" aria-label="Search the docs" autocomplete="off" aria-controls="search-results" aria-expanded="false">
      <kbd>⌘K</kbd>
      <ul id="search-results" class="search-results" role="listbox" hidden></ul>
    </div>
    <nav class="bar-links" aria-label="Links">
      <a class="quiet-link" href="${ctx.nav.repo}" rel="noopener">GitHub</a>
      <a class="open-product" href="${esc(ctx.nav.product.url)}" rel="noopener">${esc(ctx.nav.product.label)}${icon('chevron-right')}</a>
      <button class="theme-button icon-button" type="button" aria-label="Switch light and dark theme">${icon('sun-moon')}</button>
    </nav>
  </div>
  <nav class="section-tabs" aria-label="Sections">${tabs}</nav>
</header>`
}

function sidebar(ctx: Ctx, page: Page | null): string {
  const tab = ctx.nav.tabs.find((t) => t.title === page?.tab) ?? ctx.nav.tabs[0]!
  const groups = tab.groups.map((g) => `<div class="nav-group"><div class="nav-group-title">${esc(g.title)}</div><ul>${g.pages.map((slug) => {
    const p = ctx.pages.find((x) => x.slug === slug)!
    return `<li><a href="${pageUrl(ctx, slug)}"${slug === page?.slug ? ' aria-current="page"' : ''}>${esc(p.title)}</a></li>`
  }).join('')}</ul></div>`).join('')
  // on phones the section tabs and header links live in the drawer
  const drawerTabs = `<div class="drawer-only"><div class="nav-group-title">Sections</div><ul class="drawer-tabs">${ctx.nav.tabs.map((t) => `<li><a href="${pageUrl(ctx, firstSlug(t))}"${t === tab ? ' aria-current="true"' : ''}>${esc(t.title)}</a></li>`).join('')}</ul><div class="drawer-links"><a href="${ctx.nav.repo}" rel="noopener">GitHub</a><a href="${esc(ctx.nav.product.url)}" rel="noopener">${esc(ctx.nav.product.label)}</a></div></div>`
  return `<aside id="sidebar" class="sidebar" aria-label="${esc(tab.title)}">${drawerTabs}${groups}</aside>`
}

function layout(ctx: Ctx, page: Page | null, content: string, toc: Toc, meta: { title: string; description: string; eyebrow: string }): string {
  const i = page ? ctx.pages.indexOf(page) : -1
  const prev = i > 0 ? ctx.pages[i - 1] : undefined
  const next = i >= 0 ? ctx.pages[i + 1] : undefined
  const tocHtml = toc.length ? `<nav class="toc" aria-label="On this page"><div class="toc-head">${icon('text')}<span>On this page</span><button class="toc-toggle icon-button" type="button" aria-expanded="true" aria-controls="toc-list" aria-label="Hide On this page">${icon('chevron-right')}</button></div><ul id="toc-list">${toc.map((t) => `<li class="toc-${t.level}"><a href="#${t.id}">${esc(t.text)}</a></li>`).join('')}</ul></nav>` : '<div class="toc"></div>'
  const pager = page ? `<nav class="pager" aria-label="Previous and next">${prev ? `<a class="pager-prev" href="${pageUrl(ctx, prev.slug)}"><span>Previous</span>${esc(prev.title)}</a>` : '<span></span>'}${next ? `<a class="pager-next" href="${pageUrl(ctx, next.slug)}"><span>Next</span>${esc(next.title)}</a>` : '<span></span>'}</nav>` : ''
  const copy = page ? `<div class="copy-page" data-md="${pageMdUrl(ctx, page.slug)}" data-llms="${ctx.siteUrl}${ctx.base}/llms.txt">
        <button class="copy-main" type="button">${icon('copy')}<span>Copy page</span></button><button class="copy-caret" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="copy-menu" aria-label="More copy options">${icon('chevron-down')}</button>
        <div class="copy-menu" id="copy-menu" role="menu" hidden>
          <button type="button" role="menuitem" data-action="copy-md">${icon('copy')}<span><b>Copy page as Markdown</b><small>For pasting into an AI chat</small></span></button>
          <a role="menuitem" href="${pageMdUrl(ctx, page.slug)}">${icon('file-text')}<span><b>View as Markdown</b><small>This page as plain text</small></span></a>
          <button type="button" role="menuitem" data-action="copy-llms">${icon('link')}<span><b>Copy llms.txt link</b><small>The index of every page, for agents</small></span></button>
        </div>
      </div>` : ''
  const canonical = ctx.siteUrl && page ? `<link rel="canonical" href="${ctx.siteUrl}${pageUrl(ctx, page.slug)}">\n` : ''
  const alt = page ? `<link rel="alternate" type="text/markdown" href="${pageMdUrl(ctx, page.slug)}">\n` : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page?.slug === 'index' ? ctx.nav.title : `${meta.title} · ${ctx.nav.title}`)}</title>
<meta name="description" content="${esc(meta.description)}">
${canonical}${alt}<link rel="icon" href="${ctx.base}/assets/favicon.svg">
<link rel="stylesheet" href="${ctx.base}/assets/site.css">
<script>try{var t=localStorage.getItem('trina-docs-theme');if(t)document.documentElement.dataset.theme=t}catch(e){}</script>
</head>
<body data-base="${esc(ctx.base)}">
<a class="skip" href="#content">Skip to content</a>
${header(ctx, page)}
<div class="shell">
  ${sidebar(ctx, page)}
  <main id="content" class="content">
    ${meta.eyebrow ? `<div class="eyebrow">${esc(meta.eyebrow)}</div>` : ''}
    <div class="title-row"><h1>${esc(meta.title)}</h1>${copy}</div>
    <p class="lead">${esc(meta.description)}</p>
    <article class="prose">${content}</article>
    ${pager}
    <footer class="footer">Trina AX is free software under AGPL-3.0-only. Icons: Lucide (ISC).${page ? ` <a href="${ctx.nav.repo}/edit/main/${page.file}" rel="noopener">Edit this page</a>` : ''}</footer>
  </main>
  ${tocHtml}
</div>
<div class="scrim" hidden></div>
<script src="${ctx.base}/assets/site.js" defer></script>
</body>
</html>
`
}

// ---------------- build ----------------
export function build(argv: string[]) {
  const o = options(argv)
  const nav = readNav()
  const pages = loadPages(nav)
  for (const p of pages) if (!p.title || !p.description) throw new Error(`${p.file}: front matter needs title and description`)
  const ctx: Ctx = { nav, pages, base: o.base, siteUrl: o.siteUrl }
  fs.rmSync(o.out, { recursive: true, force: true })
  fs.mkdirSync(path.join(o.out, 'assets'), { recursive: true })

  const index: { t: string; u: string; g: string; d: string; h: string[]; x: string }[] = []
  const full: string[] = [`# ${nav.title}\n\n> ${nav.description}\n`]
  for (const page of pages) {
    const { html, toc } = postProcess(ctx, page, renderBlocks(ctx, page, page.body, { n: 0 }))
    const dir = page.slug === 'index' ? o.out : path.join(o.out, page.slug)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'index.html'), layout(ctx, page, html, toc, { title: page.title, description: page.description, eyebrow: page.group }))
    const mdText = renderMarkdown(ctx, page)
    fs.mkdirSync(path.dirname(path.join(o.out, `${page.slug}.md`)), { recursive: true })
    fs.writeFileSync(path.join(o.out, `${page.slug}.md`), mdText)
    full.push(`\n---\n\nSource: ${o.siteUrl}${pageMdUrl(ctx, page.slug)}\n\n${mdText}`)
    index.push({ t: page.title, u: pageUrl(ctx, page.slug), g: `${page.tab} › ${page.group}`, d: page.description, h: toc.map((t) => t.text), x: strip(html).slice(0, 4000) })
  }

  const llms = [`# ${nav.title}`, '', `> ${nav.description}`, '', '## Root URL', '', `${o.siteUrl}${ctx.base}/`, '',
    'Every page is also plain Markdown: add `.md` to its address. All pages in one file: `llms-full.txt`.', '']
  for (const t of nav.tabs) {
    llms.push(`### ${t.title}`, '')
    for (const g of t.groups) for (const slug of g.pages) {
      const p = pages.find((x) => x.slug === slug)!
      llms.push(`- [${p.title}](${o.siteUrl}${pageMdUrl(ctx, slug)}) - ${p.description}`)
    }
    llms.push('')
  }
  fs.writeFileSync(path.join(o.out, 'llms.txt'), llms.join('\n'))
  fs.writeFileSync(path.join(o.out, 'llms-full.txt'), full.join('\n'))
  fs.writeFileSync(path.join(o.out, 'search-index.json'), JSON.stringify(index))

  const assets = path.join(import.meta.dir, 'assets')
  for (const f of fs.readdirSync(assets)) fs.copyFileSync(path.join(assets, f), path.join(o.out, 'assets', f))
  fs.copyFileSync(path.join(ROOT, 'web/public/favicon.svg'), path.join(o.out, 'assets/favicon.svg'))
  fs.writeFileSync(path.join(o.out, '404.html'), layout(ctx, null, `<p><a href="${pageUrl(ctx, 'index')}">Go to the intro</a>, or search above.</p>`, [],
    { title: 'Page not found', description: 'This page does not exist.', eyebrow: '' }))
  return { out: o.out, pages: pages.length }
}

if (import.meta.main) {
  const r = build(process.argv.slice(2))
  console.log(`Docs site: ${r.pages} pages → ${path.relative(process.cwd(), r.out) || r.out}`)
}

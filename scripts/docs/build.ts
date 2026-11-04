// Builds the documentation site in docs/site/ into a static folder (default dist/docs-site/). `bun run docs:build`.
//   bun scripts/docs/build.ts [--out DIR] [--base /docs] [--site-url https://docs.example.com]
// Output: <slug>/index.html for every page, <slug>.md (plain Markdown for agents), llms.txt, llms-full.txt,
// search-index.json and assets/. No dependencies beyond the repository's own: Bun's Markdown renderer, plus
// highlight.js and lucide icons from web/node_modules when they are installed.
//
// Components in the Markdown sources (one block per container, not nested):
//   :::note / :::tip / :::warning … :::      a callout
//   :::steps … :::                          steps; each starts with a "#### Title" line
//   :::cards cols=2 … :::                   cards; each line "- icon=name | [Title](link.md) | One sentence."
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { ROOT, loadPages, readNav, type Nav, type Page } from './site'

type MarkdownApi = { html: (md: string, opts?: Record<string, unknown>) => string }
const markdown = (Bun as unknown as { markdown?: MarkdownApi }).markdown
if (!markdown?.html) throw new Error('This build needs Bun.markdown (Bun 1.3.8 or newer).')
const md = (text: string) => markdown.html(text, { headings: { ids: true }, autolinks: true })

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
const strip = (html: string) => unesc(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()

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
    const src = fs.readFileSync(path.join(dir, 'dist/esm/icons', `${name}.mjs`), 'utf8')
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
interface Block { kind: 'md'; text: string }
interface Comp { kind: 'note' | 'tip' | 'warning' | 'steps' | 'cards'; args: string; text: string }

function splitBlocks(body: string): (Block | Comp)[] {
  const out: (Block | Comp)[] = []
  const lines = body.split('\n')
  let buf: string[] = []
  let comp: Comp | null = null
  let fence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) fence = !fence
    if (!fence && !comp) {
      const open = /^:::(note|tip|warning|steps|cards)\b\s*(.*)$/.exec(line)
      if (open) {
        if (buf.length) out.push({ kind: 'md', text: buf.join('\n') }); buf = []
        comp = { kind: open[1] as Comp['kind'], args: open[2] ?? '', text: '' }
        continue
      }
    }
    if (!fence && comp && /^:::\s*$/.test(line)) { out.push(comp); comp = null; continue }
    if (comp) comp.text += `${line}\n`
    else buf.push(line)
  }
  if (comp) throw new Error(`unclosed :::${comp.kind}`)
  if (buf.length) out.push({ kind: 'md', text: buf.join('\n') })
  return out
}

function steps(text: string): { title: string; body: string }[] {
  const out: { title: string; body: string }[] = []
  let fence = false
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence
    const t = !fence && /^####\s+(.+)$/.exec(line)
    if (t) out.push({ title: t[1]!, body: '' })
    else if (out.length) out.at(-1)!.body += `${line}\n`
  }
  return out
}

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

function renderHtmlBody(ctx: Ctx, page: Page): string {
  return splitBlocks(page.body).map((b) => {
    if (b.kind === 'md') return md(b.text)
    if (b.kind === 'note' || b.kind === 'tip' || b.kind === 'warning') {
      return `<div class="callout callout-${b.kind}" role="note"><div class="callout-label">${icon(b.kind === 'warning' ? 'triangle-alert' : b.kind === 'tip' ? 'lightbulb' : 'info')}${LABEL[b.kind]}</div>${md(b.text)}</div>`
    }
    if (b.kind === 'steps') {
      return `<ol class="steps">${steps(b.text).map((s) => `<li class="step"><div class="step-title">${md(s.title).replace(/^<p>|<\/p>\s*$/g, '')}</div>${md(s.body)}</li>`).join('')}</ol>`
    }
    const cols = /cols=(\d)/.exec(b.args)?.[1] ?? '2'
    return `<div class="cards cols-${cols}">${cards(b.text).map((c) => `<a class="card" href="${esc(resolveLink(ctx, page, c.href, false))}"><span class="card-icon">${icon(c.icon)}</span><span class="card-title">${esc(c.title)}</span><span class="card-desc">${md(c.desc).replace(/^<p>|<\/p>\s*$/g, '')}</span></a>`).join('')}</div>`
  }).join('\n')
}

/** Plain Markdown for agents: callouts as quotes, steps as a numbered list, cards as links. */
function renderMarkdown(ctx: Ctx, page: Page): string {
  const fix = (text: string) => text.replace(/(!?\[[^\]]*\])\(([^)\s]+)\)/g, (_m, label: string, href: string) => `${label}(${resolveLink(ctx, page, href, true)})`)
  const body = splitBlocks(page.body).map((b) => {
    if (b.kind === 'md') return fix(b.text).trim()
    if (b.kind === 'note' || b.kind === 'tip' || b.kind === 'warning') return fix(`**${LABEL[b.kind]}:** ${b.text.trim()}`).split('\n').map((l) => `> ${l}`.trimEnd()).join('\n')
    if (b.kind === 'steps') return steps(b.text).map((s, i) => `${i + 1}. **${s.title}**\n\n${fix(s.body).trim().split('\n').map((l) => (l ? `   ${l}` : l)).join('\n')}`).join('\n\n')
    return cards(b.text).map((c) => `- [${c.title}](${resolveLink(ctx, page, c.href, true)}): ${fix(c.desc)}`).join('\n')
  }).filter(Boolean).join('\n\n')
  return `# ${page.title}\n\n> ${page.description}\n\n${body}\n`
}

// ---------------- page assembly ----------------
function postProcess(ctx: Ctx, page: Page, html: string): { html: string; toc: { level: number; id: string; text: string }[] } {
  html = html.replace(/href="([^"]+)"/g, (_m, href: string) => {
    const r = resolveLink(ctx, page, unesc(href), false)
    const ext = /^https?:/i.test(r) && !(ctx.siteUrl && r.startsWith(ctx.siteUrl))
    return `href="${esc(r)}"${ext ? ' rel="noopener"' : ''}`
  })
  html = html.replace(/<pre><code(?: class="language-([\w+-]+)")?>([\s\S]*?)<\/code><\/pre>/g, (_m, lang: string | undefined, code: string) => {
    let inner = code
    if (hljs && lang && hljs.getLanguage(lang)) { try { inner = hljs.highlight(unesc(code), { language: lang }).value } catch { inner = code } }
    return `<div class="code"><button class="copy-code" type="button" aria-label="Copy code">Copy</button><pre><code${lang ? ` class="hljs language-${lang}"` : ''}>${inner}</code></pre></div>`
  })
  const toc: { level: number; id: string; text: string }[] = []
  html = html.replace(/<h([23]) id="([^"]+)">([\s\S]*?)<\/h\1>/g, (_m, level: string, id: string, inner: string) => {
    toc.push({ level: Number(level), id, text: strip(inner) })
    return `<h${level} id="${id}"><a class="anchor" href="#${id}" aria-label="Link to this section">#</a>${inner}</h${level}>`
  })
  html = html.replace(/<table>/g, '<div class="table"><table>').replace(/<\/table>/g, '</table></div>')
  return { html, toc }
}

function layout(ctx: Ctx, page: Page, content: string, toc: { level: number; id: string; text: string }[]): string {
  const i = ctx.pages.indexOf(page)
  const prev = ctx.pages[i - 1], next = ctx.pages[i + 1]
  const nav = ctx.nav.groups.map((g) => `<div class="nav-group"><div class="nav-group-title">${esc(g.title)}</div><ul>${g.pages.map((slug) => {
    const p = ctx.pages.find((x) => x.slug === slug)!
    return `<li><a href="${pageUrl(ctx, slug)}"${slug === page.slug ? ' aria-current="page"' : ''}>${esc(p.title)}</a></li>`
  }).join('')}</ul></div>`).join('')
  const tocHtml = toc.length ? `<nav class="toc" aria-label="On this page"><div class="toc-title">On this page</div><ul>${toc.map((t) => `<li class="toc-${t.level}"><a href="#${t.id}">${esc(t.text)}</a></li>`).join('')}</ul></nav>` : ''
  const pager = `<nav class="pager" aria-label="Previous and next">${prev ? `<a class="pager-prev" href="${pageUrl(ctx, prev.slug)}"><span>Previous</span>${esc(prev.title)}</a>` : '<span></span>'}${next ? `<a class="pager-next" href="${pageUrl(ctx, next.slug)}"><span>Next</span>${esc(next.title)}</a>` : '<span></span>'}</nav>`
  const canonical = ctx.siteUrl ? `<link rel="canonical" href="${ctx.siteUrl}${pageUrl(ctx, page.slug)}">` : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.slug === 'index' ? ctx.nav.title : `${page.title} · ${ctx.nav.title}`)}</title>
<meta name="description" content="${esc(page.description)}">
${canonical}${page.slug === '404' ? '' : `<link rel="alternate" type="text/markdown" href="${pageMdUrl(ctx, page.slug)}">`}
<link rel="icon" href="${ctx.base}/assets/favicon.svg">
<link rel="stylesheet" href="${ctx.base}/assets/site.css">
<script>try{var t=localStorage.getItem('trina-docs-theme');if(t)document.documentElement.dataset.theme=t}catch(e){}</script>
</head>
<body data-base="${esc(ctx.base)}">
<a class="skip" href="#content">Skip to content</a>
<header class="topbar">
  <button class="menu-button" type="button" aria-label="Open navigation" aria-controls="sidebar" aria-expanded="false">${icon('menu')}</button>
  <a class="brand" href="${pageUrl(ctx, 'index')}"><img src="${ctx.base}/assets/favicon.svg" alt="" width="22" height="22">Trina AX <span>docs</span></a>
  <div class="search" role="search">
    <input id="search-input" type="search" placeholder="Search" aria-label="Search docs" autocomplete="off" aria-controls="search-results" aria-expanded="false">
    <kbd>/</kbd>
    <ul id="search-results" class="search-results" role="listbox" hidden></ul>
  </div>
  <button class="theme-button" type="button" aria-label="Switch light and dark theme">${icon('sun-moon')}</button>
  <a class="repo-link" href="${ctx.nav.repo}" rel="noopener" aria-label="Repository on GitHub">${icon('code-xml')}<span>GitHub</span></a>
</header>
<div class="shell">
  <aside id="sidebar" class="sidebar" aria-label="Documentation">${nav}</aside>
  <main id="content" class="content">
    <div class="eyebrow">${esc(page.group)}</div>
    <h1>${esc(page.title)}</h1>
    <p class="lead">${esc(page.description)}</p>
    ${page.slug === '404' ? '' : `<div class="page-actions"><button class="copy-page" type="button" data-md="${pageMdUrl(ctx, page.slug)}">${icon('copy')}Copy page</button><a href="${pageMdUrl(ctx, page.slug)}">${icon('file-text')}View as Markdown</a></div>`}
    <article class="prose">${content}</article>
    ${pager}
    <footer class="footer">Trina AX is free software under AGPL-3.0-only. Icons: Lucide (ISC). <a href="${ctx.nav.repo}/edit/main/${page.file}" rel="noopener">Edit this page</a></footer>
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
    const { html, toc } = postProcess(ctx, page, renderHtmlBody(ctx, page))
    const dir = page.slug === 'index' ? o.out : path.join(o.out, page.slug)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'index.html'), layout(ctx, page, html, toc))
    const mdText = renderMarkdown(ctx, page)
    fs.mkdirSync(path.dirname(path.join(o.out, `${page.slug}.md`)), { recursive: true })
    fs.writeFileSync(path.join(o.out, `${page.slug}.md`), mdText)
    full.push(`\n---\n\nSource: ${o.siteUrl}${pageMdUrl(ctx, page.slug)}\n\n${mdText}`)
    index.push({ t: page.title, u: pageUrl(ctx, page.slug), g: page.group, d: page.description, h: toc.map((t) => t.text), x: strip(html).slice(0, 4000) })
  }

  const llms = [`# ${nav.title}`, '', `> ${nav.description}`, '', '## Root URL', '', `${o.siteUrl}${ctx.base}/`, '',
    'Every page is also plain Markdown: add `.md` to its address. All pages in one file: `llms-full.txt`.', '']
  for (const g of nav.groups) {
    llms.push(`### ${g.title}`, '')
    for (const slug of g.pages) {
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
  const notFound = pages[0]!
  fs.writeFileSync(path.join(o.out, '404.html'), layout(ctx, { ...notFound, slug: '404', title: 'Page not found', description: 'This page does not exist. Use the navigation or search.', group: '' },
    `<p><a href="${pageUrl(ctx, 'index')}">Go to the intro</a></p>`, []))
  return { out: o.out, pages: pages.length }
}

if (import.meta.main) {
  const r = build(process.argv.slice(2))
  console.log(`Docs site: ${r.pages} pages → ${path.relative(process.cwd(), r.out) || r.out}`)
}

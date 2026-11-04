// The documentation site (docs/site/, scripts/docs/): every page is in the navigation with a title and a description,
// its links resolve, the HTTP API page matches the API contract, nothing private slipped in, and the build produces
// the HTML, the Markdown copies and llms.txt that agents read.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'bun:test'
import { ROOT, loadPages, navSlugs, readNav, siteMarkdownFiles } from '../../scripts/docs/site'
import { API_REFERENCE_FILE, apiReferenceMarkdown } from '../../scripts/docs/api-reference'
import { localLinkProblems } from '../../scripts/check-onboarding-docs'

describe('docs site', () => {
  test('every page is in the navigation once, with a title and a description', () => {
    const nav = readNav()
    const slugs = navSlugs(nav)
    for (const t of nav.tabs) expect(t.groups.length, t.title).toBeGreaterThan(0)
    expect(new Set(slugs).size).toBe(slugs.length)
    expect(siteMarkdownFiles()).toEqual(slugs.map((s) => `docs/site/${s}.md`).sort())
    for (const p of loadPages(nav)) {
      expect(p.title, p.file).toBeTruthy()
      expect(p.description, p.file).toBeTruthy()
      expect(p.body.trimStart().startsWith('# '), `${p.file}: the title comes from the front matter`).toBe(false)
    }
  })

  test('links resolve', () => {
    expect(siteMarkdownFiles().flatMap((f) => localLinkProblems(f))).toEqual([])
  })

  test('every screenshot a page shows exists, has alt text, and every screenshot is used', () => {
    const used = new Set<string>()
    for (const f of siteMarkdownFiles()) {
      const text = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/```[\s\S]*?```/g, '')
      for (const m of text.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[2]!))
        expect(m[1]!.trim().length, `${f}: alt text for ${m[2]}`).toBeGreaterThan(10)
        expect(target.startsWith('docs/site/images/'), `${f}: ${m[2]} is outside docs/site/images`).toBe(true)
        expect(fs.existsSync(path.join(ROOT, target)), `${f}: ${m[2]} is missing`).toBe(true)
        used.add(target)
      }
    }
    const images = path.join(ROOT, 'docs/site/images')
    const all = fs.existsSync(images) ? (fs.readdirSync(images, { recursive: true }) as string[]).filter((n) => /\.(webp|png|jpe?g)$/.test(n)).map((n) => `docs/site/images/${n.split(path.sep).join('/')}`) : []
    expect(all.filter((a) => !used.has(a)), 'screenshots no page uses').toEqual([])
    for (const a of all) expect(fs.statSync(path.join(ROOT, a)).size, `${a} is too large`).toBeLessThan(300 * 1024)
  })

  test('the HTTP API page is generated from the contract (bun run docs:api)', () => {
    expect(fs.readFileSync(path.join(ROOT, API_REFERENCE_FILE), 'utf8')).toBe(apiReferenceMarkdown())
  })

  test('no private host names, personal paths or secrets', () => {
    for (const f of siteMarkdownFiles()) {
      const text = fs.readFileSync(path.join(ROOT, f), 'utf8')
      expect(text, f).not.toMatch(/\.ts\.net|\/Users\/[a-z]|\/home\/[a-z]|sk-ant-|ghp_[A-Za-z0-9]|BEGIN [A-Z ]*PRIVATE KEY/)
    }
  })

  const hasMarkdown = typeof (Bun as unknown as { markdown?: unknown }).markdown === 'object'
  test.skipIf(!hasMarkdown)('the build writes every page as HTML and Markdown, and llms.txt lists them', async () => {
    const { build } = await import('../../scripts/docs/build')
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-site-'))
    try {
      build(['--out', out, '--base', '/docs'])
      const pages = loadPages()
      const llms = fs.readFileSync(path.join(out, 'llms.txt'), 'utf8')
      for (const p of pages) {
        const html = fs.readFileSync(path.join(out, p.slug === 'index' ? '' : p.slug, 'index.html'), 'utf8')
        expect(html).toContain(`<h1>`)
        // every link is absolute: a site page under /docs/, an anchor, or an outside address
        expect(html, p.file).not.toMatch(/href="(?!https?:|\/docs\/|#|mailto:)[^"]+"/)
        expect(fs.existsSync(path.join(out, `${p.slug}.md`))).toBe(true)
        expect(llms).toContain(`(/docs/${p.slug}.md)`)
      }
      expect(fs.readFileSync(path.join(out, 'llms-full.txt'), 'utf8')).toContain('# Quickstart')
      // tabs become labelled sections in the Markdown copy, and real tabs in HTML
      expect(fs.readFileSync(path.join(out, 'operate/install.md'), 'utf8')).toContain('**Office Mac**')
      expect(fs.readFileSync(path.join(out, 'operate/install/index.html'), 'utf8')).toContain('role="tablist"')
      // screenshots are copied and shown as figures with their alt text
      expect(fs.existsSync(path.join(out, 'images/mcp/add.webp'))).toBe(true)
      expect(fs.readFileSync(path.join(out, 'use/mcp/index.html'), 'utf8')).toMatch(/<figure class="shot">[\s\S]*?src="\/docs\/images\/mcp\/add\.webp" alt="The Add Notion dialog/)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  // ax.trina.app/docs: the website copies this build into public/docs/ (its scripts/sync-docs.mjs). That site's
  // Content-Security-Policy is script-src 'self'; style-src 'self'; img-src 'self'.
  test.skipIf(!hasMarkdown)('a build for ax.trina.app/docs stays under /docs, has absolute agent links and no inline code', async () => {
    const { build } = await import('../../scripts/docs/build')
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-site-'))
    try {
      build(['--out', out, '--base', '/docs', '--site-url', 'https://ax.trina.app'])
      const htmls = (fs.readdirSync(out, { recursive: true }) as string[]).filter((n) => n.endsWith('.html'))
      expect(htmls.length).toBeGreaterThan(loadPages().length)
      for (const n of htmls) {
        const html = fs.readFileSync(path.join(out, n), 'utf8')
        // every address on the site stays under /docs/ (or is outside the site)
        expect(html, n).not.toMatch(/(?:href|src|data-src|data-md)="\/(?!docs\/)[^"]*"/)
        // no inline script (only <script src>), no style attribute, no inline event handler, no data: URL
        expect(html, n).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/)
        expect(html, n).not.toMatch(/\sstyle="|\son[a-z]+="|="data:/)
      }
      for (const f of ['assets/site.css', 'assets/site.js', 'assets/theme.js']) expect(fs.readFileSync(path.join(out, f), 'utf8'), f).not.toContain('data:')
      const llms = fs.readFileSync(path.join(out, 'llms.txt'), 'utf8')
      expect(llms).toContain('https://ax.trina.app/docs/\n')
      for (const p of loadPages()) expect(llms).toContain(`(https://ax.trina.app/docs/${p.slug}.md)`)
      expect(fs.readFileSync(path.join(out, 'llms-full.txt'), 'utf8')).toContain('Source: https://ax.trina.app/docs/get-started/quickstart.md')
      expect(fs.readFileSync(path.join(out, 'index.html'), 'utf8')).toContain('<link rel="canonical" href="https://ax.trina.app/docs/">')
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })
})

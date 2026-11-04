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
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })
})

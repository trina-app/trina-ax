// The docs the AI's docs tool searches (trina_docs: server/src/docs-help/, docs/decisions/20261124-trina-docs-tool.md),
// built from the docs site (build.ts plainSite: the same rendering as the pages) and shipped in every server bundle
// at resources/docs/help-index.json (stageDocsHelp: build-bundle.ts for macOS and Linux, build-office.ts), so an
// installed server answers from the docs of its own version. A source checkout's server runs helpIndex() itself.
//
//   bun scripts/docs/help-index.ts [--out FILE]     writes the file (default dist/docs-help/help-index.json), prints its size
//
// Each language holds every page of its navigation: its own pages, and for a page it has not translated the language's
// tab and group names with the English page's address (so a Korean "설치" finds the English install page). The links
// are the public docs site's (PUBLIC_DOCS: the website publishes this site at ax.trina.app/docs).
import fs from 'node:fs'
import path from 'node:path'
import { HELP_INDEX_FILE, HELP_LANGS, HelpIndex, type HelpLang, type HelpPage } from '../../server/src/docs-help/data'
import { plainSite } from './build'
import { LANGS, ROOT } from './site'

/** Where the website publishes the docs (its scripts/sync-docs.mjs: --base /docs --site-url https://ax.trina.app), and
 * its pricing page. */
export const PUBLIC_DOCS = { siteUrl: 'https://ax.trina.app', base: '/docs', pricing: 'https://ax.trina.app/pricing' } as const
/** pages the help search leaves out: the generated list of HTTP endpoints (no prose; 130 KB, a third of English) */
export const HELP_LEFT_OUT: ReadonlySet<string> = new Set(['reference/http-api'])

export function helpIndex(): HelpIndex {
  if (LANGS.join() !== HELP_LANGS.join()) throw new Error(`docs languages ${LANGS.join()} differ from the server's ${HELP_LANGS.join()}`)
  const site = plainSite({ base: PUBLIC_DOCS.base, siteUrl: PUBLIC_DOCS.siteUrl })
  const en = site.find((l) => l.lang === 'en')!
  const langs = Object.fromEntries(site.map((l) => {
    const own = new Map(l.pages.map((p) => [p.slug, p]))
    const pages: HelpPage[] = l.nav.filter((n) => !HELP_LEFT_OUT.has(n.slug)).map((n) => {
      const place = `${n.tab} › ${n.group}`
      const p = own.get(n.slug)
      if (p) return { slug: p.slug, title: p.title, description: p.description, url: p.url, place, sections: p.sections }
      const e = en.pages.find((x) => x.slug === n.slug)!
      return { slug: e.slug, title: e.title, description: e.description, url: e.url, place, sections: [], english: true }
    })
    return [l.lang, pages]
  })) as Record<HelpLang, HelpPage[]>
  return HelpIndex.parse({ v: 1, pricing: PUBLIC_DOCS.pricing, langs })
}

/** Writes the docs into a bundle's version folder (or the office zip's app/): <destination>/resources/docs/help-index.json. */
export function stageDocsHelp(destination: string): { file: string; bytes: number } {
  const file = path.join(destination, HELP_INDEX_FILE)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const text = JSON.stringify(helpIndex())
  fs.writeFileSync(file, text)
  fs.chmodSync(file, 0o644)
  return { file, bytes: Buffer.byteLength(text) }
}

if (import.meta.main) {
  const i = process.argv.indexOf('--out')
  const out = path.resolve(i >= 0 ? process.argv[i + 1]! : path.join(ROOT, 'dist/docs-help/help-index.json'))
  const text = JSON.stringify(helpIndex())
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, text)
  const gz = Bun.gzipSync(Buffer.from(text)).length
  console.log(`${path.relative(process.cwd(), out) || out}: ${Buffer.byteLength(text)} bytes (${gz} gzipped)`)
}

// The documentation site in docs/site/: its navigation (nav.json: section tabs → groups → pages) and its pages
// (Markdown with a small front matter). Used by the site build (build.ts), the API reference generator
// (api-reference.ts), check:docs and the unit test.
import fs from 'node:fs'
import path from 'node:path'

export const ROOT = path.resolve(import.meta.dir, '../..')
export const SITE_DIR = path.join(ROOT, 'docs/site')

export interface NavGroup { title: string; pages: string[] }
/** A section tab in the second header row; the left sidebar shows the groups of the active tab. */
export interface NavTab { title: string; groups: NavGroup[] }
export interface Nav {
  title: string
  description: string
  repo: string
  /** the product's own site, for "Open Trina AX" in the header */
  product: { label: string; url: string }
  tabs: NavTab[]
}

export interface Page {
  /** "index", "get-started/quickstart", … (the file is docs/site/<slug>.md) */
  slug: string
  /** path from the repository root, e.g. docs/site/get-started/quickstart.md */
  file: string
  tab: string
  group: string
  title: string
  description: string
  /** Markdown after the front matter */
  body: string
}

export const readNav = (): Nav => JSON.parse(fs.readFileSync(path.join(SITE_DIR, 'nav.json'), 'utf8')) as Nav

/** Every page slug in navigation order. */
export const navSlugs = (nav = readNav()): string[] => nav.tabs.flatMap((t) => t.groups.flatMap((g) => g.pages))

/** `---\nkey: value\n---\n` at the top. Values are plain one-line strings. */
export function parseFrontMatter(text: string): { data: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { data: {}, body: text }
  const data: Record<string, string> = {}
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (kv) data[kv[1]!] = kv[2]!.trim()
  }
  return { data, body: text.slice(m[0].length) }
}

/** The pages in navigation order. Throws when a page in nav.json has no file. */
export function loadPages(nav = readNav()): Page[] {
  return nav.tabs.flatMap((t) => t.groups.flatMap((g) => g.pages.map((slug) => {
    const file = `docs/site/${slug}.md`
    const { data, body } = parseFrontMatter(fs.readFileSync(path.join(ROOT, file), 'utf8'))
    return { slug, file, tab: t.title, group: g.title, title: data.title ?? '', description: data.description ?? '', body }
  })))
}

/** Every Markdown file under docs/site/, as repository-relative paths. */
export function siteMarkdownFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.md')) out.push(path.relative(ROOT, p).split(path.sep).join('/'))
    }
  }
  walk(SITE_DIR)
  return out.sort()
}

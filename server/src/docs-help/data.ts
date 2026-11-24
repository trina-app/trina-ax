// The app's own docs as the AI's docs tool reads them (trina_docs, docs/decisions/20261124-trina-docs-tool.md): every
// language of the docs site (docs/site), as plain text cut into sections, with each page's public address. The release
// build writes them into the version folder (scripts/docs/help-index.ts stageDocsHelp: resources/docs/help-index.json),
// so an installed server answers from the docs of its own version, hosted or self-hosted, and nothing is fetched at
// answer time. A source checkout (development, tests) builds the same data from docs/site on first use.
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { REPO_ROOT } from '../app-config'

/** the file in the version folder (and in a bundle's stage folder) */
export const HELP_INDEX_FILE = 'resources/docs/help-index.json'
/** the builder a source checkout runs instead (never in a bundle: scripts/ is not shipped) */
const SOURCE_BUILDER = 'scripts/docs/help-index.ts'
const SOURCE_NAV = 'docs/site/nav.json'

/** The languages of the docs site (scripts/docs/site.ts LANGS): the app's six. */
export const HELP_LANGS = ['en', 'ko', 'zh', 'ja', 'es', 'id'] as const
export type HelpLang = (typeof HELP_LANGS)[number]

const Section = z.object({ heading: z.string().max(500), text: z.string().max(200_000) })
const Page = z.object({
  slug: z.string().min(1).max(200),
  title: z.string().max(500),
  description: z.string().max(2000),
  /** the page's public address in this language (English for a page this language has not translated) */
  url: z.string().url().max(500),
  /** where the page sits in this language's navigation: "tab › group" */
  place: z.string().max(500),
  sections: z.array(Section).max(500),
  /** a page this language has not translated: its navigation names only, and the English page's address */
  english: z.literal(true).optional(),
})
export const HelpIndex = z.object({
  v: z.literal(1),
  /** the pricing page, for the instructions' one line */
  pricing: z.string().url().max(500),
  /** every language of HELP_LANGS: its pages in navigation order, the ones it has not translated too */
  langs: z.object({ en: z.array(Page).max(1000), ko: z.array(Page).max(1000), zh: z.array(Page).max(1000), ja: z.array(Page).max(1000), es: z.array(Page).max(1000), id: z.array(Page).max(1000) }),
})
export type HelpIndex = z.infer<typeof HelpIndex>
export type HelpPage = z.infer<typeof Page>

/** Where this server's docs come from: the release's file, a source checkout's docs/site, or none (then the tool is
 * not offered). */
export function docsHelpSource(root: string = REPO_ROOT): 'release' | 'source' | null {
  if (fs.existsSync(path.join(root, HELP_INDEX_FILE))) return 'release'
  if (fs.existsSync(path.join(root, SOURCE_BUILDER)) && fs.existsSync(path.join(root, SOURCE_NAV))) return 'source'
  return null
}

const loaded = new Map<string, HelpIndex | null>()

/** The docs (read once per server process), or null when this server has none or they do not read. */
export function helpIndex(root: string = REPO_ROOT): HelpIndex | null {
  if (loaded.has(root)) return loaded.get(root)!
  let index: HelpIndex | null = null
  try {
    const source = docsHelpSource(root)
    if (source === 'release') index = HelpIndex.parse(JSON.parse(fs.readFileSync(path.join(root, HELP_INDEX_FILE), 'utf8')))
    // the docs build itself, from the checkout (a computed path: the bundler leaves it out of the server's files)
    else if (source === 'source') index = HelpIndex.parse((require(path.join(root, SOURCE_BUILDER)) as { helpIndex(): unknown }).helpIndex())
  } catch {
    index = null
  }
  loaded.set(root, index)
  return index
}

/** Is the docs tool offered on this server: are its docs there, and do they read? (read on the first call: about 20 ms
 * from a release's file) */
export const docsHelpOn = (root: string = REPO_ROOT): boolean => helpIndex(root) !== null

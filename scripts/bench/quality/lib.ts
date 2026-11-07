// Shared parts of the search quality test (README.md): where things are, the questions, the made-up target documents
// and the downloaded distractors. No network, no search.
import fs from 'node:fs'
import path from 'node:path'
import { extractText } from '../../../server/src/files/extract'
import { htmlText } from '../../../server/src/knowledge-graph/documents/text'

export const HERE = import.meta.dir
export const REPO = path.resolve(HERE, '../../..')
/** the 22 documents of the wave 1 benchmark and the documents added for this test */
export const TARGET_DIRS = [path.join(REPO, 'scripts/bench/docs'), path.join(HERE, 'docs')]
/** downloaded articles and models; git ignores it (never commit what is in it) */
export const CACHE = path.join(HERE, '.cache')
export const WIKI_DIR = path.join(CACHE, 'wiki')
/** the list of downloaded articles (title, page id, revision), written by fetch.ts next to the articles */
export const WIKI_INDEX = path.join(WIKI_DIR, 'index.json')
/** the titles chosen once, committed so that another machine downloads the same articles */
export const DISTRACTOR_LIST = path.join(HERE, 'distractors.json')
export const RESULTS = path.join(HERE, 'results')

/** the folder of the index the documents go into, and where each kind of file sits in it */
export const ROOT_ID = 'quality'
export const TARGET_PREFIX = 'acme/'
export const WIKI_PREFIX = 'wiki/'

export const TYPES = ['paraphrase', 'exact', 'table', 'cross', 'filename'] as const
export type QType = (typeof TYPES)[number]
export interface Question { id: string; lang: 'ko' | 'en'; type: QType; q: string; expectFiles: string[]; answer?: string }

export function loadQuestions(file = path.join(HERE, 'questions.json')): Question[] {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { questions: Question[] }
  return raw.questions
}

export interface TargetFile { name: string; abs: string; rel: string }
/** every made-up document, by file name (names are unique across the two folders) */
export function targetFiles(): TargetFile[] {
  const out = new Map<string, TargetFile>()
  for (const dir of TARGET_DIRS) {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name)
      if (!fs.statSync(abs).isFile() || name.startsWith('.')) continue
      if (out.has(name)) throw new Error(`two target documents are named ${name}`)
      out.set(name, { name, abs, rel: TARGET_PREFIX + name })
    }
  }
  return [...out.values()]
}

export interface WikiArticle { lang: 'ko' | 'en'; title: string; pageid: number; revid: number; group: 'topic' | 'general'; seed: string; file: string; chars: number }
/** the downloaded articles (fetch.ts), or null when nothing was downloaded yet */
export function wikiArticles(): WikiArticle[] | null {
  if (!fs.existsSync(WIKI_INDEX)) return null
  const idx = JSON.parse(fs.readFileSync(WIKI_INDEX, 'utf8')) as { articles: WikiArticle[] }
  return idx.articles.filter((a) => fs.existsSync(path.join(WIKI_DIR, a.file)))
}

/** a file's text as the document index extracts it (files/extract.ts; HTML without its tags) */
export async function textOf(name: string, bytes: Uint8Array): Promise<string> {
  const raw = await extractText(name, bytes, { pandoc: Bun.which('pandoc'), pdftotext: Bun.which('pdftotext'), stoppedPartFails: true })
  return /\.html?$/i.test(name) ? htmlText(raw) : raw
}

/** a stable order for strings: sha256 of the text (the index takes files in this order, so that no kind of file is
 * listed first by the full-text index, which takes the first few hundred matches of a word unranked) */
export const hashKey = (s: string) => new Bun.CryptoHasher('sha256').update(s).digest('hex')

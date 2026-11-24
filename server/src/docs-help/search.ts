// The docs tool's search (trina_docs, docs/decisions/20261124-trina-docs-tool.md): local, over the docs of this server's
// version (data.ts), nothing leaves the server.
//
// - BM25 over sections (h2 and h3 of a page): a section's words are its own text and heading, its page's title (three
//   times) and navigation place, and for the first section the page's description; plus half of each query word's
//   weight when the page's title holds it, and half again when its description does (a page about the thing beats a
//   page that mentions it often). A page scores its best section.
// - Words: Latin script as lower-case words without accents, short endings cut (connect/connected/connecting) and a few
//   stop words left out; Hangul, Han and kana as pairs of characters (no spaces between Korean particles, none at all in
//   Chinese and Japanese), a run of one as itself; a Korean word is first read as the app's other searches read it
//   (searchTerm: 연결하려면 → 연결, 한도는 → 한도), and words that only ask (어떻게, 해요) are left out. Names and a few loanwords people write in
//   Hangul, katakana or Han (슬랙, 구글 드라이브, 로그인, スラック) count as the English words the pages use.
//   The tests' 20 questions in Korean and English hold all of this (tests/unit/docs-help.test.ts).
// - Languages: the query's own script first (Hangul: Korean, kana: Japanese, Han alone: Chinese), then the person's
//   language, then English; each adds pages the earlier ones did not find, up to 3, and only pages that score at
//   least a third of that language's best. A page links in the person's language when it is translated, else in English.
// - The passage: the sentences of the page's best section that hold the most of the query's rarer words, at most
//   PASSAGE_MAX characters; a section with none of them gives its first sentences.
import { searchTerm } from '@mycel/shared'
import type { HelpIndex, HelpLang, HelpPage } from './data'

/** pages a search returns */
export const DOCS_HITS_MAX = 3
/** characters of a passage */
export const PASSAGE_MAX = 300

export interface DocsHit {
  slug: string
  title: string
  /** the page's public address: in the person's language when translated, else English */
  url: string
  /** the address is the English page while the person's language is another */
  english: boolean
  /** the section the passage is from */
  heading: string
  passage: string
  /** the language the page was found in */
  lang: HelpLang
}

const K1 = 1.2
const B = 0.75
const TITLE_WEIGHT = 3
const HEADING_WEIGHT = 2
/** of a query word's weight, when the page's title holds it, and when its description does */
const TITLE_BONUS = 0.5
const ABOUT_BONUS = 0.5

/** Names and loanwords people write in Hangul, katakana or Han where the English pages (and, for names, the translated
 * ones) write Latin letters: each counts as its English words, so a translated page and an English-only one meet the
 * same query (구글 계정으로 로그인 → google, sign: the English page "Sign in with Google") */
const SPELLED: readonly (readonly [string, string])[] = [
  ['슬랙', 'slack'], ['구글', 'google'], ['드라이브', 'drive'], ['지메일', 'gmail'], ['캘린더', 'calendar'], ['노션', 'notion'],
  ['깃허브', 'github'], ['깃헙', 'github'], ['클로드', 'claude'], ['챗지피티', 'chatgpt'], ['오픈에이아이', 'openai'], ['리눅스', 'linux'],
  ['도커', 'docker'], ['윈도우', 'windows'], ['맥북', 'mac'], ['아이폰', 'iphone'], ['안드로이드', 'android'], ['코덱스', 'codex'],
  ['로그인', 'sign'], ['로그아웃', 'sign out'], ['설치', 'install'], ['업데이트', 'update'], ['백업', 'backup'],
  ['スラック', 'slack'], ['グーグル', 'google'], ['ドライブ', 'drive'], ['ジーメール', 'gmail'], ['ノーション', 'notion'], ['クロード', 'claude'],
  ['ログイン', 'sign'], ['インストール', 'install'], ['アップデート', 'update'], ['バックアップ', 'backup'],
  ['登录', 'sign'], ['安装', 'install'], ['备份', 'backup'],
]
const STOP = new Set(('a an the to of in on for and or is are be do does did i you we my our your it its how can what where which who why when ' +
  'with from at by this that these those there me us them should will would could as if not no so am was were has have had any into about ' +
  'please want ' +
  // Spanish and Indonesian words that only hold a question together
  'de la el en que los las un una para con por como mi se es del al lo yang dan di ke untuk dengan ini itu cara bagaimana saya apa').split(' '))
const ENDINGS = ['ing', 'ions', 'ion', 'ed', 'es', 's', 'e']
const stem = (w: string) => {
  for (const e of ENDINGS) if (w.endsWith(e) && w.length - e.length >= 3) return w.slice(0, -e.length)
  return w
}
/** Korean words that only ask (어떻게, 해요, 방법, …), and particles and verb forms standing alone */
const KO_STOP = new Set(('어떻게 어떡해 어디 어디서 어디에 어디에서 뭐 뭔가 무엇 무엇을 뭐예요 뭔가요 왜 언제 누가 좀 수 것 거 게 법 방법 해요 하나요 있나요 ' +
  '있어요 있을까요 되나요 돼요 되요 할까요 해야 하는 하면 하려면 할 싶어요 알려 알려줘 주세요 줘 제 내 저 저희 우리 그 이 안 못 ' +
  '은 는 가 을 를 에 로 와 과 의 도 만').split(' '))
/** A Korean word as the app's other searches read it (shared search-text.ts searchTerm: without its particle, a verb
 * by its stem: 연결하려면 → 연결, 한도는 → 한도), or null for a word that only asks. */
function koWord(w: string): string | null {
  if (KO_STOP.has(w)) return null
  const t = searchTerm(w)
  return KO_STOP.has(t) ? null : t
}
const pairs = (run: string, out: string[]) => {
  if (run.length === 1) { out.push(run); return }
  for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2))
}
/** a run of Hangul, a run of Han and kana, or a word of any other letters and digits (never running into the first two:
 * "Slack을" is "slack" and "을") */
const RUN = /(\p{Script=Hangul}+)|([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+)|((?:(?![\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー])[\p{L}\p{N}])+)/gu

/** The search words of a text, repeated as often as they occur. */
export function words(text: string): string[] {
  const out: string[] = []
  for (const m of text.normalize('NFKC').toLowerCase().matchAll(RUN)) {
    const [, hangul, cjk, latin] = m
    let run = hangul ?? cjk
    if (run) {
      // a name or loanword spelled in Hangul, katakana or Han is its English words, not its letters
      for (const [spelled, english] of SPELLED) if (run.includes(spelled)) { for (const w of english.split(' ')) if (!STOP.has(w)) out.push(stem(w)); run = run.split(spelled).join(' ') }
      for (const piece of run.split(' ')) {
        const w = piece && hangul ? koWord(piece) : piece
        if (w) pairs(w, out)
      }
    } else if (latin) {
      const w = latin.normalize('NFD').replace(/\p{M}/gu, '')
      if (w.length < 2 || STOP.has(w)) continue
      out.push(stem(w))
    }
  }
  return out
}

/** The language a query's own script says: Hangul Korean, kana Japanese, Han without kana Chinese; else null. */
export function queryLang(query: string): HelpLang | null {
  if (/\p{Script=Hangul}/u.test(query)) return 'ko'
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(query)) return 'ja'
  if (/\p{Script=Han}/u.test(query)) return 'zh'
  return null
}

interface Doc { page: number; section: number; tf: Map<string, number>; len: number; title: Set<string>; about: Set<string> }
interface LangIndex { pages: HelpPage[]; docs: Doc[]; df: Map<string, number>; avg: number }

const indexes = new WeakMap<HelpIndex, Map<HelpLang, LangIndex>>()

function count(tf: Map<string, number>, ws: string[], weight: number) {
  for (const w of ws) tf.set(w, (tf.get(w) ?? 0) + weight)
}

/** One language's index, built on its first search (and kept with the docs). */
function langIndex(index: HelpIndex, lang: HelpLang): LangIndex {
  let byLang = indexes.get(index)
  if (!byLang) { byLang = new Map(); indexes.set(index, byLang) }
  const have = byLang.get(lang)
  if (have) return have
  const pages = index.langs[lang]
  const docs: Doc[] = []
  const df = new Map<string, number>()
  pages.forEach((p, pi) => {
    const title = words(p.title), place = words(p.place), description = words(p.description)
    // an untranslated page: one entry of its names (the English page's sections are searched in English)
    const sections = p.sections.length ? p.sections : [{ heading: '', text: '' }]
    sections.forEach((s, si) => {
      const tf = new Map<string, number>()
      const own = words(s.text)
      const heading = words(s.heading)
      count(tf, title, TITLE_WEIGHT)
      count(tf, place, 1)
      count(tf, heading, HEADING_WEIGHT)
      count(tf, own, 1)
      if (si === 0) count(tf, description, 1)
      const len = title.length * TITLE_WEIGHT + place.length + heading.length * HEADING_WEIGHT + own.length + (si === 0 ? description.length : 0)
      docs.push({ page: pi, section: si, tf, len, title: new Set(title), about: new Set(description) })
      for (const w of tf.keys()) df.set(w, (df.get(w) ?? 0) + 1)
    })
  })
  const avg = docs.reduce((n, d) => n + d.len, 0) / Math.max(1, docs.length)
  const made = { pages, docs, df, avg }
  byLang.set(lang, made)
  return made
}

const idf = (li: LangIndex, w: string) => {
  const n = li.df.get(w) ?? 0
  return Math.log(1 + (li.docs.length - n + 0.5) / (n + 0.5))
}

/** The pages of one language by score, best first, each with its best section (`only`: of that page alone). */
function rank(li: LangIndex, query: string[], only?: number): { page: number; section: number; score: number }[] {
  const q = [...new Set(query)].filter((w) => li.df.has(w))
  if (!q.length) return []
  const weights = new Map(q.map((w) => [w, idf(li, w)]))
  const best = new Map<number, { section: number; score: number }>()
  for (const d of li.docs) {
    if (only !== undefined && d.page !== only) continue
    let score = 0
    for (const w of q) {
      const f = d.tf.get(w)
      if (!f) continue
      score += weights.get(w)! * (f * (K1 + 1)) / (f + K1 * (1 - B + B * d.len / li.avg))
    }
    for (const w of q) if (d.title.has(w)) score += TITLE_BONUS * weights.get(w)!
    for (const w of q) if (d.about.has(w)) score += ABOUT_BONUS * weights.get(w)!
    if (score <= 0) continue
    const was = best.get(d.page)
    if (!was || score > was.score) best.set(d.page, { section: d.section, score })
  }
  return [...best].map(([page, b]) => ({ page, ...b })).sort((x, y) => y.score - x.score || x.page - y.page)
}

const SENTENCE_END = /(?<=[.!?])\s+|(?<=[。！？])/u

/** The passage of a section for these query words (PASSAGE_MAX characters at most). */
function passageOf(li: LangIndex | null, text: string, query: string[]): string {
  const parts = text.split(SENTENCE_END).map((s) => s.trim()).filter(Boolean)
  if (!parts.length) return ''
  const q = new Set(query)
  let at = 0, top = 0
  if (li) parts.forEach((s, i) => {
    const score = [...new Set(words(s))].filter((w) => q.has(w)).reduce((n, w) => n + idf(li, w), 0)
    if (score > top) { top = score; at = i }
  })
  let out = parts[at]!
  for (let i = at + 1; i < parts.length && out.length + 1 + parts[i]!.length <= PASSAGE_MAX; i++) out += ` ${parts[i]}`
  if (out.length <= PASSAGE_MAX) return out
  const cut = out.slice(0, PASSAGE_MAX - 1)
  const space = cut.lastIndexOf(' ')
  return `${space > PASSAGE_MAX / 2 ? cut.slice(0, space) : cut}…`
}

/** The page of `slug` in `lang`, translated (not a stand-in for the English page), or null. */
const ownPage = (index: HelpIndex, lang: HelpLang, slug: string) => index.langs[lang].find((p) => p.slug === slug && !p.english) ?? null

/** The languages a search goes through, in order: the query's own script, the person's language, English. */
export function searchLangs(query: string, locale: HelpLang): HelpLang[] {
  return [...new Set([queryLang(query) ?? locale, locale, 'en' as const])]
}

/** Up to DOCS_HITS_MAX pages for a query, for a person whose language is `locale`. */
export function searchDocs(index: HelpIndex, query: string, locale: HelpLang): DocsHit[] {
  const q = words(query)
  const hits: DocsHit[] = []
  const seen = new Set<string>()
  for (const lang of searchLangs(query, locale)) {
    const li = langIndex(index, lang)
    const ranked = rank(li, q)
    const top = ranked[0]?.score ?? 0
    for (const r of ranked) {
      if (hits.length >= DOCS_HITS_MAX || r.score < top / 3) break
      const page = li.pages[r.page]!
      if (seen.has(page.slug)) continue
      seen.add(page.slug)
      // the passage: from the section found; an untranslated page's from its English sections
      const en = page.english ? langIndex(index, 'en') : null
      const from = en ? en.pages.find((p) => p.slug === page.slug) ?? null : page
      const section = en && from ? bestSection(en, from, q) : (from?.sections[r.section] ?? null)
      const passage = section ? passageOf(en ?? li, section.text, q) : ''
      const shown = ownPage(index, locale, page.slug) ?? (page.english ? null : page) ?? ownPage(index, 'en', page.slug)
      const url = shown?.url ?? page.url
      hits.push({
        slug: page.slug,
        title: shown?.title ?? page.title,
        url,
        english: locale !== 'en' && !ownPage(index, locale, page.slug),
        heading: section?.heading ?? page.title,
        passage: passage || page.description,
        lang: en ? 'en' : lang,
      })
    }
    if (hits.length >= DOCS_HITS_MAX) break
  }
  return hits
}

/** The best section of a page for these words (its first when none holds them). */
function bestSection(li: LangIndex, page: HelpPage, q: string[]) {
  const ranked = rank(li, q, li.pages.indexOf(page))
  return page.sections[ranked[0]?.section ?? 0] ?? null
}

/** The docs home of a language (its "index" page), for an answer that found nothing. */
export const docsHome = (index: HelpIndex, locale: HelpLang): string =>
  (ownPage(index, locale, 'index') ?? ownPage(index, 'en', 'index'))?.url ?? ''

// Downloads the distractors of the search quality test (README.md): about 3,000 Korean and English Wikipedia articles
// as plain text (MediaWiki API, TextExtracts with explaintext), into scripts/bench/quality/.cache/wiki/, which git
// ignores. Never commit the articles. Downloads once; a second run only fetches what is missing.
//
// - Which articles: distractors.json (committed) lists them by page id, so every machine gets the same ones. Without it
//   (or with --discover) they are chosen once: the full-text search of each wiki for fixed seed words, half about office
//   topics close to the made-up documents (leases, leave, invoices, security, sensors, ...; the hard distractors) and
//   half general (history, rivers, films, ...), the results of the seeds taken in turn, an article kept when its text
//   has at least --min-chars characters and is not a disambiguation page.
// - Text: the article's plain text without its reference sections (References, See also, 각주, ...), cut at a
//   paragraph after --max-chars characters, the title on the first line.
// - Polite: one request at a time per wiki (two wikis side by side), --delay-ms between requests, maxlag=5, a backoff on
//   429, 5xx and lag, and a generic User-Agent that names the project.
//
//   bun scripts/bench/quality/fetch.ts [--per-lang 1500] [--discover] [--delay-ms 100]
import fs from 'node:fs'
import path from 'node:path'
import { DISTRACTOR_LIST, WIKI_DIR, WIKI_INDEX, type WikiArticle } from './lib'

const USER_AGENT = 'trina-ax-search-quality-test/1.0 (https://github.com/trina-app/trina-ax; public test corpus)'
const args = process.argv.slice(2)
const opt = (name: string, d: string) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] ? args[i + 1]! : d }
const PER_LANG = Number(opt('per-lang', '1500'))
const MIN_CHARS = Number(opt('min-chars', '1200'))
const MAX_CHARS = Number(opt('max-chars', '20000'))
const DELAY_MS = Number(opt('delay-ms', '100'))
const SEARCH_LIMIT = 100
const DISCOVER = args.includes('--discover') || !fs.existsSync(DISTRACTOR_LIST)

type Lang = 'ko' | 'en'
type Group = 'topic' | 'general'
const SEEDS: Record<Lang, Record<Group, string[]>> = {
  en: {
    topic: ['lease', 'non-disclosure agreement', 'service-level agreement', 'employment contract', 'annual leave', 'sick leave',
      'telecommuting', 'business travel', 'per diem', 'expense management', 'invoice', 'accounts payable', 'revenue',
      'customer satisfaction', 'net promoter score', 'customer attrition', 'information security policy', 'password policy',
      'incident management', 'code review', 'warehouse', 'inventory', 'public holidays in South Korea', 'employee stock option',
      'board of directors', 'dividend', 'recruitment', 'employee benefits', 'fire drill', 'Wi-Fi', 'printer', 'product roadmap',
      'OKR', 'referral marketing', 'vendor management', 'privacy policy', 'data retention', 'release notes', 'occupancy sensor',
      'hot desking'],
    general: ['history', 'city', 'river', 'football club', 'album', 'novel', 'film', 'mountain', 'university', 'battle', 'species',
      'railway station', 'painter', 'physics', 'chemistry', 'election', 'television series', 'video game', 'island', 'castle'],
  },
  ko: {
    topic: ['임대차', '비밀유지계약', '서비스 수준 협약', '근로계약', '연차 유급휴가', '병가', '재택근무', '출장', '일비', '경비', '세금계산서',
      '매출', '고객 만족', '순추천지수', '고객 이탈', '정보 보안', '비밀번호', '장애 관리', '코드 리뷰', '물류센터', '재고', '대한민국의 공휴일',
      '스톡옵션', '이사회', '배당', '채용', '복리후생', '소방 훈련', '와이파이', '프린터', '로드맵', '핵심성과지표', '추천 마케팅', '공급망',
      '개인정보 보호', '데이터 보존', '소프트웨어 버전', '센서', '주차장', '사무실'],
    general: ['역사', '도시', '강', '축구단', '음반', '소설', '영화', '산', '대학교', '전투', '생물', '철도역', '화가', '물리학', '화학', '선거',
      '텔레비전 드라마', '비디오 게임', '섬', '성'],
  },
}
/** sections cut from the end of an article (their heading line and everything after it) */
const TAIL = new Set(['references', 'external links', 'see also', 'notes', 'further reading', 'bibliography', 'sources', 'citations',
  'footnotes', '각주', '외부 링크', '같이 보기', '참고 문헌', '참고 자료', '주석', '출처', '읽을거리'])

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function api(lang: Lang, params: Record<string, string>): Promise<any> {
  const url = new URL(`https://${lang}.wikipedia.org/w/api.php`)
  for (const [k, v] of Object.entries({ format: 'json', formatversion: '2', maxlag: '5', ...params })) url.searchParams.set(k, v)
  for (let attempt = 1; ; attempt++) {
    await sleep(DELAY_MS)
    let wait = 0
    try {
      const r = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT } })
      if (r.status === 429 || r.status >= 500) wait = Number(r.headers.get('retry-after') ?? 0) * 1000 || 5000 * attempt
      else if (!r.ok) throw new Error(`HTTP ${r.status}`)
      else {
        const j = await r.json() as any
        if (j?.error?.code === 'maxlag') wait = Number(r.headers.get('retry-after') ?? 5) * 1000
        else if (j?.error) throw new Error(`API ${j.error.code}: ${j.error.info}`)
        else return j
      }
    } catch (e) {
      if (attempt >= 5) throw e
      wait = 5000 * attempt
    }
    if (attempt >= 5) throw new Error(`gave up on ${url.searchParams.get('titles') ?? url.searchParams.get('pageids') ?? url.searchParams.get('srsearch')}`)
    await sleep(wait)
  }
}

/** the article's plain text: reference sections off, blank lines squeezed, cut at a paragraph after MAX_CHARS */
function clean(title: string, extract: string): string {
  const lines = extract.replace(/\r\n?/g, '\n').split('\n')
  const cut = lines.findIndex((l) => TAIL.has(l.trim().toLowerCase()))
  let text = (cut >= 0 ? lines.slice(0, cut) : lines).join('\n').replace(/\n{3,}/g, '\n\n').trim()
  if (text.length > MAX_CHARS) {
    const at = text.lastIndexOf('\n', MAX_CHARS)
    text = text.slice(0, at > MAX_CHARS / 2 ? at : MAX_CHARS).trim()
  }
  return text ? `${title}\n\n${text}\n` : ''
}

/** a file name from a title (no path separators or characters some file systems refuse), unique in its folder */
function fileName(lang: Lang, title: string, pageid: number, taken: Set<string>): string {
  let base = title.replace(/[\u0000-\u001f/\\:*?"<>|]+/g, '_').replace(/^\.+/, '_').trim()
  if ([...base].length > 120) base = [...base].slice(0, 120).join('')
  let f = `${lang}/${base}.txt`
  if (taken.has(f.toLowerCase())) f = `${lang}/${base}-${pageid}.txt`
  taken.add(f.toLowerCase())
  return f
}

interface Planned { lang: Lang; title: string; pageid?: number; group: Group; seed: string }

/** candidates in the order they are tried: each group's seeds in turn (first result of every seed, then the second ...) */
async function discover(lang: Lang): Promise<Record<Group, Planned[]>> {
  const out: Record<Group, Planned[]> = { topic: [], general: [] }
  const seen = new Set<string>()
  for (const group of ['topic', 'general'] as const) {
    const lists: { seed: string; titles: string[] }[] = []
    for (const seed of SEEDS[lang][group]) {
      const j = await api(lang, { action: 'query', list: 'search', srsearch: seed, srlimit: String(SEARCH_LIMIT), srnamespace: '0', srprop: '' })
      lists.push({ seed, titles: (j?.query?.search ?? []).map((s: { title: string }) => s.title) })
    }
    for (let i = 0; i < SEARCH_LIMIT; i++) {
      for (const l of lists) {
        const t = l.titles[i]
        if (!t || seen.has(t)) continue
        seen.add(t)
        out[group].push({ lang, title: t, group, seed: l.seed })
      }
    }
    console.error(`[${lang}] ${group}: ${out[group].length} candidates from ${lists.length} seeds`)
  }
  return out
}

interface Index { _note: string; fetchedAt: string; fetchMs: number; userAgent: string; articles: WikiArticle[] }
const loadIndex = (): Index => fs.existsSync(WIKI_INDEX) ? JSON.parse(fs.readFileSync(WIKI_INDEX, 'utf8')) as Index
  : { _note: 'Downloaded Wikipedia articles (CC BY-SA). Never commit this folder.', fetchedAt: '', fetchMs: 0, userAgent: USER_AGENT, articles: [] }

const t0 = Date.now()
fs.mkdirSync(path.join(WIKI_DIR, 'ko'), { recursive: true })
fs.mkdirSync(path.join(WIKI_DIR, 'en'), { recursive: true })
const index = loadIndex()
const have = new Map(index.articles.filter((a) => fs.existsSync(path.join(WIKI_DIR, a.file))).map((a) => [`${a.lang}:${a.pageid}`, a]))
const taken = new Set([...have.values()].map((a) => a.file.toLowerCase()))
const baseMs = index.fetchMs || 0
const save = () => {
  index.articles = [...have.values()].sort((a, b) => a.lang.localeCompare(b.lang) || a.title.localeCompare(b.title))
  index.fetchedAt = new Date().toISOString()
  index.fetchMs = baseMs + (Date.now() - t0)
  fs.writeFileSync(WIKI_INDEX, JSON.stringify(index, null, 1))
}

/** fetches one article; null when it is missing, a disambiguation page or too short */
async function fetchOne(p: Planned): Promise<WikiArticle | null> {
  const j = await api(p.lang, {
    action: 'query', prop: 'extracts|info|pageprops', explaintext: '1', exsectionformat: 'plain', ppprop: 'disambiguation', redirects: '1',
    ...(p.pageid ? { pageids: String(p.pageid) } : { titles: p.title }),
  })
  const page = j?.query?.pages?.[0]
  if (!page || page.missing || page.invalid || page.pageprops?.disambiguation !== undefined || typeof page.extract !== 'string') return null
  const text = clean(page.title, page.extract)
  if (text.length < MIN_CHARS) return null
  const key = `${p.lang}:${page.pageid}`
  if (have.has(key)) return have.get(key)!
  const file = fileName(p.lang, page.title, page.pageid, taken)
  fs.writeFileSync(path.join(WIKI_DIR, file), text)
  const a: WikiArticle = { lang: p.lang, title: page.title, pageid: page.pageid, revid: page.lastrevid, group: p.group, seed: p.seed, file, chars: text.length }
  have.set(key, a)
  return a
}

async function runLang(lang: Lang, listed: Planned[] | null): Promise<{ kept: WikiArticle[]; tried: number; changed: number }> {
  const kept: WikiArticle[] = []
  let tried = 0, changed = 0
  const progress = () => { if (tried % 100 === 0) { console.error(`[${lang}] tried ${tried}, kept ${kept.length}`); save() } }
  if (listed) {
    // the committed list: the same pages everywhere (their text is today's revision)
    for (const p of listed) {
      const old = have.get(`${lang}:${p.pageid}`)
      if (old) { kept.push(old); continue }
      tried++
      const a = await fetchOne(p)
      if (a) { kept.push(a); if ((p as Planned & { revid?: number }).revid !== a.revid) changed++ }
      progress()
    }
    return { kept, tried, changed }
  }
  const cands = await discover(lang)
  const quota = Math.ceil(PER_LANG / 2)
  const pos: Record<Group, number> = { topic: 0, general: 0 }
  const got: Record<Group, number> = { topic: 0, general: 0 }
  while ((got.topic < quota && pos.topic < cands.topic.length) || (got.general < quota && pos.general < cands.general.length)) {
    for (const g of ['topic', 'general'] as const) {
      if (got[g] >= quota || pos[g] >= cands[g].length) continue
      const p = cands[g][pos[g]++]!
      tried++
      const a = await fetchOne(p)
      if (a && !kept.includes(a)) { kept.push(a); got[g]++ }
      progress()
    }
  }
  console.error(`[${lang}] kept topic ${got.topic}, general ${got.general} (quota ${quota} each)`)
  return { kept, tried, changed }
}

let listed: Record<Lang, Planned[]> | null = null
if (!DISCOVER) {
  const l = JSON.parse(fs.readFileSync(DISTRACTOR_LIST, 'utf8')) as { articles: (Planned & { pageid: number; revid: number })[] }
  listed = { ko: l.articles.filter((a) => a.lang === 'ko'), en: l.articles.filter((a) => a.lang === 'en') }
}
console.error(DISCOVER ? `choosing ${PER_LANG} articles per language (no ${path.basename(DISTRACTOR_LIST)} yet, or --discover)` : `fetching the ${listed!.ko.length + listed!.en.length} articles of ${path.basename(DISTRACTOR_LIST)}`)
const [ko, en] = await Promise.all([runLang('ko', listed?.ko ?? null), runLang('en', listed?.en ?? null)])
save()

if (DISCOVER) {
  const articles = [...ko.kept, ...en.kept].sort((a, b) => a.lang.localeCompare(b.lang) || a.title.localeCompare(b.title))
  const lines = articles.map((a) => '  ' + JSON.stringify({ lang: a.lang, title: a.title, pageid: a.pageid, revid: a.revid, group: a.group, seed: a.seed }))
  fs.writeFileSync(DISTRACTOR_LIST, `{\n "_note": "The distractor articles of the search quality test, chosen by fetch.ts on ${new Date().toISOString().slice(0, 10)}: titles and page ids only, never their text. fetch.ts downloads these pages again on another machine (today's revision; revid is the one first downloaded).",\n "minChars": ${MIN_CHARS}, "maxChars": ${MAX_CHARS}, "perLang": ${PER_LANG},\n "articles": [\n${lines.join(',\n')}\n ]\n}\n`)
}
const mins = ((Date.now() - t0) / 60_000).toFixed(1)
console.error(`done in ${mins} min: ko ${ko.kept.length} (tried ${ko.tried}), en ${en.kept.length} (tried ${en.tried})` +
  (listed ? `, ${ko.changed + en.changed} pages changed since the list was made` : '') + ` -> ${path.relative(process.cwd(), WIKI_DIR)}`)

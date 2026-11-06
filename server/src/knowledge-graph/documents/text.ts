// Text helpers of the document index (index.ts): which files it takes, HTML to text, the links a document makes, the
// words that stand for it (TF-IDF terms) and the names another document can mention it by. Pure functions: no file or
// network access.
import path from 'node:path'

/** Office, PDF and Hangul files (read by files/extract.ts converters) and plain-text documents. Code is CodeGraph's. */
export const OFFICE_DOC_EXT = new Set(['docx', 'pptx', 'odt', 'xlsx', 'xls', 'ods', 'pdf', 'hwp', 'hwpx'])
export const TEXT_DOC_EXT = new Set(['md', 'markdown', 'txt', 'text', 'csv', 'tsv', 'html', 'htm'])

export const extOf = (name: string) => (/\.([^./]+)$/.exec(name)?.[1] ?? '').toLowerCase()

/** The document index takes this file (by name). Office lock and temp files are left out. */
export function acceptsName(name: string): boolean {
  const base = path.posix.basename(name)
  if (base.startsWith('~$') || base.startsWith('.~lock')) return false
  const e = extOf(base)
  return OFFICE_DOC_EXT.has(e) || TEXT_DOC_EXT.has(e)
}

/** lowercase, compatibility-normalized (full-width letters, ligatures), for matching only */
export const norm = (s: string) => s.normalize('NFKC').toLowerCase()

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ' '
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/** The readable text of an HTML page: no scripts, styles or tags; headings as Markdown headings, blocks on their own
 * lines. A regular-expression pass, enough for search (never shown as HTML). */
export function htmlText(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, ' ')
  s = s.replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ')
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_m, n: string, inner: string) => `\n${'#'.repeat(Number(n))} ${inner.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()}\n`)
  s = s.replace(/<(br|hr)\b[^>]*>/gi, '\n')
  s = s.replace(/<\/(p|div|li|tr|section|article|header|footer|blockquote|pre|table|ul|ol|dl|dt|dd|h[1-6])\s*>/gi, '\n')
  s = s.replace(/<\/(td|th)\s*>/gi, '\t')
  s = s.replace(/<[^>]*>/g, ' ')
  s = decodeEntities(s)
  return s.split('\n').map((l) => l.replace(/[ \t\f\v ]+/g, ' ').trim()).filter(Boolean).join('\n')
}

export interface DocLink { /** the target as written (shown as the reason) */ raw: string; /** the file's path in the same folder root, or '' */ target: string; /** its file name, lowercase */ base: string }
const LINKS_MAX = 200
const SCHEME = /^[a-z][a-z0-9+.-]*:/i

/** Links to other files that a Markdown or HTML document makes ([text](a/b.md), href="b.pdf"). Web addresses,
 * anchors and mail links are not files. `target` is resolved against the document's own folder and stays '' when it
 * would leave the folder root or starts at '/' (then only the file name can match). */
export function docLinks(relPath: string, raw: string): DocLink[] {
  const found: string[] = []
  const md = /\[[^\]\n]{0,300}\]\(\s*<?([^)\s>]{1,500})>?(?:\s+"[^"\n]*")?\s*\)/g
  const href = /\b(?:href|src)\s*=\s*["']([^"'\s>]{1,500})["']/gi
  for (const re of [md, href]) for (const m of raw.matchAll(re)) { found.push(m[1]!); if (found.length >= LINKS_MAX * 2) break }
  const out = new Map<string, DocLink>()
  const dir = path.posix.dirname(relPath)
  for (const f of found) {
    if (SCHEME.test(f) || f.startsWith('#') || f.startsWith('//')) continue
    let t = f.replace(/[?#].*$/, '')
    try { t = decodeURIComponent(t) } catch {}
    if (!t || t.endsWith('/')) continue
    const base = norm(path.posix.basename(t))
    if (!base || base === '.' || base === '..') continue
    let target = ''
    if (!t.startsWith('/')) {
      const r = path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, t))
      if (r && r !== '.' && !r.startsWith('../') && r !== '..' && !path.posix.isAbsolute(r)) target = r
    }
    if (target === relPath) continue
    const key = target || '*' + base
    if (!out.has(key)) out.set(key, { raw: f.slice(0, 200), target, base })
    if (out.size >= LINKS_MAX) break
  }
  return [...out.values()]
}

// ---- terms -----------------------------------------------------------------------------------------------------

const HANGUL = /[가-힣]/
const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/
const LETTER = /\p{L}/u
/** Korean particles and common verb endings, longest first: "회의록을" → "회의록", "공유합니다" → "공유" */
const KO_SUFFIX = ['에서부터', '으로부터', '했습니다', '하였습니다', '되었습니다', '입니다', '합니다', '됩니다', '로부터', '에게서', '한테서', '이라고', '이라는',
  '에서는', '에서도', '으로는', '으로도', '에서', '에게', '한테', '께서', '으로', '까지', '부터', '처럼', '보다', '이나', '이랑', '하고', '하는', '하기', '하여',
  '해서', '했다', '된다', '되는', '되어', '이다', '이며', '이고', '라고', '라는', '은', '는', '이', '가', '을', '를', '의', '에', '로', '와', '과', '도', '만', '나', '랑']
const STOP = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'had', 'her', 'was', 'one', 'our', 'out', 'has', 'have', 'his', 'how',
  'its', 'may', 'new', 'now', 'old', 'see', 'two', 'way', 'who', 'did', 'get', 'let', 'say', 'she', 'too', 'use', 'that', 'with', 'this',
  'from', 'they', 'will', 'would', 'there', 'their', 'what', 'about', 'which', 'when', 'were', 'been', 'into', 'than', 'then', 'them',
  'these', 'those', 'some', 'such', 'only', 'also', 'more', 'most', 'other', 'over', 'very', 'just', 'each', 'both', 'after', 'before',
  'should', 'could', 'does', 'doing', 'being', 'here', 'where', 'while', 'your', 'yours', 'ours', 'because', 'between', 'through',
  'under', 'again', 'further', 'once', 'same', 'so', 'own', 'off', 'per', 'via', 'yes', 'please', 'thanks', 'page', 'sheet', 'slide',
  '것', '수', '등', '및', '위해', '대한', '통해', '관련', '경우', '때문', '이번', '현재', '오늘', '내용', '이후', '이전', '그리고', '하지만', '또한', '그러나',
  '있습니다', '없습니다', '있는', '없는', '같은', '이런', '그런', '저희', '우리', '여러분', '안녕하세요', '감사합니다', '있다', '없다', '한다', '하다', '되다',
])

/** "회의록을" → "회의록": one particle or ending off a Hangul word, when two syllables or more stay */
export function stripKo(w: string): string {
  if (!HANGUL.test(w)) return w
  for (const s of KO_SUFFIX) if (w.length - s.length >= 2 && w.endsWith(s)) return w.slice(0, -s.length)
  return w
}

let segmenter: Intl.Segmenter | null = null
const words = (text: string) => (segmenter ??= new Intl.Segmenter('und', { granularity: 'word' })).segment(text)

/** The word a token counts as, or null (numbers, stop words, too short) */
export function termOf(token: string): string | null {
  let w = norm(token)
  if (!LETTER.test(w)) return null
  if (w.length > 64) return null
  if (HANGUL.test(w)) { w = stripKo(w); return w.length >= 2 && !STOP.has(w) ? w : null }
  if (CJK.test(w)) return w.length >= 2 ? w : null
  return w.length >= 3 && !STOP.has(w) ? w : null
}

const TERMS_TEXT_MAX = 1024 * 1024
export const TERMS_PER_DOC = 64

/** The document's most frequent words (after stop words), with their share of all its words: the "tf" of TF-IDF. The
 * IDF part is counted at question time over the folders asked (index.ts related). */
export function topTerms(text: string, max = TERMS_PER_DOC): { term: string; tf: number }[] {
  const counts = new Map<string, number>()
  let total = 0
  for (const s of words(text.length > TERMS_TEXT_MAX ? text.slice(0, TERMS_TEXT_MAX) : text)) {
    if (!s.isWordLike) continue
    const t = termOf(s.segment)
    if (!t) continue
    total++
    counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  if (!total) return []
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([term, n]) => ({ term, tf: n / total }))
}

/** Search words of a question: split on spaces and punctuation (dots, dashes and underscores stay inside a word, as in
 * file names), Korean particles off, at most 10. */
export function queryTerms(q: string): string[] {
  const out: string[] = []
  for (const raw of norm(q).split(/[\s,;:!?()[\]{}"'“”‘’«»<>|/\\`*+=~^]+/)) {
    const w = stripKo(raw.replace(/^[.\-_#@]+|[.\-_#@]+$/g, ''))
    if (!w || !/[\p{L}\p{N}]/u.test(w) || w.length > 64 || out.includes(w)) continue
    out.push(w)
    if (out.length >= 10) break
  }
  return out
}

// ---- names a document can be mentioned by ---------------------------------------------------------------------------

const GENERIC = new Set(['readme', 'index', 'untitled', 'document', 'documents', 'notes', 'note', 'draft', 'final', 'copy', 'image', 'file',
  'new', 'test', 'main', 'report', 'data', 'temp', 'sheet1', 'book1', 'memo', 'todo', 'changelog', 'license', 'summary', 'agenda',
  '문서', '제목 없음', '새 문서', '메모', '보고서', '회의록', '자료', '초안', '최종', '요약', '안건'])

const distinctive = (s: string) => !GENERIC.has(s) && (s.length >= 6 || ((/[\s_\-.\d]/.test(s) || HANGUL.test(s) || CJK.test(s)) && s.length >= 4))

/** The names another document can mention this one by, lowercase: its file name with the extension, its name without
 * it when that is distinctive (not "readme", not a short common word), and its title (first heading) when long enough.
 * Each with the form shown in a reason. */
export function mentionNames(relPath: string, title: string | null): { key: string; shown: string }[] {
  const base = path.posix.basename(relPath)
  const out = new Map<string, string>()
  const b = norm(base)
  const e = extOf(base)
  const stem = e ? b.slice(0, -(e.length + 1)) : b
  if (b.length >= 5 && distinctive(stem.trim() || b)) out.set(b, base)
  if (stem && distinctive(stem.trim())) out.set(stem.trim(), e ? base.slice(0, -(e.length + 1)) : base)
  if (title) { const t = norm(title).trim(); if (t.length >= 8 && !GENERIC.has(t)) out.set(t, title.trim()) }
  return [...out.entries()].map(([key, shown]) => ({ key, shown: shown.slice(0, 120) }))
}

/** The title of a document: its first Markdown heading (Word/Hangul headings come out of the converters as Markdown
 * headings), 4 to 120 characters. */
export function titleOf(text: string): string | null {
  const m = /^#{1,3} (.{4,120}?)\s*$/m.exec(text.slice(0, 20_000))
  return m ? m[1]!.trim() : null
}

/** A person's name as written in a text: Latin names as whole words ("Bob" not in "Bobby"); Hangul, Kana and Han names
 * as they are (Korean adds 님, 씨 and particles right after a name). */
export function nameIn(textNorm: string, nameNorm: string): boolean {
  if (!nameNorm) return false
  if (HANGUL.test(nameNorm) || CJK.test(nameNorm)) return textNorm.includes(nameNorm)
  let i = textNorm.indexOf(nameNorm)
  while (i >= 0) {
    const before = i > 0 ? textNorm[i - 1]! : ' '
    const after = textNorm[i + nameNorm.length] ?? ' '
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true
    i = textNorm.indexOf(nameNorm, i + 1)
  }
  return false
}

/** A member name worth looking for: two characters or more in Hangul, Kana or Han, three or more otherwise */
export function usableName(n: string): boolean {
  const s = norm(n).trim()
  if (s.length > 80) return false
  return (HANGUL.test(s) || CJK.test(s)) ? s.length >= 2 : s.length >= 3 && LETTER.test(s)
}

/** A short piece of `text` around the first place one of `terms` appears (about 300 characters, on word breaks). */
export function snippetOf(text: string, terms: string[], width = 300): string {
  const low = text.toLowerCase()
  let at = -1, len = 0
  for (const t of [...terms].sort((a, b) => b.length - a.length)) {
    const i = low.indexOf(t)
    if (i >= 0 && (at < 0 || i < at)) { at = i; len = t.length }
  }
  const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
  if (text.length <= width) return flat(text)
  let from = at < 0 ? 0 : Math.max(0, at - Math.floor((width - len) / 3))
  let to = Math.min(text.length, from + width)
  if (to === text.length) from = Math.max(0, to - width)
  if (from > 0) { const sp = text.indexOf(' ', from); if (sp > 0 && sp - from < 20 && sp < (at < 0 ? to : at)) from = sp + 1 }
  if (to < text.length) { const sp = text.lastIndexOf(' ', to); if (sp > from + width / 2) to = sp }
  // never cut a surrogate pair
  if (from > 0 && /[\udc00-\udfff]/.test(text[from]!)) from--
  if (to < text.length && /[\ud800-\udbff]/.test(text[to - 1]!)) to--
  return (from > 0 ? '… ' : '') + flat(text.slice(from, to)) + (to < text.length ? ' …' : '')
}

// What a search box's text means, the same in the server and the app (docs/DECISIONS.md "⌘K에서 대화방 메시지 찾기"):
//   searchWords  the words of a query: every one must match, in any order (room messages, AI chat records, room files)
//   nameMatch    a name typed in ⌘K (a room, a person): every word inside the name, in any case and width (NFKC), and a
//                Korean initial consonant (초성) for the syllables that start with it: "ㄱㅈ" finds "견적", "ㅁㅎ" "민희"

/** At most this many words of a query count (as the AI's room search, rooms/reader.ts searchRooms) */
export const SEARCH_WORDS_MAX = 8

/** The words of a search: NFC, split on whitespace, no empty word, none repeated in another case (the first kept), at
 * most SEARCH_WORDS_MAX. */
export function searchWords(q: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const w of q.normalize('NFC').split(/\s+/)) {
    const k = w.toLowerCase()
    if (w && !seen.has(k)) { seen.add(k); out.push(w) }
  }
  return out.slice(0, SEARCH_WORDS_MAX)
}

/** Code points to compare: NFC on the whole (decomposed Hangul composed), then NFKC one character at a time (full-width
 * letters as ASCII, a compatibility jamo ㄱ…ㅎ as its leading consonant U+1100…U+1112, never joined with the next
 * character: NFKC of the whole would make "ㄱㅏ" one syllable "가"), in lower case */
const fold = (s: string): number[] => Array.from(s.normalize('NFC')).flatMap((c) => Array.from(c.normalize('NFKC').toLowerCase(), (x) => x.codePointAt(0)!))
/** a Hangul syllable's leading consonant (U+1100…U+1112); anything else as it is */
const leadOf = (c: number) => (c >= 0xac00 && c <= 0xd7a3 ? 0x1100 + Math.floor((c - 0xac00) / 588) : c)
/** a leading consonant typed alone (ㄱ…ㅎ after NFKC) */
const isLead = (c: number) => c >= 0x1100 && c <= 0x1112
/** Where `word` is in `name` (both folded), a typed initial consonant standing for any syllable that starts with it; -1 */
function indexIn(name: number[], word: number[]): number {
  if (!word.length) return 0
  outer: for (let i = 0; i + word.length <= name.length; i++) {
    for (let j = 0; j < word.length; j++) {
      const q = word[j]!, n = name[i + j]!
      if (q !== n && !(isLead(q) && leadOf(n) === q)) continue outer
    }
    return i
  }
  return -1
}

/** How well a name matches what was typed, or null when it does not: 0 the whole text at the start of the name, 1 the
 * whole text inside it, 2 every word somewhere in it (in any order). Case, width and initial consonants as above. */
export function nameMatch(name: string, query: string): 0 | 1 | 2 | null {
  const words = searchWords(query).map(fold)
  if (!words.length) return null
  const n = fold(name)
  const whole = fold(query.normalize('NFC').trim().replace(/\s+/g, ' '))
  const at = indexIn(n, whole)
  if (at === 0) return 0
  if (at > 0) return 1
  return words.every((w) => indexIn(n, w) >= 0) ? 2 : null
}

// ---------------- room message search: filters, phrases, word forms (QA TC-5365, "at least as good as Slack") ----------------

/** What a search of the room messages reads in its text, as Slack does: `from:` a person (`from:me`, `from:@name`,
 *  `from:"Full Name"`), `in:` a room or a 1:1 chat (`in:#room`, `in:@person`, `in:"Room name"`), a "quoted phrase"
 *  (matched as it is, its words together in that order) and the words (each in any order). */
export interface SearchParts {
  /** the words and the quoted phrases, as typed (NFC), at most SEARCH_WORDS_MAX, none repeated in another case */
  words: string[]
  /** what each of `words` is matched by, in the same order: a quoted phrase as typed; a word without its Korean particle
   *  or English ending (searchStem), so "회의를" finds "회의" and "deploys" finds "deployed" */
  terms: string[]
  /** which of `words` were quoted */
  phrases: boolean[]
  /** the people named by from: (as typed, without @), and the rooms named by in: (without # or @) */
  from: string[]
  in: string[]
}

const FILTER_RE = /(?:^|\s)(from|in):(?:"([^"]*)"?|(\S+))|"([^"]+)"|(\S+)/giu

/** A search's text read into its parts (see SearchParts). A quote with no closing one is a character to find, as a
 *  filter with nothing after it ("from:") is a plain word. */
export function parseSearch(q: string): SearchParts {
  const words: string[] = [], phrases: boolean[] = [], from: string[] = [], inn: string[] = []
  const seen = new Set<string>()
  const add = (w: string, phrase: boolean) => {
    const v = w.replace(/\s+/g, ' ').trim()
    const k = v.toLowerCase()
    if (!v || seen.has(k)) return
    seen.add(k); words.push(v); phrases.push(phrase)
  }
  const text = q.normalize('NFC').replace(/\u0000/g, '')
  for (const m of text.matchAll(FILTER_RE)) {
    const [, kind, quoted, bare, phrase, word] = m
    if (kind) {
      const v = (quoted ?? bare ?? '').trim().replace(/^[@#]+/, '').trim()
      if (!v) { add(`${kind}:`, false); continue }
      const list = kind.toLowerCase() === 'from' ? from : inn
      if (!list.some((x) => x.toLowerCase() === v.toLowerCase())) list.push(v)
    } else if (phrase !== undefined) add(phrase, true)
    else if (word) add(word, false)
  }
  const n = Math.min(words.length, SEARCH_WORDS_MAX)
  return { words: words.slice(0, n), phrases: phrases.slice(0, n), terms: words.slice(0, n).map((w, i) => (phrases[i] ? w : searchStem(w))), from: from.slice(0, 4), in: inn.slice(0, 4) }
}

/** Korean particles and endings that follow a noun, the longest first: "회의를" is searched as "회의" */
const PARTICLES = ['에서는', '으로는', '에게서', '한테서', '이라고', '에서', '에게', '한테', '으로', '까지', '부터', '처럼', '보다', '이랑', '하고', '이나', '라고', '은', '는', '이', '가', '을', '를', '에', '의', '와', '과', '로', '도', '만', '랑', '께']
const HANGUL_WORD = /^[가-힣]+$/u

/** Does `rest` (the text right after a word) start with a Korean particle that ends there ("를 옮겼어요", "에서")? */
export function particleNext(rest: string): boolean {
  return PARTICLES.some((p) => rest.startsWith(p) && !/^[\p{L}\p{N}]/u.test(rest.slice(p.length)))
}

/** The part of a word a search matches inside the text (every form that starts with it):
 *  - Hangul only: without a particle at its end when two syllables or more stay ("회의를" → "회의", "인화원에서" → "인화원";
 *    "사과" stays: one would be left);
 *  - English letters only, five or more: without -s, -es, -ies, -ed or -ing, a doubled last consonant made single, when
 *    four letters or more stay ("deploys", "deployed", "deploying" → "deploy"; "meetings" → "meeting"; "shipped" → "ship";
 *    "process", "during" stay), in lower case (the search takes A–Z in any case);
 *  - anything else as it is. */
export function searchStem(word: string): string {
  if (HANGUL_WORD.test(word)) {
    const n = [...word].length
    for (const p of PARTICLES) if (word.endsWith(p) && n - p.length >= 2) return word.slice(0, -p.length)
    return word
  }
  if (!/^[A-Za-z]{5,}$/.test(word)) return word
  let s = word.toLowerCase()
  if (s.endsWith('ies') && s.length - 3 >= 4) return s.slice(0, -3)
  if (s.endsWith('ing') && s.length - 3 >= 4) s = s.slice(0, -3)
  else if (s.endsWith('ed') && s.length - 2 >= 4) s = s.slice(0, -2)
  else if (/(?:ss|x|z|ch|sh)es$/.test(s)) s = s.slice(0, -2)
  else if (s.endsWith('s') && !s.endsWith('ss') && !s.endsWith('us') && s.length - 1 >= 4) s = s.slice(0, -1)
  else return word
  if (/([b-df-hj-np-tv-z])\1$/.test(s) && !/(?:ll|ss|zz|ff)$/.test(s)) s = s.slice(0, -1)
  return s.length >= 3 ? s : word
}

/** Lower case for A–Z only (SQLite LIKE's own rule) */
const foldAZ = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase())

/** Edit distance of a and b (insert, delete, change, swap two neighbours) when it is at most `max`, else max + 1 */
export function editDistance(a: string, b: string, max: number): number {
  const x = [...a], y = [...b]
  if (Math.abs(x.length - y.length) > max) return max + 1
  let prev2: number[] = [], prev = Array.from({ length: y.length + 1 }, (_, j) => j)
  for (let i = 1; i <= x.length; i++) {
    const cur = [i]
    let best = i
    for (let j = 1; j <= y.length; j++) {
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1))
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) v = Math.min(v, prev2[j - 2]! + 1)
      cur.push(v)
      best = Math.min(best, v)
    }
    if (best > max) return max + 1
    prev2 = prev; prev = cur
  }
  return Math.min(prev[y.length]!, max + 1)
}

/** How many typing mistakes a near match of `word` may have: none for a word with anything but letters and digits in
 *  it ("^abc", "q4-plan": those are matched as typed only) or under four letters (or Hangul syllables), one up to seven,
 *  two from eight */
export const nearBudget = (word: string): number => {
  if (!/^[\p{L}\p{N}]+$/u.test(word)) return 0
  const n = [...word].length
  return n < 4 ? 0 : n < 8 ? 1 : 2
}

/** Does `text` hold `word` with at most nearBudget(word) typing mistakes, as one of its words or the start of one
 *  ("recieve" → "receive", "stagign" → "staging", "deploymnet" → "deployment")? A–Z in any case. */
export function nearMatch(text: string, word: string): boolean {
  const max = nearBudget(word)
  if (!max) return false
  const w = foldAZ(word)
  const n = [...w].length
  for (const tok of foldAZ(text).split(/[^\p{L}\p{N}]+/u)) {
    if (!tok) continue
    const t = [...tok]
    if (Math.abs(t.length - n) <= max && editDistance(tok, w, max) <= max) return true
    // the start of a longer word ("deploymnet" in "deployments")
    if (t.length > n + max) for (let k = n - max; k <= n + max; k++) if (k > 0 && editDistance(t.slice(0, k).join(''), w, max) <= max) return true
  }
  return false
}

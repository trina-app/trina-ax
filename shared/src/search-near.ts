// Near matches of a search of several words (docs/decisions/20261121-search-near-every-word.md), the same in the server
// and the app: every word of the text on its own matches a word of the item as typed, or with a typing mistake or two,
// so one misspelled word no longer makes the whole search miss ("quarterly reprot budget" finds "Quarterly report
// budget", "견젹서 sincre" finds "견적서 Sincere"). Only the matching and the order: which words a text has (searchWords,
// parseSearch, searchStem) and the indexes stay as they are.
//   grade of a word   0 the whole word ("report"; a Korean word with a particle after it, "견적서를", counts as whole),
//                     1 the start of a word ("rep" in "report"), 2 inside a word ("port" in "report"), 3 one typing
//                     mistake (a letter more, less, changed, or two swapped; "reprot"), 4 two; a half more when the
//                     mistake is in the start of a longer word ("reprot" in "reports": 3.5)
//   a text's score    the sum of its words' grades: lower is better, so exact comes before prefix, prefix before near;
//                     null when one word matches nothing
//   how many mistakes nearWordBudget: none for a word with anything but letters and digits ("q4-plan": as typed only) or
//                     under four letters, 1 from four, 2 from eight; a Korean word by its letters (jamo: "셔" and "서"
//                     are one apart): none under three syllables, 1 from three, 2 from six
//   one letter        a word of one character matches only as a whole word or a word's start, never inside one (in a
//                     near pass "a" would otherwise match nearly everything)
import { nearBudget, particleNext } from './search-text'

/** One word of a search for nearMatcher: its forms (as typed, without its Korean particle or English ending; the best
 * one counts) and whether it is matched only as typed (a "quoted phrase") */
export interface NearTerm { forms: string[]; exact?: boolean }

const HANGUL_ONLY = /^[\uac00-\ud7a3]+$/u
const HANGUL_LAST = /[\uac00-\ud7a3]$/u
const ALNUM = /^[\p{L}\p{N}]/u
const SPLIT = /[^\p{L}\p{N}]+/u
/** what NFKC changes in a search's text: decomposed Hangul and combining marks, compatibility jamo, full-width forms,
 * ligatures and such (NFKC of a whole message is slow; most have none of these) */
const NEEDS_NFKC = /[\u0300-\u036f\u1100-\u11ff\u3131-\u318e\ufb00-\ufb4f\uff00-\uffef\u2000-\u2bff]/u
/** NFKC (full-width letters as ASCII; decomposed Hangul composed) and lower case, for every comparison here */
const fold = (s: string) => (NEEDS_NFKC.test(s) ? s.normalize('NFKC') : s).toLowerCase()
/** occurrences of a word looked at in one text, at most (a common short word in a long message) */
const OCCURRENCES_MAX = 64

/** How many typing mistakes a near match of `word` may have (see the top of this file) */
export function nearWordBudget(word: string): number {
  const w = word.normalize('NFC')
  if (HANGUL_ONLY.test(w)) {
    const n = [...w].length
    return n < 3 ? 0 : n < 6 ? 1 : 2
  }
  return nearBudget(w)
}

/** Hangul syllables as their letters (leading consonant, vowel, final consonant: U+1100…, U+1161…, U+11A8…); anything
 * else as it is */
export function hangulLetters(s: string): string {
  let out = ''
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    if (c < 0xac00 || c > 0xd7a3) { out += ch; continue }
    const i = c - 0xac00
    out += String.fromCodePoint(0x1100 + Math.floor(i / 588), 0x1161 + Math.floor((i % 588) / 28))
    if (i % 28) out += String.fromCodePoint(0x11a7 + (i % 28))
  }
  return out
}

/** The best grade of `w` (folded) found as typed in `text` (folded): 0 whole word, 1 a word's start, 2 inside; null */
function exactGrade(text: string, w: string): number | null {
  let best: number | null = null
  let seen = 0
  for (let at = text.indexOf(w); at >= 0 && best !== 0 && seen < OCCURRENCES_MAX; at = text.indexOf(w, at + 1), seen++) {
    const start = at === 0 || !ALNUM.test(text.slice(at - 1, at))
    const rest = text.slice(at + w.length)
    const end = !rest || !ALNUM.test(rest) || (HANGUL_LAST.test(w) && particleNext(rest))
    const g = start ? (end ? 0 : 1) : 2
    if (best === null || g < best) best = g
  }
  return best
}

interface Prepared {
  word: string; letters: number[]; max: number; hangul: boolean; one: boolean
  /** each word of a text looked at already: its distance (a text's words repeat across a team's messages and names) */
  seen: Map<string, number>
}
const prepare = (form: string, exact: boolean): Prepared => {
  const word = fold(form)
  const hangul = HANGUL_ONLY.test(word)
  return { word, letters: codes(hangul ? hangulLetters(word) : word), max: exact ? 0 : nearWordBudget(word), hangul, one: [...word].length === 1, seen: new Map() }
}
const codes = (s: string) => Array.from(s, (c) => c.codePointAt(0)!)
/** words remembered per word searched, at most (then forgotten at once) */
const SEEN_MAX = 50_000
const BIG = 1 << 20
let rows: Int32Array[] = []

/** The fewest typing mistakes (a letter more, less, changed, or two neighbours swapped) between `q` and `t`, or between
 * `q` and the start of `t` plus a half ("deploymnet" and "deployments": 1.5), when at most `max` (+ 0.5); else max + 1.
 * Only the band |i - j| <= max is worked out. */
export function prefixDistance(q: readonly number[], t: readonly number[], max: number): number {
  const n = q.length, m = t.length
  if (m + max < n) return max + 1
  if (!rows.length || rows[0]!.length < m + 1) rows = [0, 1, 2].map(() => new Int32Array(Math.max(m + 1, 64)))
  let [prev2, prev, cur] = rows as [Int32Array, Int32Array, Int32Array]
  prev.fill(BIG, 0, m + 1); prev2.fill(BIG, 0, m + 1)
  for (let j = 0; j <= Math.min(m, max); j++) prev[j] = j
  for (let i = 1; i <= n; i++) {
    cur.fill(BIG, 0, m + 1)
    if (i <= max) cur[0] = i
    let best = BIG
    for (let j = Math.max(1, i - max), hi = Math.min(m, i + max); j <= hi; j++) {
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (q[i - 1] === t[j - 1] ? 0 : 1))
      if (i > 1 && j > 1 && q[i - 1] === t[j - 2] && q[i - 2] === t[j - 1]) v = Math.min(v, prev2[j - 2]! + 1)
      cur[j] = v
      if (v < best) best = v
    }
    if (best > max) return max + 1
    const x = prev2; prev2 = prev; prev = cur; cur = x
  }
  // the whole of t first: its start alone counts half a mistake more ("reprot": "report" before "reports")
  let d = m <= n + max && prev[m]! <= max ? prev[m]! : max + 1
  for (let j = Math.max(1, n - max); j < Math.min(m, n + max + 1); j++) if (prev[j]! + 0.5 < d) d = prev[j]! + 0.5
  return d
}

/** The near grade (2 + mistakes, a half more in the start of a longer word) of a word in the text's words (each as a whole word or the start of a longer one), or
 * null */
function nearGrade(tokens: string[], p: Prepared): number | null {
  let best = BIG
  for (const tok of tokens) {
    let d = p.seen.get(tok)
    if (d === undefined) {
      d = prefixDistance(p.letters, codes(p.hangul ? hangulLetters(tok) : tok), p.max)
      if (p.seen.size >= SEEN_MAX) p.seen.clear()
      p.seen.set(tok, d)
    }
    if (d < best) { best = d; if (d <= 1) break }
  }
  return best < p.max + 1 ? 2 + best : null
}

/** A text's score for these words (see the top of this file): lower is better, null when a word matches nothing. The
 * words are read once; the matcher is called on each candidate. */
export function nearMatcher(terms: readonly NearTerm[]): (text: string) => number | null {
  const prepared = terms.map((t) => t.forms.filter(Boolean).map((f) => prepare(f, !!t.exact)))
  if (!prepared.length || prepared.some((p) => !p.length)) return () => null
  const anyNear = prepared.some((ps) => ps.some((p) => p.max > 0))
  return (raw: string) => {
    const text = fold(raw)
    let tokens: string[] | null = null
    let sum = 0
    for (const ps of prepared) {
      let best: number | null = null
      for (const p of ps) {
        let g = exactGrade(text, p.word)
        // one character: a whole word or a word's start only
        if (g === 2 && p.one) g = null
        if (g !== null && (best === null || g < best)) best = g
      }
      if (best === null && anyNear) {
        for (const p of ps) {
          if (!p.max) continue
          tokens ??= [...new Set(text.split(SPLIT).filter(Boolean))]
          const g = nearGrade(tokens, p)
          if (g !== null && (best === null || g < best)) best = g
        }
      }
      if (best === null) return null
      sum += best
    }
    return sum
  }
}

/** The words of a search read by parseSearch (shared/src/search-text.ts) as nearMatcher's terms: each word as typed and
 * by its part (searchStem), a quoted phrase only as typed */
export const nearTermsOf = (parts: { words: readonly string[]; terms: readonly string[]; phrases: readonly boolean[]; forms?: readonly (readonly string[])[] }): NearTerm[] =>
  parts.words.map((w, i) => ({ forms: [...new Set([w, parts.terms[i] ?? w, ...(parts.phrases[i] ? [] : parts.forms?.[i] ?? [])])], exact: !!parts.phrases[i] }))

/** May a near pass find more than the search as typed did (a word that may have a typing mistake)? */
export const nearPossible = (terms: readonly NearTerm[]): boolean => terms.some((t) => !t.exact && t.forms.some((f) => nearWordBudget(f) > 0))

/** ⌘K's name match with typing mistakes, for the names nameMatch did not find: every one of `words` in the name as typed
 * or near; the scorer of names (a score, or null), or null when no word may have a typing mistake. */
export function nearNames(words: readonly string[]): ((name: string) => number | null) | null {
  const terms = words.map((w) => ({ forms: [w] }))
  return nearPossible(terms) ? nearMatcher(terms) : null
}

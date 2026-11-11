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

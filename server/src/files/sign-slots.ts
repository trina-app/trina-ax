// Where a seal goes when the AI names more than the printed sign mark (QA TC-8357: in real runs it named the whole line
// "<label>: <name> (seal mark)", and a seal centred on all of it landed about 10 mm left of the mark). Word's insert_picture
// `over` and edit_hwp's image `at` both narrow the text they are given to its sign mark here, so the seal does not depend
// on how the AI worded the label. Decision: docs/decisions/20261123-signing-slots.md.
// The invariant of the whole path: a placement is accepted only if the document's target maps to exactly one drawn
// location, proved from the document's side; anything else is refused (hwp-changes.ts, "THE PAIRING INVARIANT").

/** The words of a printed sign mark (written as escapes: no Korean literals in server code): the seal, stamp, company
 * seal, signature and sign words of Korean forms, the hanja seal, and Seal, Stamp, Signature, Sign, L.S. */
const IN = '\\uC778', NAL_IN = `\\uB0A0\\s*${IN}`, JIK_IN = `\\uC9C1\\s*${IN}`, DOJANG = '\\uB3C4\\s*\\uC7A5', HANJA = '\\u5370'
const SEAL_WORDS = `${NAL_IN}|${JIK_IN}|${DOJANG}|${IN}|${HANJA}|seal|stamp`
const WORDS = `${SEAL_WORDS}|\\uC11C\\s*\\uBA85|\\uC0AC\\s*${IN}|signature|sign|l\\s*\\.\\s*s\\s*\\.?`
/** between two words of one mark: or, and, a slash, a middle dot, a comma, or only a space */
const JOIN = '(?:\\s*(?:\\uB610\\s*\\uB294|\\uD639\\s*\\uC740|\\uBC0F|or|and|[/\\u00B7\\u30FB,\\u3001])\\s*|\\s+)'
const OPEN = '[(\\uFF08\\[\\uFF3B\\u3014\\u3010]', CLOSE = '[)\\uFF09\\]\\uFF3D\\u3015\\u3011]'
/** the circled seal character stands on its own */
const CIRCLED = '\\u329E'
const MARK = new RegExp(`${OPEN}\\s*(?:${WORDS})(?:${JOIN}(?:${WORDS}))*\\s*${CLOSE}|${CIRCLED}`, 'giu')
const SEAL_WORD = new RegExp(SEAL_WORDS, 'giu')
const ANY_WORD = new RegExp(WORDS, 'giu')
/** bracketed text that speaks of signing but is no mark we know ("signature field", "sign here"): never passed over */
const MARK_LIKE = new RegExp(`${OPEN}[^()\\uFF08\\uFF09\\[\\]\\uFF3B\\uFF3D]{0,16}(?:\\uC11C\\s*\\uBA85|\\uB0A0\\s*${IN}|\\uC9C1\\s*${IN}|${DOJANG}|seal|stamp|signature)[^()\\uFF08\\uFF09\\[\\]\\uFF3B\\uFF3D]{0,16}${CLOSE}`, 'giu')

/** One mark in a text: `from`..`to` is the whole mark, `aimFrom`..`aimTo` what the seal is centred on (the mark, or only
 * the seal word of a "signature or seal" mark). Offsets are string indexes into the text. */
export interface SignMark { from: number; to: number; aimFrom: number; aimTo: number }

/** A signature line: three or more underscores. Used when the text holds no bracketed mark. */
const SIGN_LINE = /_{3,}/g

export function signMarks(text: string): SignMark[] {
  const lines = (): SignMark[] => [...text.matchAll(SIGN_LINE)].map((m) => ({ from: m.index, to: m.index + m[0].length, aimFrom: m.index, aimTo: m.index + m[0].length }))
  const marks = [...text.matchAll(MARK)]
  if (!marks.length) return lines()
  return marks.map((m) => {
    const from = m.index, to = from + m[0].length
    if ([...m[0].matchAll(ANY_WORD)].length < 2) return { from, to, aimFrom: from, aimTo: to }
    const w = [...m[0].matchAll(SEAL_WORD)].at(-1) ?? [...m[0].matchAll(ANY_WORD)].at(-1)!
    return { from, to, aimFrom: from + w.index, aimTo: from + w.index + w[0].length }
  })
}

/** bracketed sign-like tokens of a text that are not marks we recognise */
function markLike(text: string): string[] {
  const known = [...text.matchAll(MARK)].map((m) => [m.index, m.index + m[0].length])
  return [...text.matchAll(MARK_LIKE)].filter((m) => !known.some(([a, b]) => m.index >= a! && m.index + m[0].length <= b!)).map((m) => m[0])
}

/** Document text as the AI is shown it in a refusal or result: data, capped and quoted, with no control or
 * text-direction characters. */
const shown = (s: string, max = 40) => {
  const t = s.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ')
  return JSON.stringify(t.length > max ? `${t.slice(0, max)}…` : t)
}

/** What a label means for a seal: `mark` is the sign mark to land on (null: it holds none, the label is the target as
 * before) and `occurrence` the occurrence of the label left to apply. With several marks in the label nothing is
 * guessed: `occurrence` then says which mark, for a label found once; otherwise `ask` says what to give. */
export function pickSignMark(label: string, occurrence: number | undefined, found: number): { mark: SignMark | null; occurrence: number | undefined } | { ask: string } {
  const marks = signMarks(label)
  const odd = markLike(label)
  if (odd.length && !(marks.length === 0 && odd.length === 1 && odd[0] === label.trim())) return { ask: `${shown(label)} holds ${shown(odd[0]!)}, which looks like a place to sign but is not a mark this tool knows, so the seal's place is not clear; give only the text of the mark to sign on` }
  if (marks.length === 1) {
    // the mark must end what was named: text after it may be the signer the person meant
    if (/[\p{L}\p{N}]/u.test(label.slice(marks[0]!.to))) return { ask: `${shown(label)} has more text after its sign mark, so it is not clear whose mark is meant; give the signer's name and its mark, ending at the mark` }
    return { mark: marks[0]!, occurrence }
  }
  if (!marks.length) return { mark: null, occurrence }
  const list = marks.map((m, i) => `${i + 1}: ${shown(label.slice(Math.max(0, m.from - 12), m.to))}`).join('; ')
  const which = 'give only the part of the line for the person signing (their name and its mark)'
  if (found > 1) return { ask: `${shown(label)} is in ${found} places and holds ${marks.length} sign marks (${list}); ${which}` }
  if (occurrence === undefined) return { ask: `${shown(label)} holds ${marks.length} sign marks (${list}), so the seal's place is not clear; ${which}, or give occurrence (1 to ${marks.length}) for the mark` }
  const mark = marks[occurrence - 1]
  if (!mark) return { ask: `${shown(label)} holds ${marks.length} sign marks, so there is no mark ${occurrence}; ${which}, or give occurrence (1 to ${marks.length})` }
  return { mark, occurrence: undefined }
}

/** A label that is only the mark, on a paragraph with another signer's mark or a sign-like token: which one is meant is
 * not said by the label. An explicit `occurrence` says it. The question to ask, or null. */
export function bareMarkAsk(label: string, mark: SignMark | null, paragraph: string, occurrence: number | undefined): string | null {
  if (!mark || occurrence !== undefined || label.slice(mark.from, mark.to).trim() !== label.trim()) return null
  const all = signMarks(paragraph).length, odd = markLike(paragraph).length
  if (all + odd < 2) return null
  return `this line holds ${all + odd} places to sign (${shown(paragraph, 60)}); give the signer's name and its mark, ending at the mark`
}

/** The text a picture was placed on, for the result the AI reads: the label, or the mark and the label it came from. */
export function placedOn(label: string, mark: SignMark | null): string {
  if (!mark) return shown(label, 60)
  const whole = label.slice(mark.from, mark.to), aim = label.slice(mark.aimFrom, mark.aimTo)
  const on = aim === whole ? shown(whole) : `${shown(aim)} of the mark ${shown(whole)}`
  return whole === label ? on : `${on}, the sign mark in ${shown(label, 60)}`
}

/** How far a seal's centre may be from the centre of what it is aimed at, on each axis. */
export const SEAL_TOLERANCE_MM = 2

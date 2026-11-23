// Where a seal goes when the AI names more than the printed sign mark (QA TC-8357: in real runs it named the whole line
// "<label>: <name> (seal mark)", and a seal centred on all of it landed about 10 mm left of the mark). Word's insert_picture
// `over` and edit_hwp's image `at` both narrow the text they are given to its sign mark here, so the seal does not depend
// on how the AI worded the label. Decision: docs/decisions/20261123-signing-slots.md.

/** A printed sign mark in brackets, half or full width, with any spacing: the seal, signature, "signature or seal",
 * "signature or stamp" marks of Korean forms (written as escapes: no Korean literals in server code), the hanja seal,
 * and (Seal), (Signature), (L.S.). */
const IN = '\\uC778', NAL_IN = `\\uB0A0\\s*${IN}`, SEO_MYEONG = '\\uC11C\\s*\\uBA85', OR = '\\uB610\\s*\\uB294'
const MARK = new RegExp(`[(\\uFF08]\\s*(?:${IN}|\\u5370|${NAL_IN}|${SEO_MYEONG}(?:\\s*${OR}\\s*(?:${NAL_IN}|${IN}))?|seal|signature|l\\s*\\.\\s*s\\s*\\.?)\\s*[)\\uFF09]`, 'giu')
/** the seal word at the end of a "signature or seal" mark */
const OR_WORD = new RegExp(`${OR}\\s*(${NAL_IN}|${IN})\\s*[)\\uFF09]$`, 'u')

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
    const or = OR_WORD.exec(m[0])
    if (!or) return { from, to, aimFrom: from, aimTo: to }
    const aimFrom = from + or.index + or[0].indexOf(or[1]!)
    return { from, to, aimFrom, aimTo: aimFrom + or[1]!.length }
  })
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
  if (marks.length <= 1) return { mark: marks[0] ?? null, occurrence }
  const list = marks.map((m, i) => `${i + 1}: ${shown(label.slice(Math.max(0, m.from - 12), m.to))}`).join('; ')
  const which = 'give only the part of the line for the person signing (their name and its mark)'
  if (found > 1) return { ask: `${shown(label)} is in ${found} places and holds ${marks.length} sign marks (${list}); ${which}` }
  if (occurrence === undefined) return { ask: `${shown(label)} holds ${marks.length} sign marks (${list}), so the seal's place is not clear; ${which}, or give occurrence (1 to ${marks.length}) for the mark` }
  const mark = marks[occurrence - 1]
  if (!mark) return { ask: `${shown(label)} holds ${marks.length} sign marks, so there is no mark ${occurrence}; ${which}, or give occurrence (1 to ${marks.length})` }
  return { mark, occurrence: undefined }
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

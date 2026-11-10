// A person's status message (docs/DECISIONS.md "상태 메시지"): one emoji, a short text and when it clears, modelled on
// the common pattern of team chat apps. Pure rules shared by the server (the check of PUT /api/me/status) and the web app (its dialog), so the
// two never disagree on what may be saved.

/** characters of the text, at most (the input's maxLength counts the same UTF-16 units) */
export const STATUS_TEXT_MAX = 100
/** UTF-16 units of the emoji, at most (the longest emoji sequences take about 15) */
export const STATUS_EMOJI_MAX = 32
/** days ahead the last day of a status may be, at most (about a year) */
export const STATUS_DAYS_AHEAD = 366
/** the emoji a status with text but none of its own gets */
export const STATUS_DEFAULT_EMOJI = '💬'

// One emoji: a single pictograph (with its presentation selector or a skin tone), a ZWJ sequence of at most four of
// them (👩‍💻, 🏳️‍🌈, 👨‍👩‍👧‍👦), a flag (two regional indicators), a keycap (1️⃣) or a subdivision flag: 🏴 and its tag letters
// (🏴󠁧󠁢󠁳󠁣󠁴󠁿, only the three emoji fonts draw), nowhere else (tag letters are invisible text a reader, or an AI, could be handed unseen). Only the `u` flag
// and no lookbehind: an older browser still loads the page.
// a lone regional indicator is half a flag, and a lone skin tone or selector is no emoji
const PIC = '(?![\\p{Regional_Indicator}\\u{1F3FB}-\\u{1F3FF}])(?:\\p{Extended_Pictographic}|\\p{Emoji_Presentation})'
const ELEM = `${PIC}(?:\\u{FE0F}|[\\u{1F3FB}-\\u{1F3FF}])?`
const SEQ = `${ELEM}(?:\\u{200D}${ELEM}){0,3}`
const FLAG = '\\p{Regional_Indicator}{2}'
// the three subdivision flags emoji fonts draw (England, Scotland, Wales): no other tag letters at all
const SUBDIVISION = `\\u{1F3F4}\\u{E0067}\\u{E0062}(?:\\u{E0065}\\u{E006E}\\u{E0067}|\\u{E0073}\\u{E0063}\\u{E0074}|\\u{E0077}\\u{E006C}\\u{E0073})\\u{E007F}`
const KEYCAP = '[0-9#*]\\u{FE0F}?\\u{20E3}'
const ONE_EMOJI = new RegExp(`^(?:${FLAG}|${KEYCAP}|${SUBDIVISION}|${SEQ})$`, 'u')

/** Is this exactly one emoji (or one emoji sequence)? */
export function isStatusEmoji(s: string): boolean {
  return s.length > 0 && s.length <= STATUS_EMOJI_MAX && ONE_EMOJI.test(s)
}

// What the text may not hold: control characters (line breaks and tabs too: it is one line), line and paragraph
// separators, lone surrogates, format characters (direction marks and overrides, zero-width spaces, invisible tag
// letters), and the other characters that draw nothing yet carry something: variation selectors but the emoji's two
// (VS15, VS16), the combining grapheme joiner, Hangul and Braille blanks; a long run of combining marks (text that
// spills over the lines around it). The emoji joiner only between two pictographs (statusTextOk checks).
const BAD_TEXT = /[\p{Cc}\p{Zl}\p{Zp}\p{Cs}︀-︍\u{E0100}-\u{E01EF}͏ᅟᅠㅤﾠ⠀]|(?!‍)\p{Cf}|\p{M}{5,}/u
const PICTO = /[\p{Extended_Pictographic}\p{Emoji_Presentation}]/u
const JOINS_AFTER = /[\p{Extended_Pictographic}\p{Emoji_Presentation}️]/u

/** May this text be a status (already trimmed)? */
export function statusTextOk(s: string): boolean {
  if (s.length > STATUS_TEXT_MAX || BAD_TEXT.test(s)) return false
  // each joiner sits inside an emoji: after a pictograph (or its selector or skin tone), before a pictograph
  const cps = [...s]
  for (let i = 0; i < cps.length; i++) {
    if (cps[i] !== '‍') continue
    const before = cps[i - 1] ?? '', after = cps[i + 1] ?? ''
    if (!JOINS_AFTER.test(before) || !PICTO.test(after)) return false
  }
  return true
}

/** "YYYY-MM-DD" that is a real calendar day. */
export function isCalendarDay(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return false
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!))
  return d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!
}

/** The day `n` days after a "YYYY-MM-DD" day (calendar arithmetic, no time zone). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

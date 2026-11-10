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

// One emoji: a single pictograph (with its presentation selector or a skin tone), a ZWJ sequence of them (👩‍💻, 🏳️‍🌈), a
// flag (two regional indicators), a keycap (1️⃣) or a subdivision flag (🏴 with a few lower-case tag letters). Only the
// `u` flag: an older browser that has no `v` flag still loads the page.
// a lone regional indicator is half a flag, not an emoji
const PIC = '(?!\\p{Regional_Indicator})(?:\\p{Extended_Pictographic}|\\p{Emoji_Presentation})'
const ELEM = `${PIC}(?:\\u{FE0F}|[\\u{1F3FB}-\\u{1F3FF}])?`
const TAGS = '(?:[\\u{E0030}-\\u{E0039}\\u{E0061}-\\u{E007A}]{2,7}\\u{E007F})?'
const SEQ = `${ELEM}${TAGS}(?:\\u{200D}${ELEM}){0,4}`
const FLAG = '\\p{Regional_Indicator}{2}'
const KEYCAP = '[0-9#*]\\u{FE0F}?\\u{20E3}'
const ONE_EMOJI = new RegExp(`^(?:${FLAG}|${KEYCAP}|${SEQ})$`, 'u')

/** Is this exactly one emoji (or one emoji sequence)? */
export function isStatusEmoji(s: string): boolean {
  return s.length > 0 && s.length <= STATUS_EMOJI_MAX && ONE_EMOJI.test(s)
}

// What the text may not hold: control characters (line breaks and tabs too: it is one line), line and paragraph
// separators, format characters (direction marks and overrides, zero-width spaces, invisible tag letters a reader
// could not see) but the joiner inside an emoji, and lone surrogates.
const BAD_TEXT = /[\p{Cc}\p{Zl}\p{Zp}\p{Cs}]|(?!‍)\p{Cf}/u

/** May this text be a status (already trimmed)? */
export function statusTextOk(s: string): boolean {
  return s.length <= STATUS_TEXT_MAX && !BAD_TEXT.test(s)
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

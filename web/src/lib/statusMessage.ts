// Status messages (docs/DECISIONS.md "상태 메시지"): the dialog's suggestions and emoji, and the words of a status
// ("In a meeting · until 3:30 PM"). Days and times are the team's (Me.server.timeZone), as the server works them out.
import type { Locale, StatusClear, StatusMessage } from '@mycel/shared/api'
import type { MessageKey } from '../i18n'
import { intlTag } from './format'

export type ClearChoice = StatusClear
/** the "Clears" chips, in their order */
export const CLEAR_CHOICES: readonly ClearChoice[] = ['30m', '1h', '2h', 'today', 'week', 'dates', 'never']
export const CLEAR_LABEL: Record<ClearChoice, MessageKey> = {
  '30m': 'status.c.30m', '1h': 'status.c.1h', '2h': 'status.c.2h', today: 'status.c.today', week: 'status.c.week', dates: 'status.c.dates', never: 'status.c.never',
}

/** The suggestions of an empty dialog: an emoji, its words (in the person's language) and when it clears. */
export const SUGGESTIONS: readonly { emoji: string; text: MessageKey; clear: ClearChoice }[] = [
  { emoji: '📅', text: 'status.s.meeting', clear: '1h' },
  { emoji: '🎧', text: 'status.s.focus', clear: '2h' },
  { emoji: '🍽️', text: 'status.s.lunch', clear: '1h' },
  { emoji: '🤒', text: 'status.s.sick', clear: 'today' },
  { emoji: '🏖️', text: 'status.s.leave', clear: 'dates' },
]

/** The emoji button's grid: what people say about where they are and what they do (the reactions are another set). */
export const STATUS_EMOJI = [
  '📅', '🎧', '🍽️', '☕', '🤒', '🏖️', '🌴', '✈️',
  '🏡', '🏢', '🚌', '🚗', '🚶', '🏃', '💻', '📞',
  '🎤', '📝', '📚', '🧠', '🔕', '🤫', '⏳', '🌙',
  '👶', '🏥', '🎉', '🎂', '🙌', '💬', '✅', '🔥',
] as const

/** "YYYY-MM-DD" of now in a time zone (the browser's when none is known). */
export function dayIn(now: number, timeZone?: string): string {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now)).map((x) => [x.type, x.value]))
    return `${p.year}-${p.month}-${p.day}`
  } catch {
    return new Date(now).toISOString().slice(0, 10)
  }
}

/** A calendar day without its year: "Nov 14", "11월 14일". */
export function formatDay(day: string, locale: Locale): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  return new Intl.DateTimeFormat(intlTag(locale), { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)))
}

/** When a status ends, in words to go after "until": "end of today", "Nov 14", "3:30 PM", "Nov 14, 3:30 PM"; null when
 * it does not end by itself. */
export function untilWords(s: Pick<StatusMessage, 'until' | 'untilDay'>, locale: Locale, t: (k: MessageKey) => string, timeZone?: string, now = Date.now()): string | null {
  const today = dayIn(now, timeZone)
  if (s.untilDay) return s.untilDay === today ? t('status.endOfToday') : formatDay(s.untilDay, locale)
  if (!s.until) return null
  const at = Date.parse(s.until)
  let tz = timeZone
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }) } catch { tz = undefined }
  const sameDay = dayIn(at, tz) === today
  return new Intl.DateTimeFormat(intlTag(locale), sameDay ? { hour: 'numeric', minute: '2-digit', timeZone: tz } : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz }).format(new Date(at))
}

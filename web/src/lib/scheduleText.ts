// How a scheduled task reads on the Scheduled pages (pages/Scheduled.tsx): its name, its repeat in words, its state and
// how its last run went. Pure, so the list, the detail page and the tests read the same.
import type { Schedule } from '@mycel/shared/api'
import type { Locale } from '@mycel/shared/api'
import type { MessageKey, Params } from '../i18n'

type T = (key: MessageKey, params?: Params) => string
const TAG: Record<Locale, string> = { ko: 'ko-KR', en: 'en-US', id: 'id-ID', ja: 'ja-JP', es: 'es-ES' }

export type Tone = 'muted' | 'warn' | 'danger'
/** How a last-run result reads: a clean success stays quiet, problems and failures stand out. */
export function outcomeTone(o: Schedule['lastOutcome']): Tone {
  if (o === 'problems') return 'warn'
  if (o === 'error' || o === 'stopped' || o === 'interrupted' || o === 'budget_exceeded' || o === 'user_unavailable') return 'danger'
  return 'muted'
}

/** A template's own name in the person's language; a task's title. */
export const scheduleName = (s: Schedule, t: T) =>
  s.templateId === 'daily-file-index' || s.templateId === 'weekly-summary' ? t(`scheduleTemplates.${s.templateId}`) : s.title

const weekdayName = (n: number, locale: Locale) =>
  new Intl.DateTimeFormat(TAG[locale] ?? locale, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 0, 4 + n)))

/** "Weekdays (Mon–Fri) at 09:00", in the team's time zone (the times the server keeps). */
export const repeatText = (s: Schedule, t: T, locale: Locale) =>
  t(`schedules.repeat.${s.repeat}` as MessageKey, { time: s.time, date: s.date ?? '', day: String(s.day ?? ''), weekday: weekdayName(s.weekday ?? 0, locale) })

/** on · paused · waiting for its owner's check ("다시 확인") · a one-time task that ran or whose time passed */
export type ScheduleState = 'on' | 'paused' | 'review' | 'completed' | 'expired'
export function scheduleState(s: Schedule): ScheduleState {
  if (s.enabled) return 'on'
  if (s.resumeBlockedReason) return s.resumeBlockedReason
  return s.needsReview ? 'review' : 'paused'
}
const STATE_KEY: Record<Exclude<ScheduleState, 'on'>, MessageKey> = { paused: 'schedules.paused', review: 'schedules.reviewBadge', completed: 'schedules.completed', expired: 'schedules.expired' }
/** The short word for a state that is not "on" ("Paused"); empty for a task that is on. */
export const stateLabel = (s: Schedule, t: T) => {
  const state = scheduleState(s)
  return state === 'on' ? '' : t(STATE_KEY[state])
}

/** The last run's result in words ("Last run failed"); empty before the first run. A list card shows it beside its
 *  dot, because the dot's colour alone says nothing on a phone (no hover) and every failure is the same red. */
export const outcomeLabel = (s: Schedule, t: T) => (s.lastOutcome ? t(`scheduleTemplates.outcome.${s.lastOutcome}` as MessageKey) : '')

/** The card's dim line, like Claude's: "Paused · Weekdays (Mon–Fri) at 09:00". The last result has its own line under
 *  it (outcomeLabel), so a long repeat never cuts it off. */
export const cardLine = (s: Schedule, t: T, locale: Locale) => [stateLabel(s, t), repeatText(s, t, locale)].filter(Boolean).join(' · ')

/** What it does: a task's instruction, a template's folders (its prompt is the server's own, never shown). */
export const schedulePreview = (s: Schedule) => (s.templateId ? `${s.sourcePath ?? ''} → ${s.outputPath ?? ''}` : s.prompt)

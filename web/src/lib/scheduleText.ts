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
  if (o === 'error' || o === 'stopped' || o === 'interrupted' || o === 'budget_exceeded' || o === 'user_unavailable' || o === 'needs_key' || o === 'project_gone') return 'danger'
  return 'muted'
}

/** A template's own name in the person's language; a task's title. */
export const scheduleName = (s: Schedule, t: T) =>
  s.templateId === 'daily-file-index' || s.templateId === 'weekly-summary' ? t(`scheduleTemplates.${s.templateId}`) : s.title

const weekdayName = (n: number, locale: Locale) =>
  new Intl.DateTimeFormat(TAG[locale] ?? locale, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 0, 4 + n)))

/** A one-time task's day ("2026-10-29") in the person's words ("Oct 29, 2026", "2026. 10. 29."), as the weekday is
 * (QA TC-073: the card showed the stored form). The day is the team's own date: read and shown in UTC, never shifted. */
export const onceDate = (date: string | null | undefined, locale: Locale) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? '')
  if (!m) return date ?? ''
  return new Intl.DateTimeFormat(TAG[locale] ?? locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)))
}

/** "Weekdays (Mon–Fri) at 09:00", in the team's time zone (the times the server keeps). */
export const repeatText = (s: Schedule, t: T, locale: Locale) =>
  t(`schedules.repeat.${s.repeat}` as MessageKey, { time: s.time, date: onceDate(s.date, locale), day: String(s.day ?? ''), weekday: weekdayName(s.weekday ?? 0, locale) })

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

const RUN_STATE: Partial<Record<NonNullable<Schedule['lastOutcome']>, MessageKey>> = {
  done: 'scheduled.run.done', problems: 'scheduled.run.problems', error: 'scheduled.run.error', stopped: 'scheduled.run.stopped', interrupted: 'scheduled.run.interrupted',
}
/** The last run under the task page's "Last run" heading, without saying "last run" again: "Running" while a run is
 *  queued or running, "Succeeded", "Failed"…; an occurrence that did not run says why ("Usage limit prevented the
 *  run"); empty before the first run (or from an older server, which says neither). */
export const runStateLabel = (s: Schedule, t: T) => {
  if (s.running) return t('scheduled.run.running')
  if (!s.lastOutcome) return ''
  const key = RUN_STATE[s.lastOutcome]
  return key ? t(key) : outcomeLabel(s, t)
}

/** Why the last run did not succeed, in plain words, with the next step ("…then use Run now to try again"); empty for a
 *  success or before the first run. The API gives only the outcome code, not the error text, so this explains the code. */
export const outcomeReason = (s: Schedule, t: T) =>
  // a run that needed the owner's own key for an admin's template names it ("…your own key for Demo Wiki…")
  s.lastOutcome === 'needs_key' ? t('scheduled.reason.needs_keyNamed', { name: s.lastNeed?.name ?? '' })
    : s.lastOutcome && s.lastOutcome !== 'done' ? t(`scheduled.reason.${s.lastOutcome}` as MessageKey) : ''

/** The card's dim line, like Claude's: "Paused · Weekdays (Mon–Fri) at 09:00". The last result has its own line under
 *  it (outcomeLabel), so a long repeat never cuts it off. */
export const cardLine = (s: Schedule, t: T, locale: Locale) => [stateLabel(s, t), repeatText(s, t, locale)].filter(Boolean).join(' · ')

/** What it does: a task's instruction, a template's folders (its prompt is the server's own, never shown). */
export const schedulePreview = (s: Schedule) => (s.templateId ? `${s.sourcePath ?? ''} → ${s.outputPath ?? ''}` : s.prompt)

/** A place whose content may go into a task's save folder, in words ("내 폴더", "#영업 대화", "groups/marketing/"). */
export const sourceName = (x: NonNullable<Schedule['saveSources']>[number], t: T) =>
  x.kind === 'mine' ? t('scheduled.sourceMine') : x.kind === 'root' ? t('scheduled.sourceRoot') : x.kind === 'room' ? t('scheduled.sourceRoom', { name: x.name ?? '?' }) : `${x.name ?? '?'}/`

/** The list card's save line, the shape of a template's folders line: "저장: shared/주간보고", or "저장 폴더를 다시 확인해
 *  주세요" when its permission lapsed (server/src/chat/schedule-scope.ts); '' for a task without a save folder. */
export const saveLine = (s: Schedule, t: T) => (!s.saveFolder ? '' : s.saveLapsed ? t('scheduled.saveLapsed') : t('scheduled.saveLine', { folder: s.saveFolder }))

/** how long after a task's due time the page looks for its run (the server starts runs at a tick every 30 s), and how
 * long it keeps looking for a run that is due and not started (the server may be busy or catching up) */
export const RUN_AT_DUE = 10_000
const DUE_LOOK = 3 * 60_000
/** When to read the list again for a run at its time: the next time a task is due (or retried), plus RUN_AT_DUE; for a
 * task due a moment ago whose run has not started yet, RUN_AT_DUE from now. null: nothing is due. */
export function nextDueRead(items: readonly Schedule[] | null, now: number): number | null {
  let best: number | null = null
  for (const x of items ?? []) {
    if (x.running) continue
    for (const iso of [x.enabled ? x.nextRunAt : null, x.retryAt ?? null]) {
      const due = iso ? Date.parse(iso) : NaN
      if (!Number.isFinite(due) || due < now - DUE_LOOK) continue
      const wait = Math.max(due - now, 0) + RUN_AT_DUE
      if (best === null || wait < best) best = wait
    }
  }
  // setTimeout takes at most 2^31-1 ms (about 24 days)
  return best === null ? null : Math.min(best, 2 ** 31 - 1)
}

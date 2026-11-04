// Scheduled tasks (src/pages/Scheduled.tsx ScheduleView, src/lib/scheduleText.ts; QA B-W12-2, B-W26-3, CHAT-12, SCHED-03):
// a finished or expired one-time task keeps its switch, disabled and described by the reason (no silent no-op); the
// last run's result (succeeded / finished with problems / failed) is shown with the link to its chat; a task nobody
// confirmed has "Check again" instead of the switch and no run now; the card's line reads like Claude's.
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { Schedule } from '@mycel/shared/api'
import { translate, type MessageKey, type Params } from '../../src/i18n'
import { cardLine, outcomeTone, scheduleState } from '../../src/lib/scheduleText'
import { ScheduleView } from '../../src/pages/Scheduled'

const base: Schedule = { id: 'once-1', title: 'Team rule', prompt: 'Write today', repeat: 'once', time: '04:18', date: '2026-10-29', weekday: null, day: null,
  projectId: null, enabled: true, nextRunAt: '2026-10-28T19:18:00Z', lastRunAt: null, lastChatId: null, resumeBlockedReason: null }
const render = (s: Schedule) =>
  renderToStaticMarkup(<MemoryRouter><ScheduleView s={s} tz="Asia/Seoul" onToggle={() => {}} onRunNow={() => {}} onReview={() => {}} /></MemoryRouter>)
const toggle = (html: string) => /<button[^>]*data-testid="schedule-toggle"[^>]*>/.exec(html)?.[0] ?? ''
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
const t = (key: MessageKey, params?: Params) => translate('en', key, params)

describe('scheduled task page', () => {
  test('a completed one-time task: switch disabled and described by the reason, the result linked', () => {
    const html = decode(render({ ...base, enabled: false, nextRunAt: null, lastRunAt: '2026-10-28T19:18:15Z', lastChatId: 'chat-1', resumeBlockedReason: 'completed', lastOutcome: 'problems' }))
    const sw = toggle(html)
    expect(sw).toContain('role="switch"')
    expect(sw).toContain('aria-checked="false"')
    expect(sw).toContain('disabled=""')
    const described = /aria-describedby="([^"]+)"/.exec(sw)?.[1]
    expect(described).toBeTruthy()
    expect(html).toContain(`id="${described}"`)
    expect(html).toContain(t('schedules.completedHint'))
    expect(html).toContain(t('schedules.completed'))
    // the result: finished with problems, not "completed"
    expect(html).toContain(t('scheduleTemplates.outcome.problems'))
    expect(html).toContain('data-outcome="problems"')
    expect(html).toContain('href="/c/chat-1"')
  })

  test('a paused recurring or future task, or one that is on, keeps a working switch', () => {
    for (const s of [{ ...base, enabled: false, nextRunAt: null }, { ...base, repeat: 'daily' as const, date: null, enabled: false, nextRunAt: null }, base]) {
      const sw = toggle(render(s))
      expect(sw).not.toContain('disabled=""')
      expect(sw).not.toContain('aria-describedby')
      expect(sw).toContain(`aria-checked="${s.enabled}"`)
    }
  })

  test('a task nobody confirmed: "Check again" instead of the switch, and no run now', () => {
    const html = decode(render({ ...base, repeat: 'daily', date: null, enabled: false, nextRunAt: null, needsReview: true }))
    expect(toggle(html)).toBe('')
    expect(html).toContain('data-testid="schedule-review"')
    expect(html).not.toContain('data-testid="schedule-run-now"')
    expect(html).toContain(t('schedules.reviewHint'))
  })

  test('no runs yet says so; a template shows its folders, never its prompt', () => {
    expect(decode(render(base))).toContain(t('scheduled.noRuns'))
    const html = decode(render({ ...base, templateId: 'weekly-summary', prompt: 'internal template prompt', sourcePath: 'shared/notes', outputPath: 'users/olga/reports' }))
    expect(html).toContain('shared/notes')
    expect(html).toContain('users/olga/reports')
    expect(html).not.toContain('internal template prompt')
  })

  test('the card line: the state, then the repeat in words', () => {
    expect(cardLine({ ...base, repeat: 'weekdays', date: null, enabled: false, nextRunAt: null }, t, 'en')).toBe(`${t('schedules.paused')} · ${t('schedules.repeat.weekdays', { time: '04:18' })}`)
    expect(cardLine({ ...base, repeat: 'daily', date: null }, t, 'en')).toBe(t('schedules.repeat.daily', { time: '04:18' }))
    expect(scheduleState({ ...base, enabled: false, resumeBlockedReason: 'expired' })).toBe('expired')
  })

  test('the texts exist in every language', () => {
    for (const locale of ['en', 'ko', 'id', 'ja', 'es'] as const)
      for (const key of ['schedules.completedHint', 'schedules.expiredHint', 'scheduleTemplates.outcome.problems', 'notifications.event.schedule.problems', 'sidebar.scheduled', 'scheduled.history', 'scheduled.switch'] as const)
        expect(translate(locale, key)).not.toBe(key)
  })

  test('result tone: success quiet, problems a warning, failures an error', () => {
    expect(outcomeTone('done')).toBe('muted')
    expect(outcomeTone('problems')).toBe('warn')
    for (const o of ['error', 'stopped', 'interrupted', 'budget_exceeded', 'user_unavailable'] as const) expect(outcomeTone(o)).toBe('danger')
    expect(decode(render({ ...base, lastOutcome: 'done', lastChatId: 'c' }))).toContain(t('scheduleTemplates.outcome.done'))
  })
})

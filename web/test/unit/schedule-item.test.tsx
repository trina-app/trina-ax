// Settings › Scheduled tasks row (src/components/settings/ScheduleItem.tsx; QA B-W12-2, B-W26-3, CHAT-12, SCHED-03):
// a finished or expired one-time task shows its switch disabled with the reason linked to it (no silent no-op), and
// the last run's result (succeeded / finished with problems / failed) is shown next to the result link.
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { Schedule } from '@mycel/shared/api'
import { translate } from '../../src/i18n'
import { outcomeTone, ScheduleItem } from '../../src/components/settings/ScheduleItem'

const base: Schedule = { id: 'once-1', title: 'Team rule', prompt: 'Write today', repeat: 'once', time: '04:18', date: '2026-10-29', weekday: null, day: null,
  projectId: null, enabled: true, nextRunAt: '2026-10-28T19:18:00Z', lastRunAt: null, lastChatId: null, resumeBlockedReason: null }
const render = (s: Schedule) => renderToStaticMarkup(<MemoryRouter><ScheduleItem s={s} tz="Asia/Seoul" when="once" onToggle={() => {}} onRemove={() => {}} /></MemoryRouter>)
const button = (html: string) => /<button(?![^>]*aria-label)[^>]*>[^<]*<\/button>/.exec(html)?.[0] ?? ''
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')

describe('schedule row', () => {
  // Server rendering reads the locale store's initial state (English); ko/id texts are the same keys (i18n tests).
  for (const locale of ['en'] as const) {
    test(`a completed one-time task: switch disabled and described by the reason (${locale})`, () => {
      const html = render({ ...base, enabled: false, nextRunAt: null, lastRunAt: '2026-10-28T19:18:15Z', lastChatId: 'chat-1', resumeBlockedReason: 'completed', lastOutcome: 'problems' })
      const b = button(html)
      expect(b).toContain('disabled=""')
      expect(b).toContain('aria-describedby="schedule-once-1-blocked"')
      expect(decode(b)).toContain(translate(locale, 'schedules.resume'))
      expect(decode(html)).toContain(`id="schedule-once-1-blocked"`)
      expect(decode(html)).toContain(translate(locale, 'schedules.completedHint'))
      expect(decode(html)).toContain(translate(locale, 'schedules.completed'))
      // the result: finished with problems, not "completed"
      expect(decode(html)).toContain(translate(locale, 'scheduleTemplates.outcome.problems'))
      expect(html).toContain('data-outcome="problems"')
      expect(html).toContain('href="/c/chat-1"')
    })
  }

  test('a paused recurring or future task keeps a working switch', () => {
    for (const s of [{ ...base, enabled: false, nextRunAt: null }, { ...base, repeat: 'daily' as const, date: null, enabled: false, nextRunAt: null }, base]) {
      const b = button(render(s))
      expect(b).not.toContain('disabled=""')
      expect(b).not.toContain('aria-describedby')
    }
  })

  test('the reason and the result texts exist in every language', () => {
    for (const locale of ['en', 'ko', 'id'] as const)
      for (const key of ['schedules.completedHint', 'schedules.expiredHint', 'scheduleTemplates.outcome.problems', 'notifications.event.schedule.problems'] as const)
        expect(translate(locale, key)).not.toBe(key)
  })

  test('result tone: success quiet, problems a warning, failures an error', () => {
    expect(outcomeTone('done')).toBe('muted')
    expect(outcomeTone('problems')).toBe('warn')
    for (const o of ['error', 'stopped', 'interrupted', 'budget_exceeded', 'user_unavailable'] as const) expect(outcomeTone(o)).toBe('danger')
    expect(render({ ...base, lastOutcome: 'done', lastChatId: 'c' })).toContain(translate('en', 'scheduleTemplates.outcome.done'))
  })
})

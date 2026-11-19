// Scheduled tasks at any frequency on the Scheduled pages (src/lib/scheduleText.ts, src/components/settings/
// ScheduleEditDialog.tsx; docs/decisions/20261118-shared-schedules-any-frequency.md): how every N minutes, several
// weekdays, the last day of the month and cron read, what the edit form sends for each kind, and where a task made in a
// shared chat posts.
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { Schedule } from '@mycel/shared/api'
import { translate, type MessageKey, type Params } from '../../src/i18n'
import { intervalUnit, repeatText } from '../../src/lib/scheduleText'
import { formOf, formReady, taskEdit } from '../../src/components/settings/ScheduleEditDialog'
import { ScheduleView } from '../../src/pages/Scheduled'

const base: Schedule = { id: 's-1', title: 'Report', prompt: 'Write the report', repeat: 'daily', time: '09:00', date: null, weekday: null, day: null,
  projectId: null, enabled: true, nextRunAt: '2026-11-20T00:00:00Z', lastRunAt: null, lastChatId: null, resumeBlockedReason: null }
const en = (key: MessageKey, params?: Params) => translate('en', key, params)
const ko = (key: MessageKey, params?: Params) => translate('ko', key, params)

describe('how a task repeats, in words', () => {
  test('several weekdays, the last day, every N minutes or hours, cron', () => {
    expect(repeatText({ ...base, repeat: 'weekly', weekday: 1, weekdays: [1, 4] }, en, 'en')).toBe('Every Monday and Thursday at 09:00')
    expect(repeatText({ ...base, repeat: 'weekly', weekday: 3 }, en, 'en')).toBe('Every Wednesday at 09:00')
    expect(repeatText({ ...base, repeat: 'monthly', day: 'last', time: '18:00' }, en, 'en')).toBe('On the last day of each month at 18:00')
    expect(repeatText({ ...base, repeat: 'monthly', day: 'last', time: '18:00' }, ko, 'ko')).toBe('매월 마지막 날 18:00')
    expect(repeatText({ ...base, repeat: 'interval', everyMinutes: 120, date: '2026-11-19' }, en, 'en')).toBe('Every 2 hours, from Nov 19, 2026 09:00')
    expect(repeatText({ ...base, repeat: 'interval', everyMinutes: 15, date: '2026-11-19' }, en, 'en')).toBe('Every 15 minutes, from Nov 19, 2026 09:00')
    expect(repeatText({ ...base, repeat: 'cron', cron: '*/30 9-18 * * 1-5' }, en, 'en')).toBe('Custom schedule: */30 9-18 * * 1-5')
    expect([intervalUnit(90), intervalUnit(180), intervalUnit(2880)]).toEqual([{ n: 90, unit: 'minutes' }, { n: 3, unit: 'hours' }, { n: 2, unit: 'days' }])
  })
})

describe('the edit form', () => {
  const f = formOf({ ...base, repeat: 'weekly', weekday: 1, weekdays: [1, 4] }, '2026-11-19')
  test('starts from the task, with a value for every other kind', () => {
    expect(f).toMatchObject({ repeat: 'weekly', weekdays: [1, 4], every: 1, unit: 'hours', cron: '0 9 * * 1-5', date: '2026-11-19' })
    expect(formOf({ ...base, repeat: 'interval', everyMinutes: 90, date: '2026-11-01' }, '2026-11-19')).toMatchObject({ every: 90, unit: 'minutes', date: '2026-11-01' })
  })
  test('sends only what the kind uses', () => {
    expect(taskEdit(f)).toMatchObject({ repeat: 'weekly', weekday: null, weekdays: [1, 4], day: null, everyMinutes: null, cron: null, date: null })
    expect(taskEdit({ ...f, weekdays: [5] })).toMatchObject({ weekday: 5, weekdays: null })
    expect(taskEdit({ ...f, repeat: 'interval', every: 3, unit: 'hours' })).toMatchObject({ everyMinutes: 180, date: '2026-11-19', weekdays: null })
    expect(taskEdit({ ...f, repeat: 'monthly', day: 'last' })).toMatchObject({ day: 'last' })
    expect(taskEdit({ ...f, repeat: 'cron', cron: ' 0 18 L * * ' })).toMatchObject({ cron: '0 18 L * *', time: '' })
  })
  test('can be checked only with what the kind needs', () => {
    expect(formReady(f)).toBe(true)
    expect(formReady({ ...f, weekdays: [] })).toBe(false)
    expect(formReady({ ...f, repeat: 'interval', every: Number.NaN })).toBe(false)
    expect(formReady({ ...f, repeat: 'cron', cron: '0 9 * *' })).toBe(false)
    expect(formReady({ ...f, repeat: 'cron', cron: '@hourly' })).toBe(true)
  })
})

describe('a task made in a shared chat', () => {
  test('the task page says where it posts, with a link to that chat', () => {
    const html = renderToStaticMarkup(<MemoryRouter><ScheduleView s={{ ...base, postsIn: { chatId: 'chat-9', title: 'Falcon weekly' } }} tz="Asia/Seoul" onToggle={() => {}} onRunNow={() => {}} onReview={() => {}} /></MemoryRouter>)
    expect(html).toContain('data-testid="schedule-posts-in"')
    expect(html).toContain('href="/c/chat-9"')
    expect(html).toContain('Falcon weekly')
    expect(renderToStaticMarkup(<MemoryRouter><ScheduleView s={base} tz="Asia/Seoul" onToggle={() => {}} onRunNow={() => {}} onReview={() => {}} /></MemoryRouter>)).not.toContain('schedule-posts-in')
  })
})

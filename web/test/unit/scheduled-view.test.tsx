// Scheduled tasks (src/pages/Scheduled.tsx ScheduleView, src/lib/scheduleText.ts; QA B-W12-2, B-W26-3, CHAT-12, SCHED-03):
// a finished or expired one-time task keeps its switch, disabled and described by the reason (no silent no-op); the
// last run's result (succeeded / finished with problems / failed) is shown with the link to its chat; a task nobody
// confirmed has "Check again" instead of the switch and no run now; the card's line reads like Claude's.
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { Chat, Schedule } from '@mycel/shared/api'
import { translate, type MessageKey, type Params } from '../../src/i18n'
import { cardLine, nextDueRead, onceDate, outcomeReason, outcomeTone, RUN_AT_DUE, scheduleState } from '../../src/lib/scheduleText'
import { snippetAround, titleFirst } from '../../src/components/SearchDialog'
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
    // Run now is offered, so the hint points to it, not to "create a new schedule"
    expect(html).toContain(t('scheduled.completedRunHint'))
    expect(html).not.toContain(t('schedules.completedHint'))
    expect(html).toContain(t('schedules.completed'))
    // the result: finished with problems, not "completed"
    expect(html).toContain(t('scheduleTemplates.outcome.problems'))
    expect(html).toContain('data-outcome="problems"')
    expect(html).toContain('href="/c/chat-1"')
  })

  test('without Run now, a completed task keeps the "create a new schedule" hint', () => {
    const s = { ...base, enabled: false, nextRunAt: null, resumeBlockedReason: 'completed' as const }
    const html = decode(renderToStaticMarkup(<MemoryRouter><ScheduleView s={s} tz="Asia/Seoul" onToggle={() => {}} /></MemoryRouter>))
    expect(html).toContain(t('schedules.completedHint'))
  })

  test('a failed last run: in the status line under the title, with the reason and a link to the result', () => {
    const html = decode(render({ ...base, repeat: 'daily', date: null, lastRunAt: '2026-10-28T19:18:15Z', lastChatId: 'chat-9', lastOutcome: 'error' }))
    expect(html).toContain('data-testid="schedule-status-outcome"')
    expect(html).toContain(t('scheduleTemplates.outcome.error'))
    expect(html).toContain(t('scheduled.reason.error'))
    expect(html).toContain(t('scheduled.lastRunTitle'))
    expect(html).toContain(t('scheduled.openResult'))
    expect(html).toContain('href="/c/chat-9"')
    // a success stays quiet: no outcome in the status line, no reason
    const ok = decode(render({ ...base, lastRunAt: '2026-10-28T19:18:15Z', lastOutcome: 'done' }))
    expect(ok).not.toContain('data-testid="schedule-status-outcome"')
    expect(ok).not.toContain('data-testid="schedule-outcome-reason"')
  })

  test('every failed outcome has a reason in every language', () => {
    for (const o of ['problems', 'error', 'stopped', 'interrupted', 'budget_exceeded', 'user_unavailable'] as const)
      for (const locale of ['en', 'ko', 'id', 'ja', 'es'] as const) {
        const r = outcomeReason({ ...base, lastOutcome: o }, (key, params) => translate(locale, key, params))
        expect(r).not.toBe(`scheduled.reason.${o}`)
        expect(r.length).toBeGreaterThan(0)
      }
    expect(outcomeReason({ ...base, lastOutcome: 'done' }, t)).toBe('')
  })

  test('search: the part of an instruction that matched, on one line', () => {
    expect(snippetAround('On Monday,\n  sum the weekly notes', 'weekly')).toBe('On Monday, sum the weekly notes')
    const long = `${'a'.repeat(60)} weekly ${'b'.repeat(80)}`
    const cut = snippetAround(long, 'weekly')
    expect(cut.startsWith('…')).toBe(true)
    expect(cut.endsWith('…')).toBe(true)
    expect(cut).toContain('weekly')
    expect(snippetAround('nothing here', 'weekly')).toBe('')
  })

  test('search: a chat with the text in its title comes before a newer one that has it only in its messages', () => {
    const chat = (id: string, title: string) => ({ id, title }) as Chat
    const found = [chat('new', 'Two attachments'), chat('named', 'Onboarding guide'), chat('old', 'Q3 notes'), chat('also', 'onboarding v2')]
    expect(titleFirst(found, 'onboarding').map((c) => c.id)).toEqual(['named', 'also', 'new', 'old'])
    expect(titleFirst(found, 'zzz').map((c) => c.id)).toEqual(['new', 'named', 'old', 'also'])
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
      for (const key of ['schedules.completedHint', 'schedules.expiredHint', 'scheduleTemplates.outcome.problems', 'notifications.event.schedule.problems', 'sidebar.scheduled', 'scheduled.switch', 'scheduled.openResult', 'scheduled.emptyBody', 'scheduled.expiredRunHint', 'search.inInstruction', 'search.fileNamesFailed'] as const)
        expect(translate(locale, key)).not.toBe(key)
  })

  test('result tone: success quiet, problems a warning, failures an error', () => {
    expect(outcomeTone('done')).toBe('muted')
    expect(outcomeTone('problems')).toBe('warn')
    for (const o of ['error', 'stopped', 'interrupted', 'budget_exceeded', 'user_unavailable'] as const) expect(outcomeTone(o)).toBe('danger')
    expect(decode(render({ ...base, lastOutcome: 'done', lastChatId: 'c' }))).toContain(t('scheduled.run.done'))
  })

  // the "Last run" block: one heading, then the state and when (QA: it said "Last run / Last run / Last run succeeded")
  const history = (html: string) => /data-testid="schedule-history"[\s\S]*?<\/section>/.exec(html)?.[0] ?? ''
  const count = (s: string, part: string) => s.split(part).length - 1
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

  test('the Last run block: one heading, then "Succeeded · 2 minutes ago" linked to the run', () => {
    // a "Run now" run: only lastChatId moved (lastRunAt is the last run at its time, here none)
    const block = history(decode(render({ ...base, repeat: 'daily', date: null, lastRunAt: null, lastChatId: 'chat-3', lastOutcome: 'done', lastOutcomeAt: ago(2 * 60_000), running: false })))
    expect(count(block, t('scheduled.lastRunTitle'))).toBe(1)
    expect(block).not.toContain(t('scheduleTemplates.outcome.done'))
    expect(block).toContain(t('scheduled.run.done'))
    expect(block).toContain('2 minutes ago')
    expect(block).toContain('data-outcome="done"')
    expect(block).toContain('href="/c/chat-3"')
    expect(block).toContain(t('scheduled.openResult'))
  })

  test('a run on its way: "Running", linked to its chat; the run before it is not shown as its result', () => {
    const html = decode(render({ ...base, repeat: 'daily', date: null, lastRunAt: ago(86400_000), lastChatId: 'chat-4', lastOutcome: 'error', lastOutcomeAt: ago(86400_000), running: true }))
    const block = history(html)
    expect(count(block, t('scheduled.lastRunTitle'))).toBe(1)
    expect(block).toContain(t('scheduled.run.running'))
    expect(block).toContain('data-outcome="running"')
    expect(block).not.toContain(t('scheduled.run.error'))
    expect(block).not.toContain('data-testid="schedule-outcome-reason"')
    expect(block).toContain(t('schedules.openRun'))
    // nor under the title
    expect(html).not.toContain('data-testid="schedule-status-outcome"')
  })

  test('a failure says what and when, then why; an older server (no lastOutcomeAt) uses the last run at its time', () => {
    const block = history(decode(render({ ...base, repeat: 'daily', date: null, lastRunAt: ago(3 * 3600_000), lastChatId: 'chat-5', lastOutcome: 'error' })))
    expect(count(block, t('scheduled.lastRunTitle'))).toBe(1)
    expect(block).toContain(`${t('scheduled.run.error')}</span><span class="text-muted" aria-hidden="true"> · </span>`)
    expect(block).toContain('3 hours ago')
    expect(block).toContain(t('scheduled.reason.error'))
    // an occurrence that did not run keeps its own words (they never said "last run")
    const skipped = history(decode(render({ ...base, repeat: 'daily', date: null, lastRunAt: ago(60_000), lastOutcome: 'budget_exceeded', lastOutcomeAt: ago(60_000) })))
    expect(skipped).toContain(t('scheduleTemplates.outcome.budget_exceeded'))
  })

  test('a run at its time is looked for when it is due (no chat event names it before the list knows its chat)', () => {
    const now = Date.parse('2026-11-11T09:00:00Z')
    const at = (ms: number) => new Date(now + ms).toISOString()
    const daily = { ...base, repeat: 'daily' as const, date: null }
    // the next due time, plus a moment for the server's tick
    expect(nextDueRead([{ ...daily, nextRunAt: at(60_000) }, { ...daily, id: 'b', nextRunAt: at(3600_000) }], now)).toBe(60_000 + RUN_AT_DUE)
    // due a moment ago and not started yet: again shortly; long past, or paused, or already running: not looked for
    expect(nextDueRead([{ ...daily, nextRunAt: at(-30_000) }], now)).toBe(RUN_AT_DUE)
    expect(nextDueRead([{ ...daily, nextRunAt: at(-3600_000) }], now)).toBeNull()
    expect(nextDueRead([{ ...daily, enabled: false, nextRunAt: at(60_000) }], now)).toBeNull()
    expect(nextDueRead([{ ...daily, running: true, nextRunAt: at(60_000) }], now)).toBeNull()
    // a run retried after a full queue
    expect(nextDueRead([{ ...daily, nextRunAt: null, retryAt: at(5000) }], now)).toBe(5000 + RUN_AT_DUE)
    expect(nextDueRead(null, now)).toBeNull()
  })

  test('the block\'s words exist in every language', () => {
    for (const locale of ['en', 'ko', 'id', 'ja', 'es'] as const)
      for (const key of ['scheduled.run.running', 'scheduled.run.done', 'scheduled.run.problems', 'scheduled.run.error', 'scheduled.run.stopped', 'scheduled.run.interrupted', 'rooms.roomNotIn'] as const)
        expect(translate(locale, key)).not.toBe(key)
  })
})

test("a one-time task's day reads in the person's language, never shifted (QA TC-073)", () => {
  expect(onceDate('2026-10-29', 'en')).toBe('Oct 29, 2026')
  expect(onceDate('2026-01-01', 'en')).toBe('Jan 1, 2026')
  expect(onceDate('2026-10-29', 'ko')).toContain('2026')
  expect(onceDate('2026-10-29', 'ko')).toContain('29')
  expect(onceDate('2026-10-29', 'id')).toContain('Okt')
  // anything that is not a plain day stays as it is; none gives ''
  expect(onceDate('soon', 'en')).toBe('soon')
  expect(onceDate(null, 'en')).toBe('')
  const en = (key: MessageKey, params?: Params) => translate('en', key, params)
  expect(cardLine({ ...base }, en, 'en')).toBe('Once on Oct 29, 2026 at 04:18')
})

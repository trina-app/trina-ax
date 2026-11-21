// Scheduled tasks at any frequency (server/src/chat/schedule-timing.ts, docs/decisions/20261118-shared-schedules-any-
// frequency.md): every N minutes, several weekdays, day 29–31 and the last day of the month, cron; how they are stored
// so an older build after a rollback never runs them more often; and the runner keeping such a task on after a run.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, setSystemTime, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import { CronError, describeTiming, nextOf, parseCron, STORED_PAST, storedTiming, timingOf, type Timing } from '../../server/src/chat/schedule-timing'
import { inputTiming, isFrequent, ScheduleInput } from '../../server/src/chat/schedules'
import { scheduleWhen } from '../../server/src/tools/schedules'
import { startHarness, type Harness } from '../lib/b-harness'
import { CONFIRMED } from '../lib/schedule-card'

setDefaultTimeout(60_000)
const SEOUL = 'Asia/Seoul'
const NY = 'America/New_York'
const t = (o: Partial<Timing>): Timing => ({ repeat: 'daily', time: '09:00', weekdays: null, day: null, date: null, everyMinutes: null, cron: null, ...o })
const iso = (d: Date | null) => d?.toISOString() ?? null
/** the runs after `from`, one after another */
function runs(src: Timing, from: Date, n: number, tz = SEOUL): string[] {
  const out: string[] = []
  let at: Date | null = from
  for (let i = 0; i < n && at; i++) { at = nextOf(src, at, tz); if (at) out.push(at.toISOString()) }
  return out
}

describe('the kinds the old columns could not hold', () => {
  const wedNoon = new Date('2026-10-21T03:00:00Z') // Wed 12:00 in Seoul
  test('every N minutes or hours, counted from its start (a start in the past keeps its beat)', () => {
    const hourly = t({ repeat: 'interval', everyMinutes: 60, date: '2026-10-21', time: '09:00' })
    expect(runs(hourly, wedNoon, 3)).toEqual(['2026-10-21T04:00:00.000Z', '2026-10-21T05:00:00.000Z', '2026-10-21T06:00:00.000Z'])
    // every 90 minutes from 09:00 crosses midnight without starting over
    const ninety = t({ repeat: 'interval', everyMinutes: 90, date: '2026-10-21', time: '21:00' })
    expect(runs(ninety, new Date('2026-10-21T13:00:00Z'), 3)).toEqual(['2026-10-21T13:30:00.000Z', '2026-10-21T15:00:00.000Z', '2026-10-21T16:30:00.000Z'])
    // a start still to come is the first run; every minute is allowed (no shortest interval)
    expect(iso(nextOf(t({ repeat: 'interval', everyMinutes: 1, date: '2026-10-22', time: '00:00' }), wedNoon, SEOUL))).toBe('2026-10-21T15:00:00.000Z')
    expect(runs(t({ repeat: 'interval', everyMinutes: 1, date: '2026-10-21', time: '00:00' }), wedNoon, 2)).toEqual(['2026-10-21T03:01:00.000Z', '2026-10-21T03:02:00.000Z'])
  })

  test('several days of the week; day 31 (skipped where a month has none) and the last day of the month', () => {
    expect(runs(t({ repeat: 'weekly', weekdays: [1, 4] }), wedNoon, 3)).toEqual(['2026-10-22T00:00:00.000Z', '2026-10-26T00:00:00.000Z', '2026-10-29T00:00:00.000Z'])
    expect(runs(t({ repeat: 'monthly', day: 'last', time: '18:00' }), wedNoon, 4)).toEqual(['2026-10-31T09:00:00.000Z', '2026-11-30T09:00:00.000Z', '2026-12-31T09:00:00.000Z', '2027-01-31T09:00:00.000Z'])
    expect(iso(nextOf(t({ repeat: 'monthly', day: 'last', time: '18:00' }), new Date('2028-02-01T00:00:00Z'), SEOUL))).toBe('2028-02-29T09:00:00.000Z')
    expect(runs(t({ repeat: 'monthly', day: 31 }), new Date('2026-10-31T01:00:00Z'), 2)).toEqual(['2026-12-31T00:00:00.000Z', '2027-01-31T00:00:00.000Z'])
  })

  test('cron: steps, ranges, lists, names, L, macros; day of the month or of the week (either, as cron)', () => {
    // every 15 minutes in working hours on weekdays
    expect(runs(t({ repeat: 'cron', cron: '*/15 9-18 * * 1-5' }), new Date('2026-10-23T09:50:00Z'), 3)).toEqual(['2026-10-26T00:00:00.000Z', '2026-10-26T00:15:00.000Z', '2026-10-26T00:30:00.000Z'])
    expect(runs(t({ repeat: 'cron', cron: '0 9 * * MON,THU' }), wedNoon, 2)).toEqual(['2026-10-22T00:00:00.000Z', '2026-10-26T00:00:00.000Z'])
    expect(runs(t({ repeat: 'cron', cron: '30 17 L * *' }), wedNoon, 2)).toEqual(['2026-10-31T08:30:00.000Z', '2026-11-30T08:30:00.000Z'])
    expect(iso(nextOf(t({ repeat: 'cron', cron: '@hourly' }), wedNoon, SEOUL))).toBe('2026-10-21T04:00:00.000Z')
    expect(iso(nextOf(t({ repeat: 'cron', cron: '0 0 1 JAN *' }), wedNoon, SEOUL))).toBe('2026-12-31T15:00:00.000Z')
    // the 13th or a Friday: the next of either
    expect(runs(t({ repeat: 'cron', cron: '0 9 13 * 5' }), wedNoon, 2)).toEqual(['2026-10-23T00:00:00.000Z', '2026-10-30T00:00:00.000Z'])
    // 7 is Sunday too
    expect(iso(nextOf(t({ repeat: 'cron', cron: '0 9 * * 7' }), wedNoon, SEOUL))).toBe('2026-10-25T00:00:00.000Z')
    // a date that never comes: no next run
    expect(nextOf(t({ repeat: 'cron', cron: '0 0 31 2 *' }), wedNoon, SEOUL)).toBeNull()
  })

  test('cron across daylight saving: the wall clock of the team, a skipped hour has no run', () => {
    // New York, 2026-03-08: 02:00 → 03:00
    expect(runs(t({ repeat: 'cron', cron: '0 9 * * *' }), new Date('2026-03-07T15:00:00Z'), 2, NY)).toEqual(['2026-03-08T13:00:00.000Z', '2026-03-09T13:00:00.000Z'])
    expect(runs(t({ repeat: 'cron', cron: '30 2 * * *' }), new Date('2026-03-07T12:00:00Z'), 2, NY)).toEqual(['2026-03-09T06:30:00.000Z', '2026-03-10T06:30:00.000Z'])
  })

  test('a bad cron schedule says what is wrong; ScheduleInput refuses it and each kind without what it needs', () => {
    expect(() => parseCron('0 9 * *')).toThrow(CronError)
    expect(() => parseCron('61 * * * *')).toThrow('minute: "61" is outside 0–59')
    expect(() => parseCron('*/0 * * * *')).toThrow('the step')
    // security review of #1353: a range has two values; "*/1" is the whole field (Fridays only, not "every day or Friday")
    expect(() => parseCron('1-2-3 * * * *')).toThrow('is not a range')
    expect(runs(t({ repeat: 'cron', cron: '0 9 */1 * 5' }), new Date('2026-10-21T03:00:00Z'), 2)).toEqual(['2026-10-23T00:00:00.000Z', '2026-10-30T00:00:00.000Z'])
    const base = { title: 'T', prompt: 'do the task' }
    expect(ScheduleInput.safeParse({ ...base, repeat: 'cron', cron: '0 25 * * *' }).error?.issues[0]?.message).toBe('hour: "25" is outside 0–23')
    expect(ScheduleInput.safeParse({ ...base, repeat: 'cron', cron: '0 9 * * 1-5' }).success).toBe(true)
    expect(ScheduleInput.safeParse({ ...base, repeat: 'interval', time: '09:00' }).success).toBe(false)
    expect(ScheduleInput.safeParse({ ...base, repeat: 'interval', time: '09:00', everyMinutes: 30 }).success).toBe(true)
    expect(ScheduleInput.safeParse({ ...base, repeat: 'weekly', time: '09:00', weekdays: [1, 4] }).success).toBe(true)
    expect(ScheduleInput.safeParse({ ...base, repeat: 'monthly', time: '09:00', day: 'last' }).success).toBe(true)
    expect(ScheduleInput.safeParse({ ...base, repeat: 'daily' }).success).toBe(false)
  })

  test('in words: English for the AI, the person\'s language on the card', () => {
    expect(describeTiming(t({ repeat: 'weekly', weekdays: [1, 4] }))).toBe('every Monday and Thursday at 09:00')
    expect(describeTiming(t({ repeat: 'monthly', day: 'last', time: '18:00' }))).toBe('on the last day of every month at 18:00')
    expect(describeTiming(t({ repeat: 'interval', everyMinutes: 120, date: '2026-10-21' }))).toBe('every 2 hours, counted from 2026-10-21 09:00')
    expect(describeTiming(t({ repeat: 'cron', cron: '*/5 * * * *' }))).toContain('"*/5 * * * *"')
    expect(scheduleWhen(t({ repeat: 'weekly', weekdays: [1, 4] }), 'en')).toBe('every Monday and Thursday at 09:00')
    expect(scheduleWhen(t({ repeat: 'monthly', day: 'last', time: '18:00' }), 'ko')).toBe('매월 마지막 날 18:00')
    expect(scheduleWhen(t({ repeat: 'interval', everyMinutes: 30, date: '2026-10-21' }), 'en')).toBe('every 30 minutes, from Oct 21, 2026 09:00')
  })
})

describe('stored so an older build never runs it more often', () => {
  test('the five first kinds stay in the old columns; the others are a past one-time task there, with `rule`', () => {
    expect(storedTiming(t({ repeat: 'weekly', weekdays: [3] }))).toEqual({ repeat: 'weekly', time: '09:00', weekday: 3, day: null, date: null, rule: null })
    expect(storedTiming(t({ repeat: 'monthly', day: 28 }))).toEqual({ repeat: 'monthly', time: '09:00', weekday: null, day: 28, date: null, rule: null })
    for (const x of [t({ repeat: 'weekly', weekdays: [1, 4] }), t({ repeat: 'monthly', day: 'last' }), t({ repeat: 'monthly', day: 30 }), t({ repeat: 'interval', everyMinutes: 15, date: '2026-10-21' }), t({ repeat: 'cron', cron: '0 9 * * 1-5' })]) {
      const s = storedTiming(x)
      expect([s.repeat, s.date, s.weekday, s.day]).toEqual(['once', STORED_PAST, null, null])
      // as an older build reads the old columns: a one-time task in the past, never scheduled again
      expect(nextOf({ repeat: s.repeat, time: s.time, date: s.date }, new Date(), SEOUL)).toBeNull()
      // and this build reads it back as it was
      expect(timingOf(s)).toEqual(x)
    }
  })

  test('an interval without a start counts from today in the team zone; a cron task keeps 00:00 in the time column', () => {
    const now = new Date('2026-10-21T16:00:00Z') // Oct 22 01:00 in Seoul
    expect(inputTiming({ title: 'T', prompt: 'p p p', repeat: 'interval', everyMinutes: 60, time: '00:30' }, now, SEOUL)).toMatchObject({ date: '2026-10-22', time: '00:30' })
    expect(inputTiming({ title: 'T', prompt: 'p p p', repeat: 'cron', cron: '0 9 * * *' }, now, SEOUL)).toMatchObject({ time: '00:00', cron: '0 9 * * *' })
  })
})

describe('the runner and the Scheduled page', () => {
  let h: Harness
  beforeAll(async () => { h = await startHarness({ name: 'schedule-timing', timeZone: 'Asia/Seoul' }) })
  afterAll(async () => { await h.close() })
  const fake = (d: unknown) => '@fake ' + JSON.stringify(d)

  test('an hourly task runs, stays on and moves to its next hour (not ended like the one-time task its old columns hold)', async () => {
    const rt = h.rt()
    const start = new Date(Date.now() - 3 * 3600_000)
    const made = rt.schedules.create('alice', { title: 'Hourly', prompt: fake({ say: 'ok' }), repeat: 'interval', everyMinutes: 60, time: '00:00' }, start, CONFIRMED)
    expect(made).toMatchObject({ repeat: 'once', date: STORED_PAST })
    h.ctx.db.query('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), made.id)
    const now = new Date()
    expect(rt.schedules.runDue(now)).toEqual([made.id])
    const after = rt.schedules.get('alice', made.id)!
    expect(after.enabled).toBe(1)
    const next = new Date(after.next_run_at!).getTime()
    expect(next).toBeGreaterThan(now.getTime())
    expect(next - now.getTime()).toBeLessThanOrEqual(3600_000)
    // the Scheduled page reads it as it is, and a pause and resume keep it hourly (not "a one-time task that ran")
    const listed = (await h.api('alice').call(API.listSchedules)).items.find((x) => x.id === made.id)!
    expect(listed).toMatchObject({ repeat: 'interval', everyMinutes: 60, resumeBlockedReason: null })
    rt.schedules.setEnabled('alice', made.id, false)
    expect(rt.schedules.setEnabled('alice', made.id, true)).toMatchObject({ enabled: 1 })
    rt.schedules.delete('alice', made.id)
  })

  test('an edit sets Mon + Thu, the last day or cron through the same card; the card binds the new timing', async () => {
    const rt = h.rt()
    const made = rt.schedules.create('alice', { title: 'Report', prompt: 'write the weekly report in my folder', repeat: 'daily', time: '09:00' }, undefined, CONFIRMED)
    const body = { kind: 'task' as const, title: 'Report', prompt: 'write the weekly report in my folder', repeat: 'weekly' as const, time: '09:00', weekdays: [1, 4], projectId: null }
    const card = await h.api('alice').call(API.scheduleEditCard, { params: { id: made.id }, body })
    expect(card.request.question).toContain('every Monday and Thursday at 09:00')
    // another timing is another card: the answer to the first one does not save it
    const other = await h.api('alice').call(API.scheduleEditCard, { params: { id: made.id }, body: { ...body, weekdays: [1, 5] } })
    expect(other.request.requestId).not.toBe(card.request.requestId)
    const saved = await h.api('alice').call(API.editSchedule, { params: { id: made.id }, body: { ...body, requestId: card.request.requestId, answer: 'save' } })
    expect(saved).toMatchObject({ repeat: 'weekly', weekdays: [1, 4], weekday: 1 })
    const cronBody = { ...body, repeat: 'cron' as const, time: '', weekdays: null, cron: '0 18 L * *' }
    const c2 = await h.api('alice').call(API.scheduleEditCard, { params: { id: made.id }, body: cronBody })
    expect((await h.api('alice').call(API.editSchedule, { params: { id: made.id }, body: { ...cronBody, requestId: c2.request.requestId, answer: 'save' } }))).toMatchObject({ repeat: 'cron', cron: '0 18 L * *' })
    // a bad cron schedule is refused under its field, before any card
    const bad = await h.api('alice').call(API.scheduleEditCard, { params: { id: made.id }, body: { ...cronBody, cron: '0 18 L *' } }).then(() => null, (e: { body: { fields?: Record<string, string> } }) => e)
    expect(Object.keys(bad!.body.fields ?? {})).toEqual(['body.cron'])
    rt.schedules.delete('alice', made.id)
  })
})

describe('isFrequent: the interval of the schedule, never the time of day', () => {
  const daily = t({ repeat: 'daily', time: '09:00' })
  const at = (d: string) => isFrequent(daily, d, SEOUL)
  test('a daily 09:00 task is not frequent at any hour, the hour before its time included ("Run now" at 08:30)', () => {
    // 23:32Z is 08:32 in Seoul: the next run is 28 minutes away, but the task is daily
    for (const d of ['2026-11-20T23:32:00Z', '2026-11-20T23:00:01Z', '2026-11-21T00:30:00Z', '2026-11-21T12:00:00Z']) expect(at(d)).toBe(false)
  })
  test('with the clock pinned inside the hour before the daily time', () => {
    setSystemTime(new Date('2026-11-20T23:32:00Z'))
    try { expect(isFrequent(daily, new Date().toISOString(), SEOUL)).toBe(false) } finally { setSystemTime() }
  })
  test('weekdays, weekly, monthly, once and hourly-or-slower are never frequent; an interval or cron under an hour is, at any time', () => {
    const slow = [t({ repeat: 'weekdays' }), t({ repeat: 'weekly', weekdays: [1] }), t({ repeat: 'monthly', day: 1 }),
      t({ repeat: 'once', date: '2026-11-21' }), t({ repeat: 'interval', everyMinutes: 60, date: '2026-11-01' }), t({ repeat: 'cron', cron: '0 * * * *' }), t({ repeat: 'cron', cron: '0 9 * * *' })]
    const fast = [t({ repeat: 'interval', everyMinutes: 15, date: '2026-11-01' }), t({ repeat: 'interval', everyMinutes: 59, date: '2026-11-01' }), t({ repeat: 'cron', cron: '*/10 * * * *' })]
    for (const d of ['2026-11-20T23:32:00Z', '2026-11-21T00:30:00Z', '2026-11-21T03:07:00Z']) {
      for (const x of slow) expect(isFrequent(x, d, SEOUL)).toBe(false)
      for (const x of fast) expect(isFrequent(x, d, SEOUL)).toBe(true)
    }
  })
})

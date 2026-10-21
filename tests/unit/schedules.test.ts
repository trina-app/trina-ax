// Scheduled tasks (server/src/chat/schedules.ts, tools/schedules.ts, routes in memories.ts): the next-run arithmetic
// in a time zone (with and without daylight saving), and runs through the real chat runtime with the scripted engine:
// a due schedule makes a new chat of its person, the turn is marked "schedule", tells the AI nobody is watching, and
// an ask_user inside it does not wait.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import { describeSchedule, nextRun, zonedToUtc } from '../../server/src/chat/schedules'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { waitFor } from '../lib/wait'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const s = (o: Partial<{ repeat: 'once' | 'daily' | 'weekdays' | 'weekly' | 'monthly'; time: string; weekday: number | null; day: number | null; date: string | null }>) =>
  ({ repeat: 'daily' as const, time: '09:00', weekday: null, day: null, date: null, ...o })

describe('next run (team time zone)', () => {
  const SEOUL = 'Asia/Seoul'
  test('wall-clock times map to UTC, also across daylight saving', () => {
    expect(zonedToUtc(2026, 10, 21, 9, 0, SEOUL).toISOString()).toBe('2026-10-21T00:00:00.000Z')
    expect(zonedToUtc(2026, 3, 9, 9, 0, 'America/New_York').toISOString()).toBe('2026-03-09T13:00:00.000Z') // EDT
    expect(zonedToUtc(2026, 3, 6, 9, 0, 'America/New_York').toISOString()).toBe('2026-03-06T14:00:00.000Z') // EST
  })
  test('daily, weekdays, weekly, monthly, once', () => {
    const wedNoon = new Date('2026-10-21T03:00:00Z') // Wed 12:00 in Seoul
    expect(nextRun(s({ time: '09:00' }), wedNoon, SEOUL)!.toISOString()).toBe('2026-10-22T00:00:00.000Z')
    expect(nextRun(s({ time: '18:30' }), wedNoon, SEOUL)!.toISOString()).toBe('2026-10-21T09:30:00.000Z')
    const friEvening = new Date('2026-10-23T12:00:00Z') // Fri 21:00 in Seoul
    expect(nextRun(s({ repeat: 'weekdays' }), friEvening, SEOUL)!.toISOString()).toBe('2026-10-26T00:00:00.000Z') // Monday
    expect(nextRun(s({ repeat: 'weekly', weekday: 1 }), wedNoon, SEOUL)!.toISOString()).toBe('2026-10-26T00:00:00.000Z')
    expect(nextRun(s({ repeat: 'monthly', day: 1 }), wedNoon, SEOUL)!.toISOString()).toBe('2026-11-01T00:00:00.000Z')
    expect(nextRun(s({ repeat: 'once', date: '2026-10-21', time: '13:00' }), wedNoon, SEOUL)!.toISOString()).toBe('2026-10-21T04:00:00.000Z')
    expect(nextRun(s({ repeat: 'once', date: '2026-10-21', time: '11:00' }), wedNoon, SEOUL)).toBeNull()
    expect(describeSchedule(s({ repeat: 'weekly', weekday: 1 }))).toBe('every Monday at 09:00')
  })
})

describe('runs through the chat runtime', () => {
  let h: Harness
  let alice: TestSocket
  beforeAll(async () => {
    h = await startHarness({ name: 'schedules', askUserTimeoutMs: 20_000 })
    alice = await h.ws('alice', { windowId: 'win-sched-1' })
    await alice.next('hello')
  })
  afterAll(async () => { alice?.close(); await h.close() })

  test('a due schedule starts a new chat of its person; the turn is unattended and knows it', async () => {
    const rt = h.rt()
    const now = new Date()
    const made = rt.schedules.create('alice', { title: 'Morning digest', prompt: fake({ echo: 'message' }), repeat: 'daily', time: '09:00' }, new Date(now.getTime() - 2 * 86_400_000))
    expect(rt.schedules.runDue(now)).toEqual([made.id])
    const row = rt.schedules.get('alice', made.id)!
    expect(row.last_chat_id).toBeTruthy()
    expect(new Date(row.next_run_at!).getTime()).toBeGreaterThan(now.getTime())
    expect(rt.schedules.runDue(now)).toEqual([]) // moved on: never twice
    const turn = h.ctx.db.query('SELECT client_kind, user_id FROM turns WHERE chat_id = ?').get(row.last_chat_id) as { client_kind: string; user_id: string }
    expect(turn).toEqual({ client_kind: 'schedule', user_id: 'alice' })
    const chat = await h.api('alice').call(API.getChat, { params: { id: row.last_chat_id! } })
    expect(chat.title.startsWith('⏰ Morning digest · ')).toBe(true)
    await waitFor(() => (h.ctx.db.query("SELECT status FROM messages WHERE chat_id = ? AND role = 'assistant'").get(row.last_chat_id) as { status: string }).status !== 'streaming', { timeoutMs: 30_000 })
    const answer = h.ctx.db.query("SELECT content FROM messages WHERE chat_id = ? AND role = 'assistant'").get(row.last_chat_id) as { content: string }
    expect(answer.content).toContain('<scheduled_run title="Morning digest">')
    expect(answer.content).toContain('Nobody is watching this chat now')
  })

  test('ask_user inside a scheduled run comes back "skipped" at once (nobody waits 20 s)', async () => {
    const rt = h.rt()
    const now = new Date()
    const made = rt.schedules.create('alice', { title: 'Asker', prompt: fake({ tool: 'ask_user', args: { question: 'Which format?' }, sayResult: true }), repeat: 'once', date: '2099-01-01', time: '09:00' })
    h.ctx.db.query('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(new Date(now.getTime() - 1000).toISOString(), made.id)
    const t0 = Date.now()
    rt.schedules.runDue(now)
    const chatId = rt.schedules.get('alice', made.id)!.last_chat_id!
    await waitFor(() => (h.ctx.db.query("SELECT status FROM messages WHERE chat_id = ? AND role = 'assistant'").get(chatId) as { status: string }).status !== 'streaming', { timeoutMs: 15_000 })
    expect(Date.now() - t0).toBeLessThan(15_000)
    const answer = h.ctx.db.query("SELECT content FROM messages WHERE chat_id = ? AND role = 'assistant'").get(chatId) as { content: string }
    expect(answer.content).toContain('"skipped":true')
    // a once-schedule that ran is finished
    expect(rt.schedules.get('alice', made.id)!.next_run_at).toBeNull()
  })

  test('the API lists only own schedules; pause, resume and delete', async () => {
    const rt = h.rt()
    rt.schedules.create('bob', { title: 'Bob only', prompt: 'x x x', repeat: 'daily', time: '10:00' })
    const mine = await h.api('alice').call(API.listSchedules)
    expect(mine.items.every((x) => x.title !== 'Bob only')).toBe(true)
    const one = mine.items.find((x) => x.title === 'Morning digest')!
    const paused = await h.api('alice').call(API.updateSchedule, { params: { id: one.id }, body: { enabled: false } })
    expect(paused).toMatchObject({ enabled: false, nextRunAt: null })
    expect((await h.api('alice').call(API.updateSchedule, { params: { id: one.id }, body: { enabled: true } })).nextRunAt).toBeTruthy()
    const bobs = rt.schedules.list('bob')[0]!
    expect((await h.req('alice', `/api/schedules/${bobs.id}`, { method: 'DELETE' })).status).toBe(404)
    await h.api('alice').call(API.deleteSchedule, { params: { id: one.id } })
    expect(rt.schedules.get('alice', one.id)).toBeNull()
  })
})

// A task's run history (GET /api/schedules/:id/runs, server/src/chat/schedules.ts runs): every run of the task with its
// result, start, end and chat, newest first, the occurrences that did not run, a failed run's one-line error, paging,
// a deleted chat without its link, and only the task's owner (another member and an admin get not_found).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { CONFIRMED } from '../lib/schedule-card'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')

describe('run history of a task', () => {
  let h: Harness
  beforeAll(async () => { h = await startHarness({ name: 'schedule-runs', timeZone: 'Asia/Seoul' }) })
  afterAll(async () => { await h.close() })

  const chat = (id: string, user = 'alice', deleted: string | null = null) =>
    h.ctx.db.query("INSERT INTO chats (id, user_id, title, engine, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,?)").run(id, user, 'Digest · run', 'claude-code', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', deleted)
  const turn = (id: string, scheduleId: string, chatId: string, o: { status: string; at: string; ended?: string | null; outcome?: string | null; error?: string | null }) =>
    h.ctx.db.query('INSERT INTO turns (id, chat_id, user_id, engine, status, started_at, ended_at, run_outcome, error, schedule_id, scheduled_for) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, chatId, 'alice', 'claude-code', o.status, o.at, o.ended ?? null, o.outcome ?? null, o.error ?? null, scheduleId, o.at)

  test('a real run is listed with its chat; it stays linked to that chat', async () => {
    const rt = h.rt()
    const now = new Date()
    const made = rt.schedules.create('alice', { title: 'Morning digest', prompt: fake({ echo: 'message' }), repeat: 'daily', time: '09:00' }, new Date(now.getTime() - 2 * 86_400_000), CONFIRMED)
    expect(rt.schedules.runDue(now)).toEqual([made.id])
    const chatId = rt.schedules.get('alice', made.id)!.last_chat_id!
    await waitFor(() => (h.ctx.db.query('SELECT status FROM turns WHERE chat_id = ?').get(chatId) as { status: string } | null)?.status === 'done')
    const page = await h.api('alice').call(API.listScheduleRuns, { params: { id: made.id }, query: {} })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({ status: 'done', chatId, error: null })
    expect(page.items[0]!.endedAt).toBeTruthy()
    expect(page.nextCursor).toBeNull()
  })

  test('a run chat says which own task it is a run of (Chat.schedule) and how it went; a deleted task, none', async () => {
    const rt = h.rt()
    const now = new Date()
    const made = rt.schedules.create('alice', { title: 'Fold me', prompt: fake({ echo: 'message' }), repeat: 'daily', time: '07:00' }, new Date(now.getTime() - 2 * 86_400_000), CONFIRMED)
    expect(rt.schedules.runDue(now)).toEqual([made.id])
    const chatId = rt.schedules.get('alice', made.id)!.last_chat_id!
    await waitFor(() => (h.ctx.db.query('SELECT status FROM turns WHERE chat_id = ?').get(chatId) as { status: string } | null)?.status === 'done')
    const listed = (await h.api('alice').call(API.listChats, { query: { limit: 100 } })).items.find((c) => c.id === chatId)!
    expect(listed.schedule).toEqual({ id: made.id, title: 'Fold me', templateId: null, outcome: 'succeeded' })
    expect((await h.api('alice').call(API.getChat, { params: { id: chatId } })).schedule?.id).toBe(made.id)
    // an ordinary chat has none
    expect((await h.api('alice').call(API.listChats, { query: { limit: 100 } })).items.filter((c) => c.id !== chatId && c.schedule?.id === made.id)).toEqual([])
    // a new name reaches the lists that fold its runs: the run chat's event carries it
    const ws = await h.ws('alice', { windowId: 'win-runs-1' })
    await ws.next('hello')
    h.ctx.db.query('UPDATE schedules SET title = ? WHERE id = ?').run('Folded', made.id)
    rt.schedules.publishRuns('alice', made.id)
    expect((await ws.next('chat.updated', (f) => f.data.chatId === chatId)).data.chat?.schedule?.title).toBe('Folded')
    // the task deleted: its runs are ordinary chats again, and the open lists hear it
    const heard = ws.next('chat.updated', (f) => f.data.chatId === chatId && !f.data.chat?.schedule)
    expect(rt.schedules.delete('alice', made.id)).toBe(true)
    expect((await heard).data.chat?.title).toBeTruthy()
    ws.close()
    expect((await h.api('alice').call(API.listChats, { query: { limit: 100 } })).items.find((c) => c.id === chatId)!.schedule).toBeUndefined()
  })

  test('results, skips, a failed run’s error line, a deleted chat, newest first and paged', async () => {
    const rt = h.rt()
    const made = rt.schedules.create('alice', { title: 'Weekly report', prompt: 'Summarise the week', repeat: 'daily', time: '09:00' }, new Date('2026-10-01T00:00:00Z'), CONFIRMED)
    for (const c of ['c1', 'c2', 'c3', 'c5']) chat(c)
    chat('c4', 'alice', '2026-11-05T00:00:00Z')
    turn('t1', made.id, 'c1', { status: 'done', at: '2026-11-01T00:00:00.000Z', ended: '2026-11-01T00:02:00.000Z', outcome: 'succeeded' })
    turn('t2', made.id, 'c2', { status: 'done', at: '2026-11-02T00:00:00.000Z', ended: '2026-11-02T00:01:00.000Z', outcome: 'problems' })
    turn('t3', made.id, 'c3', { status: 'error', at: '2026-11-03T00:00:00.000Z', ended: '2026-11-03T00:00:30.000Z', error: '\nThe AI could not answer just now.\nDetails: engine exited' })
    turn('t4', made.id, 'c4', { status: 'stopped', at: '2026-11-05T00:00:00.000Z', ended: '2026-11-05T00:00:10.000Z' })
    turn('t5', made.id, 'c5', { status: 'running', at: '2026-11-07T00:00:00.000Z' })
    h.ctx.db.query('INSERT INTO schedule_outcomes (id, user_id, schedule_id, scheduled_for, code, created_at) VALUES (?,?,?,?,?,?)').run('o1', 'alice', made.id, '2026-11-04T00:00:00.000Z', 'budget_exceeded', '2026-11-04T00:00:00.000Z')
    h.ctx.db.query('INSERT INTO schedule_template_skips (id, user_id, schedule_id, scheduled_for, template_id, template_name, created_at) VALUES (?,?,?,?,?,?,?)').run('k1', 'alice', made.id, '2026-11-06T00:00:00.000Z', 'tpl', 'Demo Wiki', '2026-11-06T00:00:00.000Z')
    // another task's run is not in this one's history
    const other = rt.schedules.create('alice', { title: 'Other', prompt: 'Something else', repeat: 'daily', time: '10:00' }, new Date('2026-10-01T00:00:00Z'), CONFIRMED)
    chat('c9'); turn('t9', other.id, 'c9', { status: 'done', at: '2026-11-04T12:00:00.000Z', ended: '2026-11-04T12:01:00.000Z', outcome: 'succeeded' })

    const all = await h.api('alice').call(API.listScheduleRuns, { params: { id: made.id }, query: { limit: 100 } })
    expect(all.items.map((r) => [r.id, r.status, r.chatId])).toEqual([
      ['t5', 'running', 'c5'], ['k1', 'needs_key', null], ['t4', 'stopped', null], ['o1', 'budget_exceeded', null],
      ['t3', 'error', 'c3'], ['t2', 'problems', 'c2'], ['t1', 'done', 'c1'],
    ])
    expect(all.items.find((r) => r.id === 't3')!.error).toBe('The AI could not answer just now.')
    expect(all.items.find((r) => r.id === 'k1')!.needName).toBe('Demo Wiki')
    expect(all.items.find((r) => r.id === 't1')).toMatchObject({ startedAt: '2026-11-01T00:00:00.000Z', endedAt: '2026-11-01T00:02:00.000Z', error: null })
    expect(all.nextCursor).toBeNull()

    // default page of 10 holds them all; pages of 3 walk the same order without gaps or repeats
    expect((await h.api('alice').call(API.listScheduleRuns, { params: { id: made.id }, query: {} })).items).toHaveLength(7)
    const seen: string[] = []
    let cursor: string | undefined
    for (let i = 0; i < 5; i++) {
      const p = await h.api('alice').call(API.listScheduleRuns, { params: { id: made.id }, query: { limit: 3, ...(cursor ? { cursor } : {}) } })
      seen.push(...p.items.map((r) => r.id))
      if (!p.nextCursor) break
      cursor = p.nextCursor
    }
    expect(seen).toEqual(all.items.map((r) => r.id))
  })

  test('only the task’s owner: another member, an admin and someone signed out get nothing', async () => {
    const made = h.rt().schedules.create('alice', { title: 'Private task', prompt: 'Read my notes', repeat: 'daily', time: '08:00' }, new Date('2026-10-01T00:00:00Z'), CONFIRMED)
    chat('p1'); turn('pt1', made.id, 'p1', { status: 'done', at: '2026-11-01T00:00:00.000Z', ended: '2026-11-01T00:01:00.000Z', outcome: 'succeeded' })
    for (const who of ['bob', 'carol', 'dana']) {
      const res = await h.req(who, `/api/schedules/${made.id}/runs`)
      expect(res.status).toBe(404)
    }
    const anon = await h.req(null, `/api/schedules/${made.id}/runs`)
    expect(anon.status).toBe(401)
    expect((await h.req('alice', '/api/schedules/no-such-task/runs')).status).toBe(404)
    expect((await h.req('alice', `/api/schedules/${made.id}/runs?limit=0`)).status).toBe(400)
  })
})

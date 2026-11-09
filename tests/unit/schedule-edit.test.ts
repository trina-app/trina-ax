// Settings › Scheduled tasks: run now, edit, pause/resume (docs/DECISIONS.md "Scheduled tasks: run now, edit, pause").
// "지금 실행" runs once with the rules of a scheduled run (unattended, the card's addresses only, budgets, the person's
// access) without moving the schedule; "수정" goes through the same checks and card as the AI's schedule_create (the
// long-query address listed apart, the "allow" connections) and saves only the card's answer; pausing and resuming are
// audited. Every path is refused for anyone but the task's person.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type ApiError, type ScheduleTaskEdit } from '@mycel/shared/api'
import { uuidv7 } from '@mycel/shared'
import { startHarness, type Harness } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { CONFIRMED } from '../lib/schedule-card'
import { waitFor } from '../lib/wait'
import type { ScheduleRow } from '../../server/src/chat/schedules'
import { noteEgressIp } from '../../server/src/tools/egress'
import { MAX_UNCONFIRMED_QUERY } from '../../server/src/tools/url-gate'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')

let h: Harness
beforeAll(async () => {
  h = await startHarness({ name: 'schedule-edit', timeZone: 'Asia/Seoul', askUserTimeoutMs: 3000 })
  noteEgressIp(h.ctx, '198.51.100.7')
})
afterAll(async () => { await h?.close() })

const row = (id: string) => h.ctx.db.query('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow
const failure = (p: Promise<unknown>) => p.then(() => { throw new Error('expected an error') }, (e: unknown) => e as ApiError)
const audits = (id: string, action: string) => (h.ctx.db.query('SELECT actor_id, detail FROM audit_log WHERE action = ? AND target = ? ORDER BY id').all(action, id) as { actor_id: string | null; detail: string | null }[])
  .map((r) => ({ actor: r.actor_id, ...(r.detail ? JSON.parse(r.detail) : {}) }))
const make = (user: string, o: Partial<{ title: string; prompt: string; repeat: 'daily' | 'weekly' | 'once'; time: string; weekday: number; date: string }> = {}, approval = CONFIRMED) =>
  h.rt().schedules.create(user, { title: o.title ?? 'Morning digest', prompt: o.prompt ?? fake({ say: 'digest done' }), repeat: o.repeat ?? 'daily', time: o.time ?? '09:00', ...(o.weekday !== undefined ? { weekday: o.weekday } : {}), ...(o.date ? { date: o.date } : {}) }, undefined, approval)
const settle = (chatId: string) => waitFor(() => (h.ctx.db.query("SELECT status FROM messages WHERE chat_id = ? AND role = 'assistant'").get(chatId) as { status: string } | null)?.status !== 'streaming', { timeoutMs: 30_000 })
const edit = (s: ScheduleRow, o: Partial<ScheduleTaskEdit> = {}): ScheduleTaskEdit => ({ kind: 'task', title: s.title, prompt: s.prompt, repeat: s.repeat, time: s.time, weekday: s.weekday, day: s.day, date: s.date, projectId: s.project_id, ...o })

describe('run now', () => {
  test('one run now with the rules of a scheduled run; the schedule, on/off and the next run stay; audited', async () => {
    const s = make('alice', { prompt: `Read https://news.example/today and summarise it.\n${fake({ echo: 'message' })}` }, { allowedUrls: ['https://news.example/today'], writeConnections: [] })
    const before = row(s.id)
    const r = await h.api('alice').call(API.runScheduleNow, { params: { id: s.id }, body: {} })
    expect(r.schedule).toMatchObject({ id: s.id, enabled: true, nextRunAt: before.next_run_at, lastChatId: r.chatId })
    const turn = h.ctx.db.query('SELECT client_kind, schedule_id, scheduled_for, user_id FROM turns WHERE chat_id = ?').get(r.chatId) as { client_kind: string; schedule_id: string; scheduled_for: string; user_id: string }
    expect(turn).toMatchObject({ client_kind: 'schedule', schedule_id: s.id, user_id: 'alice' })
    // its own occurrence key: never a whole minute (a scheduled occurrence's key)
    expect(Date.parse(turn.scheduled_for) % 60_000).not.toBe(0)
    // the message is the AI's text (auto_sent): only the addresses the card showed open without asking
    expect(h.ctx.db.query("SELECT auto_sent FROM messages WHERE chat_id = ? AND role = 'user'").get(r.chatId)).toEqual({ auto_sent: 1 })
    expect((h.ctx.db.query('SELECT url, source FROM chat_seen_urls WHERE chat_id = ?').all(r.chatId) as { url: string; source: string }[]).map((x) => [x.url, x.source])).toEqual([['https://news.example/today', 'allowed']])
    await settle(r.chatId)
    const answer = h.ctx.db.query("SELECT content FROM messages WHERE chat_id = ? AND role = 'assistant'").get(r.chatId) as { content: string }
    expect(answer.content).toContain('<scheduled_run title="Morning digest">')
    expect(answer.content).toContain('Nobody is watching this chat now')
    const after = row(s.id)
    expect(after).toMatchObject({ enabled: 1, next_run_at: before.next_run_at, last_run_at: before.last_run_at, pending_due_at: null, last_chat_id: r.chatId })
    expect(audits(s.id, 'schedule.run_now')).toEqual([{ actor: 'alice', scheduledFor: turn.scheduled_for }])
    expect((await h.api('alice').call(API.listSchedules)).items.find((x) => x.id === s.id)!.lastOutcome).toBe('done')
    // the scheduled occurrence still comes at its time
    expect(h.rt().schedules.runDue(new Date(Date.parse(before.next_run_at!) + 1000))).toContain(s.id)
  })

  test('a paused task runs once and stays paused; a one-time task is not used up', async () => {
    const s = make('alice', { title: 'Once later', repeat: 'once', date: new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10) })
    await h.api('alice').call(API.updateSchedule, { params: { id: s.id }, body: { enabled: false } })
    const r = await h.api('alice').call(API.runScheduleNow, { params: { id: s.id }, body: {} })
    expect(r.schedule).toMatchObject({ enabled: false, nextRunAt: null, resumeBlockedReason: null })
    await settle(r.chatId)
    expect((await h.api('alice').call(API.updateSchedule, { params: { id: s.id }, body: { enabled: true } })).enabled).toBe(true)
  })

  test('refused: a task nobody confirmed, one running now, a used-up budget, a full queue, someone else\'s', async () => {
    const unconfirmed = h.rt().schedules.create('alice', { title: 'Never confirmed', prompt: 'x x x', repeat: 'daily', time: '09:00' })
    const e1 = await failure(h.api('alice').call(API.runScheduleNow, { params: { id: unconfirmed.id }, body: {} }))
    expect([e1.status, e1.body.params?.reason]).toEqual([409, 'schedule_review'])
    // running now: one at a time
    const slow = make('alice', { title: 'Slow one', prompt: fake({ sleep: 3000 }, { say: 'late' }) })
    const first = await h.api('alice').call(API.runScheduleNow, { params: { id: slow.id }, body: {} })
    const e2 = await failure(h.api('alice').call(API.runScheduleNow, { params: { id: slow.id }, body: {} }))
    expect([e2.status, e2.body.params?.reason]).toEqual([409, 'schedule_running'])
    expect(e2.message).toContain('running now')
    await settle(first.chatId)
    // a used-up "block" limit: nothing is queued
    const turns = () => (h.ctx.db.query('SELECT count(*) n FROM turns WHERE schedule_id = ?').get(slow.id) as { n: number }).n
    const n = turns()
    h.ctx.db.query("INSERT INTO budgets (id, subject_type, subject_id, period, limit_usd, limit_tokens, action) VALUES ('sched-block', 'user', 'alice', 'day', 0, 0, 'block')").run()
    try {
      const e3 = await failure(h.api('alice').call(API.runScheduleNow, { params: { id: slow.id }, body: {} }))
      expect([e3.status, e3.code]).toEqual([429, 'budget_exceeded'])
      expect(e3.message).toContain('AI usage limit')
      expect(turns()).toBe(n)
    } finally { h.ctx.db.query("DELETE FROM budgets WHERE id = 'sched-block'").run() }
    // someone else's task: not there for anyone else
    const e4 = await failure(h.api('bob').call(API.runScheduleNow, { params: { id: slow.id }, body: {} }))
    expect(e4.status).toBe(404)
    expect(turns()).toBe(n)
    expect(audits(slow.id, 'schedule.run_now')).toHaveLength(1)
  })
})

describe('runs of one task never overlap', () => {
  test('a run at its time while "run now" is still going waits for it (logged once), then runs with its own key', async () => {
    const s = make('alice', { title: 'Overlap', prompt: fake({ sleep: 2500 }, { say: 'late' }) })
    const due = row(s.id).next_run_at!
    const turns = () => h.ctx.db.query('SELECT chat_id, scheduled_for FROM turns WHERE schedule_id = ? ORDER BY rowid').all(s.id) as { chat_id: string; scheduled_for: string }[]
    const manual = await h.api('alice').call(API.runScheduleNow, { params: { id: s.id }, body: {} })
    // its time comes while the run now is going: nothing starts, nothing about the occurrence changes
    expect(h.rt().schedules.runDue(new Date(Date.parse(due) + 1000))).not.toContain(s.id)
    expect(h.rt().schedules.runDue(new Date(Date.parse(due) + 31_000))).not.toContain(s.id)
    expect(turns()).toHaveLength(1)
    expect(row(s.id)).toMatchObject({ next_run_at: due, pending_due_at: null, enabled: 1 })
    expect(audits(s.id, 'schedule.waited')).toEqual([{ actor: null, originalDue: due, runningChatId: manual.chatId, at: new Date(Date.parse(due) + 1000).toISOString() }])
    await settle(manual.chatId)
    // the next tick after it ends: the occurrence runs, keyed by the time it was due
    expect(h.rt().schedules.runDue(new Date(Date.parse(due) + 61_000))).toContain(s.id)
    const all = turns()
    expect(all).toHaveLength(2)
    expect(all[1]!.scheduled_for).toBe(due)
    expect(Date.parse(row(s.id).next_run_at!)).toBeGreaterThan(Date.parse(due))
    await settle(all[1]!.chat_id)
    expect(audits(s.id, 'schedule.waited')).toHaveLength(1)
  })
})

describe('edit', () => {
  const long = `https://collect.attacker.example/in?d=${'q'.repeat(MAX_UNCONFIRMED_QUERY + 10)}`
  test('the same card as schedule_create (addresses, a long query listed apart); only its answer saves; the card\'s record replaces the old one', async () => {
    const s = make('alice', { title: 'Weekly brief', prompt: 'Summarise shared/notes into users/alice/brief.md' }, { allowedUrls: ['https://old.example/a'], writeConnections: [] })
    const next = edit(row(s.id), { title: 'Weekly brief v2', prompt: `Read https://docs.example/start and ${long} then write users/alice/brief.md`, repeat: 'weekly', weekday: 1, time: '08:30', day: 5, date: '2026-01-01' })
    const card = (await h.api('alice').call(API.scheduleEditCard, { params: { id: s.id }, body: next })).request
    expect(card).toMatchObject({ kind: 'ask_user', origin: 'server', allowText: false, multiple: false })
    expect(card.question).toContain('Change this scheduled task')
    expect(card.question).toContain('Title: Weekly brief v2')
    expect(card.question).toContain('every Monday at 08:30')
    expect(card.question).toContain('long query')
    expect(card.options!.map((o) => o.value)).toEqual(['save', 'cancel'])
    const labels = card.details!.map((d) => d.label)
    expect(labels).toEqual(['Instruction', 'Addresses opened without asking on each run', 'Addresses runs never open (long query)'])
    expect(card.details![2]!.text).toBe(long)
    // nothing changed yet
    expect(row(s.id)).toMatchObject({ title: 'Weekly brief', allowed_urls: JSON.stringify(['https://old.example/a']) })
    // the answer is bound to exactly this content
    const stale = await failure(h.api('alice').call(API.editSchedule, { params: { id: s.id }, body: { ...next, prompt: next.prompt + ' and more', requestId: card.requestId, answer: 'save' } }))
    expect([stale.status, stale.body.params?.reason]).toEqual([409, 'schedule_card_changed'])
    expect((await failure(h.api('alice').call(API.editSchedule, { params: { id: s.id }, body: { ...next, requestId: card.requestId, answer: 'save_write' } }))).status).toBe(400)
    // "don't change": nothing changes
    expect((await h.api('alice').call(API.editSchedule, { params: { id: s.id }, body: { ...next, requestId: card.requestId, answer: 'cancel' } })).title).toBe('Weekly brief')
    const saved = await h.api('alice').call(API.editSchedule, { params: { id: s.id }, body: { ...next, requestId: card.requestId, answer: 'save' } })
    expect(saved).toMatchObject({ title: 'Weekly brief v2', repeat: 'weekly', weekday: 1, day: null, date: null, time: '08:30', enabled: true })
    const r = row(s.id)
    // the card's addresses (the long-query one too: url-gate refuses it in a run whatever the record says)
    expect(JSON.parse(r.allowed_urls!)).toEqual(['https://docs.example/start', long])
    expect(r.write_connections).toBeNull()
    expect(r.confirmed_at).toBeTruthy()
    expect(new Date(r.next_run_at!).getUTCDay()).toBe(0) // Monday 08:30 in Seoul is Sunday 23:30 UTC
    const a = audits(s.id, 'schedule.edited')
    expect(a).toEqual([{ actor: 'alice', changed: ['title', 'prompt', 'schedule'], urls: 2, connections: 0, enabled: true }])
    expect(JSON.stringify(a)).not.toContain('brief')
  })

  test('"allow" connections are offered on the card; a connection that changed after the card refuses the answer', async () => {
    const s = make('alice', { title: 'Board post' })
    const conn = uuidv7()
    h.ctx.db.query("INSERT INTO integrations (id, scope, owner_user_id, kind, name, slug, url, auth, write_policy, status, created_at, updated_at) VALUES (?, 'team', NULL, 'mcp', 'Team board', 'board', 'https://board.example/mcp', 'none', 'allow', 'connected', 'x', 'x')").run(conn)
    h.ctx.db.query("INSERT INTO integration_access (integration_id, subject_type, subject_id) VALUES (?, 'everyone', '')").run(conn)
    try {
      const body = edit(row(s.id), { prompt: 'Post the summary of shared/notes to the team board.' })
      const card = (await h.api('alice').call(API.scheduleEditCard, { params: { id: s.id }, body })).request
      expect(card.question).toContain('Team board')
      expect(card.options!.map((o) => o.value)).toEqual(['save_write', 'save', 'cancel'])
      h.ctx.db.query('UPDATE integrations SET version = version + 1 WHERE id = ?').run(conn)
      expect((await failure(h.api('alice').call(API.editSchedule, { params: { id: s.id }, body: { ...body, requestId: card.requestId, answer: 'save_write' } }))).body.params).toMatchObject({ reason: 'schedule_card_changed' })
      const again = (await h.api('alice').call(API.scheduleEditCard, { params: { id: s.id }, body })).request
      await h.api('alice').call(API.editSchedule, { params: { id: s.id }, body: { ...body, requestId: again.requestId, answer: 'save_write' } })
      expect(JSON.parse(row(s.id).write_connections!)).toEqual([conn])
      // saving again without the sends drops them
      const third = (await h.api('alice').call(API.scheduleEditCard, { params: { id: s.id }, body })).request
      await h.api('alice').call(API.editSchedule, { params: { id: s.id }, body: { ...body, requestId: third.requestId, answer: 'save' } })
      expect(row(s.id).write_connections).toBeNull()
    } finally { h.ctx.db.query('DELETE FROM integrations WHERE id = ?').run(conn) }
  })

  test('checks like schedule_create: limits, a time still to come, a project the person can open; a paused task stays paused', async () => {
    const s = make('alice', { title: 'Checks' })
    await h.api('alice').call(API.updateSchedule, { params: { id: s.id }, body: { enabled: false } })
    const card = (body: ScheduleTaskEdit) => failure(h.api('alice').call(API.scheduleEditCard, { params: { id: s.id }, body }))
    const base = edit(row(s.id))
    const e1 = await card({ ...base, title: '   ' })
    expect([e1.status, Object.keys(e1.body.fields ?? {})]).toEqual([400, ['body.title']])
    expect((await card({ ...base, prompt: 'x' })).body.fields).toHaveProperty(['body.prompt'])
    expect((await card({ ...base, time: '25:00' })).body.fields).toHaveProperty(['body.time'])
    expect((await card({ ...base, repeat: 'weekly', weekday: null })).body.fields).toHaveProperty(['body.weekday'])
    const past = await card({ ...base, repeat: 'once', date: '2020-01-01' })
    expect([past.status, past.message]).toEqual([400, 'That time has already passed. Pick a date and time in the future.'])
    // a project: one the person can open, else refused
    const p = await oldProject(h, 'alice', { name: 'Q4 plan', folderPath: 'groups/marketing/q4-sched', instructions: 'Use the brief.' })
    const bad = await card({ ...base, projectId: uuidv7() })
    expect([bad.status, Object.keys(bad.body.fields ?? {})]).toEqual([400, ['body.projectId']])
    const withProject = { ...base, projectId: p.id }
    const c = (await h.api('alice').call(API.scheduleEditCard, { params: { id: s.id }, body: withProject })).request
    expect(c.question).toContain('Project: Q4 plan')
    const saved = await h.api('alice').call(API.editSchedule, { params: { id: s.id }, body: { ...withProject, requestId: c.requestId, answer: 'save' } })
    expect(saved).toMatchObject({ projectId: p.id, enabled: false, nextRunAt: null })
    // bob cannot open alice's project folder, nor edit alice's task
    const bobs = make('bob', { title: 'Bob task' })
    const e2 = await failure(h.api('bob').call(API.scheduleEditCard, { params: { id: bobs.id }, body: { ...edit(row(bobs.id)), projectId: p.id } }))
    expect(Object.keys(e2.body.fields ?? {})).toEqual(['body.projectId'])
    expect((await failure(h.api('bob').call(API.scheduleEditCard, { params: { id: s.id }, body: base }))).status).toBe(404)
    expect((await failure(h.api('bob').call(API.editSchedule, { params: { id: s.id }, body: { ...base, requestId: c.requestId, answer: 'save' } }))).status).toBe(404)
    expect(row(s.id).project_id).toBe(p.id)
  })

  test('a one-time task that already ran, given a new date, can be turned on again', async () => {
    const date = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10)
    const s = make('alice', { title: 'Once', repeat: 'once', date })
    h.ctx.db.query('UPDATE schedules SET enabled = 0, next_run_at = NULL, last_run_at = ? WHERE id = ?').run(new Date().toISOString(), s.id)
    expect((await h.api('alice').call(API.listSchedules)).items.find((x) => x.id === s.id)!.resumeBlockedReason).toBe('completed')
    const body = edit(row(s.id), { date: new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10) })
    const c = (await h.api('alice').call(API.scheduleEditCard, { params: { id: s.id }, body })).request
    const saved = await h.api('alice').call(API.editSchedule, { params: { id: s.id }, body: { ...body, requestId: c.requestId, answer: 'save' } })
    expect(saved).toMatchObject({ enabled: false, resumeBlockedReason: null })
    expect((await h.api('alice').call(API.updateSchedule, { params: { id: s.id }, body: { enabled: true } })).nextRunAt).toBeTruthy()
  })

  test('a task nobody confirmed: editing it is its confirmation (the card), it stays paused until resumed', async () => {
    const s = h.rt().schedules.create('alice', { title: 'Legacy', prompt: 'x x x', repeat: 'daily', time: '09:00' })
    h.ctx.db.query('UPDATE schedules SET enabled = 0, next_run_at = NULL, review_since = ? WHERE id = ?').run(new Date().toISOString(), s.id)
    const body = edit(row(s.id), { prompt: 'Summarise shared/notes' })
    const c = (await h.api('alice').call(API.scheduleEditCard, { params: { id: s.id }, body })).request
    const saved = await h.api('alice').call(API.editSchedule, { params: { id: s.id }, body: { ...body, requestId: c.requestId, answer: 'save' } })
    expect(saved).toMatchObject({ needsReview: false, enabled: false, reviewSince: null })
    expect(audits(s.id, 'schedule.edited')[0]).toMatchObject({ wasUnconfirmed: true })
  })

  test('templates: their time and folders only, checked like at creation; a free-text edit of a template is refused', async () => {
    const t = await h.api('alice').call(API.createScheduleFromTemplate, { body: { requestId: crypto.randomUUID(), templateId: 'weekly-summary', version: 1, sourcePath: 'shared', outputPath: 'users/alice/reports', time: '09:00', weekday: 1 } })
    const e1 = await failure(h.api('alice').call(API.scheduleEditCard, { params: { id: t.id }, body: edit(row(t.id)) }))
    expect([e1.status, e1.body.params?.reason]).toEqual([409, 'schedule_template'])
    const saved = await h.api('alice').call(API.editSchedule, { params: { id: t.id }, body: { kind: 'template', time: '07:15', weekday: 3, sourcePath: 'shared', outputPath: 'users/alice/weekly' } })
    expect(saved).toMatchObject({ time: '07:15', weekday: 3, sourcePath: 'shared', outputPath: 'users/alice/weekly', enabled: true })
    expect(row(t.id).prompt).toContain('"outputPath":"users/alice/weekly"')
    // the output must stay in the person's own folder; a folder they cannot read is not found
    expect((await failure(h.api('alice').call(API.editSchedule, { params: { id: t.id }, body: { kind: 'template', time: '07:15', weekday: 3, sourcePath: 'shared', outputPath: 'shared/out' } }))).status).toBe(404)
    expect((await failure(h.api('alice').call(API.editSchedule, { params: { id: t.id }, body: { kind: 'template', time: '07:15', weekday: 3, sourcePath: 'users/bob', outputPath: 'users/alice/weekly' } }))).status).toBe(404)
    expect((await failure(h.api('alice').call(API.editSchedule, { params: { id: t.id }, body: { kind: 'template', time: '07:15', weekday: null, sourcePath: 'shared', outputPath: 'users/alice/weekly' } }))).body.fields).toHaveProperty(['body.weekday'])
    expect(row(t.id)).toMatchObject({ template_output_path: 'users/alice/weekly', weekday: 3 })
    const free = make('alice', { title: 'Free' })
    expect((await failure(h.api('alice').call(API.editSchedule, { params: { id: free.id }, body: { kind: 'template', time: '07:15', sourcePath: 'shared', outputPath: 'users/alice/weekly' } }))).body.params).toMatchObject({ reason: 'schedule_not_template' })
    expect(audits(t.id, 'schedule.edited')).toEqual([{ actor: 'alice', changed: ['schedule', 'output'], template: 'weekly-summary', enabled: true }])
  })
})

describe('pause and resume', () => {
  test('paused tasks do not run; both are audited; someone else cannot', async () => {
    const s = make('alice', { title: 'Pausable' })
    await h.api('alice').call(API.updateSchedule, { params: { id: s.id }, body: { enabled: false } })
    expect(h.rt().schedules.runDue(new Date(Date.now() + 2 * 86400_000))).not.toContain(s.id)
    expect((await failure(h.api('bob').call(API.updateSchedule, { params: { id: s.id }, body: { enabled: true } }))).status).toBe(404)
    const on = await h.api('alice').call(API.updateSchedule, { params: { id: s.id }, body: { enabled: true } })
    expect(audits(s.id, 'schedule.paused')).toEqual([{ actor: 'alice', nextRunAt: null }])
    expect(audits(s.id, 'schedule.resumed')).toEqual([{ actor: 'alice', nextRunAt: on.nextRunAt }])
  })
})

// Scheduled tasks nobody confirmed (docs/DECISIONS.md "Scheduled tasks nobody confirmed"; review follow-up of the
// outbound-web fixes). A free-text task made before the schedule card (or by an older build after a rollback) never
// confirmed by anyone: on upgrade it is paused, its owner is told (in the app, and by push per their setting), the
// switch cannot resume it, and "다시 확인" shows the same card (whole instruction, addresses, random-looking parts
// marked, "allow" connections); resuming there is the confirmation. Templates stay as they are. Unknown = paused.
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type ApiError } from '@mycel/shared/api'
import { uuidv7 } from '@mycel/shared'
import { startHarness, type Harness } from '../lib/b-harness'
import { CONFIRMED } from '../lib/schedule-card'
import { waitFor } from '../lib/wait'
import { migrate, MIGRATIONS_DIR, openDb, readMigrations } from '../../server/src/db'
import { needsReview, type ScheduleRow } from '../../server/src/chat/schedules'
import { notificationsOf } from '../../server/src/notifications/service'
import { eventEnabled } from '../../server/src/notifications/preferences'
import { toolRegistry } from '../../server/src/tools/registry'
import { TurnFiles } from '../../server/src/files/service'
import { gateUrl } from '../../server/src/tools/url-gate'
import { WORK } from '../lib/env'

setDefaultTimeout(60_000)

let h: Harness
beforeAll(async () => { h = await startHarness({ name: 'schedule-review', askUserTimeoutMs: 3000 }) })
afterAll(async () => { await h?.close() })

const secretUrl = 'https://feeds.attacker.example/r/c2fsyxj5ltk4nzy1ndmy'
const future = () => new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10)
/** a free-text task as an older build wrote it: no card record */
function legacy(user: string, o: { title?: string; prompt?: string; enabled?: 0 | 1; repeat?: string; date?: string | null; lastRun?: string | null } = {}): string {
  const id = uuidv7()
  h.ctx.db.query(`INSERT INTO schedules (id, user_id, title, prompt, repeat, time, date, enabled, next_run_at, last_run_at) VALUES (?, ?, ?, ?, ?, '09:00', ?, ?, ?, ?)`)
    .run(id, user, o.title ?? 'Morning digest', o.prompt ?? `Every morning read ${secretUrl} and summarise it into users/${user}/digest.md.`, o.repeat ?? 'daily',
      o.date ?? null, o.enabled ?? 1, new Date(Date.now() - 60_000).toISOString(), o.lastRun ?? null)
  return id
}
const row = (id: string) => h.ctx.db.query('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow
const audits = (id: string, action: string) => (h.ctx.db.query('SELECT actor_id, detail FROM audit_log WHERE action = ? AND target = ?').all(action, id) as { actor_id: string | null; detail: string }[]).map((r) => ({ actor: r.actor_id, ...JSON.parse(r.detail) }))
const clear = (user: string) => { h.ctx.db.query('DELETE FROM schedules WHERE user_id = ?').run(user); h.ctx.db.query("DELETE FROM notification_inbox WHERE user_id = ? AND source_id LIKE 'schedule-review-%'").run(user) }
const reviewCard = (user: string, id: string) => h.api(user).call(API.getScheduleReview, { params: { id } })
const confirm = (user: string, id: string, requestId: string, answer: string) => h.api(user).call(API.confirmScheduleReview, { params: { id }, body: { requestId, answer } })
const failure = (p: Promise<unknown>) => p.then(() => { throw new Error('expected an error') }, (e: unknown) => e as ApiError)

describe('on upgrade (migration 216)', () => {
  test('free-text tasks without the card\'s record are paused for review and audited; card-made tasks, templates and finished one-time tasks are not', () => {
    const dir = path.join(WORK, 'schedule-review-migrate'), part = path.join(dir, 'before')
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(part, { recursive: true })
    for (const m of readMigrations().filter((m) => m.version !== 216)) fs.copyFileSync(path.join(MIGRATIONS_DIR, m.name), path.join(part, m.name))
    const db = openDb(path.join(dir, 'app.db'), { migrationsDir: part })
    try {
      db.query("INSERT INTO users (id, username, name, role) VALUES ('alice','alice','Alice','member')").run()
      const ins = (id: string, extra: string, values: string) => db.query(`INSERT INTO schedules (id, user_id, title, prompt, repeat, time, next_run_at, enabled${extra}) VALUES ('${id}','alice','t','p','daily','09:00','2026-11-01T00:00:00.000Z',1${values})`).run()
      ins('free-on', '', '')
      db.query("INSERT INTO schedules (id, user_id, title, prompt, repeat, time, enabled, pending_due_at, retry_at) VALUES ('free-off','alice','t','p','weekly','09:00',0,'2026-10-30T00:00:00.000Z','2026-10-30T00:01:00.000Z')").run()
      ins('card-urls', ', allowed_urls', ", '[\"https://x.example/a\"]'")
      ins('card-conn', ', write_connections', ", '[\"c1\"]'")
      ins('tpl', ', template_id, template_version', ", 'daily-file-index', 1")
      db.query("INSERT INTO schedules (id, user_id, title, prompt, repeat, time, date, enabled, last_run_at) VALUES ('done-once','alice','t','p','once','09:00','2026-10-01',0,'2026-10-01T00:00:00.000Z')").run()
      migrate(db, { backupDir: path.join(dir, 'backups') })
      const rows = Object.fromEntries((db.query('SELECT id, enabled, next_run_at, pending_due_at, retry_at, confirmed_at, review_since, created_at FROM schedules').all() as Record<string, unknown>[]).map((r) => [r.id, r]))
      for (const id of ['free-on', 'free-off']) {
        expect(rows[id]).toMatchObject({ enabled: 0, next_run_at: null, pending_due_at: null, retry_at: null, confirmed_at: null })
        expect(rows[id]!.review_since).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      }
      // both paused in one statement: one pause time (one notice per person)
      expect(rows['free-on']!.review_since).toBe(rows['free-off']!.review_since)
      for (const id of ['card-urls', 'card-conn']) expect(rows[id]).toMatchObject({ enabled: 1, review_since: null, confirmed_at: rows[id]!.created_at })
      expect(rows.tpl).toMatchObject({ enabled: 1, review_since: null, confirmed_at: null, next_run_at: '2026-11-01T00:00:00.000Z' })
      expect(rows['done-once']).toMatchObject({ review_since: null, confirmed_at: null })
      const audited = (db.query("SELECT target, actor_id, detail FROM audit_log WHERE action = 'schedule.review_paused' ORDER BY target").all() as { target: string; actor_id: null; detail: string }[])
      expect(audited.map((a) => [a.target, a.actor_id, JSON.parse(a.detail)])).toEqual([
        ['free-off', null, { userId: 'alice', wasEnabled: false, reason: 'upgrade' }],
        ['free-on', null, { userId: 'alice', wasEnabled: true, reason: 'upgrade' }],
      ])
    } finally { db.close() }
  })
})

describe('a task nobody confirmed never runs (unknown = paused)', () => {
  test('due: paused for review instead of run, audited, its owner told; the switch cannot resume it', async () => {
    clear('alice')
    // as an older build after a rollback would have written it: enabled, due, no card record
    const id = legacy('alice')
    expect(needsReview(row(id))).toBe(true)
    expect(h.rt().schedules.runDue()).toEqual([])
    expect(row(id)).toMatchObject({ enabled: 0, next_run_at: null, confirmed_at: null })
    expect(row(id).review_since).toBeTruthy()
    expect(h.ctx.db.query('SELECT COUNT(*) AS n FROM turns WHERE schedule_id = ?').get(id)).toEqual({ n: 0 })
    expect(audits(id, 'schedule.review_paused')).toEqual([{ actor: null, userId: 'alice', wasEnabled: true, reason: 'run' }])
    const res = await h.req('alice', `/api/schedules/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) })
    expect(res.status).toBe(409)
    const err = (await res.json()).error
    expect(err).toMatchObject({ code: 'conflict', params: { reason: 'schedule_review' } })
    expect(err.message).toContain('Check again')
    expect(row(id).enabled).toBe(0)
    const listed = (await h.api('alice').call(API.listSchedules)).items.find((s) => s.id === id)!
    expect(listed).toMatchObject({ enabled: false, needsReview: true, reviewSince: row(id).review_since })
  })

  test('the AI\'s schedule_list says it waits for the person', async () => {
    clear('alice')
    legacy('alice', { enabled: 0 })
    h.rt().schedules.pauseForReview(h.rt().schedules.list('alice')[0]!)
    const r = await toolRegistry(h.ctx.files).call('schedule_list', {}, { user: h.ctx.files.principal('alice'), turnId: null, files: new TurnFiles() })
    expect(r.text).toContain('paused until the user confirms it again in Settings › Scheduled tasks')
  })

  test('confirmed tasks and templates run as before', async () => {
    clear('alice')
    const made = h.rt().schedules.create('alice', { title: 'Confirmed', prompt: '@fake {"say":"ok"}', repeat: 'daily', time: '09:00' }, new Date(Date.now() - 2 * 86400_000), CONFIRMED)
    expect(made.confirmed_at).toBeTruthy()
    expect(needsReview(made)).toBe(false)
    expect(h.rt().schedules.runDue()).toEqual([made.id])
    await waitFor(() => (h.ctx.db.query("SELECT 1 FROM turns WHERE schedule_id = ? AND status IN ('done', 'error')").get(made.id) ? true : undefined), { timeoutMs: 20_000 })
    expect(needsReview({ template_id: 'daily-file-index', confirmed_at: null })).toBe(false)
  })

  test('a scheduled run queued before the upgrade is stopped at recovery, not run', async () => {
    clear('alice')
    const id = legacy('alice', { enabled: 0 })
    const chat = uuidv7(), u = uuidv7(), a = uuidv7(), turn = uuidv7()
    h.ctx.db.query("INSERT INTO chats (id, user_id, title, title_source) VALUES (?, 'alice', '⏰ old', 'schedule')").run(chat)
    h.ctx.db.query("INSERT INTO messages (id, chat_id, role, author_id, content, status, auto_sent) VALUES (?, ?, 'user', 'alice', 'old', 'done', 1)").run(u, chat)
    h.ctx.db.query("INSERT INTO messages (id, chat_id, parent_id, role, content, status) VALUES (?, ?, ?, 'assistant', '', 'streaming')").run(a, chat, u)
    h.ctx.db.query("INSERT INTO turns (id, chat_id, user_id, engine, status, message_id, user_message_id, client_kind, schedule_id, scheduled_for, queue_seq) VALUES (?, ?, 'alice', 'claude-code', 'queued', ?, ?, 'schedule', ?, 'x', 999999)").run(turn, chat, a, u, id)
    await h.rt().recover()
    expect(h.ctx.db.query('SELECT status FROM turns WHERE id = ?').get(turn)).toEqual({ status: 'stopped' })
  })
})

describe('"다시 확인": the same card, resuming is the confirmation', () => {
  test('the card: title, schedule, whole instruction, its addresses with random-looking parts marked; resume / keep', async () => {
    clear('alice')
    const id = legacy('alice', { enabled: 0 })
    h.rt().schedules.pauseForReview(row(id))
    const { request: r } = await reviewCard('alice', id)
    expect(r).toMatchObject({ kind: 'ask_user', origin: 'server', allowText: false, multiple: false })
    expect(r.question).toContain('made without its confirmation card')
    expect(r.question).toContain('Title: Morning digest')
    expect(r.question).toContain('Schedule: every day at 09:00')
    expect(r.question).toContain('opens the 1 addresses below without asking')
    expect(r.options!.map((o) => o.value)).toEqual(['resume', 'keep'])
    expect(r.details![0]).toMatchObject({ text: row(id).prompt, marks: ['c2fsyxj5ltk4nzy1ndmy'] })
    expect(r.details![1]!.text).toBe(secretUrl)
    // in the person's language (Korean: 해요체); a task nobody confirmed has the card even if the server never paused it
    clear('bob')
    const ko = (await reviewCard('bob', legacy('bob', { enabled: 0 }))).request
    expect(ko.question).toContain('확인 카드 없이 만들어져서 멈춰 뒀어요')
    expect(ko.question).toContain('일정: 매일 09:00')
    expect(ko.options!.map((o) => o.label)).toEqual(['다시 켜기', '계속 멈춰 두기'])
  })

  test('keep: nothing changes; a typed answer or a stale card is refused; another person gets 404', async () => {
    clear('alice')
    const id = legacy('alice', { enabled: 0 })
    const { request: r } = await reviewCard('alice', id)
    expect(await confirm('alice', id, r.requestId, 'keep')).toMatchObject({ enabled: false, needsReview: true })
    expect((await failure(confirm('alice', id, r.requestId, 'yes please'))).code).toBe('validation')
    const stale = await failure(confirm('alice', id, 'schedule-review-0000', 'resume'))
    expect(stale.code).toBe('conflict')
    expect(stale.body.params).toMatchObject({ reason: 'schedule_card_changed' })
    expect((await failure(reviewCard('bob', id))).code).toBe('not_found')
    expect((await failure(confirm('bob', id, r.requestId, 'resume'))).code).toBe('not_found')
    expect(row(id).confirmed_at).toBeNull()
  })

  test('resume: confirmed, on again, review cleared, audited; the run opens the addresses the card showed and nothing else', async () => {
    clear('alice')
    const id = legacy('alice', { enabled: 0, prompt: `Read ${secretUrl} and save a summary.` })
    h.rt().schedules.pauseForReview(row(id))
    const { request: r } = await reviewCard('alice', id)
    const s = await confirm('alice', id, r.requestId, 'resume')
    expect(s).toMatchObject({ enabled: true, needsReview: false, reviewSince: null })
    expect(row(id)).toMatchObject({ enabled: 1, review_since: null, allowed_urls: JSON.stringify([secretUrl]), write_connections: null })
    expect(row(id).confirmed_at).toBeTruthy()
    expect(row(id).next_run_at).toBeTruthy()
    expect(audits(id, 'schedule.reconfirmed')).toEqual([{ actor: 'alice', urls: 1, connections: 0 }])
    // answering again (another window): nothing more happens
    expect(await confirm('alice', id, r.requestId, 'resume')).toMatchObject({ enabled: true })
    expect(audits(id, 'schedule.reconfirmed')).toHaveLength(1)
    // the card's address opens in the run's chat without asking; another one does not
    h.ctx.db.query('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), id)
    expect(h.rt().schedules.runDue()).toEqual([id])
    const chat = row(id).last_chat_id!
    expect(await gateUrl(h.ctx.db, chat, secretUrl, null)).toBe('seen')
    expect(gateUrl(h.ctx.db, chat, 'https://feeds.attacker.example/r/other', null)).rejects.toThrow(/nobody can confirm/)
  })

  test('"allow" team connections: the card offers them; one that turned "allow" after the card was shown refuses the answer', async () => {
    clear('alice')
    const id = legacy('alice', { enabled: 0, prompt: 'Every morning post the summary of shared/notes to the team board.' })
    const conn = uuidv7()
    h.ctx.db.query("INSERT INTO integrations (id, scope, owner_user_id, kind, name, slug, url, auth, write_policy, status, created_at, updated_at) VALUES (?, 'team', NULL, 'mcp', 'Team board', 'board', 'https://board.example/mcp', 'none', 'ask', 'connected', 'x', 'x')").run(conn)
    h.ctx.db.query("INSERT INTO integration_access (integration_id, subject_type, subject_id) VALUES (?, 'everyone', '')").run(conn)
    try {
      const before = (await reviewCard('alice', id)).request
      expect(before.options!.map((o) => o.value)).toEqual(['resume', 'keep'])
      h.ctx.db.query("UPDATE integrations SET write_policy = 'allow', version = version + 1 WHERE id = ?").run(conn)
      const stale = await failure(confirm('alice', id, before.requestId, 'resume'))
      expect(stale.body.params).toMatchObject({ reason: 'schedule_card_changed' })
      // the same for an answer only the new card has
      expect((await failure(confirm('alice', id, before.requestId, 'resume_write'))).body.params).toMatchObject({ reason: 'schedule_card_changed' })
      const now = (await reviewCard('alice', id)).request
      expect(now.question).toContain('Team board')
      expect(now.options!.map((o) => o.value)).toEqual(['resume_write', 'resume', 'keep'])
      await confirm('alice', id, now.requestId, 'resume_write')
      expect(JSON.parse(row(id).write_connections!)).toEqual([conn])
    } finally { h.ctx.db.query('DELETE FROM integrations WHERE id = ?').run(conn) }
  })

  test('a one-time task whose time has passed cannot be resumed (it says why)', async () => {
    clear('alice')
    const id = legacy('alice', { enabled: 0, repeat: 'once', date: '2020-01-01' })
    const { request: r } = await reviewCard('alice', id)
    const e = await failure(confirm('alice', id, r.requestId, 'resume'))
    expect(e.body.params).toMatchObject({ reason: 'schedule_expired' })
    expect(row(id).confirmed_at).toBeNull()
  })

  test('a confirmed task has no card to show', async () => {
    clear('alice')
    const made = h.rt().schedules.create('alice', { title: 'ok', prompt: 'plain task', repeat: 'daily', time: '09:00' }, undefined, CONFIRMED)
    expect((await failure(reviewCard('alice', made.id))).body.params).toMatchObject({ reason: 'schedule_not_waiting' })
  })
})

describe('the owner is told; admins see what waits', () => {
  test('one notice per person and pause, in the app even with failure notices off; push follows the setting', async () => {
    clear('erin')
    await h.api('erin').call(API.updateNotificationPreferences, { body: { scheduleFailure: false } })
    try {
      const a = legacy('erin', { enabled: 0 }), b = legacy('erin', { enabled: 0, title: 'Other' })
      const at = new Date().toISOString()
      h.ctx.db.query('UPDATE schedules SET review_since = ? WHERE id IN (?, ?)').run(at, a, b)
      notificationsOf(h.ctx).reconcile('erin')
      notificationsOf(h.ctx).reconcile('erin')
      const items = (await h.api('erin').call(API.listNotifications, { query: {} })).items.filter((i) => i.review)
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({ eventType: 'schedule.failure', code: 'schedule.failure', review: true, chatId: null, link: null, outcome: null })
      // metadata only: the source names no task
      expect(items[0]!.sourceId).not.toContain(a)
      expect(JSON.stringify(items[0])).not.toContain('Morning digest')
      // OS push uses the person's "scheduled task failed" setting (push-service eligible / the service worker)
      const stored = h.ctx.db.query('SELECT event_type, suppressed FROM notification_inbox WHERE id = ?').get(items[0]!.id)
      expect(stored).toEqual({ event_type: 'schedule.failure', suppressed: 0 })
      expect(eventEnabled(notificationsOf(h.ctx).preferences('erin'), 'schedule.failure')).toBe(false)
      // confirming one leaves the notice as it was (no second one)
      const { request: r } = await reviewCard('erin', a)
      await confirm('erin', a, r.requestId, 'resume')
      notificationsOf(h.ctx).reconcile('erin')
      expect((await h.api('erin').call(API.listNotifications, { query: {} })).items.filter((i) => i.review)).toHaveLength(1)
    } finally { await h.api('erin').call(API.updateNotificationPreferences, { body: { scheduleFailure: true } }) }
  })

  test('admins list paused tasks with owner, schedule and time — never the title or instruction; members cannot', async () => {
    clear('alice')
    const id = legacy('alice', { enabled: 0, title: 'Private plans' })
    h.rt().schedules.pauseForReview(row(id))
    const r = await h.api('carol').call(API.listSchedulesAwaitingReview)
    const mine = r.items.find((s) => s.id === id)!
    expect(mine).toEqual({ id, user: { id: 'alice', name: 'Alice Kim' }, repeat: 'daily', time: '09:00', weekday: null, day: null, date: null, reviewSince: row(id).review_since })
    expect(JSON.stringify(r)).not.toContain('Private plans')
    expect(JSON.stringify(r)).not.toContain('attacker.example')
    expect((await failure(h.api('alice').call(API.listSchedulesAwaitingReview))).code).toBe('forbidden')
    // confirmed again: gone from the list
    const { request } = await reviewCard('alice', id)
    await confirm('alice', id, request.requestId, 'resume')
    expect((await h.api('carol').call(API.listSchedulesAwaitingReview)).items.some((s) => s.id === id)).toBe(false)
  })
})

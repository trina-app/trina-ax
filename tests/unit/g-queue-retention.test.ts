// Queue caps (L07): the in-memory turn queue and job queue cannot grow without end (429 + Retry-After; a scheduled run
// waits a minute). Retention (L08): the tables that grow with every turn are pruned hourly in batches. The nightly
// backup's start (L09): 03:00 in the team's zone, spread over 02:00–04:59 by install id on Team AX Cloud.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import path from 'node:path'
import { getChatRuntime, QUEUE_PER_USER, QUEUE_TEAM_MIN } from '../../server/src/chat/runtime'
import { HttpError } from '../../server/src/http/errors'
import { JOBS_PER_USER } from '../../server/src/jobs/service'
import { BATCH, pruneOld } from '../../server/src/system/retention'
import { installId, setSetting, updateTeamSettings } from '../../server/src/admin/settings'
import { OpsService } from '../../server/src/system/ops'
import { setPlanForTests, Plan } from '../../server/src/system/limits'
import { openDb } from '../../server/src/db'
import { harness, withOwner, addMember, type Client, type Harness } from './a-lib'
import { WORK } from '../lib/env'

const spec = (userId: string, i: number) => ({ turnId: `t-${userId}-${i}`, chatId: `c-${userId}-${i}`, userId, assistantId: `a-${i}`, userMessageId: `u-${i}`, windowId: null, clientKind: null, engine: 'claude-code', model: null, locale: 'en' })

describe('queue caps', () => {
  let h: Harness
  let owner: Client
  beforeAll(async () => { h = await harness('g-queue'); owner = await withOwner(h); await addMember(h, owner, { username: 'mina' }) })
  afterAll(() => h.close())

  test('one person: at most 3 waiting; the team: at most max(10, 4 × concurrency); 429 with Retry-After 30', () => {
    const rt = getChatRuntime(h.ctx)
    const q = (rt as unknown as { queued: unknown[] }).queued
    setSetting(h.ctx.db, 'concurrency', 1)
    for (let i = 0; i < QUEUE_PER_USER; i++) q.push(spec('olga', i))
    let e = (() => { try { rt.checkQueueRoom('olga', 'ko') } catch (x) { return x } })() as HttpError
    expect(e).toBeInstanceOf(HttpError)
    expect(e.status).toBe(429)
    expect(e.retryAfter).toBe(30)
    expect(e.extra.params).toEqual({ reason: 'queue_full_user' })
    expect(e.userMessage).toContain('3')
    expect(() => rt.checkQueueRoom('mina', 'ko')).not.toThrow()
    for (let i = 0; i < QUEUE_TEAM_MIN; i++) q.push(spec(`p${i}`, i))
    e = (() => { try { rt.checkQueueRoom('mina', 'en') } catch (x) { return x } })() as HttpError
    expect(e.extra.params).toEqual({ reason: 'queue_full' })
    // a higher concurrency lets more wait: 4 × 4 = 16 > 13
    setSetting(h.ctx.db, 'concurrency', 4)
    expect(() => rt.checkQueueRoom('mina', 'en')).not.toThrow()
    q.splice(0)
    setSetting(h.ctx.db, 'concurrency', 3)
  })
  test('a scheduled run that meets a full queue waits a minute (no empty chat is left), audited', () => {
    const rt = getChatRuntime(h.ctx)
    const q = (rt as unknown as { queued: unknown[] }).queued
    const s = rt.schedules.create('olga', { title: 'Digest', prompt: 'summarize', repeat: 'daily', time: '09:00' }, new Date(Date.now() - 2 * 86_400_000))
    for (let i = 0; i < QUEUE_PER_USER; i++) q.push(spec('olga', i))
    const now = new Date()
    const chatsBefore = (h.ctx.db.query('SELECT COUNT(*) AS n FROM chats').get() as { n: number }).n
    expect(rt.schedules.runDue(now)).toEqual([])
    const row = rt.schedules.get('olga', s.id)!
    expect(row.enabled).toBe(1)
    expect(row.next_run_at).toBe(s.next_run_at)
    expect(row.pending_due_at).toBe(s.next_run_at)
    expect(new Date(row.retry_at!).getTime()).toBe(now.getTime() + 60_000)
    expect((h.ctx.db.query('SELECT COUNT(*) AS n FROM chats').get() as { n: number }).n).toBe(chatsBefore)
    const a = h.ctx.db.query("SELECT target, detail FROM audit_log WHERE action = 'schedule.deferred'").get() as { target: string; detail: string }
    expect(a.target).toBe(s.id)
    expect(JSON.parse(a.detail).reason).toBe('queue_full_user')
    q.splice(0)
  })
  test('jobs: at most 5 waiting or running per person', async () => {
    const jobs = h.ctx.services.jobs!
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const ids = Array.from({ length: JOBS_PER_USER }, () => jobs.start({ kind: 'export', userId: 'olga', run: () => gate }))
    expect(ids.length).toBe(JOBS_PER_USER)
    let err: unknown
    try { jobs.start({ kind: 'export', userId: 'olga', run: async () => null }) } catch (e) { err = e }
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(429)
    expect((err as HttpError).extra.params).toEqual({ reason: 'jobs_full' })
    // someone else, and system work, are not affected
    expect(jobs.start({ kind: 'export', userId: 'mina', run: async () => null })).toBeTruthy()
    release()
    for (const id of ids) await (jobs as unknown as { wait(id: string): Promise<unknown> }).wait(id)
    expect(jobs.start({ kind: 'export', userId: 'olga', run: async () => null })).toBeTruthy()
  })
})

describe('retention sweep (L08)', () => {
  test('each table keeps what is inside its period; every chat keeps its last turn; batches of 5000', () => {
    const db = openDb(path.join(WORK, 'g-retention', `${Date.now()}.db`))
    const now = new Date('2026-10-22T00:00:00Z')
    const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString()
    db.query("INSERT INTO users (id, username, name, role) VALUES ('u', 'u', 'U', 'owner')").run()
    const tool = db.query("INSERT INTO tool_events (turn_id, user_id, tool, summary, ok, at) VALUES (NULL, 'u', 'read', 's', 1, ?)")
    db.transaction(() => { for (let i = 0; i < BATCH + 7; i++) tool.run(ago(91)) })()
    tool.run(ago(89))
    const fe = db.query("INSERT INTO file_events (turn_id, user_id, path, action, at) VALUES (NULL, 'u', 'a.md', 'create', ?)")
    fe.run(ago(366)); fe.run(ago(200))
    const turn = db.query("INSERT INTO turns (id, chat_id, user_id, engine, status, started_at, ended_at) VALUES (?, ?, 'u', 'claude-code', ?, ?, ?)")
    turn.run('0190-a-1', 'chat-a', 'done', ago(500), ago(500)) // old, not the chat's last: goes
    turn.run('0190-a-2', 'chat-a', 'done', ago(450), ago(450)) // old but the last of chat-a: stays
    turn.run('0190-b-1', 'chat-b', 'error', ago(401), null) // old (started), not last: goes
    turn.run('0190-b-2', 'chat-b', 'done', ago(10), ago(10))
    turn.run('0190-c-1', 'chat-c', 'running', ago(999), null) // not finished: stays
    turn.run('0190-c-2', 'chat-c', 'done', ago(5), ago(5))
    const pt = db.query("INSERT INTO proxy_tokens (token_hash, turn_id, user_id, expires_at, revoked_at) VALUES (?, 't', 'u', ?, ?)")
    pt.run('h1', ago(8), null); pt.run('h2', ago(1), null); pt.run('h3', now.toISOString(), ago(9)); pt.run('h4', now.toISOString(), null)
    const job = db.query("INSERT INTO jobs (id, user_id, kind, status, created_at, finished_at) VALUES (?, 'u', 'export', ?, ?, ?)")
    job.run('j1', 'done', ago(100), ago(91)); job.run('j2', 'failed', ago(10), ago(10)); job.run('j3', 'running', ago(200), null)

    const r = pruneOld(db, { now })
    expect(r).toEqual({ tool_events: BATCH + 7, file_events: 1, turns: 2, proxy_tokens: 2, jobs: 1 })
    expect((db.query('SELECT COUNT(*) AS n FROM tool_events').get() as { n: number }).n).toBe(1)
    expect((db.query('SELECT id FROM turns ORDER BY id').all() as { id: string }[]).map((x) => x.id)).toEqual(['0190-a-2', '0190-b-2', '0190-c-1', '0190-c-2'])
    expect((db.query('SELECT token_hash FROM proxy_tokens ORDER BY token_hash').all() as { token_hash: string }[]).map((x) => x.token_hash)).toEqual(['h2', 'h4'])
    expect((db.query('SELECT id FROM jobs ORDER BY id').all() as { id: string }[]).map((x) => x.id)).toEqual(['j2', 'j3'])
    // a longer audit retention keeps more (file events at least a year)
    setSetting(db, 'auditRetentionDays', 400)
    fe.run(ago(390))
    expect(pruneOld(db, { now }).file_events).toBe(0)
    // the migration's indexes are there
    const idx = (db.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((x) => x.name)
    for (const n of ['turns_ended', 'proxy_tokens_expires', 'proxy_tokens_revoked', 'jobs_finished', 'tool_events_at', 'file_events_at']) expect(idx).toContain(n)
    db.close()
  })
})

describe('nightly backup start (L09)', () => {
  let h: Harness
  beforeAll(async () => { h = await harness('g-backup-start'); await withOwner(h) })
  afterAll(() => { h.close(); setPlanForTests(undefined) })

  test('03:00 in the team\'s zone; on Team AX Cloud 02:00 + 0–179 min, fixed per install', () => {
    let now = new Date('2026-10-21T17:30:00Z') // 02:30 in Seoul, 17:30 in UTC
    const ops = new OpsService(h.ctx, { now: () => now, engines: async () => [] })
    // the last nightly backup 21 h ago: not due by age (20–30 h), so the time of day decides
    const last = () => [{ kind: 'daily', createdAt: new Date(now.getTime() - 21 * 3600_000).toISOString() }]
    ;(ops.backups as unknown as { metas: () => unknown[] }).metas = last
    expect(ops.backupStartMinute()).toBe(180)
    const fresh = () => ops.shouldRunDailyBackup()
    // updateTeamSettings drops the 60 s zone cache, like the PATCH route
    updateTeamSettings(h.ctx.db, { timeZone: 'UTC' })
    expect(fresh()).toBe(true) // 17:30 UTC is after 03:00
    updateTeamSettings(h.ctx.db, { timeZone: 'Asia/Seoul' })
    expect(fresh()).toBe(false) // 02:30 KST is before 03:00
    now = new Date('2026-10-21T18:05:00Z') // 03:05 KST
    expect(fresh()).toBe(true)
    h.ctx.config.deployment = 'hosted'
    try {
      const m = ops.backupStartMinute()
      expect(m).toBeGreaterThanOrEqual(120)
      expect(m).toBeLessThan(300)
      expect(ops.backupStartMinute()).toBe(m)
      // the window ax-hostd chose for this tenant (enroll.json -> /etc/default/mycel) wins; a bad value is ignored
      expect(ops.backupStartMinute({ MYCEL_BACKUP_WINDOW_START_MIN: '150' })).toBe(150)
      expect(ops.backupStartMinute({ MYCEL_BACKUP_WINDOW_START_MIN: '1440' })).toBe(m)
      expect(ops.backupStartMinute({ MYCEL_BACKUP_WINDOW_START_MIN: 'x' })).toBe(m)
      expect(installId(h.ctx.db)).toBe(installId(h.ctx.db))
      expect(installId(h.ctx.db, { MYCEL_INSTALL_ID: 'tenant-42' })).toBe('tenant-42')
    } finally { h.ctx.config.deployment = undefined }
    setPlanForTests(Plan.parse({ format: 1, plan: 'basic', maxConcurrency: 2, memoryMiB: 2048, cpuCores: 1, diskGiB: 20 }))
    expect(ops.backupStartMinute()).toBeGreaterThanOrEqual(120)
    setPlanForTests(undefined)
  })
})

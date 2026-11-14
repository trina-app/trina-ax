// F2 sleep facts of a hosted team server (server/src/system/activity.ts, cloud-tenant.ts cloudIdle): signed-in
// requests, open connections and running answers count as use; the next due schedule is reported in seconds; admin.js
// cloud-idle reads status.json and says "not sleepable" for a stale or old file; the idle-wait contract keeps its old
// form and parses the new fields.
import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { IdleWaitResult, TENANT_COMMANDS, tenantCommandArgv, tenantCommandProblem } from '@mycel/shared/cloud-protocol'
import { openDb } from '../../server/src/db'
import { ACTIVITY_SAVE_EVERY_MS, activityFacts, busyJobs, configureActivityStore, lastActivity, nextScheduleDue, PUSH_RETRY_TABLES, setLastActivity, sleepableBy, touchActivity } from '../../server/src/system/activity'
import { cloudIdle } from '../../server/src/system/cloud-tenant'
import { WORK } from '../lib/env'

const W = path.join(WORK, `f2-sleep-${process.pid}`)
afterEach(() => fs.rmSync(W, { recursive: true, force: true }))

function db() {
  fs.mkdirSync(W, { recursive: true })
  return openDb(path.join(W, `app-${Math.random().toString(36).slice(2)}.db`))
}
function insertSchedule(d: ReturnType<typeof db>, id: string, nextRunAt: string | null, enabled = 1) {
  const u = d.query("SELECT id FROM users LIMIT 1").get() as { id: string } | null
  const userId = u?.id ?? 'u1'
  if (!u) d.query("INSERT INTO users (id, username, name, password_hash, role, status) VALUES ('u1', 'owner', 'Owner', 'x', 'owner', 'active')").run()
  d.query(`INSERT INTO schedules (id, user_id, title, prompt, repeat, time, next_run_at, enabled) VALUES (?, ?, 't', 'p', 'daily', '09:00', ?, ?)`).run(id, userId, nextRunAt, enabled)
}

describe('activity clock', () => {
  test('touch moves the clock forward only; connections and answers count as use now', () => {
    const d = db()
    try {
      setLastActivity(1_000_000)
      touchActivity(900_000)
      expect(lastActivity()).toBe(1_000_000)
      expect(activityFacts({ db: d, connections: 0, busy: false, now: 1_600_000 })).toEqual({ connections: 0, idleForSec: 600, nextScheduleInSec: null })
      expect(activityFacts({ db: d, connections: 2, busy: false, now: 1_700_000 }).idleForSec).toBe(0)
      expect(activityFacts({ db: d, connections: 0, busy: true, now: 1_800_000 }).idleForSec).toBe(0)
      expect(activityFacts({ db: d, connections: 0, busy: false, now: 1_860_000 }).idleForSec).toBe(60)
    } finally { d.close() }
  })

  test('next schedule: the earliest enabled one, in seconds; a disabled one does not count', () => {
    const d = db()
    try {
      insertSchedule(d, 's1', '2026-10-31T10:00:00.000Z')
      insertSchedule(d, 's2', '2026-10-31T09:30:00.000Z', 0)
      expect(nextScheduleDue(d)).toBe(Date.parse('2026-10-31T10:00:00.000Z'))
      const f = activityFacts({ db: d, connections: 0, busy: false, now: Date.parse('2026-10-31T09:50:00.000Z') })
      expect(f.nextScheduleInSec).toBe(600)
      expect(sleepableBy(f, 0, 0)).toBe(false) // due within 15 minutes
      expect(sleepableBy({ ...f, nextScheduleInSec: 901 }, 0, 0)).toBe(true)
      expect(sleepableBy({ ...f, nextScheduleInSec: null }, 1, 0)).toBe(false)
      expect(sleepableBy({ ...f, nextScheduleInSec: null, connections: 1 }, 0, 0)).toBe(false)
    } finally { d.close() }
  })

  test('a push retry is due work; an expired or sent one is not', () => {
    const d = db()
    try {
      d.exec('PRAGMA foreign_keys = OFF')
      const ins = d.query(`INSERT INTO push_deliveries (notification_id, subscription_id, state, next_at, expires_at) VALUES (?, 's', ?, ?, ?)`)
      ins.run('n1', 'sent', '2026-10-31T10:01:00.000Z', '2026-11-01T00:00:00.000Z')
      ins.run('n2', 'pending', '2026-10-31T10:02:00.000Z', '2026-10-31T09:00:00.000Z')
      const now = Date.parse('2026-10-31T09:50:00.000Z')
      expect(nextScheduleDue(d, now)).toBeNull()
      ins.run('n3', 'pending', '2026-10-31T10:05:00.000Z', '2026-11-01T00:00:00.000Z')
      expect(activityFacts({ db: d, connections: 0, busy: false, now }).nextScheduleInSec).toBe(900)
    } finally { d.close() }
  })

  test('every push delivery queue is due work (room messages, handover, finished answers)', () => {
    const now = Date.parse('2026-10-31T09:50:00.000Z')
    for (const t of PUSH_RETRY_TABLES) {
      const d = db()
      try {
        d.exec('PRAGMA foreign_keys = OFF')
        expect(nextScheduleDue(d, now)).toBeNull()
        d.query(`INSERT INTO ${t} (notification_id, subscription_id, state, next_at, expires_at) VALUES ('n', 's', 'pending', '2026-10-31T10:00:00.000Z', '2026-11-01T00:00:00.000Z')`).run()
        expect(activityFacts({ db: d, connections: 0, busy: false, now }).nextScheduleInSec).toBe(600)
      } finally { d.close() }
    }
  })

  test('a dev environment job that waits or runs is use now; a dev environment server is not', () => {
    const d = db()
    try {
      d.exec('PRAGMA foreign_keys = OFF')
      setLastActivity(1_000_000)
      const ins = d.query(`INSERT INTO dev_env_runs (id, user_id, kind, name, root, state, started_at) VALUES (?, 'u', ?, ?, '/x', ?, '2026-10-31T09:00:00.000Z')`)
      ins.run('r1', 'server', 'web', 'running')
      ins.run('r2', 'job', 'job-1', 'ended')
      expect(busyJobs(d)).toBe(0)
      expect(activityFacts({ db: d, connections: 0, busy: false, now: 1_600_000 }).idleForSec).toBe(600)
      ins.run('r3', 'job', 'job-2', 'running')
      expect(busyJobs(d)).toBe(1)
      expect(activityFacts({ db: d, connections: 0, busy: false, now: 1_700_000 }).idleForSec).toBe(0)
      d.query(`UPDATE dev_env_runs SET state = 'waiting' WHERE id = 'r3'`).run()
      expect(busyJobs(d)).toBe(1)
    } finally { d.close() }
  })

  test('a queued or running background job is use now; a failed read fails closed', () => {
    const d = db()
    try {
      setLastActivity(1_000_000)
      d.query(`INSERT INTO jobs (id, kind, status) VALUES ('j1', 'export', 'done')`).run()
      expect(busyJobs(d)).toBe(0)
      expect(activityFacts({ db: d, connections: 0, busy: false, now: 1_600_000 }).idleForSec).toBe(600)
      d.query(`INSERT INTO jobs (id, kind, status) VALUES ('j2', 'transcribe', 'running')`).run()
      expect(busyJobs(d)).toBe(1)
      expect(activityFacts({ db: d, connections: 0, busy: false, now: 1_700_000 }).idleForSec).toBe(0)
      d.exec('DROP TABLE push_deliveries')
      expect(nextScheduleDue(d, 5_000)).toBe(5_000)
      expect(activityFacts({ db: d, connections: 0, busy: false, now: 1_800_000 }).nextScheduleInSec).toBe(0)
    } finally { d.close() }
  })
})

describe('admin.js cloud-idle (status.json)', () => {
  const statusFile = (dir: string, o: Record<string, unknown>) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({
      format: 1, writtenAt: '2026-10-31T12:00:00.000Z', version: '0.2.15', pid: 1, webUrl: 'https://a.example', localUrl: 'http://127.0.0.1:1',
      label: null, logsDir: null, connection: { mode: 'relay', state: 'connected', address: null, detail: null }, queue: { running: 0, queued: 0 },
      firewall: 'ok', sandbox: 'ok', lastBackupAt: null, overall: 'ok', problems: [], ...o,
    }))
  }
  const at = (s: number) => Date.parse('2026-10-31T12:00:00.000Z') + s * 1000

  test('fresh file: the age is added to the idle time and taken from the schedule time', () => {
    const dir = path.join(W, 'st1')
    statusFile(dir, { activity: { connections: 0, idleForSec: 1800, nextScheduleInSec: 3600 } })
    expect(cloudIdle({ statusDir: dir, now: at(30) })).toEqual({ fresh: true, connections: 0, idleForSec: 1830, nextScheduleInSec: 3570, queued: 0, sleepable: true })
  })
  test('not sleepable: an open connection, a queued answer, a schedule soon, a stale file, an older server', () => {
    const dir = path.join(W, 'st2')
    statusFile(dir, { activity: { connections: 1, idleForSec: 0, nextScheduleInSec: null } })
    expect(cloudIdle({ statusDir: dir, now: at(1) }).sleepable).toBe(false)
    statusFile(dir, { activity: { connections: 0, idleForSec: 4000, nextScheduleInSec: null }, queue: { running: 0, queued: 1 } })
    expect(cloudIdle({ statusDir: dir, now: at(1) }).sleepable).toBe(false)
    statusFile(dir, { activity: { connections: 0, idleForSec: 4000, nextScheduleInSec: 900 } })
    expect(cloudIdle({ statusDir: dir, now: at(1) }).sleepable).toBe(false)
    statusFile(dir, { activity: { connections: 0, idleForSec: 4000, nextScheduleInSec: null } })
    expect(cloudIdle({ statusDir: dir, now: at(1) }).sleepable).toBe(true)
    expect(cloudIdle({ statusDir: dir, now: at(181) })).toMatchObject({ fresh: false, sleepable: false })
    expect(cloudIdle({ statusDir: dir, now: at(-5) })).toMatchObject({ fresh: false, sleepable: false })
    statusFile(dir, {})
    expect(cloudIdle({ statusDir: dir, now: at(1) })).toMatchObject({ fresh: false, sleepable: false, idleForSec: null })
    expect(cloudIdle({ statusDir: path.join(W, 'none'), now: at(1) })).toMatchObject({ fresh: false, sleepable: false })
  })
})

describe('idle-wait contract (F2)', () => {
  test('old form unchanged; --activity is a flag; the output parses with and without the new fields', () => {
    expect(tenantCommandArgv('idle-wait', { max: 600 })).toEqual(['idle-wait', '--json', '--max', '600'])
    expect(tenantCommandArgv('idle-wait', { max: 0, activity: true })).toEqual(['idle-wait', '--json', '--activity', '--max', '0'])
    expect(tenantCommandProblem('idle-wait', { max: 0, activity: true }, null)).toBeNull()
    expect(tenantCommandProblem('idle-wait', { max: 0, activity: 'yes' }, null)).not.toBeNull()
    expect(TENANT_COMMANDS['idle-wait'].output.parse({ idle: true, running: 0 })).toEqual({ idle: true, running: 0 })
    expect(IdleWaitResult.parse({ idle: true, running: 0, sleepable: true, idleForSec: 10, connections: 0, nextScheduleInSec: null }).sleepable).toBe(true)
    expect(IdleWaitResult.safeParse({ idle: true, running: 0, idleForSec: -1 }).success).toBe(false)
  })
})

describe('the idle clock survives a restart (an EC2 trial wakes with a fresh boot)', () => {
  afterEach(() => configureActivityStore(null))
  test('the last use is saved at most once a minute and read back at start; a wake does not reset the idle time', () => {
    const d = db()
    const dir = path.join(W, 'status')
    const t0 = Date.parse('2026-11-14T01:00:00Z')
    configureActivityStore(dir, t0)
    setLastActivity(t0)
    touchActivity(t0 + 1000)
    activityFacts({ db: d, connections: 0, busy: false, now: t0 + ACTIVITY_SAVE_EVERY_MS + 1 })
    expect(Number(fs.readFileSync(path.join(dir, 'last-activity'), 'utf8'))).toBe(t0 + 1000)
    // not again within a minute
    touchActivity(t0 + 2000)
    activityFacts({ db: d, connections: 0, busy: false, now: t0 + ACTIVITY_SAVE_EVERY_MS + 2 })
    expect(Number(fs.readFileSync(path.join(dir, 'last-activity'), 'utf8'))).toBe(t0 + 1000)
    // the instance stops; 5 hours later it boots for a backup: the clock starts at the saved use, not at the boot
    const boot = t0 + 5 * 3600_000
    setLastActivity(boot)
    configureActivityStore(dir, boot)
    expect(lastActivity()).toBe(t0 + 1000)
    expect(activityFacts({ db: d, connections: 0, busy: false, now: boot + 1000 }).idleForSec).toBeGreaterThan(4 * 3600)
  })
  test('a saved time in the future (a clock that was ahead) is not trusted past now; no file: the clock starts now', () => {
    const dir = path.join(W, 'status2')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'last-activity'), String(Date.parse('2030-01-01T00:00:00Z')))
    const now = Date.parse('2026-11-14T01:00:00Z')
    configureActivityStore(dir, now)
    expect(lastActivity()).toBe(now)
    setLastActivity(now)
    configureActivityStore(path.join(W, 'none'), now + 5)
    expect(lastActivity()).toBe(now)
  })
})

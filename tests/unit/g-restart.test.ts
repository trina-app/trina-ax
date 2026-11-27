// Restart from Admin › System › Health (server/src/system/restart.ts, docs/decisions/20261127-restart.md) through the
// real app: who may, what is offered where (a supervisor for the server, an installed launcher that knows the request
// for the AI), every refusal, the limit (accepted requests in the audit log, every kind together), the wait for running
// answers with its own mark, "now" and "don't restart", the audit rows, the server's restart mark at the next start.
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { Hono } from 'hono'
import { uuidv7, type RestartStatus } from '@mycel/shared/api'
import { emptyAppState } from '@mycel/shared/install'
import { buildApp } from '../../server/src/app'
import type { AppConfig } from '../../server/src/app-config'
import { createContext, type AppContext } from '../../server/src/context'
import { openDb } from '../../server/src/db'
import type { AppEnv } from '../../server/src/http/env'
import { silentLogger } from '../../server/src/log'
import { ROUTE_MODULES, type RouteModule } from '../../server/src/routes'
import { getOps, getRestarts, systemTestHooks } from '../../server/src/routes/system'
import type { AuthInfo, SessionService } from '../../server/src/services'
import { noteRestarted, RESTART_GAP_MS } from '../../server/src/system/restart'
import { _resetUpdateWait, beginUpdateWait, updateWaiting } from '../../server/src/system/update-wait'
import { WORK } from '../lib/env'

setDefaultTimeout(30_000)

const BASE = path.join(WORK, 'g-restart')
fs.rmSync(BASE, { recursive: true, force: true })
fs.mkdirSync(BASE, { recursive: true })

const person = (id: string, role: 'owner' | 'admin' | 'member'): AuthInfo => ({ user: { id, username: id, name: id, role, locale: 'en', mustChangePassword: false }, session: { id: uuidv7(), client: 'web' }, via: 'cookie' })
const people: Record<string, AuthInfo> = { owner: person('olga', 'owner'), admin: person('ann', 'admin'), member: person('mia', 'member') }
const sessions: SessionService = {
  async resolve(req) { return people[req.headers.get('x-test-user') ?? ''] ?? null },
  async verifyPassword(_u, pw) { return pw === 'pw' },
  async verifyReauth(_u, _s, p) { return 'password' in p && p.password === 'pw' },
}
const sessionModule: RouteModule = { name: 'g-test-sessions', owner: 'A', init(ctx) { ctx.services.sessions = sessions }, register() {} }

// the fake supervisor and launcher: changed by the tests (the service keeps these objects)
const env: Record<string, string | undefined> = { MYCEL_SUPERVISOR_PID: '4242' }
const launcher = {
  ops: ['restart'] as string[] | undefined,
  answers: true,
  calls: 0,
  status: async (_sock: string) => ({ ops: launcher.ops }),
  restart: async (_sock: string) => { launcher.calls++; return launcher.answers ? { live: 1 } : null },
}
let running = 0
let restarts = 0

let ctx: AppContext
let app: Hono<AppEnv>
beforeAll(async () => {
  systemTestHooks.restart = () => { restarts++ }
  systemTestHooks.restartDeps = { env, launcher, sleep: () => Bun.sleep(10), waitMs: 60_000 }
  const dir = path.join(BASE, 'dev')
  const cfg: AppConfig = {
    mode: 'dev', configFile: null, listen: { host: '127.0.0.1', port: 19173 }, tls: null, publicOrigins: [],
    teamRoot: path.join(dir, 'team'), dataDir: path.join(dir, 'data'), logDir: null, logLevel: 'error',
    engine: { authMode: 'local-login', launcherSock: path.join(dir, 'launcher.sock') }, relay: { url: null, teamName: null }, update: { channel: 'stable', feedUrl: null },
    validateResponses: true, setupToken: null,
  }
  fs.mkdirSync(cfg.dataDir, { recursive: true })
  fs.mkdirSync(cfg.teamRoot, { recursive: true })
  const db = openDb(path.join(cfg.dataDir, 'app.db'))
  for (const [id, role] of [['olga', 'owner'], ['ann', 'admin'], ['mia', 'member']]) db.query('INSERT INTO users (id, username, name, role) VALUES (?, ?, ?, ?)').run(id, id, id, role)
  ctx = createContext({ config: cfg, db, log: silentLogger })
  app = await buildApp(ctx, [...ROUTE_MODULES, sessionModule])
  // the running answers (a count; the queue reads turns)
  const ops = getOps(ctx)!
  const queue = ops.queue.bind(ops)
  ops.queue = () => ({ ...queue(), running })
})
afterAll(async () => { await ctx.close(); systemTestHooks.restart = null; systemTestHooks.restartDeps = null; _resetUpdateWait() })
beforeEach(async () => {
  await getRestarts(ctx)!.settled()
  ctx.db.query("DELETE FROM audit_log WHERE action LIKE 'system.restart%'").run()
  running = 0; restarts = 0
  launcher.ops = ['restart']; launcher.answers = true; launcher.calls = 0
  env.MYCEL_SUPERVISOR_PID = '4242'
  _resetUpdateWait()
  fs.rmSync(path.join(ctx.config.dataDir, 'restore-pending.json'), { force: true })
})

const req = (p: string, init: RequestInit & { as?: keyof typeof people } = {}) => {
  const h = new Headers(init.headers)
  if (init.as) h.set('x-test-user', init.as)
  if (init.method && init.method !== 'GET') h.set('x-mycel-csrf', '1')
  if (init.body) h.set('content-type', 'application/json')
  return app.fetch(new Request('http://team.localhost' + p, { ...init, headers: h }), { ip: '10.0.0.9', via: 'test' })
}
const status = async (as: keyof typeof people = 'owner') => (await (await req('/api/admin/restart', { as })).json()) as RestartStatus
const start = (body: Record<string, unknown>, as: keyof typeof people = 'owner') => req('/api/admin/restart', { method: 'POST', as, body: JSON.stringify({ password: 'pw', ...body }) })
const errorOf = async (r: Response) => ((await r.json()) as { error: { code: string; message: string } }).error
const auditRows = (action: string) => ctx.db.query('SELECT actor_id, detail FROM audit_log WHERE action = ? ORDER BY id').all(action) as { actor_id: string | null; detail: string | null }[]
const pastRequest = (msAgo: number) => ctx.db.query("INSERT INTO audit_log (actor_id, action, detail, at) VALUES ('olga', 'system.restart_requested', '{}', ?)").run(new Date(Date.now() - msAgo).toISOString())

describe('who may', () => {
  test('owners and admins read and ask; members and signed-out people do not; the password is checked', async () => {
    expect((await req('/api/admin/restart')).status).toBe(401)
    expect((await req('/api/admin/restart', { as: 'member' })).status).toBe(403)
    expect((await req('/api/admin/restart', { as: 'admin' })).status).toBe(200)
    expect((await start({ what: 'ai', when: 'idle' }, 'member')).status).toBe(403)
    expect((await start({ what: 'ai', when: 'idle', password: 'wrong' })).status).toBe(403)
    expect(auditRows('system.restart_requested')).toHaveLength(0)
  })

  test('an admin: only when answers finish; "now" and skipping the wait are the owner\'s', async () => {
    expect((await status('admin')).now).toBe(false)
    expect((await status('owner')).now).toBe(true)
    const r = await start({ what: 'ai', when: 'now' }, 'admin')
    expect(r.status).toBe(403)
    expect((await errorOf(r)).message).toContain('Only the owner')
    running = 1
    expect((await start({ what: 'ai', when: 'idle' }, 'admin')).status).toBe(202)
    expect((await req('/api/admin/restart/now', { method: 'POST', as: 'admin', body: JSON.stringify({ password: 'pw' }) })).status).toBe(403)
    // an admin may call off their own
    expect((await status('admin')).waiting?.mayCancel).toBe(true)
    expect((await req('/api/admin/restart', { method: 'DELETE', as: 'admin' })).status).toBe(200)
    await getRestarts(ctx)!.settled()
    expect(launcher.calls).toBe(0)
  })

  test('"now" asks the owner\'s password again; an admin cannot call off the owner\'s restart', async () => {
    running = 1
    expect((await start({ what: 'ai', when: 'idle' })).status).toBe(202)
    expect((await status('admin')).waiting?.mayCancel).toBe(false)
    expect((await status('owner')).waiting?.mayCancel).toBe(true)
    const no = await req('/api/admin/restart', { method: 'DELETE', as: 'admin' })
    expect(no.status).toBe(403)
    expect((await errorOf(no)).message).toContain('Only the owner')
    expect(auditRows('system.restart_cancelled')).toHaveLength(0)
    expect((await req('/api/admin/restart/now', { method: 'POST', as: 'owner', body: '{}' })).status).toBe(400)
    expect((await req('/api/admin/restart/now', { method: 'POST', as: 'owner', body: JSON.stringify({ password: 'wrong' }) })).status).toBe(403)
    expect(launcher.calls).toBe(0)
    expect((await req('/api/admin/restart', { method: 'DELETE', as: 'owner' })).status).toBe(200)
    await getRestarts(ctx)!.settled()
    expect(launcher.calls).toBe(0)
  })
})

describe('what is offered', () => {
  test('the server option needs a supervisor (the bootstrap\'s MYCEL_SUPERVISOR_PID, or office mode)', async () => {
    expect((await status()).options.server).toBe(true)
    env.MYCEL_SUPERVISOR_PID = undefined
    expect((await status()).options.server).toBe(false)
    const r = await start({ what: 'server', when: 'now' })
    expect(r.status).toBe(409)
    expect(restarts).toBe(0)
    // office mode's supervisor (office.js run) starts the server again too
    const office = ctx.config.office
    ;(ctx.config as { office?: boolean }).office = true
    try { expect((await status()).options.server).toBe(true) } finally { (ctx.config as { office?: boolean }).office = office }
  })

  test('the AI option needs an installed launcher that lists the request', async () => {
    expect((await status()).options.ai).toBe(true)
    launcher.ops = undefined // an older launcher
    expect((await status()).options.ai).toBe(false)
    expect((await start({ what: 'ai', when: 'now' })).status).toBe(409)
  })
})

describe('refusals', () => {
  test('another maintenance task, an update, a restore prepared, an update being checked', async () => {
    const ops = getOps(ctx)!
    expect(ops.tryLock('backup')).toBe(true)
    try {
      expect((await status()).blocked).toContain('maintenance')
      expect((await start({ what: 'ai', when: 'now' })).status).toBe(409)
    } finally { ops.unlock() }

    beginUpdateWait(new Date(), new Date(Date.now() + 60_000))
    expect((await errorOf(await start({ what: 'ai', when: 'now' }))).message).toContain('update is under way')
    _resetUpdateWait()

    fs.writeFileSync(path.join(ctx.config.dataDir, 'restore-pending.json'), '{}')
    expect((await errorOf(await start({ what: 'server', when: 'now' }))).message).toContain('restore is prepared')
    fs.rmSync(path.join(ctx.config.dataDir, 'restore-pending.json'))

    // the bootstrap still checks this version (state.json pending / forward): an exit now counts towards a roll-back
    const readState = ops.updates.readState.bind(ops.updates)
    for (const k of ['pending', 'forward'] as const) {
      ops.updates.readState = () => ({ ...emptyAppState(), [k]: ctx.version })
      try { expect((await errorOf(await start({ what: 'server', when: 'now' }))).message).toContain('still being checked') } finally { ops.updates.readState = readState }
    }
    expect(auditRows('system.restart_requested')).toHaveLength(0)
    expect(restarts + launcher.calls).toBe(0)
  })
})

describe('the limit', () => {
  test('accepted requests of every kind count together: 2 minutes apart, 5 an hour; refusals do not count', async () => {
    expect((await start({ what: 'ai', when: 'now' })).status).toBe(202)
    await getRestarts(ctx)!.settled()
    // the other kind right after: too soon
    const soon = await start({ what: 'server', when: 'now' })
    expect(soon.status).toBe(429)
    expect((await errorOf(soon)).message).toContain('just restarted')
    expect(auditRows('system.restart_requested')).toHaveLength(1)
    // five in the last hour (each 2+ minutes apart)
    ctx.db.query("DELETE FROM audit_log WHERE action = 'system.restart_requested'").run()
    for (let i = 0; i < 5; i++) pastRequest(RESTART_GAP_MS + 60_000 + i * 10 * 60_000)
    const many = await start({ what: 'ai', when: 'now' })
    expect(many.status).toBe(429)
    expect((await errorOf(many)).message).toContain('several times')
    // older than an hour: free again
    ctx.db.query("UPDATE audit_log SET at = ? WHERE action = 'system.restart_requested'").run(new Date(Date.now() - 2 * 3600_000).toISOString())
    expect((await start({ what: 'ai', when: 'now' })).status).toBe(202)
  })
})

describe('the wait', () => {
  test('when answers finish: the count, its own mark (no "Update now anyway"), other maintenance says why, then the AI restarts', async () => {
    running = 2
    const r = await start({ what: 'ai', when: 'idle' })
    expect(r.status).toBe(202)
    const s = (await r.json()) as RestartStatus
    expect(s.waiting?.what).toBe('ai')
    expect(s.running).toBe(2)
    expect(JSON.stringify(s)).not.toContain('olga') // a count, never whose
    expect(updateWaiting()).toMatchObject({ kind: 'restart', skippable: false })
    // a backup asked meanwhile: the restart's words
    const b = await req('/api/admin/backup', { method: 'POST', as: 'owner', body: JSON.stringify({ scope: 'db' }) })
    expect(b.status).toBe(409)
    expect((await errorOf(b)).message).toContain('waiting for answers to finish so it can restart')
    // a second restart: already waiting
    expect((await errorOf(await start({ what: 'server', when: 'idle' }))).message).toContain('already waiting')
    await Bun.sleep(50)
    expect(launcher.calls).toBe(0)
    running = 0
    await getRestarts(ctx)!.settled()
    expect(launcher.calls).toBe(1)
    expect(updateWaiting()).toBeNull()
    expect(getOps(ctx)!.busyWith).toBeNull()
    const after = await status()
    expect(after.waiting).toBeNull()
    expect(after.last?.what).toBe('ai')
    expect(auditRows('system.restart_requested').map((x) => JSON.parse(x.detail!))).toEqual([{ what: 'ai', when: 'idle' }])
    expect(auditRows('system.restarted').map((x) => [x.actor_id, JSON.parse(x.detail!).what])).toEqual([['olga', 'ai']])
  })

  test('"now" ends the wait; "don\'t restart" calls it off and frees the lock', async () => {
    running = 1
    await start({ what: 'ai', when: 'idle' })
    expect((await req('/api/admin/restart/now', { method: 'POST', as: 'owner', body: JSON.stringify({ password: 'pw' }) })).status).toBe(200)
    await getRestarts(ctx)!.settled()
    expect(launcher.calls).toBe(1)

    ctx.db.query("DELETE FROM audit_log WHERE action LIKE 'system.restart%'").run()
    await start({ what: 'server', when: 'idle' })
    const c = await req('/api/admin/restart', { method: 'DELETE', as: 'owner' })
    expect(c.status).toBe(200)
    await getRestarts(ctx)!.settled()
    expect(restarts).toBe(0)
    expect(getOps(ctx)!.busyWith).toBeNull()
    expect(updateWaiting()).toBeNull()
    expect(auditRows('system.restart_cancelled')).toHaveLength(1)
    // nothing waits: both say so
    expect((await req('/api/admin/restart', { method: 'DELETE', as: 'owner' })).status).toBe(409)
    expect((await req('/api/admin/restart/now', { method: 'POST', as: 'owner', body: JSON.stringify({ password: 'pw' }) })).status).toBe(409)
  })

  test('the wait ends at its limit even when answers still run', async () => {
    const svc = getRestarts(ctx)! as unknown as { d: { waitMs?: number } }
    svc.d.waitMs = 100
    try {
      running = 3
      await start({ what: 'ai', when: 'idle' })
      await getRestarts(ctx)!.settled()
      expect(launcher.calls).toBe(1)
    } finally { svc.d.waitMs = 60_000 }
  })
})

describe('restarting', () => {
  test('the server: its mark, the planned restart, and at the next start the audit row', async () => {
    const r = await start({ what: 'server', when: 'now' })
    expect(r.status).toBe(202)
    await getRestarts(ctx)!.settled()
    expect(restarts).toBe(1)
    // it goes: no "now" or "don't restart" any more
    expect(((await r.json()) as RestartStatus).waiting?.going).toBe(true)
    expect((await req('/api/admin/restart', { method: 'DELETE', as: 'owner' })).status).toBe(409)
    expect(auditRows('system.restart_cancelled')).toHaveLength(0)
    const mark = path.join(ctx.config.dataDir, 'restart.json')
    expect(JSON.parse(fs.readFileSync(mark, 'utf8'))).toMatchObject({ what: 'server', by: 'olga' })
    // the update-wait mark stays until the exit (scheduled runs do not start in between)
    expect(updateWaiting()).toMatchObject({ kind: 'restart' })
    noteRestarted(ctx)
    expect(fs.existsSync(mark)).toBe(false)
    expect(auditRows('system.restarted').map((x) => [x.actor_id, JSON.parse(x.detail!).what])).toEqual([['olga', 'server']])
    // the test's server did not exit: free the lock and the marks it holds until then
    getRestarts(ctx)!._afterServerRestart()
    expect(getOps(ctx)!.busyWith).toBeNull()
  })

  test('a launcher that does not answer: said once, the lock freed', async () => {
    launcher.answers = false
    await start({ what: 'ai', when: 'now' })
    await getRestarts(ctx)!.settled()
    const s = await status()
    expect(s.failed?.what).toBe('ai')
    expect(getOps(ctx)!.busyWith).toBeNull()
    expect(auditRows('system.restarted')).toHaveLength(0)
  })

  test('the watchdog gave up (state.json liveness): the status says so', async () => {
    const ops = getOps(ctx)!
    const readState = ops.updates.readState.bind(ops.updates)
    ops.updates.readState = () => ({ ...emptyAppState(), liveness: { gaveUp: true, since: '2026-11-27T01:00:00.000Z', detail: 'x' } })
    try { expect((await status()).watchdogGaveUp).toEqual({ since: '2026-11-27T01:00:00.000Z' }) } finally { ops.updates.readState = readState }
    expect((await status()).watchdogGaveUp).toBeNull()
  })
})

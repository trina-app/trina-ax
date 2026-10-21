// Component G: the SYSTEM endpoints through the real app (auth levels, jobs, files they produce), diagnostics in dev
// and in an installed (prod) layout, the menubar status file.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import type { Hono } from 'hono'
import { uuidv7, type Diagnostics, type Job } from '@mycel/shared/api'
import { StatusFile } from '@mycel/shared/install'
import { buildApp } from '../../server/src/app'
import type { AppConfig } from '../../server/src/app-config'
import { createContext, type AppContext } from '../../server/src/context'
import { openDb } from '../../server/src/db'
import type { AppEnv } from '../../server/src/http/env'
import { silentLogger } from '../../server/src/log'
import { ROUTE_MODULES, type RouteModule } from '../../server/src/routes'
import { setSetting } from '../../server/src/admin/settings'
import { getOps, systemTestHooks } from '../../server/src/routes/system'
import type { AuthInfo, SessionService } from '../../server/src/services'
import { jobFromRow } from '../../server/src/system/job-runner'
import { resolveLayout } from '../../server/src/system/layout'
import { OpsService } from '../../server/src/system/ops'
import { stepText, uptimeText } from '../../server/src/system/messages'
import { WORK } from '../lib/env'

const BASE = path.join(WORK, 'g-routes')
fs.rmSync(BASE, { recursive: true, force: true })
fs.mkdirSync(BASE, { recursive: true })

const people: Record<string, AuthInfo> = {
  owner: { user: { id: 'olga', username: 'olga', name: 'Olga', role: 'owner', locale: 'ko', mustChangePassword: false }, session: { id: uuidv7(), client: 'web' }, via: 'cookie' },
  ownerEn: { user: { id: 'olga', username: 'olga', name: 'Olga', role: 'owner', locale: 'en', mustChangePassword: false }, session: { id: uuidv7(), client: 'web' }, via: 'cookie' },
  admin: { user: { id: 'ann', username: 'ann', name: 'Ann', role: 'admin', locale: 'ko', mustChangePassword: false }, session: { id: uuidv7(), client: 'web' }, via: 'cookie' },
}
const sessions: SessionService = {
  async resolve(req) { return people[req.headers.get('x-test-user') ?? ''] ?? null },
  async verifyPassword(_u, pw) { return pw === 'owner-pass' },
}
const sessionModule: RouteModule = { name: 'g-test-sessions', owner: 'A', init(ctx) { ctx.services.sessions = sessions }, register() {} }

function config(dir: string, over: Partial<AppConfig> = {}): AppConfig {
  return {
    mode: 'dev', configFile: null, listen: { host: '127.0.0.1', port: 19172 }, tls: null, publicOrigins: [],
    teamRoot: path.join(dir, 'team'), dataDir: path.join(dir, 'data'), logDir: null, logLevel: 'error',
    engine: { authMode: 'local-login' }, relay: { url: null, teamName: null }, update: { channel: 'stable', feedUrl: null },
    validateResponses: true, setupToken: null, ...over,
  }
}

async function makeApp(cfg: AppConfig) {
  fs.mkdirSync(cfg.dataDir, { recursive: true })
  fs.mkdirSync(cfg.teamRoot, { recursive: true })
  const db = openDb(path.join(cfg.dataDir, 'app.db'))
  db.query("INSERT INTO users (id, username, name, role) VALUES ('olga', 'olga', 'Olga', 'owner')").run()
  const ctx = createContext({ config: cfg, db, log: silentLogger })
  // test sessions last: init() runs in order, so they replace A's real session service
  const app = await buildApp(ctx, [...ROUTE_MODULES, sessionModule])
  return { ctx, app }
}

let ctx: AppContext
let app: Hono<AppEnv>
let restarts = 0
beforeAll(async () => {
  systemTestHooks.opsOptions = { engines: async () => [{ engine: 'claude-code', installed: true, loggedIn: true, method: 'claude.ai', reason: null }, { engine: 'codex', installed: false, loggedIn: null, method: null, reason: 'not_installed' }] }
  systemTestHooks.restart = () => { restarts++ }
  const cfg = config(path.join(BASE, 'dev'), { configFile: path.join(BASE, 'dev', 'server.json') })
  fs.mkdirSync(path.join(BASE, 'dev'), { recursive: true })
  fs.writeFileSync(cfg.configFile!, JSON.stringify({ listen: { port: 19172 } }))
  ;({ ctx, app } = await makeApp(cfg))
  fs.mkdirSync(path.join(cfg.teamRoot, 'shared'), { recursive: true })
  fs.writeFileSync(path.join(cfg.teamRoot, 'shared', 'a.md'), 'hello')
})
afterAll(async () => { await ctx.close(); systemTestHooks.opsOptions = null; systemTestHooks.restart = null })

const req = (p: string, init: RequestInit & { as?: keyof typeof people } = {}, a = app) => {
  const h = new Headers(init.headers)
  if (init.as) h.set('x-test-user', init.as)
  if (init.method && init.method !== 'GET') h.set('x-mycel-csrf', '1')
  if (init.body) h.set('content-type', 'application/json')
  return a.fetch(new Request('http://team.localhost' + p, { ...init, headers: h }), { ip: '10.0.0.9', via: 'test' })
}
const post = (p: string, body: unknown, as: keyof typeof people = 'owner', method = 'POST') => req(p, { method, body: JSON.stringify(body), as })

async function waitJob(c: AppContext, id: string): Promise<Job> {
  for (let i = 0; i < 300; i++) {
    const r = c.db.query('SELECT id, kind, status, progress, message, result, error, created_at, finished_at FROM jobs WHERE id = ?').get(id) as Parameters<typeof jobFromRow>[0] | null
    if (r && (r.status === 'done' || r.status === 'failed' || r.status === 'canceled')) return jobFromRow(r)
    await Bun.sleep(50)
  }
  throw new Error('job did not finish')
}

describe('auth levels', () => {
  test('everything but health is owner-only; update / restore / connection change ask for the password again', async () => {
    expect((await req('/api/health')).status).toBe(200)
    expect((await req('/api/admin/diagnostics')).status).toBe(401)
    expect((await req('/api/admin/diagnostics', { as: 'admin' })).status).toBe(403)
    expect((await req('/api/admin/backups', { as: 'admin' })).status).toBe(403)
    expect((await post('/api/admin/restore', { backupId: 'x', password: 'wrong' })).status).toBe(403)
    expect((await post('/api/admin/update', { password: 'wrong' })).status).toBe(403)
    expect((await post('/api/admin/connection', { mode: 'direct-only', password: 'wrong' }, 'owner', 'PUT')).status).toBe(403)
  })
})

describe('job progress wording', () => {
  test('step ids become words; numbers are kept; unknown text passes through', () => {
    expect(stepText('ko', 'team folder')).toBe('팀 폴더 보관 중')
    expect(stepText('en', 'download')).toBe('Downloading the new version')
    expect(stepText('id', 'archive 3/7')).toBe('Memulihkan folder tim (3/7)')
    expect(stepText('ko', '진행 중인 답변 1개가 끝나기를 기다리는 중')).toBe('진행 중인 답변 1개가 끝나기를 기다리는 중')
    expect(stepText('ko', null)).toBeNull()
  })
})

describe('uptime wording', () => {
  test('days / hours / minutes in each language', () => {
    expect(uptimeText(59, 'ko')).toBe('0분')
    expect(uptimeText(3 * 3600 + 120, 'ko')).toBe('3시간 2분')
    expect(uptimeText(2 * 86400 + 5 * 3600, 'id')).toBe('2 hari 5 jam')
    expect(uptimeText(600, 'en')).toBe('10 min')
  })
})

describe('diagnostics (dev)', () => {
  test('checks with localized details; OS controls are reported as not used in dev', async () => {
    const r = await req('/api/admin/diagnostics', { as: 'owner' })
    expect(r.status).toBe(200)
    const d = (await r.json()) as Diagnostics
    const ids = d.checks.map((c) => c.id)
    for (const id of ['server', 'relay', 'disk.team', 'disk.data', 'engine.claude-code', 'engine.codex', 'queue', 'pf_anchor', 'sandbox', 'backups', 'update']) expect(ids).toContain(id)
    expect(d.checks.find((c) => c.id === 'pf_anchor')!.status).toBe('unknown')
    expect(d.checks.find((c) => c.id === 'engine.claude-code')!.status).toBe('ok')
    expect(d.checks.find((c) => c.id === 'relay')!.detail).toContain('중계')
    const en = (await (await req('/api/admin/diagnostics', { as: 'ownerEn' })).json()) as Diagnostics
    expect(en.checks.find((c) => c.id === 'relay')!.detail).toContain('relay')
    // written for the owner: uptime in their words, and the place to fix it named as the screen names it
    expect(d.checks.find((c) => c.id === 'server')!.detail).toMatch(/\d+분 동안 실행 중/)
    expect(en.checks.find((c) => c.id === 'server')!.detail).toMatch(/running for \d+ min/)
    expect(d.checks.find((c) => c.id === 'relay')!.detail).toContain('관리자 > 시스템 > 연결')
    expect(d.disk.teamFolderFreeBytes).toBeGreaterThan(0)
  })

  test('the menubar status file is written at start and has no private data', async () => {
    const f = path.join(path.dirname(ctx.config.dataDir), 'status', 'status.json')
    for (let i = 0; i < 50 && !fs.existsSync(f); i++) await Bun.sleep(50)
    const s = StatusFile.parse(JSON.parse(fs.readFileSync(f, 'utf8')))
    expect(s.version).toBe(ctx.version)
    expect(s.webUrl).toBe('http://127.0.0.1:19172')
    expect(fs.statSync(f).mode & 0o777).toBe(0o640)
    expect(JSON.stringify(s)).not.toContain('olga')
  })
})

describe('backup, restore, export jobs', () => {
  test('backup now → listed; second request while one runs is refused', async () => {
    const r = await post('/api/admin/backup', { scope: 'full' })
    expect(r.status).toBe(202)
    const { jobId } = (await r.json()) as { jobId: string }
    expect((await post('/api/admin/backup', { scope: 'db' })).status).toBe(409)
    const job = await waitJob(ctx, jobId)
    expect(job.status).toBe('done')
    expect(job.result).toMatchObject({ backupId: expect.stringMatching(/-manual$/) })
    // the progress line under the button is words in the owner's language, not the worker's step id ("done")
    expect(job.message).toBe('마무리 중')
    const list = (await (await req('/api/admin/backups', { as: 'owner' })).json()) as { items: { id: string; scope: string }[] }
    expect(list.items[0]).toMatchObject({ scope: 'full' })
  })

  test('restore: unknown id 404; a known one is staged for the next start (dev: no automatic restart)', async () => {
    expect((await post('/api/admin/restore', { backupId: '20990101T000000Z-manual', password: 'owner-pass' })).status).toBe(404)
    const id = getOps(ctx)!.backups.list()[0]!.id
    const r = await post('/api/admin/restore', { backupId: id, password: 'owner-pass' })
    expect(r.status).toBe(202)
    const job = await waitJob(ctx, ((await r.json()) as { jobId: string }).jobId)
    expect(job.status).toBe('done')
    expect(job.result).toMatchObject({ backupId: id })
    expect(job.message).toContain('다시 시작')
    expect(fs.existsSync(path.join(ctx.config.dataDir, 'restore-pending.json'))).toBe(true)
    expect(restarts).toBe(0)
    fs.rmSync(path.join(ctx.config.dataDir, 'restore-pending.json'))
  })

  test('export with a password lands in the owner\'s exports folder', async () => {
    const r = await post('/api/admin/export', { what: ['memories', 'files'], password: 'export-pass' })
    expect(r.status).toBe(202)
    const job = await waitJob(ctx, ((await r.json()) as { jobId: string }).jobId)
    expect(job.status).toBe('done')
    const res = job.result as { path: string; size: number }
    expect(res.path).toMatch(/^users\/olga\/exports\/.+\.age$/)
    expect(fs.statSync(path.join(ctx.config.teamRoot, res.path)).size).toBe(res.size)
    expect((await post('/api/admin/export', { what: [] })).status).toBe(400)
    expect((await post('/api/admin/export', { what: ['files'], password: 'short' })).status).toBe(400)
  })
})

describe('update and connection', () => {
  test('dev server: update status works, starting an update is refused with a reason', async () => {
    const s = await (await req('/api/admin/update', { as: 'owner' })).json()
    expect(s).toMatchObject({ current: ctx.version, available: null, previous: null })
    const r = await post('/api/admin/update', { password: 'owner-pass' })
    expect(r.status).toBe(409)
    expect(((await r.json()) as { error: { message: string } }).error.message).toContain('설치된 서버')
  })

  test('connection mode: read, change (stored in server.json), unsupported modes refused', async () => {
    const s = await (await req('/api/admin/connection', { as: 'owner' })).json()
    expect(s).toMatchObject({ mode: 'direct-only', state: 'disabled', direct: { enabled: false } })
    expect((await post('/api/admin/connection', { mode: 'tailscale', password: 'owner-pass' }, 'owner', 'PUT')).status).toBe(409)
    expect((await post('/api/admin/connection', { mode: 'self-relay', password: 'owner-pass' }, 'owner', 'PUT')).status).toBe(400)
    const plain = await post('/api/admin/connection', { mode: 'self-relay', relayUrl: 'http://plain.example/x', password: 'owner-pass' }, 'owner', 'PUT')
    expect(plain.status).toBe(400)
    expect(((await plain.json()) as { error: { message: string } }).error.message).toContain('자체 중계 서버 주소') // in the user's language
    const r = await post('/api/admin/connection', { mode: 'self-relay', relayUrl: 'wss://relay.example.org/connect', password: 'owner-pass' }, 'owner', 'PUT')
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ mode: 'self-relay', state: 'connecting' })
    expect(JSON.parse(fs.readFileSync(ctx.config.configFile!, 'utf8'))).toMatchObject({ listen: { port: 19172 }, relay: { url: 'wss://relay.example.org/connect' } })
  })
})

describe('diagnostics in an installed layout', () => {
  test('pf status, sandbox profile, launcher socket, Time Machine, release signature', async () => {
    const dir = path.join(BASE, 'prod')
    const base = path.join(dir, 'base')
    for (const d of ['root', 'status', 'run', 'secrets', 'agent', 'app/versions/1.0.0', 'ld']) fs.mkdirSync(path.join(base, d), { recursive: true })
    fs.symlinkSync('versions/1.0.0', path.join(base, 'app', 'current'))
    fs.writeFileSync(path.join(base, 'root', 'pf.anchor'), 'block drop out quick user _x\n')
    fs.writeFileSync(path.join(base, 'root', 'engine.sb'), '(version 1)')
    fs.writeFileSync(path.join(base, 'ld', 'app.treesoop.base.launcher.plist'), '<string>--sandbox-profile</string>')
    const sock = path.join(dir, 'l.sock')
    const srv = net.createServer((c) => c.end()).listen(sock)
    const me = Bun.spawnSync(['/usr/bin/id', '-un']).stdout.toString().trim()
    fs.mkdirSync(path.join(base, 'at'), { recursive: true })
    fs.writeFileSync(path.join(base, 'at', 'cron.deny'), `Guest\n${me}\n`)
    fs.writeFileSync(path.join(base, 'at', 'at.deny'), '')
    const cfg = config(dir, { mode: 'prod', engine: { authMode: 'local-login', launcherSock: sock, agentUid: process.getuid!() }, configFile: path.join(base, 'config', 'server.json') })
    const db = openDb(path.join(dir, 'app.db'))
    fs.mkdirSync(cfg.teamRoot, { recursive: true })
    const c2 = createContext({ config: cfg, db, log: silentLogger })
    let pfAt = new Date().toISOString()
    // pf-load (root) writes run/pf.json; a pf.json in status/ (a folder the server account owns) is not trusted
    fs.writeFileSync(path.join(base, 'status', 'pf.json'), JSON.stringify({ format: 1, at: new Date().toISOString(), enabled: true, anchor: 'x', rules: 9, referenced: true }))
    const writePf = (o: object) => fs.writeFileSync(path.join(base, 'run', 'pf.json'), JSON.stringify({ format: 1, at: pfAt, enabled: true, anchor: 'com.apple/250.x', rules: 4, referenced: true, ...o }))
    const layout = { ...resolveLayout(cfg, { MYCEL_INSTALL_BASE: base, MYCEL_LAUNCHDAEMONS_DIR: path.join(base, 'ld') }) }
    expect(layout.label).toBe('app.treesoop.base')
    const ops = new OpsService(c2, { layout, engines: async () => [], tmutil: async (p) => p.endsWith('secrets'), atDir: path.join(base, 'at') })
    const get = async (id: string) => (await ops.diagnostics('ko')).checks.find((x) => x.id === id)!
    expect(layout.pfStatusFile).toBe(path.join(base, 'run', 'pf.json'))
    expect((await get('pf_anchor')).status).toBe('fail') // only status/pf.json so far
    writePf({})
    expect((await get('pf_anchor')).status).toBe('ok')
    expect((await get('sandbox')).status).toBe('ok')
    expect((await get('launcher')).status).toBe('ok')
    expect((await get('time_machine')).status).toBe('warn') // agent/ not excluded in this fake
    expect((await get('release_signature')).status).toBe('warn') // no manifest.sig: unsigned test build
    expect((await get('cron_deny')).status).toBe('warn') // listed in cron.deny but not in at.deny
    fs.writeFileSync(path.join(base, 'at', 'at.deny'), `${me}\n`)
    expect((await get('cron_deny')).status).toBe('ok')
    writePf({ enabled: false })
    expect((await get('pf_anchor')).status).toBe('fail')
    pfAt = new Date(Date.now() - 20 * 60_000).toISOString()
    writePf({})
    expect((await get('pf_anchor')).detail).toContain('15분')
    fs.writeFileSync(path.join(base, 'ld', 'app.treesoop.base.launcher.plist'), '<string>--listen</string>')
    expect((await get('sandbox')).status).toBe('fail')
    srv.close()
    expect((await get('launcher')).status).toBe('fail')
    // the status file summarises it for the menubar
    const s = await ops.statusFile()
    expect(s.overall).toBe('fail')
    expect(s.firewall).toBe('fail')
    // in the team's default language: English until a team default is set, then that one
    expect(s.locale).toBe('en')
    expect(s.problems.some((p) => p.includes('sandbox'))).toBe(true)
    setSetting(db, 'defaultLocale', 'ko')
    const ko = await ops.statusFile()
    expect(ko.locale).toBe('ko')
    expect(ko.problems.some((p) => p.includes('샌드박스'))).toBe(true)
    await c2.close()
    db.close()
  })
})

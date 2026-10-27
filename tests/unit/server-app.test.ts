// HTTP foundation: middleware order, auth levels, CSRF, validation, error shape, response checks, route registry,
// migration runner, config loading, logging.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { Hono } from 'hono'
import { IN_APP_BROWSER_UA_MARK } from '@mycel/shared'
import { API, ApiClient, ApiError, endpoint, multipart, binary, empty, listEndpoints, uuidv7, type Endpoint } from '@mycel/shared/api'
import { buildApp } from '../../server/src/app'
import { ConfigError, loadAppConfig, type AppConfig } from '../../server/src/app-config'
import { createContext, type AppContext } from '../../server/src/context'
import { SchemaTooNewError, openDb, readMigrations } from '../../server/src/db'
import type { AppEnv } from '../../server/src/http/env'
import { fail } from '../../server/src/http/errors'
import { createLogger, silentLogger } from '../../server/src/log'
import { ROUTE_MODULES, type RouteModule } from '../../server/src/routes'
import type { RouteKit } from '../../server/src/http/route'
import type { AuthInfo, SessionService } from '../../server/src/services'
import { WORK } from '../lib/env'
import { PRODUCT } from '@mycel/shared'

const BASE = path.join(WORK, 'server-app')
fs.rmSync(BASE, { recursive: true, force: true })
fs.mkdirSync(BASE, { recursive: true })

function testConfig(over: Partial<AppConfig> = {}): AppConfig {
  const dir = fs.mkdtempSync(path.join(BASE, 'cfg-'))
  return {
    mode: 'dev', configFile: null, listen: { host: '127.0.0.1', port: 0 }, tls: null, publicOrigins: ['https://acme.treesoop.com'],
    teamRoot: path.join(dir, 'team'), dataDir: path.join(dir, 'data'), logDir: null, logLevel: 'error',
    engine: { authMode: 'local-login' }, relay: { url: null, teamName: null }, update: { channel: 'stable', feedUrl: null },
    validateResponses: true, setupToken: null, ...over,
  }
}

const people: Record<string, AuthInfo> = {
  member: { user: { id: 'bob', username: 'bob', name: 'Bob', role: 'member', locale: 'en', mustChangePassword: false }, session: { id: uuidv7(), client: 'web' }, via: 'cookie' },
  admin: { user: { id: 'ann', username: 'ann', name: 'Ann', role: 'admin', locale: 'ko', mustChangePassword: false }, session: { id: uuidv7(), client: 'web' }, via: 'cookie' },
  owner: { user: { id: 'olga', username: 'olga', name: 'Olga', role: 'owner', locale: 'ko', mustChangePassword: false }, session: { id: uuidv7(), client: 'web' }, via: 'cookie' },
  fresh: { user: { id: 'fred', username: 'fred', name: 'Fred', role: 'member', locale: 'ko', mustChangePassword: true }, session: { id: uuidv7(), client: 'web' }, via: 'cookie' },
  mobile: { user: { id: 'mia', username: 'mia', name: 'Mia', role: 'member', locale: 'id', mustChangePassword: false }, session: { id: uuidv7(), client: 'mobile' }, via: 'bearer' },
}
/** test session service: header "x-test-user: <key>" */
const fakeSessions: SessionService = {
  async resolve(req) { return people[req.headers.get('x-test-user') ?? ''] ?? null },
  async verifyPassword(_u, pw) { return pw === 'correct horse' },
}

// test-only endpoints exercising every RouteKit feature
const T = {
  echo: endpoint({ method: 'POST', path: '/api/test/echo/:id', auth: 'user', owner: 'B', query: z.object({ n: z.coerce.number().int().max(10) }), body: z.object({ name: z.string().min(2) }), response: z.object({ id: z.string(), n: z.number(), name: z.string(), ip: z.string().nullable() }), summary: 'echo test' }),
  adminOnly: endpoint({ method: 'GET', path: '/api/test/admin', auth: 'admin', owner: 'A', response: z.object({ ok: z.boolean() }), summary: 'admin test' }),
  ownerOnly: endpoint({ method: 'GET', path: '/api/test/owner', auth: 'owner', owner: 'A', response: z.object({ ok: z.boolean() }), summary: 'owner test' }),
  reauth: endpoint({ method: 'POST', path: '/api/test/reauth', auth: 'owner-reauth', owner: 'G', body: z.object({ password: z.string() }), response: empty, status: 204, summary: 'reauth test' }),
  badResponse: endpoint({ method: 'GET', path: '/api/test/bad', auth: 'public', owner: 'G', response: z.object({ n: z.number() }), summary: 'returns off-contract data' }),
  boom: endpoint({ method: 'GET', path: '/api/test/boom', auth: 'public', owner: 'G', response: z.object({}), summary: 'throws' }),
  conflict: endpoint({ method: 'GET', path: '/api/test/conflict', auth: 'public', owner: 'G', response: z.object({}), summary: 'HttpError' }),
  upload: endpoint({ method: 'POST', path: '/api/test/upload', auth: 'user', owner: 'C', body: multipart(z.object({ folder: z.string() }), 1000), response: z.object({ size: z.number(), folder: z.string(), name: z.string() }), summary: 'multipart test' }),
  chunk: endpoint({ method: 'PUT', path: '/api/test/chunk', auth: 'user', owner: 'C', body: binary(1000), response: z.object({ bytes: z.number() }), summary: 'binary test' }),
}
const testModule: RouteModule = {
  name: 'test', owner: 'B',
  init(ctx) { ctx.services.sessions = fakeSessions },
  register(kit) {
    kit.handle(T.echo, ({ params, query, body, c }) => ({ id: params.id, n: query.n, name: body.name, ip: c.get('info').ip }))
    kit.handle(T.adminOnly, () => ({ ok: true }))
    kit.handle(T.ownerOnly, () => ({ ok: true }))
    kit.handle(T.reauth, () => {})
    kit.handle(T.badResponse, () => ({ n: 'not a number' }) as unknown as { n: number })
    kit.handle(T.boom, () => { throw new Error('kaboom') })
    kit.handle(T.conflict, () => fail('conflict', 'Someone else saved first.'))
    kit.handle(T.upload, async ({ body }) => ({ size: body.file.size, folder: body.fields.folder, name: body.file.name }))
    kit.handle(T.chunk, async ({ body }) => { let n = 0; for await (const ch of body) n += ch.byteLength; return { bytes: n } })
  },
}

let ctx: AppContext
let app: Hono<AppEnv>
beforeAll(async () => {
  const cfg = testConfig()
  const db = openDb(path.join(cfg.dataDir, 'app.db'))
  ctx = createContext({ config: cfg, db, log: silentLogger })
  app = await buildApp(ctx, [...ROUTE_MODULES.filter((m) => m.name !== 'web'), testModule, ROUTE_MODULES.find((m) => m.name === 'web')!])
})
afterAll(async () => { await ctx.close() })

const req = (p: string, init: RequestInit & { as?: keyof typeof people; csrf?: boolean; ip?: string } = {}) => {
  const h = new Headers(init.headers)
  if (init.as) h.set('x-test-user', init.as)
  if (init.csrf !== false && init.method && init.method !== 'GET') h.set('x-mycel-csrf', '1')
  return app.fetch(new Request('http://team.localhost' + p, { ...init, headers: h }), { ip: init.ip ?? '10.0.0.7', via: 'test' })
}
const json = (b: unknown) => ({ method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } })

describe('auth levels', () => {
  test('401 without session, 403 for the wrong role, 200 for the right one', async () => {
    expect((await req('/api/test/admin')).status).toBe(401)
    expect((await req('/api/test/admin', { as: 'member' })).status).toBe(403)
    expect((await req('/api/test/admin', { as: 'admin' })).status).toBe(200)
    expect((await req('/api/test/admin', { as: 'owner' })).status).toBe(200)
    expect((await req('/api/test/owner', { as: 'admin' })).status).toBe(403)
  })
  test("the desktop's in-app browser (User-Agent mark) gets 401 everywhere, signed in or not", async () => {
    const ua = `Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36 ${IN_APP_BROWSER_UA_MARK}`
    for (const p of ['/api/test/admin', '/api/health', '/', '/c/123']) {
      const r = await req(p, { as: 'owner', headers: { 'user-agent': ua } })
      expect(r.status).toBe(401)
    }
    expect((await req('/api/test/admin', { as: 'owner', headers: { 'user-agent': ua.replace(IN_APP_BROWSER_UA_MARK, '') } })).status).toBe(200)
  })
  test('must-change-password users only reach allowed endpoints', async () => {
    const r = await req('/api/test/admin', { as: 'fresh' })
    expect(r.status).toBe(403)
    expect(((await r.json()) as any).error.code).toBe('password_change_required')
  })
  test('owner-reauth checks the re-entered password', async () => {
    expect((await req('/api/test/reauth', { ...json({ password: 'nope' }), as: 'owner' })).status).toBe(403)
    expect((await req('/api/test/reauth', { ...json({ password: 'correct horse' }), as: 'owner' })).status).toBe(204)
    expect((await req('/api/test/reauth', { ...json({ password: 'correct horse' }), as: 'admin' })).status).toBe(403)
  })
})

describe('CSRF', () => {
  test('cookie sessions need the header; cross-site origins are refused; bearer is exempt', async () => {
    const body = json({ name: 'xx' })
    const noHeader = await req('/api/test/echo/1?n=1', { ...body, as: 'member', csrf: false })
    expect(noHeader.status).toBe(403)
    expect(((await noHeader.json()) as any).error.code).toBe('csrf')
    expect((await req('/api/test/echo/1?n=1', { ...body, as: 'member', headers: { ...body.headers, origin: 'https://evil.example' } })).status).toBe(403)
    expect((await req('/api/test/echo/1?n=1', { ...body, as: 'member', headers: { ...body.headers, 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    expect((await req('/api/test/echo/1?n=1', { ...body, as: 'member', headers: { ...body.headers, origin: 'https://acme.treesoop.com' } })).status).toBe(200)
    expect((await req('/api/test/echo/1?n=1', { ...body, as: 'member', headers: { ...body.headers, origin: 'http://team.localhost' } })).status).toBe(200)
    expect((await req('/api/test/echo/1?n=1', { ...body, as: 'mobile', csrf: false })).status).toBe(200)
  })
  test('public forms (login) need the header too', async () => {
    expect((await req('/api/auth/login', { ...json({}), csrf: false })).status).toBe(403)
  })
})

describe('validation and errors', () => {
  test('params, query and body reach the handler parsed; real IP comes from the transport only', async () => {
    const r = await req('/api/test/echo/abc?n=7', { ...json({ name: 'Kim' }), as: 'member', headers: { 'content-type': 'application/json', 'x-forwarded-for': '6.6.6.6', 'cf-connecting-ip': '6.6.6.6' } })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ id: 'abc', n: 7, name: 'Kim', ip: '10.0.0.7' })
  })
  test('schema failures -> 400 validation with field paths, message in the user language', async () => {
    const r = await req('/api/test/echo/abc?n=70', { ...json({ name: 'K' }), as: 'member' })
    expect(r.status).toBe(400)
    const e = ((await r.json()) as any).error
    expect(e.code).toBe('validation')
    expect(Object.keys(e.fields).sort()).toEqual(['query.n'])
    expect(e.message).toBe('Please check the input.') // member's locale is en
    const r2 = await req('/api/test/echo/abc?n=1', { ...json({ name: 'K' }), as: 'member' })
    expect(Object.keys(((await r2.json()) as any).error.fields)).toEqual(['body.name'])
  })
  test('malformed JSON / wrong content type -> bad_request', async () => {
    expect((await req('/api/test/echo/a?n=1', { method: 'POST', body: '{nope', headers: { 'content-type': 'application/json' }, as: 'member' })).status).toBe(400)
    expect((await req('/api/test/echo/a?n=1', { method: 'POST', body: '{"name":"xx"}', headers: { 'content-type': 'text/plain' }, as: 'member' })).status).toBe(400)
  })
  test('oversized JSON -> 413', async () => {
    const r = await req('/api/test/echo/a?n=1', { ...json({ name: 'x'.repeat(1_100_000) }), as: 'member' })
    expect(r.status).toBe(413)
  })
  test('HttpError keeps its message; unknown errors become internal without details; X-Request-Id matches', async () => {
    const c = await req('/api/test/conflict')
    expect(c.status).toBe(409)
    expect(((await c.json()) as any).error).toMatchObject({ code: 'conflict', message: 'Someone else saved first.' })
    // before sign-in the page's own language header decides (Accept-Language does not: docs/DECISIONS.md "언어")
    const b = await req('/api/test/boom', { headers: { 'x-mycel-locale': 'id', 'accept-language': 'ko' } })
    expect(b.status).toBe(500)
    const e = ((await b.json()) as any).error
    expect(e).toMatchObject({ code: 'internal', message: 'Terjadi kesalahan pada server.' })
    expect(JSON.stringify(e)).not.toContain('kaboom')
    expect(e.requestId).toBe(b.headers.get('x-request-id'))
  })
  test('responses that break the contract are caught (validateResponses)', async () => {
    const r = await req('/api/test/bad')
    expect(r.status).toBe(500)
  })
  test('unknown /api path -> JSON 404; security headers set', async () => {
    const r = await req('/api/nope')
    expect(r.status).toBe(404)
    expect(((await r.json()) as any).error.code).toBe('not_found')
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
  })
})

describe('bodies', () => {
  test('multipart: file + validated fields, size limit', async () => {
    const fd = new FormData()
    fd.set('folder', 'shared')
    fd.set('file', new File(['hello'], 'a.txt'))
    const r = await req('/api/test/upload', { method: 'POST', body: fd, as: 'member' })
    expect(await r.json()).toEqual({ size: 5, folder: 'shared', name: 'a.txt' })
    const big = new FormData()
    big.set('folder', 'x')
    big.set('file', new File(['x'.repeat(2000)], 'b.bin'))
    expect((await req('/api/test/upload', { method: 'POST', body: big, as: 'member' })).status).toBe(413)
  })
  test('binary: streamed with a hard limit', async () => {
    expect(await (await req('/api/test/chunk', { method: 'PUT', body: new Uint8Array(900), as: 'member' })).json()).toEqual({ bytes: 900 })
    expect((await req('/api/test/chunk', { method: 'PUT', body: new Uint8Array(1500), as: 'member' })).status).toBe(413)
    // no content-length: the stream itself is cut off
    const stream = new ReadableStream({ start(c) { for (let i = 0; i < 5; i++) c.enqueue(new Uint8Array(400)); c.close() } })
    expect((await req('/api/test/chunk', { method: 'PUT', body: stream, as: 'member', duplex: 'half' } as RequestInit)).status).toBe(413)
  })
})

describe('route registry', () => {
  test('every implemented route is in the contract (or a known off-contract route)', () => {
    const contract = new Set(listEndpoints().map(({ ep }) => `${ep.method} ${ep.path}`))
    const offContract = new Set([
      'GET *', 'GET /api/ws',
      // External OAuth/MCP protocols are tested through their raw contracts, not our app JSON API.
      'GET /api/integrations/google-drive/callback',
      'GET /.well-known/oauth-protected-resource', 'GET /.well-known/oauth-protected-resource/mcp',
      'GET /.well-known/oauth-authorization-server', 'GET /oauth/authorize',
      'POST /oauth/register', 'POST /oauth/token', 'POST /oauth/revoke',
      'GET /mcp', 'POST /mcp', 'DELETE /mcp',
    ])
    for (const [k, mod] of ctx.implemented) if (mod !== 'test') expect(contract.has(k) || offContract.has(k), `${k} (${mod})`).toBe(true)
  })
  test('implementing the same endpoint twice is refused', async () => {
    const twice: RouteModule = { name: 'twice', owner: 'G', register(kit) { kit.handle(API.health, () => ({ ok: true, version: '', schema: { applied: 0, readerLevel: 1 }, uptimeSec: 0, time: new Date().toISOString() })) } }
    const c2 = createContext({ config: testConfig(), db: openDb(':memory:'), log: silentLogger })
    await expect(buildApp(c2, [ROUTE_MODULES.find((m) => m.name === 'system')!, twice])).rejects.toThrow('implemented twice')
  })
  test('module owners match the contract owners of what they implement', () => {
    const owners = new Map(listEndpoints().map(({ ep }) => [`${ep.method} ${ep.path}`, ep.owner]))
    const modOwner = new Map(ROUTE_MODULES.map((m) => [m.name, m.owner]))
    for (const [k, mod] of ctx.implemented) {
      const o = owners.get(k)
      if (o && mod !== 'test') expect(modOwner.get(mod), k).toBe(o)
    }
  })
  test('progress report: which contract endpoints are implemented', () => {
    const missing = listEndpoints().filter(({ ep }) => !ctx.implemented.has(`${ep.method} ${ep.path}`))
    const byOwner: Record<string, number> = {}
    for (const { ep } of missing) byOwner[ep.owner] = (byOwner[ep.owner] ?? 0) + 1
    console.log(`contract endpoints implemented: ${listEndpoints().length - missing.length}/${listEndpoints().length}; missing by owner: ${JSON.stringify(byOwner)}`)
    expect(ctx.implemented.has('GET /api/health')).toBe(true)
  })
})

describe('system + web', () => {
  test('health through the typed client', async () => {
    const api = new ApiClient({ baseUrl: 'http://team.localhost', fetch: ((u: string, i: RequestInit) => app.fetch(new Request(u, i), { ip: null, via: 'test' })) as unknown as typeof fetch })
    const h = await api.call(API.health)
    expect(h.ok).toBe(true)
    expect(h.schema!.applied).toBeGreaterThanOrEqual(2)
    const err = await api.call(T.adminOnly).catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(401)
  })
  test('ctx.appFetch (relay client path) reaches the app with the relay-provided IP', async () => {
    const r = await ctx.appFetch(new Request('http://team.localhost/api/test/echo/r?n=1', { method: 'POST', body: '{"name":"via relay"}', headers: { 'content-type': 'application/json', 'x-mycel-csrf': '1', 'x-test-user': 'member' } }), { ip: '203.0.113.9', via: 'relay' })
    expect(await r.json()).toMatchObject({ name: 'via relay', ip: '203.0.113.9' })
  })
  test('non-API GET serves the web app (dev page without a build)', async () => {
    const r = await req('/chats/123')
    expect(r.status).toBe(200)
    expect(await r.text()).toContain(PRODUCT.displayName)
  })
})

describe('migrations', () => {
  const dir = (name: string, files: Record<string, string>) => {
    const d = path.join(BASE, 'mig-' + name)
    fs.rmSync(d, { recursive: true, force: true })
    fs.mkdirSync(d, { recursive: true })
    for (const [f, s] of Object.entries(files)) fs.writeFileSync(path.join(d, f), s)
    return d
  }
  test('repo migrations apply cleanly, in numeric order, and record min_compatible_reader', () => {
    const db = openDb(':memory:')
    const rows = db.query('SELECT version, name, min_compatible_reader AS r FROM schema_migrations ORDER BY version').all() as any[]
    expect(rows.map((r) => r.version)).toEqual(readMigrations().map((m) => m.version))
    expect(rows.every((r) => r.r >= 1)).toBe(true)
    const cols = (db.query('PRAGMA table_info(messages)').all() as any[]).map((c) => c.name)
    expect(cols).toEqual(expect.arrayContaining(['parent_id', 'turn_id', 'client_message_id', 'files']))
    db.close()
  })
  test('a DB that needs a newer reader is refused; older readers keep working with additive migrations', () => {
    const d = dir('reader', { '001_a.sql': 'CREATE TABLE t (id TEXT);', '002_b.sql': '-- min_compatible_reader: 2\nALTER TABLE t ADD COLUMN x TEXT;' })
    const file = path.join(BASE, 'reader.db')
    fs.rmSync(file, { force: true })
    openDb(file, { migrationsDir: d, readerLevel: 2 }).close()
    expect(() => openDb(file, { migrationsDir: d, readerLevel: 1 })).toThrow(SchemaTooNewError)
    const d2 = dir('additive', { '001_a.sql': 'CREATE TABLE t (id TEXT);' })
    const f2 = path.join(BASE, 'additive.db')
    fs.rmSync(f2, { force: true })
    openDb(f2, { migrationsDir: dir('additive-new', { '001_a.sql': 'CREATE TABLE t (id TEXT);', '002_c.sql': 'ALTER TABLE t ADD COLUMN y TEXT;' }) }).close()
    expect(() => openDb(f2, { migrationsDir: d2, readerLevel: 1 }).close()).not.toThrow()
  })
  test('a DB with data is copied (VACUUM INTO) before new migrations run', () => {
    const file = path.join(BASE, 'backup.db')
    fs.rmSync(file, { force: true })
    fs.rmSync(path.join(BASE, 'backups'), { recursive: true, force: true })
    openDb(file, { migrationsDir: dir('b1', { '001_a.sql': 'CREATE TABLE t (id TEXT); INSERT INTO t VALUES (\'kept\');' }) }).close()
    openDb(file, { migrationsDir: dir('b2', { '001_a.sql': 'CREATE TABLE t (id TEXT);', '101_a_more.sql': 'CREATE TABLE u (id TEXT);' }) }).close()
    const copies = fs.readdirSync(path.join(BASE, 'backups')).filter((f) => f.startsWith('pre-migrate-'))
    expect(copies.length).toBe(1)
  })
  test('two files with the same number are an error', () => {
    expect(() => readMigrations(dir('dup', { '005_a_x.sql': '', '005_b_y.sql': '' }))).toThrow('two migrations with number 5')
  })
})

describe('config', () => {
  test('file + env overrides, relative paths against the file', () => {
    const d = path.join(BASE, 'conf')
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'server.json'), JSON.stringify({ teamRoot: 'team', dataDir: '/abs/data', listen: { port: 19111 }, publicOrigins: ['https://a.example'] }))
    const c = loadAppConfig({ argv: ['--config', path.join(d, 'server.json')], env: { MYCEL_PORT: '19112', MYCEL_LOG_LEVEL: 'warn' } })
    expect(c.teamRoot).toBe(path.join(d, 'team'))
    expect(c.dataDir).toBe('/abs/data')
    expect(c.listen.port).toBe(19112)
    expect(c.logLevel).toBe('warn')
    expect(c.mode).toBe('dev')
    expect(c.validateResponses).toBe(true)
    expect(c.publicOrigins).toEqual(['https://a.example'])
  })
  test('prod defaults and errors', () => {
    const c = loadAppConfig({ argv: [], env: { MYCEL_MODE: 'prod', MYCEL_CONFIG: path.join(BASE, 'conf', 'server.json') } })
    expect(c.mode).toBe('prod')
    expect(c.validateResponses).toBe(false)
    expect(() => loadAppConfig({ argv: ['--config', '/nonexistent/x.json'], env: {} })).toThrow(ConfigError)
    expect(() => loadAppConfig({ argv: [], env: { MYCEL_PORT: 'abc' } })).toThrow(ConfigError)
    fs.writeFileSync(path.join(BASE, 'conf', 'bad.json'), JSON.stringify({ listen: { port: 'x' } }))
    expect(() => loadAppConfig({ argv: ['--config', path.join(BASE, 'conf', 'bad.json')], env: {} })).toThrow('listen.port')
  })
})

describe('logging', () => {
  test('JSON lines with secrets redacted by key', () => {
    const lines: string[] = []
    const log = createLogger({ level: 'debug', sink: (l) => lines.push(l) }).child({ user: 'bob' })
    log.info('login', { password: 'hunter2', nested: { apiKey: 'sk-1', ok: 1 }, authorization: 'Bearer x' })
    log.debug('d')
    const rec = JSON.parse(lines[0]!)
    expect(rec).toMatchObject({ level: 'info', msg: 'login', user: 'bob', password: '[redacted]', nested: { apiKey: '[redacted]', ok: 1 }, authorization: '[redacted]' })
    expect(lines.length).toBe(2)
    const quiet: string[] = []
    createLogger({ level: 'warn', sink: (l) => quiet.push(l) }).info('x')
    expect(quiet.length).toBe(0)
  })
  test('daily files in the log dir', () => {
    const d = path.join(BASE, 'logs')
    fs.rmSync(d, { recursive: true, force: true })
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'server-2000-01-01.log'), 'old\n')
    const log = createLogger({ dir: d, sink: () => {} })
    log.info('hello')
    const files = fs.readdirSync(d)
    expect(files).toContain(`server-${new Date().toISOString().slice(0, 10)}.log`)
    expect(files).not.toContain('server-2000-01-01.log')
  })
})

// Compile-time checks of RouteKit typing (never called; `bun run typecheck` fails if these stop being errors).
export function _typeChecks(kit: RouteKit) {
  // @ts-expect-error the handler must return the contract's response shape
  kit.handle(T.adminOnly, () => ({ ok: 'yes' }))
  // @ts-expect-error unknown body field
  kit.handle(T.echo, ({ body }) => ({ id: '', n: 0, name: body.nope, ip: null }))
  kit.handle(API.health, ({ auth }) => {
    // public endpoint: auth may be null
    // @ts-expect-error auth is possibly null
    void auth.user
    return { ok: true, version: '', schema: { applied: 0, readerLevel: 1 }, uptimeSec: 0, time: new Date().toISOString() }
  })
  const ep: Endpoint = API.sendMessage
  return ep
}

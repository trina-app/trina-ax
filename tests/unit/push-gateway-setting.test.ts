// Where phone notifications go, chosen by an owner or admin in Settings › Notifications (server/src/notifications/
// push-gateway-setting.ts, docs/DECISIONS.md "Owners and admins choose where phone notifications go"): the edition's
// gateway, off, or the team's own address, saved only when its /health answers {"ok":true}. The operator's
// MYCEL_PUSH_GATEWAY or server.json push.gatewayUrl wins and locks the row. A saved choice applies without a restart.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { WORK } from '../lib/env'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { loadAppConfig } from '../../server/src/app-config'
import { checkGatewayHealth, effectiveGatewayUrl, pushGatewaySetting, readNativePushConfig, writePushGateway, PUSH_GATEWAY_SETTING } from '../../server/src/notifications/push-gateway-setting'
import { pushOf } from '../../server/src/notifications/push-service'
import { SERVICE_HOSTS } from '../../shared/src/service-hosts'

const TRINA = 'https://push.trina.app'
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }]
const answer = (body: string, status = 200, headers: Record<string, string> = {}) => (async () => new Response(body, { status, headers })) as unknown as typeof fetch

describe('who chose the address (AppConfig push.setBy)', () => {
  const dir = path.join(WORK, 'push-gateway-setby')
  const file = (o: object) => { fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, `server-${Math.random().toString(36).slice(2)}.json`); fs.writeFileSync(f, JSON.stringify(o)); return f }
  const prod = () => ({ mode: 'prod', teamRoot: path.join(dir, 'team'), dataDir: path.join(dir, 'data'), logDir: path.join(dir, 'logs') })
  const load = (env: Record<string, string>, o: object) => loadAppConfig({ argv: ['--config', file(o)], env }).push
  test('the variable (even empty or off), then server.json (even null), else nobody: the edition default', () => {
    expect(load({}, prod())).toEqual({ gatewayUrl: TRINA, setBy: null })
    expect(load({ MYCEL_PUSH_GATEWAY: '' }, prod())).toEqual({ gatewayUrl: null, setBy: 'env' })
    expect(load({ MYCEL_PUSH_GATEWAY: 'off' }, prod())).toEqual({ gatewayUrl: null, setBy: 'env' })
    expect(load({ MYCEL_PUSH_GATEWAY: 'https://push.example.test' }, { ...prod(), push: { gatewayUrl: null } })).toEqual({ gatewayUrl: 'https://push.example.test', setBy: 'env' })
    expect(load({}, { ...prod(), push: { gatewayUrl: null } })).toEqual({ gatewayUrl: null, setBy: 'file' })
    expect(load({}, { ...prod(), push: { gatewayUrl: 'https://push.example.test' } })).toEqual({ gatewayUrl: 'https://push.example.test', setBy: 'file' })
    expect(load({}, { mode: 'dev' })).toEqual({ gatewayUrl: null, setBy: null })
  })
})

describe('the address in use and what the row shows', () => {
  let h: Harness
  beforeAll(async () => { h = await harness('push-gateway-resolve') })
  afterAll(async () => { await h?.close() })
  afterEach(() => { h.ctx.db.query('DELETE FROM settings WHERE key = ?').run(PUSH_GATEWAY_SETTING) })
  const installed = { push: { gatewayUrl: TRINA, setBy: null } }

  test('nothing chosen: the edition default as app-config resolved it (none on a developer\'s server)', () => {
    expect(SERVICE_HOSTS.pushGatewayUrl).toBe(TRINA)
    expect(effectiveGatewayUrl(installed, h.ctx.db)).toBe(TRINA)
    expect(effectiveGatewayUrl({ push: { gatewayUrl: null, setBy: null } }, h.ctx.db)).toBeNull()
    expect(effectiveGatewayUrl({}, h.ctx.db)).toBeNull()
    expect(pushGatewaySetting(installed, h.ctx.db)).toEqual({ choice: 'default', url: null, defaultHost: 'push.trina.app', lockedBy: null })
  })
  test('an owner\'s or admin\'s choice: off, or their own address; default removes it again', () => {
    writePushGateway(h.ctx.db, 'off')
    expect(effectiveGatewayUrl(installed, h.ctx.db)).toBeNull()
    expect(pushGatewaySetting(installed, h.ctx.db).choice).toBe('off')
    writePushGateway(h.ctx.db, 'custom', 'https://push.example.test')
    expect(effectiveGatewayUrl(installed, h.ctx.db)).toBe('https://push.example.test')
    expect(pushGatewaySetting(installed, h.ctx.db)).toEqual({ choice: 'custom', url: 'https://push.example.test', defaultHost: 'push.trina.app', lockedBy: null })
    writePushGateway(h.ctx.db, 'default')
    expect(h.ctx.db.query('SELECT 1 FROM settings WHERE key = ?').get(PUSH_GATEWAY_SETTING)).toBeNull()
    expect(effectiveGatewayUrl(installed, h.ctx.db)).toBe(TRINA)
    // a stored value that is not a valid address is no choice
    h.ctx.db.query('INSERT INTO settings (key, value) VALUES (?, ?)').run(PUSH_GATEWAY_SETTING, JSON.stringify({ choice: 'custom', url: 'http://10.0.0.5:8787' }))
    expect(effectiveGatewayUrl(installed, h.ctx.db)).toBe(TRINA)
  })
  test('the operator\'s config wins over any stored choice and locks the row, saying where it is set', () => {
    writePushGateway(h.ctx.db, 'custom', 'https://push.example.test')
    const env = { push: { gatewayUrl: 'https://own.example.test', setBy: 'env' as const } }
    expect(effectiveGatewayUrl(env, h.ctx.db)).toBe('https://own.example.test')
    expect(pushGatewaySetting(env, h.ctx.db)).toEqual({ choice: 'custom', url: 'https://own.example.test', defaultHost: 'push.trina.app', lockedBy: 'MYCEL_PUSH_GATEWAY' })
    const off = { push: { gatewayUrl: null, setBy: 'file' as const } }
    expect(effectiveGatewayUrl(off, h.ctx.db)).toBeNull()
    expect(pushGatewaySetting(off, h.ctx.db)).toEqual({ choice: 'off', url: null, defaultHost: 'push.trina.app', lockedBy: 'server.json push.gatewayUrl' })
    expect(pushGatewaySetting({ push: { gatewayUrl: TRINA, setBy: 'file' } }, h.ctx.db)).toMatchObject({ choice: 'default', url: null, lockedBy: 'server.json push.gatewayUrl' })
  })
})

describe('the health check before a custom address is saved', () => {
  test('a gateway answers {"ok":true} at /health, and only then', async () => {
    const seen: string[] = []
    const ok = (async (u: string, init: RequestInit) => { seen.push(u); expect(init.redirect).toBe('manual'); return new Response('{"ok":true}') }) as unknown as typeof fetch
    expect(await checkGatewayHealth(' https://push.example.test/ ', { lookup: publicLookup, fetch: ok })).toEqual({ ok: true, url: 'https://push.example.test' })
    expect(seen).toEqual(['https://push.example.test/health'])
    expect(await checkGatewayHealth('https://push.example.test', { lookup: publicLookup, fetch: answer('{"ok":false}') })).toEqual({ ok: false, problem: 'not_gateway' })
    expect(await checkGatewayHealth('https://push.example.test', { lookup: publicLookup, fetch: answer('<html>hi</html>') })).toEqual({ ok: false, problem: 'not_gateway' })
    expect(await checkGatewayHealth('https://push.example.test', { lookup: publicLookup, fetch: answer('{"ok":true}', 404) })).toEqual({ ok: false, problem: 'not_gateway' })
    // a redirect is not followed (it could point anywhere)
    expect(await checkGatewayHealth('https://push.example.test', { lookup: publicLookup, fetch: answer('', 302, { location: 'http://127.0.0.1:1/health' }) })).toEqual({ ok: false, problem: 'not_gateway' })
    // a long answer is not read to its end
    expect(await checkGatewayHealth('https://push.example.test', { lookup: publicLookup, fetch: answer('{"ok":true,"x":"' + 'a'.repeat(2000) + '"}') })).toEqual({ ok: false, problem: 'not_gateway' })
  })
  test('not an address of the rule; a private or local address; no answer', async () => {
    const never = (async () => { throw new Error('must not be called') }) as unknown as typeof fetch
    for (const bad of ['', 'push.example.test', 'http://push.example.test', 'https://push.example.test:8443', 'https://push.example.test/v1', 'https://u@push.example.test', 'http://10.0.0.5:8787', 'ftp://push.example.test'])
      expect(await checkGatewayHealth(bad, { lookup: publicLookup, fetch: never })).toEqual({ ok: false, problem: 'address' })
    expect(await checkGatewayHealth('https://push.example.test', { lookup: async () => [{ address: '10.0.0.5', family: 4 }], fetch: never })).toEqual({ ok: false, problem: 'private' })
    expect(await checkGatewayHealth('https://push.example.test', { lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }], fetch: never })).toEqual({ ok: false, problem: 'private' })
    expect(await checkGatewayHealth('https://gateway.internal', { lookup: publicLookup, fetch: never })).toEqual({ ok: false, problem: 'private' })
    expect(await checkGatewayHealth('https://push.example.test', { lookup: async () => { throw new Error('ENOTFOUND') }, fetch: never })).toEqual({ ok: false, problem: 'unreachable' })
    expect(await checkGatewayHealth('https://push.example.test', { lookup: publicLookup, fetch: (async () => { throw new TypeError('connect refused') }) as unknown as typeof fetch })).toEqual({ ok: false, problem: 'unreachable' })
    // a gateway on this machine is allowed, except on a hosted server
    expect(await checkGatewayHealth('http://127.0.0.1:8787', { hosted: true, fetch: never })).toEqual({ ok: false, problem: 'address' })
    expect(await checkGatewayHealth('http://127.0.0.1:8787', { fetch: answer('{"ok":true}') })).toEqual({ ok: true, url: 'http://127.0.0.1:8787' })
  })
  test('a server that does not answer in time', async () => {
    const slow = ((_u: string, init: RequestInit) => new Promise((_r, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch
    expect(await checkGatewayHealth('https://push.example.test', { lookup: publicLookup, fetch: slow, timeoutMs: 30 })).toEqual({ ok: false, problem: 'unreachable' })
  })
})

describe('GET and PUT /api/admin/push-gateway', () => {
  let h: Harness, owner: Client, admin: Client, member: Client
  let gateway: ReturnType<typeof Bun.serve>, healthy = true
  beforeAll(async () => {
    // the team's own gateway on this machine (http://127.0.0.1:<port>): its /health answers as push-gateway/ does
    gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req) => new URL(req.url).pathname === '/health' ? Response.json(healthy ? { ok: true } : { ok: false }) : new Response('not found', { status: 404 }) })
    h = await harness('push-gateway-routes')
    owner = await withOwner(h)
    admin = (await addMember(h, owner, { username: 'adam', role: 'admin' })).client
    member = (await addMember(h, owner, { username: 'mia' })).client
  })
  afterAll(async () => { await h?.close(); gateway?.stop(true) })
  const own = () => `http://127.0.0.1:${gateway.port}`
  const audits = () => h.ctx.db.query("SELECT actor_id, detail FROM audit_log WHERE action = 'push.gateway' ORDER BY id").all() as { actor_id: string; detail: string }[]

  test('owners and admins only', async () => {
    expect((await member.try('GET', '/api/admin/push-gateway')).status).toBe(403)
    expect((await member.try('PUT', '/api/admin/push-gateway', { choice: 'off' })).status).toBe(403)
    expect(await admin.call('GET', '/api/admin/push-gateway')).toEqual({ choice: 'default', url: null, defaultHost: 'push.trina.app', lockedBy: null })
  })
  test('an admin turns it off, then picks their own gateway: checked, saved, audited and used at once', async () => {
    expect((await admin.call('PUT', '/api/admin/push-gateway', { choice: 'off' })).choice).toBe('off')
    expect(readNativePushConfig(h.ctx)).toBeNull()
    const saved = await owner.call('PUT', '/api/admin/push-gateway', { choice: 'custom', url: own() + '/' })
    expect(saved).toEqual({ choice: 'custom', url: own(), defaultHost: 'push.trina.app', lockedBy: null })
    // no restart: the push service reads it on its next use
    expect(readNativePushConfig(h.ctx)).toEqual({ url: own() })
    const sid = (h.ctx.db.query("SELECT s.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.username = 'olga' ORDER BY s.created_at DESC LIMIT 1").get() as { id: string }).id
    const ownerId = (h.ctx.db.query("SELECT id FROM users WHERE username = 'olga'").get() as { id: string }).id
    expect(pushOf(h.ctx).settings(ownerId, sid).native).toMatchObject({ available: true, gateway: `127.0.0.1:${gateway.port}` })
    const rows = audits()
    expect(rows.map((r) => JSON.parse(r.detail))).toEqual([{ choice: 'off', before: 'default' }, { choice: 'custom', host: `127.0.0.1:${gateway.port}`, before: 'off' }])
    // the same choice again is no new entry
    await owner.call('PUT', '/api/admin/push-gateway', { choice: 'custom', url: own() })
    expect(audits()).toHaveLength(2)
  })
  test('an address that is not a gateway is not saved, and the answer says why', async () => {
    healthy = false
    const r = await admin.try('PUT', '/api/admin/push-gateway', { choice: 'custom', url: own() })
    expect(r.status).toBe(400)
    expect(r.body.error.params).toEqual({ reason: 'not_gateway' })
    healthy = true
    const bad = await admin.try('PUT', '/api/admin/push-gateway', { choice: 'custom', url: 'http://10.0.0.5:8787' })
    expect(bad.status).toBe(400)
    expect(bad.body.error.params).toEqual({ reason: 'address' })
    const none = await admin.try('PUT', '/api/admin/push-gateway', { choice: 'custom' })
    expect(none.body.error.params).toEqual({ reason: 'address' })
    expect((await admin.call('GET', '/api/admin/push-gateway')).url).toBe(own())
  })
  test('back to the default', async () => {
    expect((await admin.call('PUT', '/api/admin/push-gateway', { choice: 'default' })).choice).toBe('default')
    expect(h.ctx.db.query('SELECT 1 FROM settings WHERE key = ?').get(PUSH_GATEWAY_SETTING)).toBeNull()
  })
})

test('set in the server\'s config: shown, and every change is refused', async () => {
  const h = await harness('push-gateway-locked', { push: { gatewayUrl: 'https://own.example.test', setBy: 'env' } })
  try {
    const owner = await withOwner(h)
    expect(await owner.call('GET', '/api/admin/push-gateway')).toEqual({ choice: 'custom', url: 'https://own.example.test', defaultHost: 'push.trina.app', lockedBy: 'MYCEL_PUSH_GATEWAY' })
    const r = await owner.try('PUT', '/api/admin/push-gateway', { choice: 'off' })
    expect(r.status).toBe(409)
    expect(r.body.error.params).toEqual({ reason: 'locked' })
    expect(readNativePushConfig(h.ctx)).toEqual({ url: 'https://own.example.test' })
  } finally { await h.close() }
})

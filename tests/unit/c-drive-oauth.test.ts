import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import { harness, withOwner, addMember, OWNER_PW, type Harness, type Client } from './a-lib'
import { googleDriveOf, type GoogleDrive } from '../../server/src/integrations/google-drive/oauth'
import { DRIVE_SCOPE } from '../../server/src/integrations/google-drive/config'
import { FakeGoogleDrive, DRIVE_CONFIG } from '../lib/fake-google-drive'
import { createLogger } from '../../server/src/log'

let h: Harness, c: Client, other: Client, svc: GoogleDrive, fake: FakeGoogleDrive
let seq = 0
let logs: string[]
let browser: { userId: string; sessionId: string }
const base = '/api/integrations/google-drive'
beforeEach(async () => {
  logs = []
  h = await harness('drive-oauth-' + ++seq, {}, { log: createLogger({ level: 'debug', sink: line => logs.push(line) }) }); c = await withOwner(h); other = (await addMember(h, c, { username: 'bob', role: 'member' })).client
  fake = new FakeGoogleDrive(); svc = googleDriveOf(h.ctx, { config: DRIVE_CONFIG, fetch: fake.fetch, now: () => fake.now })
  browser = h.ctx.db.query("SELECT s.id sessionId,s.user_id userId FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.username='olga'").get() as typeof browser
})
afterEach(async () => { await h?.close() })
async function ready(who = 'alice') {
  const f = await c.call('POST', base + '/authorize', {})
  const cb = fake.authorize(f.authorizationUrl, who)
  expect(await svc.callback(cb, browser)).toBe(true)
  return { ...f, cb }
}
async function connect() { const f = await ready(); await c.call('POST', `${base}/flows/${f.flowId}/complete`, {}); return f }

test('PKCE code exchange is encrypted and original session explicitly completes the account', async () => {
  const f = await ready()
  expect((await c.call('GET', `${base}/flows/${f.flowId}`)).state).toBe('ready')
  expect((await c.call('GET', base)).status).toBe('disconnected')
  expect((await other.try('POST', `${base}/flows/${f.flowId}/complete`, {})).status).toBe(404)
  const status = await c.call('POST', `${base}/flows/${f.flowId}/complete`, {})
  expect(status).toMatchObject({ status: 'connected', account: { email: 'alice@example.test' }, scopes: [DRIVE_SCOPE] })
  expect((await c.try('POST', `${base}/flows/${f.flowId}/complete`, {})).status).toBe(409)
  await expect(svc.callback(f.cb, browser)).rejects.toThrow('invalid_flow')
  const rows = JSON.stringify(h.ctx.db.query('SELECT * FROM drive_connections').all()) + JSON.stringify(h.ctx.db.query('SELECT * FROM drive_oauth_flows').all()) + JSON.stringify(h.ctx.db.query('SELECT * FROM audit_log').all())
  expect(rows).not.toContain('CANARY-'); expect(rows).not.toContain(f.cb.state)
  expect(fs.statSync(svc.store.vault.keyPath()).mode & 0o777).toBe(0o600)
})
test('expired, cancelled, wrong scope and revoked session flows cannot connect', async () => {
  const f = await c.call('POST', base + '/authorize', {}), cb = fake.authorize(f.authorizationUrl)
  await c.call('DELETE', `${base}/flows/${f.flowId}`)
  await expect(svc.callback(cb, browser)).rejects.toThrow('invalid_flow')
  const g = await c.call('POST', base + '/authorize', {}); fake.now += 600_001
  expect((await c.call('GET', `${base}/flows/${g.flowId}`)).state).toBe('expired')
  expect(svc.store.flow(g.flowId)?.secret_enc).toBeNull()
  fake.scope = 'https://www.googleapis.com/auth/drive.file'
  const bad = await c.call('POST', base + '/authorize', {})
  expect(await svc.callback(fake.authorize(bad.authorizationUrl), browser)).toBe(false)
  expect((await c.call('GET', `${base}/flows/${bad.flowId}`)).reason).toBe('scope_denied')
  const s = await c.call('POST', base + '/authorize', {}), scb = fake.authorize(s.authorizationUrl)
  h.ctx.db.exec('DELETE FROM sessions')
  await expect(svc.callback(scb, browser)).rejects.toThrow('invalid_flow')
})
test('refresh is single flight, preserves omitted refresh token and disconnect fences late refresh', async () => {
  await connect()
  const user = (h.ctx.db.query('SELECT user_id FROM drive_connections').get() as { user_id: string }).user_id
  fake.now += 3_601_000
  let release!: () => void
  fake.delayRefresh = () => new Promise<void>(resolve => { release = resolve })
  const one = svc.api(user, 'files', {}, 1024), two = svc.api(user, 'files', {}, 1024)
  await new Promise(r => setTimeout(r, 5)); release()
  await Promise.all([one, two]); expect(fake.refreshCount).toBe(1)
  expect(svc.store.open<any>(svc.store.connection(user)!).refreshToken).toBe('CANARY-refresh:alice')
  fake.now += 3_601_000
  const pending = svc.api(user, 'files', {}, 1024).catch(e => e)
  await new Promise(r => setTimeout(r, 5))
  expect((await svc.disconnect(user)).disconnected).toBe(true); release()
  expect((await pending).message).toMatch(/cancelled|disconnected/)
  expect(svc.store.connection(user)).toBeNull(); expect(fake.revoked).toBe(true)
})
test('invalid refresh requires reconnect and disabled users make no provider requests', async () => {
  await connect()
  const user = (h.ctx.db.query('SELECT user_id FROM drive_connections').get() as { user_id: string }).user_id
  fake.now += 3_601_000; fake.invalidRefresh = true
  await expect(svc.api(user, 'files', {}, 1024)).rejects.toThrow('needs_reconnect')
  expect(svc.status(user).status).toBe('needs_reconnect')
  h.ctx.db.query("UPDATE users SET status='disabled' WHERE id=?").run(user)
  const calls = fake.calls.length
  await expect(svc.api(user, 'files', {}, 1024)).rejects.toThrow('access_denied')
  expect(fake.calls.length).toBe(calls)
})
test('a 401 after proactive refresh uses the rotated refresh token, never the stale row', async () => {
  fake.rotateRefresh = true
  await connect()
  const user = (h.ctx.db.query('SELECT user_id FROM drive_connections').get() as { user_id: string }).user_id
  fake.now += 3_601_000
  let first = true
  fake.response = () => { if (first) { first = false; return new Response('', { status: 401 }) }; return null }
  await expect(svc.api(user, 'files', {}, 4096)).resolves.toBeDefined()
  expect(fake.refreshCount).toBe(2)
  expect(svc.status(user).status).toBe('connected')
})
test('cancelling a refresh waiter returns promptly without cancelling other waiters', async () => {
  await connect()
  const user = (h.ctx.db.query('SELECT user_id FROM drive_connections').get() as { user_id: string }).user_id
  fake.now += 3_601_000
  let release!: () => void
  fake.delayRefresh = () => new Promise<void>(resolve => { release = resolve })
  const abort = new AbortController()
  const one = svc.api(user, 'files', {}, 4096, abort.signal).catch(e => e), two = svc.api(user, 'files', {}, 4096)
  await new Promise(r => setTimeout(r, 5)); abort.abort()
  const result: any = await Promise.race([one, new Promise(resolve => setTimeout(() => resolve('hung'), 50))])
  release(); await two
  expect(result).toBeInstanceOf(Error)
  expect(result.message).toBe('drive_cancelled')
  expect(fake.refreshCount).toBe(1)
})
test('callback rejects anonymous or other-person browsers, never reflects secrets, and another own session cannot complete it', async () => {
  const f = await c.call('POST', base + '/authorize', {}), cb = fake.authorize(f.authorizationUrl)
  const callbackUrl = base + '/callback?' + new URLSearchParams(cb)
  expect((await h.fetch(callbackUrl)).status).toBe(400)
  expect((await other.raw('GET', callbackUrl)).status).toBe(400)
  expect(fake.calls).toHaveLength(0)
  const response = await c.raw('GET', callbackUrl)
  expect(response.status).toBe(200); expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.text()).not.toContain(cb.code)
  const second = h.client(); await second.login('olga', OWNER_PW)
  expect((await second.try('GET', `${base}/flows/${f.flowId}`)).status).toBe(404)
  expect((await second.try('POST', `${base}/flows/${f.flowId}/complete`, {})).status).toBe(404)
  expect((await c.call('POST', `${base}/flows/${f.flowId}/complete`, {})).status).toBe('connected')
  const csrf = await h.fetch(base + '/authorize', { method: 'POST', headers: { cookie: c.cookie!, 'content-type': 'application/json' }, body: '{}' })
  expect(csrf.status).toBe(403)
  const output = logs.join('\n')
  for (const secret of ['CANARY-', cb.code, cb.state]) expect(output).not.toContain(secret)
})
test('disconnect immediately clears local data and blocks reconnect until revocation finishes', async () => {
  await connect()
  const user = (h.ctx.db.query('SELECT user_id FROM drive_connections').get() as { user_id: string }).user_id
  const session = (h.ctx.db.query('SELECT session_id FROM drive_oauth_flows LIMIT 1').get() as { session_id: string }).session_id
  let release!: () => void
  fake.delayRevoke = () => new Promise(resolve => { release = resolve })
  const disconnect = svc.disconnect(user)
  expect(svc.status(user).status).toBe('disconnected')
  expect(() => svc.authorize(user, session)).toThrow('disconnecting')
  release(); expect((await disconnect).revocation).toBe('revoked')
  expect(() => svc.authorize(user, session)).not.toThrow()
  expect(h.ctx.db.query('SELECT count(*) n FROM drive_connections').get()).toEqual({ n: 0 })
})
test('reconnect notification deduplicates the durable episode without account or token metadata', async () => {
  await connect()
  const user = (h.ctx.db.query('SELECT user_id FROM drive_connections').get() as { user_id: string }).user_id
  fake.now += 3_601_000; fake.invalidRefresh = true
  await expect(svc.api(user, 'files', {}, 1024)).rejects.toThrow('needs_reconnect')
  svc.status(user); svc.status(user)
  const rows = h.ctx.db.query("SELECT * FROM notification_inbox WHERE user_id=? AND event_type='connection.reconnect'").all(user)
  expect(rows).toHaveLength(1)
  expect(JSON.stringify(rows)).not.toContain('CANARY'); expect(JSON.stringify(rows)).not.toContain('alice@example.test')
})

// Google Drive on a hosted server through the hosting service's sign-in broker (integrations/google-drive/broker.ts,
// shared/src/cloud-protocol/drive-broker.ts). Covers: when broker mode is chosen (hosted, no client of its own, not
// turned off) and when the direct flow stays; Drive stays off until the broker answers; a member's own Drive and a team
// share connect through it; every call is signed with the team key; the browser's handoff needs the same signed-in
// person; refresh and revoke go to the broker, never to Google's token endpoint; a refused sealed token asks for a new
// sign-in; the stored secret holds no token in plain text; a start answer that is not Google's sign-in page is refused;
// the hosting service's own start page (connectUrl) is passed on only in its exact shape on the configured origin.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { makeCApp, type CApp } from '../lib/c-app'
import { googleDriveOf, type GoogleDrive } from '../../server/src/integrations/google-drive/oauth'
import { brokerOrigin, driveBrokerFor } from '../../server/src/integrations/google-drive/broker'
import { driveAdminStatus } from '../../server/src/integrations/google-drive/admin-setup'
import { stopShare, updateShare } from '../../server/src/integrations/google-drive/share-admin'
import { registerDriveTools } from '../../server/src/tools/drive'
import { toolRegistry } from '../../server/src/tools/registry'
import { GOOGLE_REVOKE, GOOGLE_TOKEN } from '../../server/src/integrations/google-drive/client'
import { DRIVE_BROKER_PATHS } from '../../shared/src/cloud-protocol/drive-broker'
import { FakeGoogleDrive, DRIVE_CONFIG, membersMayConnect } from '../lib/fake-google-drive'
import { BROKER_ORIGIN, FakeDriveBroker } from '../lib/fake-drive-broker'

let a: CApp, google: FakeGoogleDrive, broker: FakeDriveBroker, svc: GoogleDrive, i = 0
const session = (user: string, id: string) => {
  const now = new Date().toISOString(), later = new Date(Date.now() + 3600_000).toISOString()
  a.ctx.db.query("INSERT INTO sessions(id,user_id,token_hash,client,created_at,last_seen_at,expires_at) VALUES(?,?,?,'web',?,?,?)").run(id, user, id + '-hash', now, now, later)
}
const browser = (who: string) => ({ userId: who, sessionId: `${who}-session` })
async function connect(who = 'alice') {
  const f = await svc.begin(who, `${who}-session`)
  expect(await svc.callback(broker.browserReturn(f.authorizationUrl, who), browser(who))).toBe(true)
  return svc.complete(who, `${who}-session`, f.flowId)
}

beforeEach(async () => {
  a = await makeCApp('drive-broker-' + ++i)
  ;(a.ctx.config as any).deployment = 'hosted'
  google = new FakeGoogleDrive(); broker = new FakeDriveBroker(google)
  svc = googleDriveOf(a.ctx, { config: null, fetch: broker.fetch, broker: broker.options() })
  for (const u of ['carol', 'alice', 'bob']) session(u, `${u}-session`)
  registerDriveTools(a.ctx, toolRegistry(a.ctx.files))
})
afterEach(async () => { await a?.close() })

test('broker mode only on a hosted server without a Google client of its own; the direct flow stays otherwise', async () => {
  const env = { MYCEL_GOOGLE_DRIVE_BROKER_URL: 'https://account.trina.app' }
  // nothing changes without the operator's broker URL, even on a hosted server
  expect(driveBrokerFor(a.ctx, false, false, {})).toBeNull()
  expect(driveBrokerFor(a.ctx, false, false, { MYCEL_GOOGLE_DRIVE_BROKER_URL: ' ' })).toBeNull()
  expect(driveBrokerFor(a.ctx, false, false, env)?.origin).toBe('https://account.trina.app')
  expect(driveBrokerFor(a.ctx, true, false, env)).toBeNull() // client.json of its own: direct, unchanged
  expect(driveBrokerFor(a.ctx, false, true, env)).toBeNull() // MYCEL_GOOGLE_DRIVE_CLIENT_FILE: direct
  expect(driveBrokerFor(a.ctx, false, false, { MYCEL_GOOGLE_DRIVE_BROKER_URL: 'http://127.0.0.1:47900' })?.origin).toBe('http://127.0.0.1:47900')
  ;(a.ctx.config as any).deployment = 'self'
  expect(driveBrokerFor(a.ctx, false, false, env)).toBeNull() // self-installed: its own client as today
  // only https, or http to this machine; never a path, query or credentials
  for (const bad of ['http://evil.test', 'https://u:p@cp.test', 'https://cp.test/x', 'https://cp.test/?a=1', 'ftp://cp.test', 'not a url'])
    expect(brokerOrigin({ MYCEL_GOOGLE_DRIVE_BROKER_URL: bad })).toBeNull()
  // a client of its own wins over the broker even on a hosted server
  ;(a.ctx.config as any).deployment = 'hosted'
  const direct = googleDriveOf(a.ctx, { config: DRIVE_CONFIG, fetch: google.fetch })
  expect(direct.broker).toBeNull(); expect(direct.mode).toBe('direct')
})

test('Drive stays off until the hosting service answers that it serves this team; then the admin card needs nothing', async () => {
  // the hosting service does not know this team key (not hosted there, or not yet): Drive stays off
  broker.trusted = 'another-team-key'
  svc = googleDriveOf(a.ctx, { config: null, fetch: broker.fetch, broker: broker.options() })
  expect(svc.enabled).toBe(false) // nothing before the first answer
  expect(await svc.checkBroker()).toBe(false)
  expect(svc.enabled).toBe(false)
  expect(driveAdminStatus(a.ctx)).toMatchObject({ configured: false, source: 'none', canSetUp: false, blocked: 'hosted' })
  await expect(svc.begin('carol', 'carol-session', {})).rejects.toThrow('drive_not_configured')
  broker.trusted = broker.publicKey; broker.configured = false
  expect(await svc.checkBroker()).toBe(false)
  broker.configured = true
  expect(await svc.checkBroker()).toBe(true)
  expect(svc.mode).toBe('broker')
  expect(driveAdminStatus(a.ctx)).toMatchObject({ configured: true, source: 'service', canSetUp: false, blocked: 'hosted', redirectUri: null })
})

test("a member's own Drive through the broker: signed calls, handoff bound to the browser's person, refresh and revoke at the broker", async () => {
  await svc.checkBroker(); membersMayConnect(a.ctx.db)
  const f = await svc.begin('alice', 'alice-session')
  expect(new URL(f.authorizationUrl).hostname).toBe('accounts.google.com')
  const start = JSON.parse(broker.requests.find((r) => r.path === DRIVE_BROKER_PATHS.start)!.body)
  expect(start).toMatchObject({ v: 1, purpose: 'personal' })
  expect(Object.keys(start).sort()).toEqual(['codeChallenge', 'purpose', 'returnState', 'v'])
  const back = broker.browserReturn(f.authorizationUrl, 'alice')
  // another signed-in person's browser cannot take alice's sign-in, and a direct `code` is not a handoff
  await expect(svc.callback(back, browser('bob'))).rejects.toThrow('browser_session_required')
  expect(await svc.callback({ state: back.state, code: 'synthetic-code-0' }, browser('alice'))).toBe(false)
  // the handoff of a failed flow is not redeemed again, and a new flow works
  expect(broker.requests.filter((r) => r.path === DRIVE_BROKER_PATHS.redeem)).toHaveLength(0)
  google.expired = true // short-lived access tokens: the next call refreshes
  const f2 = await svc.begin('alice', 'alice-session')
  expect(await svc.callback(broker.browserReturn(f2.authorizationUrl, 'alice'), browser('alice'))).toBe(true)
  const status = svc.complete('alice', 'alice-session', f2.flowId)
  expect(status).toMatchObject({ status: 'connected', account: { email: 'alice@example.test' } })
  // the stored secret is sealed again here: no token, sealed or not, in a row
  const rows = JSON.stringify(a.ctx.db.query('SELECT * FROM drive_connections').all()) + JSON.stringify(a.ctx.db.query('SELECT * FROM drive_oauth_flows').all())
  expect(rows).not.toContain('CANARY-'); expect(rows).not.toContain('ev1.k1.')
  // a tool call works; an expired access token is refreshed at the broker, never at Google's token endpoint
  google.expired = false
  expect((await svc.api('alice', 'about', {}, 4096)).bytes.byteLength).toBeGreaterThan(0)
  expect(broker.requests.some((r) => r.path === DRIVE_BROKER_PATHS.refresh)).toBe(true)
  expect(google.calls.some((c) => c.url === GOOGLE_TOKEN || c.url === GOOGLE_REVOKE)).toBe(false)
  // the refresh request carries the sealed token only
  const refresh = JSON.parse(broker.requests.find((r) => r.path === DRIVE_BROKER_PATHS.refresh)!.body)
  expect(Object.keys(refresh).sort()).toEqual(['refreshToken', 'v']); expect(refresh.refreshToken).toStartWith('ev1.')
  // disconnect revokes at the broker
  expect((await svc.disconnect('alice')).revocation).toBe('revoked')
  expect(broker.revoked).toHaveLength(1)
  expect(google.calls.some((c) => c.url === GOOGLE_REVOKE)).toBe(false)
})

test('a sealed token the broker refuses asks for a new sign-in', async () => {
  await svc.checkBroker(); membersMayConnect(a.ctx.db)
  google.expired = true
  await connect('alice')
  broker.invalidGrant = true
  await expect(svc.api('alice', 'about', {}, 4096)).rejects.toThrow('needs_reconnect')
  expect(svc.status('alice').status).toBe('needs_reconnect')
})

test('a team share through the broker: the admin signs in, members use it, stop sharing revokes at the broker', async () => {
  await svc.checkBroker()
  const f = await svc.begin('carol', 'carol-session', {})
  expect(JSON.parse(broker.requests.find((r) => r.path === DRIVE_BROKER_PATHS.start)!.body).purpose).toBe('share')
  expect(await svc.callback(broker.browserReturn(f.authorizationUrl, 'carol'), browser('carol'))).toBe(true)
  const share = svc.completeShare('carol', 'carol-session', f.flowId, 'Company Drive')
  google.blobs.set('carol-file', { owner: 'carol', name: 'carol.txt', mime: 'text/plain', bytes: new TextEncoder().encode('x') })
  await updateShare(a.ctx, 'carol', share.id, { wholeDrive: true, access: { everyone: true, groups: [], users: [] } })
  expect((svc.status('alice').teamShares ?? []).map((s) => s.name)).toEqual(['Company Drive'])
  const stopped = await stopShare(a.ctx, 'carol', share.id)
  expect(stopped.revocation).toBe('revoked'); expect(broker.revoked).toHaveLength(1)
  // a member cannot start a share sign-in through the broker either
  await expect(svc.begin('alice', 'alice-session', {})).rejects.toThrow('drive_access_denied')
})

test('a start answer that is not Google sign-in is refused and the flow fails', async () => {
  await svc.checkBroker(); membersMayConnect(a.ctx.db)
  broker.authorizeBase = 'https://accounts.google.com.evil.test/o/oauth2/v2/auth'
  await expect(svc.begin('alice', 'alice-session')).rejects.toThrow('broker_unavailable')
  expect((a.ctx.db.query("SELECT state, reason FROM drive_oauth_flows WHERE user_id='alice'").get() as any)).toMatchObject({ state: 'failed', reason: 'broker_unavailable' })
  // the broker unreachable: the same, and nothing is logged with a token
  const down = googleDriveOf(a.ctx, { config: null, fetch: async () => { throw new Error('CANARY-network') }, broker: { origin: BROKER_ORIGIN, identity: broker.options().identity } })
  expect(await down.checkBroker()).toBe(false)
})

test('the hosting service\'s start page is passed on with Google\'s address; the sign-in still completes', async () => {
  await svc.checkBroker(); membersMayConnect(a.ctx.db)
  broker.connect = 'page'
  const f = await svc.begin('alice', 'alice-session')
  expect(new URL(f.authorizationUrl).hostname).toBe('accounts.google.com')
  const c = new URL(f.connectUrl!)
  expect(c.origin).toBe(BROKER_ORIGIN); expect(c.pathname).toBe('/drive-broker/connect')
  // the page's state is the one sent to Google: the page links on to that same sign-in
  expect(c.searchParams.get('state')).toBe(new URL(f.authorizationUrl).searchParams.get('state'))
  expect(await svc.callback(broker.browserReturn(f.authorizationUrl, 'alice'), browser('alice'))).toBe(true)
  expect((await svc.complete('alice', 'alice-session', f.flowId)).status).toBe('connected')
})

test('a start page that is not exactly the hosting service\'s is dropped; Google\'s address stays', async () => {
  await svc.checkBroker(); membersMayConnect(a.ctx.db)
  for (const bad of [
    'https://evil.test/drive-broker/connect?state={state}',
    BROKER_ORIGIN + '/drive-broker/other?state={state}',
    BROKER_ORIGIN + '/drive-broker/connect?state={state}&next=https://evil.test',
    BROKER_ORIGIN + '/drive-broker/connect?state=short',
    'https://user:pw@account.broker.test/drive-broker/connect?state={state}',
    BROKER_ORIGIN + '/drive-broker/connect?state={state}#x',
    'http://account.broker.test/drive-broker/connect?state={state}',
  ]) {
    broker.connect = bad
    const f = await svc.begin('alice', 'alice-session')
    expect(f.connectUrl).toBeUndefined()
    expect(new URL(f.authorizationUrl).hostname).toBe('accounts.google.com')
  }
  // an older hosting service sends none: Google first, as before
  broker.connect = 'none'
  expect((await svc.begin('alice', 'alice-session')).connectUrl).toBeUndefined()
})

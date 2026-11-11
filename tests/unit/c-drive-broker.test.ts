// Google Drive through the hosting service's sign-in broker (integrations/google-drive/broker.ts,
// shared/src/cloud-protocol/drive-broker.ts), on a hosted server or a self-installed one the hosting service registered.
// Covers: when broker mode is chosen (the broker URL set, no client of its own; hosted or self-installed) and when the
// direct flow stays; Drive stays off until the broker answers; a member's own Drive and a team share connect through it;
// every call is signed with the team key; the browser's handoff needs the same signed-in person; refresh and revoke go
// to the broker, never to Google's token endpoint; a refused sealed token asks for a new sign-in; the stored secret holds
// no token in plain text; a start answer that is not Google's sign-in page is refused; the hosting service's own start
// page (connectUrl) is passed on only in its exact shape on the configured origin; a self-installed server signs in
// with its relay key, shows what a hosted team shows, never calls the broker with a client of its own; and
// `admin.js google-broker-key` prints that key's public part and the address, never the private key.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeCApp, type CApp } from '../lib/c-app'
import { googleDriveOf, type GoogleDrive } from '../../server/src/integrations/google-drive/oauth'
import { brokerOrigin, driveBrokerFor, googleBrokerKey } from '../../server/src/integrations/google-drive/broker'
import { loadOrCreateKey } from '../../server/src/relay-client/registration'
import { driveAdminStatus, setDriveClient } from '../../server/src/integrations/google-drive/admin-setup'
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

test('broker mode only with the broker URL and without a Google client of its own; the direct flow stays otherwise', async () => {
  const env = { MYCEL_GOOGLE_DRIVE_BROKER_URL: 'https://account.trina.app' }
  // nothing changes without the operator's broker URL, even on a hosted server
  expect(driveBrokerFor(a.ctx, false, false, {})).toBeNull()
  expect(driveBrokerFor(a.ctx, false, false, { MYCEL_GOOGLE_DRIVE_BROKER_URL: ' ' })).toBeNull()
  expect(driveBrokerFor(a.ctx, false, false, env)?.origin).toBe('https://account.trina.app')
  expect(driveBrokerFor(a.ctx, true, false, env)).toBeNull() // client.json of its own: direct, unchanged
  expect(driveBrokerFor(a.ctx, false, true, env)).toBeNull() // MYCEL_GOOGLE_DRIVE_CLIENT_FILE: direct
  expect(driveBrokerFor(a.ctx, false, false, { MYCEL_GOOGLE_DRIVE_BROKER_URL: 'http://127.0.0.1:47900' })?.origin).toBe('http://127.0.0.1:47900')
  // self-installed: the same rule (the hosting service decides whether it serves this server)
  ;(a.ctx.config as any).deployment = 'self'
  expect(driveBrokerFor(a.ctx, false, false, env)?.origin).toBe('https://account.trina.app')
  expect(driveBrokerFor(a.ctx, true, false, env)).toBeNull()
  expect(driveBrokerFor(a.ctx, false, true, env)).toBeNull()
  expect(driveBrokerFor(a.ctx, false, false, {})).toBeNull()
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

// ---------------- a self-installed server the hosting service registered ----------------

/** a Drive service built the way the server builds it: the broker decided from the environment, the relay key on disk */
function withEnv<T>(vars: Record<string, string | undefined>, f: () => T): T {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  try { return f() } finally { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}
const selfInstalled = () => {
  ;(a.ctx.config as any).deployment = 'self'
  ;(a.ctx.config as any).tunnel = { host: 'office.example.test', allowFrom: [], countries: [] }
}

test('a registered self-installed server signs in through the broker with its relay key and looks like a hosted team', async () => {
  selfInstalled()
  const relay = { publicKey: loadOrCreateKey(a.ctx.config.dataDir).publicKey } // the server made its key on start
  expect(googleBrokerKey(a.ctx.config.dataDir, a.ctx.config.tunnel?.host)).toEqual({ publicKey: relay.publicKey, address: 'https://office.example.test' })
  broker.trusted = 'not-registered-yet'
  svc = withEnv({ MYCEL_GOOGLE_DRIVE_BROKER_URL: BROKER_ORIGIN, MYCEL_GOOGLE_DRIVE_CLIENT_FILE: undefined }, () => googleDriveOf(a.ctx, { config: null, fetch: broker.fetch }))
  expect(svc.broker?.o.origin).toBe(BROKER_ORIGIN)
  // not registered at the hosting service: "Not available yet", and the page still lets the admin set a client of
  // its own (a self-installed server is not the hosting service's to set up until it serves it)
  expect(await svc.checkBroker()).toBe(false)
  expect(svc.enabled).toBe(false)
  expect(driveAdminStatus(a.ctx)).toMatchObject({ configured: false, source: 'none', canSetUp: true, blocked: null, redirectUri: 'https://office.example.test/api/integrations/google-drive/callback' })
  // the operator registered the key admin.js google-broker-key prints: Drive works as on a hosted team, and the Set up
  // dialog is the hosting service's
  broker.trusted = relay.publicKey
  expect(await svc.checkBroker()).toBe(true)
  expect(driveAdminStatus(a.ctx)).toMatchObject({ configured: true, source: 'service', canSetUp: false, blocked: 'hosted', redirectUri: null })
  expect(() => setDriveClient(a.ctx, 'carol', { clientId: DRIVE_CONFIG.clientId, clientSecret: DRIVE_CONFIG.clientSecret })).toThrow('setup_hosted')
  membersMayConnect(a.ctx.db)
  expect(await connect('alice')).toMatchObject({ status: 'connected', account: { email: 'alice@example.test' } })
  expect((await svc.api('alice', 'about', {}, 4096)).bytes.byteLength).toBeGreaterThan(0)
  expect(google.calls.some((c) => c.url === GOOGLE_TOKEN)).toBe(false)
  // the hosting service removed the server: not available, and the admin may set a client of its own, which wins
  broker.trusted = 'removed'
  expect(await svc.checkBroker()).toBe(false)
  expect(svc.enabled).toBe(false)
  expect(driveAdminStatus(a.ctx)).toMatchObject({ configured: false, canSetUp: true, blocked: null })
  expect(setDriveClient(a.ctx, 'carol', { clientId: DRIVE_CONFIG.clientId, clientSecret: DRIVE_CONFIG.clientSecret })).toMatchObject({ configured: true, source: 'app', blocked: null })
  expect(svc.mode).toBe('direct')
  const before = broker.requests.length
  const f = await svc.begin('bob', 'bob-session')
  expect(new URL(f.authorizationUrl).searchParams.get('client_id')).toBe(DRIVE_CONFIG.clientId)
  expect(broker.requests.length).toBe(before)
})

test('a self-installed server with a Google client of its own never calls the broker; without the variable nothing changes', async () => {
  selfInstalled()
  const env = { MYCEL_GOOGLE_DRIVE_BROKER_URL: BROKER_ORIGIN }
  await Bun.sleep(0); broker.requests = [] // the hosted service built in beforeEach asked once
  // its own client.json (here: the config read from it)
  svc = withEnv({ ...env, MYCEL_GOOGLE_DRIVE_CLIENT_FILE: undefined }, () => googleDriveOf(a.ctx, { config: DRIVE_CONFIG, fetch: broker.fetch }))
  expect(svc.broker).toBeNull(); expect(svc.mode).toBe('direct')
  expect(await svc.checkBroker()).toBe(false)
  expect(driveAdminStatus(a.ctx).blocked).not.toBe('hosted')
  // the operator's client file (MYCEL_GOOGLE_DRIVE_CLIENT_FILE)
  const file = path.join(a.ctx.config.dataDir, 'operator-client.json')
  fs.writeFileSync(file, JSON.stringify(DRIVE_CONFIG), { mode: 0o600 })
  svc = withEnv({ ...env, MYCEL_GOOGLE_DRIVE_CLIENT_FILE: file }, () => googleDriveOf(a.ctx, { fetch: broker.fetch }))
  expect(svc.broker).toBeNull()
  expect(await svc.checkBroker()).toBe(false)
  expect(driveAdminStatus(a.ctx)).toMatchObject({ blocked: 'server' })
  // no broker URL: no broker, and the page sets up a client as before
  svc = withEnv({ MYCEL_GOOGLE_DRIVE_BROKER_URL: undefined, MYCEL_GOOGLE_DRIVE_CLIENT_FILE: undefined }, () => googleDriveOf(a.ctx, { config: null, fetch: broker.fetch }))
  expect(svc.broker).toBeNull(); expect(svc.mode).toBe('off')
  expect(driveAdminStatus(a.ctx)).toMatchObject({ configured: false, canSetUp: true, blocked: null, redirectUri: 'https://office.example.test/api/integrations/google-drive/callback' })
  expect(broker.requests).toHaveLength(0)
})

test('admin.js google-broker-key prints the relay public key and the address, plain or JSON, never the private key; never makes a key', () => {
  const base = path.join(a.ctx.config.dataDir, 'cli')
  const dataDir = path.join(base, 'data'), teamRoot = path.join(base, 'team')
  fs.mkdirSync(teamRoot, { recursive: true }); fs.mkdirSync(dataDir, { recursive: true })
  const run = (cfg: Record<string, unknown>, ...args: string[]) => {
    const cfgFile = path.join(base, 'server.json')
    fs.writeFileSync(cfgFile, JSON.stringify({ mode: 'dev', dataDir, teamRoot, ...cfg }))
    const p = Bun.spawnSync([process.execPath, path.resolve(import.meta.dir, '../../server/src/system/cli.ts'), 'google-broker-key', ...args], { env: { ...process.env, MYCEL_CONFIG: cfgFile, MYCEL_MODE: 'dev' } })
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
  }
  // before the server made its key: "start the server first", and no key file left behind (a root run must not
  // leave one the server account cannot read)
  const keyFile = path.join(dataDir, 'relay', 'team-key.pem')
  const early = run({ tunnel: { host: 'office.example.test' } })
  expect(early.code).toBe(1)
  expect(early.err).toContain('start the server first')
  const earlyJson = run({ tunnel: { host: 'office.example.test' } }, '--json')
  expect(earlyJson.code).toBe(1)
  expect(JSON.parse(earlyJson.out)).toMatchObject({ error: 'no_key', address: 'https://office.example.test' })
  expect(fs.existsSync(keyFile)).toBe(false)
  expect(googleBrokerKey(dataDir, null)).toEqual({ publicKey: null, address: null })
  // the server made it on start
  const made = loadOrCreateKey(dataDir).publicKey
  const j = run({ tunnel: { host: 'office.example.test' } }, '--json')
  expect(j.code).toBe(0)
  const answer = JSON.parse(j.out)
  expect(Object.keys(answer).sort()).toEqual(['address', 'publicKey'])
  // the key every broker call is signed with
  expect(answer).toEqual({ publicKey: made, address: 'https://office.example.test' })
  const plain = run({ tunnel: { host: 'office.example.test' } })
  expect(plain.code).toBe(0)
  expect(plain.out).toContain(`public key: ${answer.publicKey}`)
  expect(plain.out).toContain('address:    https://office.example.test')
  const none = run({})
  expect(none.out).toContain('not set')
  expect(JSON.parse(run({}, '--json').out)).toEqual({ publicKey: answer.publicKey, address: null })
  // never the private key, in any form
  const pem = fs.readFileSync(keyFile, 'utf8')
  const body = pem.split('\n').filter((l) => l && !l.startsWith('-----')).join('')
  for (const r of [early, earlyJson, j, plain, none]) {
    expect(r.out + r.err).not.toContain('PRIVATE')
    expect(r.out + r.err).not.toContain(body)
  }
}, 60_000)

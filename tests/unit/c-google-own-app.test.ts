// The company's own Google app for the whole Google family (server/src/integrations/google-drive/own-app.ts,
// docs/AGENTS/plan/20261113-0917-google-own-app.md). Covered: set on a hosted server → Google Drive and the four apps
// sign in directly with it and never call the hosting service; removed → all five back to the hosting service at once,
// also after a restart while it was set; refused where the operator set a client, where the hosting service is not the
// sign-in, without a public address, and for a file missing a return address; members get 403; no client ID or secret
// in answers, the audit log or the log; old sign-ins and the team's shared account ask to reconnect; a non-Google
// connection is unchanged; the team's public host (system/deployment.ts publicHostOf) leaves the hosting service's
// sign-in on hosted and on served self-installed servers as it was. Removal: an app's earlier setting comes back, a card
// changed since is left alone, a client someone wrote over it is left alone with the cards on it; restore from a backup
// (row without file); nothing is revoked at Google or the hosting service either way; canGoBack false turns Google off.
// A team address change marks it stale; while set, no card has a setup of its own (also served self-installed); the
// operator's file on disk counts even before a reload. Fake Google, broker and library only.
import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import { makeCApp, PEOPLE, type CApp, type Person } from '../lib/c-app'
import { APP_CLIENT, FakeGoogle, FakeLibrary, sessionRow } from '../lib/fake-google-apps'
import { FakeGoogleDrive } from '../lib/fake-google-drive'
import { BROKER_ORIGIN, FakeDriveBroker } from '../lib/fake-drive-broker'
import { loadOrCreateKey } from '../../server/src/relay-client/registration'
import { googleAppsOf, type GoogleApps } from '../../server/src/integrations/google-apps/service'
import { clientSettingKey, setupOf } from '../../server/src/integrations/google-apps/config'
import { setSetting } from '../../server/src/admin/settings'
import { googleDriveOf, type GoogleDrive } from '../../server/src/integrations/google-drive/oauth'
import { OWN_APP_SETTING } from '../../server/src/integrations/google-drive/config'
import { ownAppStatus } from '../../server/src/integrations/google-drive/own-app'
import { getSetting } from '../../server/src/admin/settings'
import { publicHostOf } from '../../server/src/system/deployment'
import { DRIVE_BROKER_PATHS } from '../../shared/src/cloud-protocol/drive-broker'

setDefaultTimeout(60_000)

const HOST = 'acme.trina.test'
const DRIVE_BACK = `https://${HOST}/api/integrations/google-drive/callback`
const APPS_BACK = `https://${HOST}/api/integrations/google-apps/callback`
const APPS = ['gmail', 'calendar', 'docs', 'sheets'] as const
const webFile = (uris: string[]) => JSON.stringify({ web: { client_id: APP_CLIENT.clientId, client_secret: APP_CLIENT.clientSecret, project_id: 'acme', redirect_uris: uris } })

let A: CApp, lib: FakeLibrary, google: FakeGoogle, gd: FakeGoogleDrive, broker: FakeDriveBroker, drive: GoogleDrive, apps: GoogleApps, i = 0
const logs: string[] = []
const answers: string[] = []

beforeAll(() => { lib = new FakeLibrary().start(); process.env.MYCEL_GOOGLE_APPS_LIBRARY_URL = lib.url })
afterAll(() => { lib.stop(); delete process.env.MYCEL_GOOGLE_APPS_LIBRARY_URL })
beforeEach(async () => {
  A = await makeCApp('google-own-app-' + ++i)
  const cfg = A.ctx.config as any
  cfg.deployment = 'hosted'; cfg.publicOrigins = [`https://${HOST}`]; cfg.tunnel = null
  const log = A.ctx.log as any
  for (const level of ['debug', 'info', 'warn', 'error']) { const orig = log[level]?.bind(log); log[level] = (m: string, d?: unknown) => { logs.push(`${m} ${JSON.stringify(d ?? null)}`); orig?.(m, d) } }
  google = new FakeGoogle(lib); gd = new FakeGoogleDrive(); broker = new FakeDriveBroker(gd)
  broker.onAccess = (token, who) => lib.tokens.set(token, who)
  broker.trusted = loadOrCreateKey(A.ctx.config.dataDir).publicKey
  for (const p of PEOPLE) sessionRow(A.ctx.db, p)
  start()
})
afterEach(async () => { await A?.close() })

const fetcher = async (raw: string, init: RequestInit = {}) => {
  if (raw.startsWith(BROKER_ORIGIN)) return broker.fetch(raw, init)
  if (raw.startsWith('https://oauth2.googleapis.com/') || raw.startsWith('https://openidconnect.googleapis.com/') || raw.includes('/userinfo')) return google.fetch(raw, init)
  return gd.fetch(raw, init)
}
/** (Re)start the Google services as the server does: the broker from MYCEL_GOOGLE_DRIVE_BROKER_URL, the client from disk */
function start() {
  const saved = process.env.MYCEL_GOOGLE_DRIVE_BROKER_URL
  process.env.MYCEL_GOOGLE_DRIVE_BROKER_URL = BROKER_ORIGIN
  try { drive = googleDriveOf(A.ctx, { fetch: fetcher }) } finally { if (saved === undefined) delete process.env.MYCEL_GOOGLE_DRIVE_BROKER_URL; else process.env.MYCEL_GOOGLE_DRIVE_BROKER_URL = saved }
  apps = googleAppsOf(A.ctx, { fetch: fetcher })
}
const call = async (as: Person, method: string, body?: unknown) => {
  const r = await A.json('/api/admin/google/own-app', { method, as, ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) })
  answers.push(JSON.stringify(r.body))
  return r
}
const browser = (who: string) => ({ userId: who, sessionId: `${who}-session` })
const starts = () => broker.requests.filter((r) => r.path === DRIVE_BROKER_PATHS.start).length
const noClient = () => {
  const text = answers.join('\n') + logs.join('\n') + JSON.stringify(A.ctx.db.query('SELECT * FROM audit_log').all())
  expect(text).not.toContain(APP_CLIENT.clientSecret)
  expect(text).not.toContain(APP_CLIENT.clientId)
  expect(JSON.stringify(A.ctx.db.query('SELECT * FROM settings').all())).not.toContain(APP_CLIENT.clientSecret)
}

test('the team public host: tunnel.host, else a hosted server\'s first https team address', () => {
  expect(publicHostOf({ publicOrigins: [], tunnel: { host: 'team.example.test', allowFrom: [], countries: [] } })).toBe('team.example.test')
  expect(publicHostOf({ publicOrigins: ['https://acme.trina.test'], deployment: 'hosted' })).toBe('acme.trina.test')
  expect(publicHostOf({ publicOrigins: ['http://acme.localhost:19100', 'https://acme.trina.test'], deployment: 'hosted' })).toBe('acme.trina.test')
  expect(publicHostOf({ publicOrigins: ['https://acme.trina.test'], deployment: 'self' })).toBeNull() // self-installed: tunnel.host only
  expect(publicHostOf({ publicOrigins: ['https://acme.trina.test/x'], deployment: 'hosted' })).toBeNull()
  expect(publicHostOf({ publicOrigins: [], deployment: 'hosted' })).toBeNull()
})

test('hosted and served self-installed: the hosting service\'s sign-in is unchanged by the public host (cards blocked "hosted", no address shown)', async () => {
  for (const kind of ['hosted', 'self'] as const) {
    if (kind === 'self') { const cfg = A.ctx.config as any; cfg.deployment = 'self'; cfg.publicOrigins = []; cfg.tunnel = { host: HOST, allowFrom: [], countries: [] }; start() }
    expect(await drive.checkBroker()).toBe(true)
    expect((await A.json('/api/admin/google-drive', { as: 'carol' })).body).toMatchObject({ configured: true, source: 'service', canSetUp: false, blocked: 'hosted', redirectUri: null })
    for (const card of (await A.json('/api/admin/google-apps', { as: 'carol' })).body.apps) expect(card).toMatchObject({ source: 'service', canSetUp: false, blocked: 'hosted', redirectUri: null })
    const n = starts()
    await drive.begin('alice', 'alice-session')
    const f = await apps.authorize('bob', 'bob-session', 'gmail')
    expect(starts()).toBe(n + 2)
    expect(JSON.parse(broker.requests.filter((r) => r.path === DRIVE_BROKER_PATHS.start).at(-1)!.body)).toMatchObject({ purpose: 'personal', app: 'gmail' })
    expect(await apps.callback(broker.browserReturn(f.authorizationUrl, 'bob'), browser('bob'))).toBe(true)
  }
})

test('hosted: set once → Drive and the four apps sign in directly with it and never call the hosting service; members 403; no client anywhere', async () => {
  for (const m of ['GET', 'PUT', 'DELETE']) expect((await call('alice', m, m === 'PUT' ? { clientId: 'x', clientSecret: 'y' } : undefined)).status).toBe(403)
  // available on a hosted server before the hosting service answered (the way around one that does not serve it yet)
  const before = await call('carol', 'GET')
  expect(before.body).toEqual({ available: true, blocked: null, active: false, stale: false, canGoBack: true, setBy: null, setAt: null, people: 0, shared: 0, returnAddresses: { drive: DRIVE_BACK, apps: APPS_BACK } })
  // the downloaded file must list both return addresses
  expect((await call('carol', 'PUT', { file: webFile([DRIVE_BACK]) })).body.error.params.reason).toBe('client_redirect_apps')
  expect((await call('carol', 'PUT', { file: webFile([APPS_BACK]) })).body.error.params.reason).toBe('client_redirect_drive')
  expect((await call('carol', 'PUT', { file: JSON.stringify({ installed: {} }) })).body.error.params.reason).toBe('client_invalid')
  expect((await call('carol', 'PUT', { file: webFile([APPS_BACK]) })).status).toBe(400)
  expect(fs.existsSync(drive.clientFile)).toBe(false)

  const set = await call('carol', 'PUT', { file: webFile([DRIVE_BACK, APPS_BACK]) })
  expect(set.status).toBe(200)
  expect(set.body).toMatchObject({ available: true, active: true, canGoBack: true, setBy: { id: 'carol', name: 'Carol Park' }, people: 0, shared: 0 })
  expect(set.body.setAt).toBeString()
  expect(fs.statSync(drive.clientFile).mode & 0o777).toBe(0o600)
  for (const app of APPS) expect(getSetting<{ by: string }>(A.ctx.db, clientSettingKey(app))).toEqual({ by: 'drive' })
  expect(A.ctx.db.query("SELECT detail FROM audit_log WHERE action='google.own_app_set'").all()).toEqual([{ detail: JSON.stringify({ replaced: false }) }])

  // all five sign in directly with the company's app; the hosting service is never asked
  const calls = broker.requests.length
  expect(drive.mode).toBe('direct')
  const d = new URL((await drive.begin('alice', 'alice-session')).authorizationUrl)
  expect(d.hostname).toBe('accounts.google.com')
  expect(d.searchParams.get('client_id')).toBe(APP_CLIENT.clientId)
  expect(d.searchParams.get('redirect_uri')).toBe(DRIVE_BACK)
  for (const app of APPS) {
    expect(setupOf(A.ctx, app)).toMatchObject({ source: 'drive', mode: 'direct' })
    const u = new URL((await apps.authorize('bob', 'bob-session', app)).authorizationUrl)
    expect(u.hostname).toBe('accounts.google.com')
    expect(u.searchParams.get('client_id')).toBe(APP_CLIENT.clientId)
    expect(u.searchParams.get('redirect_uri')).toBe(APPS_BACK)
  }
  const f = await apps.authorize('erin', 'erin-session', 'gmail')
  expect(await apps.callback(google.authorize(f.authorizationUrl, 'erin'), browser('erin'))).toBe(true)
  expect(await apps.complete('erin', 'erin-session', 'gmail', f.flowId)).toMatchObject({ status: 'connected' })
  expect(google.tokenCalls.at(-1)!.get('redirect_uri')).toBe(APPS_BACK)
  expect(broker.requests.length).toBe(calls)
  // the cards stay as they are: the hosting service's setup on a hosted server, no address shown
  expect((await A.json('/api/admin/google-drive', { as: 'carol' })).body).toMatchObject({ canSetUp: false, blocked: 'hosted', redirectUri: null })
  for (const card of (await A.json('/api/admin/google-apps', { as: 'carol' })).body.apps) expect(card).toMatchObject({ canSetUp: false, blocked: 'hosted', redirectUri: null })

  // replaced with the ID and secret: still the company's app, audited as a replacement
  const again = await call('dana', 'PUT', { clientId: APP_CLIENT.clientId, clientSecret: APP_CLIENT.clientSecret })
  expect(again.body).toMatchObject({ active: true, setBy: { id: 'dana', name: 'Dana Choi' }, people: 1 })
  expect((A.ctx.db.query("SELECT detail FROM audit_log WHERE action='google.own_app_set' ORDER BY id").all() as { detail: string }[]).map((r) => r.detail)).toEqual([JSON.stringify({ replaced: false }), JSON.stringify({ replaced: true })])
  noClient()
})

test('removed → all five back to the hosting service at once, also after a restart while it was set', async () => {
  expect((await call('carol', 'PUT', { file: webFile([DRIVE_BACK, APPS_BACK]) })).status).toBe(200)
  // a restart while the company's app is set: its client wins, the hosting service's sign-in stays ready behind it
  start()
  expect(drive.mode).toBe('direct')
  expect(drive.broker).not.toBeNull()
  expect((await call('carol', 'GET')).body).toMatchObject({ available: true, active: true, canGoBack: true })

  const removed = await call('carol', 'DELETE')
  expect(removed.status).toBe(200)
  expect(removed.body).toMatchObject({ available: true, active: false, setBy: null, setAt: null })
  expect(fs.existsSync(drive.clientFile)).toBe(false)
  expect(getSetting(A.ctx.db, OWN_APP_SETTING)).toBeUndefined()
  for (const app of APPS) expect(getSetting<unknown>(A.ctx.db, clientSettingKey(app))).toBeUndefined()
  // the hosting service was asked right away: no restart, no wait for the next check
  expect(drive.mode).toBe('broker')
  for (const app of APPS) expect(setupOf(A.ctx, app)).toMatchObject({ source: 'service', mode: 'broker' })
  const n = starts()
  expect(new URL((await drive.begin('alice', 'alice-session')).authorizationUrl).searchParams.get('client_id')).not.toBe(APP_CLIENT.clientId)
  await apps.authorize('bob', 'bob-session', 'calendar')
  expect(starts()).toBe(n + 2)
  expect(A.ctx.db.query("SELECT detail FROM audit_log WHERE action='google.own_app_removed'").all()).toEqual([{ detail: '{}' }])
  // removing again changes nothing
  expect((await call('carol', 'DELETE')).body).toMatchObject({ active: false })
  expect(A.ctx.db.query("SELECT count(*) n FROM audit_log WHERE action='google.own_app_removed'").get()).toEqual({ n: 1 })
  noClient()
})

test('refused where the operator set a client, where the hosting service is not the sign-in, and without a public address', async () => {
  // a Google client the operator set for one app (environment): not the page's to change
  process.env.MYCEL_GOOGLE_GMAIL_CLIENT_FILE = '/nonexistent/gmail.json'
  try {
    expect((await call('carol', 'GET')).body).toMatchObject({ available: false, blocked: 'server' })
    expect((await call('carol', 'PUT', { clientId: 'x', clientSecret: 'y' })).body.error.params.reason).toBe('server')
  } finally { delete process.env.MYCEL_GOOGLE_GMAIL_CLIENT_FILE }
  // a client.json the operator wrote (not this setting): left alone, removal does not delete it either
  drive.store.safeDirectory(true)
  fs.writeFileSync(drive.clientFile, JSON.stringify({ clientId: 'operator-client', clientSecret: 'operator-secret', redirectUri: DRIVE_BACK }), { mode: 0o600 })
  start()
  expect(ownAppStatus(A.ctx, {})).toMatchObject({ available: false, blocked: 'server', active: false })
  expect((await call('carol', 'PUT', { file: webFile([DRIVE_BACK, APPS_BACK]) })).status).toBe(409)
  await call('carol', 'DELETE')
  expect(fs.existsSync(drive.clientFile)).toBe(true)
  fs.rmSync(drive.clientFile)
  start()
  // no public address on the hosted server
  ;(A.ctx.config as any).publicOrigins = []
  expect(ownAppStatus(A.ctx, {})).toMatchObject({ available: false, blocked: 'public_host', returnAddresses: null })
  // self-installed that the hosting service does not serve: the per-card setup stays, nothing here
  const cfg = A.ctx.config as any
  cfg.deployment = 'self'; cfg.tunnel = { host: HOST, allowFrom: [], countries: [] }
  broker.trusted = 'not-registered'
  start()
  expect(await drive.checkBroker()).toBe(false)
  expect((await call('carol', 'GET')).body).toMatchObject({ available: false, blocked: 'not_service' })
  expect((await call('carol', 'PUT', { file: webFile([DRIVE_BACK, APPS_BACK]) })).body.error.params.reason).toBe('not_service')
  // once it serves this server, it is offered
  broker.trusted = loadOrCreateKey(A.ctx.config.dataDir).publicKey
  expect(await drive.checkBroker()).toBe(true)
  expect((await call('carol', 'GET')).body).toMatchObject({ available: true, blocked: null, canGoBack: true })
  // without a hosting service behind it (no broker URL), removal cannot go back: canGoBack false
  drive = googleDriveOf(A.ctx, { fetch: fetcher })
  expect(ownAppStatus(A.ctx, {})).toMatchObject({ canGoBack: false })
  noClient()
})

test('old sign-ins and the shared team account ask to reconnect; a non-Google connection is unchanged', async () => {
  expect(await drive.checkBroker()).toBe(true)
  // through the hosting service: alice's own Drive, bob's Gmail, and the team's shared Gmail account (carol)
  const fd = await drive.begin('alice', 'alice-session')
  expect(await drive.callback(broker.browserReturn(fd.authorizationUrl, 'alice'), browser('alice'))).toBe(true)
  drive.complete('alice', 'alice-session', fd.flowId)
  const fg = await apps.authorize('bob', 'bob-session', 'gmail')
  expect(await apps.callback(broker.browserReturn(fg.authorizationUrl, 'bob'), browser('bob'))).toBe(true)
  await apps.complete('bob', 'bob-session', 'gmail', fg.flowId)
  const ft = await apps.authorize('carol', 'carol-session', 'gmail', 'team')
  expect(await apps.callback(broker.browserReturn(ft.authorizationUrl, 'teambox'), browser('carol'))).toBe(true)
  await apps.completeTeam('carol', 'carol-session', 'gmail', ft.flowId)
  expect(drive.status('alice').status).toBe('connected')
  expect(apps.view('bob', 'gmail').status).toBe('connected')
  expect(apps.teamView('gmail')!.status).toBe('connected')
  // a connection that is not Google's
  A.ctx.db.query("INSERT INTO integrations (id, scope, owner_user_id, kind, name, slug, url, auth, write_policy, status, tools_json, version, created_at, updated_at) VALUES ('notion1','personal','alice','mcp','Notion','notion','https://mcp.notion.test/mcp','oauth','ask','connected','[]',1,'t','t')").run()
  const other = () => JSON.stringify(A.ctx.db.query("SELECT * FROM integrations WHERE id='notion1'").get())
  const snapshot = other()

  expect((await call('carol', 'GET')).body).toMatchObject({ people: 2, shared: 1 })
  const revokes = () => ({ google: google.revoked.length, service: broker.revoked.length, revokeCalls: broker.requests.filter((r) => r.path === DRIVE_BROKER_PATHS.revoke).length })
  expect(revokes()).toEqual({ google: 0, service: 0, revokeCalls: 0 })
  expect((await call('carol', 'PUT', { file: webFile([DRIVE_BACK, APPS_BACK]) })).status).toBe(200)
  expect(revokes()).toEqual({ google: 0, service: 0, revokeCalls: 0 })
  expect(drive.status('alice').status).toBe('needs_reconnect')
  expect(apps.view('bob', 'gmail').status).toBe('needs_reconnect')
  expect(apps.teamView('gmail')!.status).toBe('needs_reconnect')
  expect(other()).toBe(snapshot)
  // and back to the hosting service: the other connection is still untouched, and still nothing revoked anywhere
  await call('carol', 'DELETE')
  expect(other()).toBe(snapshot)
  expect(revokes()).toEqual({ google: 0, service: 0, revokeCalls: 0 })
  noClient()
})

test('removal: an app\'s earlier setting comes back; a card changed since is left alone', async () => {
  // Gmail had a setting before (a page's own client whose file is gone: the hosting service signs it in)
  setSetting(A.ctx.db, clientSettingKey('gmail'), { by: 'app', key: 'earlier' })
  expect((await call('carol', 'GET')).body).toMatchObject({ available: true })
  expect((await call('carol', 'PUT', { file: webFile([DRIVE_BACK, APPS_BACK]) })).status).toBe(200)
  for (const app of APPS) expect(getSetting<unknown>(A.ctx.db, clientSettingKey(app))).toEqual({ by: 'drive' })
  // an admin changes Calendar's card after the set
  setSetting(A.ctx.db, clientSettingKey('calendar'), { by: 'app', key: 'changed-since' })
  expect((await call('carol', 'DELETE')).status).toBe(200)
  expect(getSetting<unknown>(A.ctx.db, clientSettingKey('gmail'))).toEqual({ by: 'app', key: 'earlier' })
  expect(getSetting<unknown>(A.ctx.db, clientSettingKey('calendar'))).toEqual({ by: 'app', key: 'changed-since' })
  for (const app of ['docs', 'sheets'] as const) expect(getSetting<unknown>(A.ctx.db, clientSettingKey(app))).toBeUndefined()
  noClient()
})

test('restore from a backup: the settings row without its file shows as not set; set again; remove puts the cards back', async () => {
  expect((await call('carol', 'PUT', { file: webFile([DRIVE_BACK, APPS_BACK]) })).status).toBe(200)
  // a restore brings back the database (the row, the cards on "same as Drive") but not the private client file
  fs.rmSync(drive.clientFile)
  start()
  expect(getSetting(A.ctx.db, OWN_APP_SETTING)).toBeDefined()
  expect((await call('carol', 'GET')).body).toMatchObject({ available: true, blocked: null, active: false, stale: false, setBy: null, setAt: null })
  // the cards still work: Drive has no client, so they sign in through the hosting service
  expect(drive.mode).toBe('broker')
  for (const app of APPS) expect(setupOf(A.ctx, app)).toMatchObject({ source: 'service', mode: 'broker' })
  // set again
  expect((await call('dana', 'PUT', { file: webFile([DRIVE_BACK, APPS_BACK]) })).body).toMatchObject({ active: true, setBy: { id: 'dana' } })
  for (const app of APPS) expect(setupOf(A.ctx, app)).toMatchObject({ source: 'drive', mode: 'direct' })
  // remove: the cards go back to how they were before the first set (no setting), all five back to the hosting service
  expect((await call('carol', 'DELETE')).body).toMatchObject({ active: false })
  expect(fs.existsSync(drive.clientFile)).toBe(false)
  expect(getSetting(A.ctx.db, OWN_APP_SETTING)).toBeUndefined()
  for (const app of APPS) expect(getSetting<unknown>(A.ctx.db, clientSettingKey(app))).toBeUndefined()
  expect(drive.mode).toBe('broker')
  noClient()
})

test('a client someone wrote over it: shown as the server\'s (on disk, before any reload); removal leaves that client and the cards on it working', async () => {
  expect((await call('carol', 'PUT', { file: webFile([DRIVE_BACK, APPS_BACK]) })).status).toBe(200)
  // the operator writes their own client.json; the server has not read it yet (memory still has the company's app)
  fs.writeFileSync(drive.clientFile + '.op', JSON.stringify({ clientId: 'operator-client', clientSecret: 'operator-secret', redirectUri: DRIVE_BACK }), { mode: 0o600 })
  fs.renameSync(drive.clientFile + '.op', drive.clientFile)
  expect(drive.config!.clientId).toBe(APP_CLIENT.clientId)
  // decided from the file on disk: not active, the operator's client blocks setting it again
  expect((await call('carol', 'GET')).body).toMatchObject({ active: false, available: false, blocked: 'server' })
  expect((await call('carol', 'PUT', { file: webFile([DRIVE_BACK, APPS_BACK]) })).status).toBe(409)
  expect(JSON.parse(fs.readFileSync(drive.clientFile, 'utf8')).clientId).toBe('operator-client')
  // removal: only this setting goes; the operator's file stays and the cards keep following it
  expect((await call('carol', 'DELETE')).status).toBe(200)
  expect(getSetting(A.ctx.db, OWN_APP_SETTING)).toBeUndefined()
  expect(JSON.parse(fs.readFileSync(drive.clientFile, 'utf8')).clientId).toBe('operator-client')
  for (const app of APPS) {
    expect(getSetting<unknown>(A.ctx.db, clientSettingKey(app))).toEqual({ by: 'drive' })
    expect(setupOf(A.ctx, app)).toMatchObject({ source: 'drive', mode: 'direct', client: { clientId: 'operator-client' } })
  }
  expect(new URL((await apps.authorize('bob', 'bob-session', 'gmail')).authorizationUrl).searchParams.get('client_id')).toBe('operator-client')
  noClient()
})

test('hosted, the hosting service not serving this team: canGoBack false, and removal turns Google off', async () => {
  broker.trusted = 'not-registered'
  expect(await drive.checkBroker()).toBe(false)
  expect((await call('carol', 'GET')).body).toMatchObject({ available: true, canGoBack: false }) // the way around it
  expect((await call('carol', 'PUT', { file: webFile([DRIVE_BACK, APPS_BACK]) })).body).toMatchObject({ active: true, canGoBack: false })
  expect(drive.mode).toBe('direct')
  expect((await call('carol', 'DELETE')).body).toMatchObject({ active: false, canGoBack: false })
  expect(drive.mode).toBe('off')
  expect(drive.enabled).toBe(false)
  for (const app of APPS) expect(setupOf(A.ctx, app)).toMatchObject({ mode: 'off' })
  noClient()
})

test('the team\'s address changes after it was set: stale, never rewritten; Replace with the new addresses clears it', async () => {
  expect((await call('carol', 'PUT', { file: webFile([DRIVE_BACK, APPS_BACK]) })).body).toMatchObject({ active: true, stale: false })
  const NEW = 'acme-co.trina.test'
  ;(A.ctx.config as any).publicOrigins = [`https://${NEW}`]
  const st = (await call('carol', 'GET')).body
  expect(st).toMatchObject({ active: true, stale: true, available: true, returnAddresses: { drive: `https://${NEW}/api/integrations/google-drive/callback`, apps: `https://${NEW}/api/integrations/google-apps/callback` } })
  // the client still sends people to the old address (Google accepts only what is listed in Google Cloud)
  expect(new URL((await drive.begin('alice', 'alice-session')).authorizationUrl).searchParams.get('redirect_uri')).toBe(DRIVE_BACK)
  expect(new URL((await apps.authorize('bob', 'bob-session', 'gmail')).authorizationUrl).searchParams.get('redirect_uri')).toBe(APPS_BACK)
  // the old file is refused now; one listing the new addresses is taken
  expect((await call('carol', 'PUT', { file: webFile([DRIVE_BACK, APPS_BACK]) })).body.error.params.reason).toBe('client_redirect_drive')
  const NEW_BACK = [st.returnAddresses.drive, st.returnAddresses.apps]
  expect((await call('carol', 'PUT', { file: webFile(NEW_BACK) })).body).toMatchObject({ active: true, stale: false })
  expect(new URL((await apps.authorize('bob', 'bob-session', 'gmail')).authorizationUrl).searchParams.get('redirect_uri')).toBe(NEW_BACK[1])
  noClient()
})

test('while it is set, no card has a setup of its own: hosted, and a self-installed server the hosting service serves', async () => {
  for (const kind of ['hosted', 'self'] as const) {
    if (kind === 'self') {
      await call('carol', 'DELETE')
      const cfg = A.ctx.config as any; cfg.deployment = 'self'; cfg.publicOrigins = []; cfg.tunnel = { host: HOST, allowFrom: [], countries: [] }
      start()
    }
    expect(await drive.checkBroker()).toBe(true)
    expect((await call('carol', 'PUT', { file: webFile([DRIVE_BACK, APPS_BACK]) })).body).toMatchObject({ active: true })
    expect(drive.mode).toBe('direct')
    expect((await A.json('/api/admin/google-drive', { as: 'carol' })).body).toMatchObject({ canSetUp: false, blocked: 'hosted', redirectUri: null })
    for (const card of (await A.json('/api/admin/google-apps', { as: 'carol' })).body.apps) expect(card).toMatchObject({ source: 'drive', canSetUp: false, blocked: 'hosted', redirectUri: null })
    const r = await A.json('/api/admin/google-apps/gmail/client', { method: 'PUT', as: 'carol', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: JSON.stringify({ web: { client_id: 'other.apps.googleusercontent.com', client_secret: 'other', redirect_uris: [APPS_BACK] } }) }) })
    expect(r.status).toBe(409)
    const d = await A.json('/api/admin/google-drive/client', { method: 'PUT', as: 'carol', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId: 'other.apps.googleusercontent.com', clientSecret: 'other' }) })
    expect(d.status).toBe(409)
    expect(JSON.parse(fs.readFileSync(drive.clientFile, 'utf8')).clientId).toBe(APP_CLIENT.clientId)
  }
  // removed on the served self-installed server: the cards are the hosting service's again, as before
  await call('carol', 'DELETE')
  for (const card of (await A.json('/api/admin/google-apps', { as: 'carol' })).body.apps) expect(card).toMatchObject({ source: 'service', blocked: 'hosted' })
  noClient()
})

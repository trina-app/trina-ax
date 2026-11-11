// Gmail, Calendar, Docs and Sheets: the admin's setup per card and a person's Google sign-in (server/src/integrations/
// google-apps/, docs/GOOGLE-APPS.md). Covered: the admin status and its checklist, a card's own client (written private,
// never shown) and "the same Google app as Drive", the sign-in (PKCE, the app's fixed scopes, the same person in the
// browser, the account confirmed), the connection hidden from the generic list with only its own app's tools, the team
// switch (on by default), Always allow from the page, disconnect and when Google is asked to revoke, the hosting
// service's sign-in with the `app` field (and an older one that refuses it), Google Drive's members switch on for new
// teams only (migration 340), and canaries: no token or client secret in an answer, the database outside sealed
// columns, the audit log or the server's log. Fake Google and a fake library on 127.0.0.1 only.
import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeCApp, PEOPLE, type CApp, type Person } from '../lib/c-app'
import { WORK } from '../lib/env'
import { APP_CLIENT, FakeGoogle, FakeLibrary, sessionRow, ALL_SCOPES } from '../lib/fake-google-apps'
import { FakeGoogleDrive, DRIVE_CONFIG } from '../lib/fake-google-drive'
import { FakeDriveBroker } from '../lib/fake-drive-broker'
import { googleAppsOf, scopesCover, type GoogleApps } from '../../server/src/integrations/google-apps/service'
import { appsSecretsDir } from '../../server/src/integrations/google-apps/config'
import { googleDriveOf } from '../../server/src/integrations/google-drive/oauth'
import { membersCanConnect } from '../../server/src/integrations/google-drive/shares'
import { integrationToolProvider } from '../../server/src/integrations/connections/tools'
import { getRow, savedTools } from '../../server/src/integrations/connections/store'
import { GOOGLE_USERINFO } from '../../server/src/integrations/google-drive/client'
import { migrate, MIGRATIONS_DIR, openDb } from '../../server/src/db'
import { DRIVE_BROKER_PATHS } from '../../shared/src/cloud-protocol/drive-broker'

setDefaultTimeout(30_000)

const REDIRECT = 'https://team.example.test/api/integrations/google-apps/callback'
let A: CApp, lib: FakeLibrary, google: FakeGoogle, apps: GoogleApps, i = 0
const logs: string[] = []

beforeAll(() => { lib = new FakeLibrary().start(); process.env.MYCEL_GOOGLE_APPS_LIBRARY_URL = lib.url })
afterAll(() => { lib.stop(); delete process.env.MYCEL_GOOGLE_APPS_LIBRARY_URL })
beforeEach(async () => {
  A = await makeCApp('gapps-signin-' + ++i)
  ;(A.ctx.config as any).tunnel = { host: 'team.example.test' }
  const log = A.ctx.log as any
  for (const level of ['debug', 'info', 'warn', 'error']) { const orig = log[level]?.bind(log); log[level] = (m: string, d?: unknown) => { logs.push(`${m} ${JSON.stringify(d ?? null)}`); orig?.(m, d) } }
  google = new FakeGoogle(lib)
  apps = googleAppsOf(A.ctx, { fetch: google.fetch })
  for (const p of PEOPLE) sessionRow(A.ctx.db, p)
})
afterEach(async () => { await A?.close() })

const put = (as: Person, p: string, body: unknown) => A.json(p, { method: 'PUT', as, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const browser = (who: string) => ({ userId: who, sessionId: `${who}-session` })
const setUp = async (app = 'gmail') => {
  const r = await put('carol', `/api/admin/google-apps/${app}/client`, { clientId: APP_CLIENT.clientId, clientSecret: APP_CLIENT.clientSecret })
  expect(r.status).toBe(200)
  return r.body
}
async function connect(who: Person, app: 'gmail' | 'calendar' | 'docs' | 'sheets' = 'gmail') {
  const f = await apps.authorize(who, `${who}-session`, app)
  const q = google.authorize(f.authorizationUrl, who)
  expect(await apps.callback(q, browser(who))).toBe(true)
  return { flow: f, view: await apps.complete(who, `${who}-session`, app, f.flowId) }
}
const plain = () => ['integrations', 'google_app_flows', 'audit_log', 'settings'].map((t) => JSON.stringify(A.ctx.db.query(`SELECT * FROM ${t}`).all())).join('\n') + logs.join('\n')
const noSecrets = (text: string) => {
  expect(text).not.toContain(APP_CLIENT.clientSecret)
  expect(text).not.toContain('CANARY-gapp-access')
  expect(text).not.toContain('CANARY-gapp-refresh')
}

test('Admin › Connectors: four cards with their checklist and switch; a card\'s own client is private and never shown', async () => {
  expect((await A.json('/api/admin/google-apps', { as: 'alice' })).status).toBe(403)
  const before = await A.json('/api/admin/google-apps', { as: 'carol' })
  expect(before.body.apps.map((a: any) => a.id)).toEqual(['gmail', 'calendar', 'docs', 'sheets'])
  expect(before.body.apps[0]).toMatchObject({ configured: false, source: 'none', canSetUp: true, blocked: null, redirectUri: REDIRECT, driveAppAvailable: false, membersCanConnect: true, connectedMembers: 0 })
  expect(before.body.apps[0].apis.map((x: any) => x.name)).toEqual(['Gmail API'])
  expect(before.body.apps[2].apis.map((x: any) => x.name)).toEqual(['Google Docs API', 'Google Drive API'])
  // a member sees why they cannot connect yet
  expect((await A.json('/api/integrations/google-apps', { as: 'alice' })).body.apps[0]).toMatchObject({ id: 'gmail', available: false, reason: 'not_set_up', status: 'disconnected' })
  // a downloaded file must list this server's redirect address
  const wrong = await put('carol', '/api/admin/google-apps/gmail/client', { file: JSON.stringify({ web: { client_id: APP_CLIENT.clientId, client_secret: APP_CLIENT.clientSecret, redirect_uris: ['https://elsewhere.example/cb'] } }) })
  expect(wrong.status).toBe(400)
  expect(wrong.body.error.params.reason).toBe('client_redirect')
  const ok = await put('carol', '/api/admin/google-apps/gmail/client', { file: JSON.stringify({ web: { client_id: APP_CLIENT.clientId, client_secret: APP_CLIENT.clientSecret, redirect_uris: [REDIRECT] } }) })
  expect(ok.status).toBe(200)
  expect(ok.body).toMatchObject({ id: 'gmail', configured: true, source: 'app', canSetUp: true })
  expect(JSON.stringify(ok.body)).not.toContain(APP_CLIENT.clientSecret)
  expect(JSON.stringify(ok.body)).not.toContain(APP_CLIENT.clientId)
  const file = path.join(appsSecretsDir(A.ctx), 'gmail.json')
  expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
  expect((await A.json('/api/integrations/google-apps', { as: 'alice' })).body.apps[0]).toMatchObject({ available: true, reason: null })
  // the other cards are not set up by this one
  expect((await A.json('/api/admin/google-apps', { as: 'carol' })).body.apps[1]).toMatchObject({ id: 'calendar', configured: false })
  noSecrets(plain())
  expect(A.ctx.db.query("SELECT detail FROM audit_log WHERE action='google_app.client_set'").get()).toMatchObject({ detail: JSON.stringify({ app: 'gmail', sameAsDrive: false, replaced: false }) })
})

test('the same Google app as Drive: offered when Drive has one, signs in with its client at this callback, follows Drive\'s changes', async () => {
  expect((await put('carol', '/api/admin/google-apps/calendar/client', { sameAsDrive: true })).body.error.params.reason).toBe('drive_not_set_up')
  googleDriveOf(A.ctx, { config: DRIVE_CONFIG, fetch: new FakeGoogleDrive().fetch })
  const st = await put('carol', '/api/admin/google-apps/calendar/client', { sameAsDrive: true })
  expect(st.body).toMatchObject({ source: 'drive', configured: true, driveAppAvailable: true })
  const f = await apps.authorize('alice', 'alice-session', 'calendar')
  const u = new URL(f.authorizationUrl)
  expect(u.searchParams.get('client_id')).toBe(DRIVE_CONFIG.clientId)
  expect(u.searchParams.get('redirect_uri')).toBe(REDIRECT)
  // Drive gets another client: a flow started with the old one cannot finish
  googleDriveOf(A.ctx, { config: { ...DRIVE_CONFIG, clientId: 'another-drive-client' }, fetch: new FakeGoogleDrive().fetch })
  expect(await apps.callback(google.authorize(f.authorizationUrl, 'alice'), browser('alice'))).toBe(false)
})

test('sign-in: PKCE, the app\'s scopes, offline access; the same person\'s browser; the account confirmed; tokens never shown', async () => {
  await setUp('gmail')
  const f = await apps.authorize('alice', 'alice-session', 'gmail')
  const u = new URL(f.authorizationUrl)
  expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
  expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: APP_CLIENT.clientId, redirect_uri: REDIRECT, response_type: 'code', scope: ALL_SCOPES('gmail'), access_type: 'offline', prompt: 'consent', code_challenge_method: 'S256' })
  expect(f.authorizationUrl).not.toContain(APP_CLIENT.clientSecret)
  const q = google.authorize(f.authorizationUrl, 'alice')
  // someone else's browser (or none) cannot take Alice's consent
  expect(await apps.callback(q, browser('bob'))).toBe(false)
  expect(await apps.callback(q)).toBe(false)
  expect(await apps.callback(q, browser('alice'))).toBe(true)
  // the flow shows the account to confirm; another session or person cannot poll it
  expect(apps.flow('alice', 'alice-session', 'gmail', f.flowId)).toMatchObject({ state: 'ready', account: { name: 'alice Kim', email: 'alice@acme.example' } })
  expect(() => apps.flow('bob', 'bob-session', 'gmail', f.flowId)).toThrow()
  expect(() => apps.flow('alice', 'alice-session', 'calendar', f.flowId)).toThrow()
  const view = await apps.complete('alice', 'alice-session', 'gmail', f.flowId)
  expect(view).toMatchObject({ id: 'gmail', available: true, status: 'connected', account: { name: 'alice Kim', email: 'alice@acme.example' }, writePolicy: 'ask', serviceDown: false })
  expect(view.tools.find((t) => t.name === 'send_gmail_message')).toMatchObject({ changes: true })
  // a connection of its own kind: not in the generic list, not changed through the generic API
  const row = A.ctx.db.query("SELECT * FROM integrations WHERE google_app='gmail'").get() as any
  expect(row).toMatchObject({ scope: 'personal', owner_user_id: 'alice', kind: 'mcp', auth: 'oauth', url: 'https://google-apps.invalid/gmail', write_policy: 'ask' })
  expect((await A.json('/api/integrations', { as: 'alice' })).body.items).toEqual([])
  expect((await A.json(`/api/integrations/${row.id}`, { method: 'DELETE', as: 'alice' })).status).toBe(404)
  // its tools: Gmail's only (no Drive tool, no library sign-in, nothing of the other apps); the attachment tool reads
  const tools = savedTools(A.ctx.db, getRow(A.ctx.db, row.id)!)
  expect(tools.map((t) => t.name).sort()).toEqual(view.tools.map((t) => t.name).sort())
  expect(tools.find((t) => t.name === 'get_gmail_attachment_content')!.readOnly).toBe(true)
  expect(tools.find((t) => t.name === 'send_gmail_message')!.readOnly).toBe(false)
  // the token request carried the secret to Google's token address only; nothing readable kept it
  expect(google.tokenCalls[0]!.get('code_verifier')).toBeTruthy()
  noSecrets(plain())
  noSecrets(JSON.stringify(view) + JSON.stringify((await A.json('/api/integrations/google-apps', { as: 'alice' })).body))
  expect(A.ctx.db.query("SELECT detail FROM audit_log WHERE action='google_app.connected'").get()).toMatchObject({ detail: JSON.stringify({ app: 'gmail', reconnected: false }) })
  expect((await A.json('/api/admin/google-apps', { as: 'carol' })).body.apps[0].connectedMembers).toBe(1)
})

test('a sign-in without every scope the app needs is refused', async () => {
  await setUp('gmail')
  google.grant = (asked) => asked.split(' ').filter((s) => !s.endsWith('gmail.send')).join(' ')
  const f = await apps.authorize('alice', 'alice-session', 'gmail')
  expect(await apps.callback(google.authorize(f.authorizationUrl, 'alice'), browser('alice'))).toBe(false)
  expect(apps.flow('alice', 'alice-session', 'gmail', f.flowId)).toMatchObject({ state: 'failed', reason: 'scope_denied' })
  await expect(apps.complete('alice', 'alice-session', 'gmail', f.flowId)).rejects.toThrow()
})

test('a broader scope Google granted in place of a narrower one counts; short identity names count', async () => {
  const G = 'https://www.googleapis.com/auth/'
  // the pure check: the small explicit table only
  expect(scopesCover([`${G}calendar`, 'email', 'profile'], [`${G}userinfo.email`, `${G}userinfo.profile`, `${G}calendar`, `${G}calendar.readonly`, `${G}calendar.events`])).toBe(true)
  expect(scopesCover([`${G}documents`, `${G}drive`], [`${G}documents.readonly`, `${G}drive.readonly`, `${G}drive.file`])).toBe(true)
  expect(scopesCover([`${G}spreadsheets`, `${G}gmail.modify`], [`${G}spreadsheets.readonly`, `${G}gmail.readonly`])).toBe(true)
  expect(scopesCover([`${G}calendar.readonly`], [`${G}calendar`])).toBe(false)
  expect(scopesCover([`${G}drive.readonly`], [`${G}drive.file`])).toBe(false)
  expect(scopesCover([`${G}gmail.readonly`], [`${G}gmail.send`])).toBe(false)
  // a sign-in where Google folded calendar.readonly and calendar.events into calendar, with short identity names
  await setUp('calendar')
  google.grant = (asked) => asked.split(' ').filter((s) => !s.endsWith('calendar.readonly') && !s.endsWith('calendar.events'))
    .map((s) => s.replace(`${G}userinfo.email`, 'email').replace(`${G}userinfo.profile`, 'profile')).join(' ')
  const { view } = await connect('alice', 'calendar')
  expect(view.status).toBe('connected')
  // a box really unticked (calendar itself): refused with the reason the page words
  google.grant = (asked) => asked.split(' ').filter((s) => !s.endsWith('/calendar')).join(' ')
  const f = await apps.authorize('bob', 'bob-session', 'calendar')
  expect(await apps.callback(google.authorize(f.authorizationUrl, 'bob'), browser('bob'))).toBe(false)
  expect(apps.flow('bob', 'bob-session', 'calendar', f.flowId)).toMatchObject({ state: 'failed', reason: 'scope_denied' })
})

test('the team switch: on by default; off stops sign-ins and the AI\'s tools; Always allow from the page', async () => {
  await setUp('gmail')
  await connect('alice')
  const chat = A.chat('alice')
  const tools = () => [...integrationToolProvider(A.ctx).build({ userId: 'alice', chatId: chat, turnId: A.turn('alice', chat), browser: false, scheduled: false }).tools].map((t) => t.name)
  expect(tools()).toContain('my_gmail__search_gmail_messages')
  expect(tools().some((n) => n.includes('drive'))).toBe(false)
  const off = await put('carol', '/api/admin/google-apps/gmail/members', { on: false })
  expect(off.body).toMatchObject({ membersCanConnect: false })
  expect((await put('alice', '/api/admin/google-apps/gmail/members', { on: true })).status).toBe(403)
  expect(tools()).toEqual([])
  expect((await A.json('/api/integrations/google-apps', { as: 'alice' })).body.apps[0]).toMatchObject({ available: false, reason: 'members_off', status: 'connected' })
  await expect(apps.authorize('bob', 'bob-session', 'gmail')).rejects.toMatchObject({ reason: 'members_off' })
  await put('carol', '/api/admin/google-apps/gmail/members', { on: true })
  expect(tools()).toContain('my_gmail__send_gmail_message')
  const allow = await A.json('/api/integrations/google-apps/gmail', { method: 'PATCH', as: 'alice', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ writePolicy: 'allow' }) })
  expect(allow.body).toMatchObject({ writePolicy: 'allow' })
  expect((await A.json('/api/integrations/google-apps/calendar', { method: 'PATCH', as: 'alice', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ writePolicy: 'allow' }) })).status).toBe(404)
})

test('disconnect: the tokens go at once; Google is asked to revoke only for the person\'s last Google sign-in here', async () => {
  await setUp('gmail'); await setUp('calendar')
  await connect('alice', 'gmail'); await connect('alice', 'calendar')
  const gone = await A.json('/api/integrations/google-apps/gmail', { method: 'DELETE', as: 'alice' })
  expect(gone.body).toEqual({ disconnected: true, revocation: 'not_needed' })
  expect(google.revoked).toEqual([])
  expect(A.ctx.db.query("SELECT 1 FROM integrations WHERE google_app='gmail'").get()).toBeNull()
  // a Google Drive of hers stays too: still not the last one
  const now = new Date().toISOString()
  A.ctx.db.query("INSERT INTO drive_connections(id,user_id,config_key,account,scopes,secret_enc,key_version,status,expires_at,created_at,updated_at) VALUES('d1','alice','k','{}','[]','x',1,'connected',?,?,?)").run(now, now, now)
  expect((await apps.disconnect('alice', 'calendar')).revocation).toBe('not_needed')
  await connect('alice', 'calendar')
  A.ctx.db.query("DELETE FROM drive_connections WHERE id='d1'").run()
  expect((await apps.disconnect('alice', 'calendar')).revocation).toBe('revoked')
  expect(google.revoked).toHaveLength(1)
  expect(google.revoked[0]).toStartWith('CANARY-gapp-refresh-alice')
  // nothing to disconnect: nothing to revoke
  expect((await apps.disconnect('alice', 'docs')).revocation).toBe('not_needed')
  // Google Drive's own disconnect leaves the grant alone while one of these apps is connected
  await connect('alice', 'gmail')
  A.ctx.db.query("INSERT INTO drive_connections(id,user_id,config_key,account,scopes,secret_enc,key_version,status,expires_at,created_at,updated_at) VALUES('d2','alice','k','{}','[]','x',1,'connected',?,?,?)").run(now, now, now)
  expect((await googleDriveOf(A.ctx, { config: DRIVE_CONFIG, fetch: new FakeGoogleDrive().fetch }).disconnect('alice')).revocation).toBe('not_needed')
})

test('disconnect does not revoke a grant that backs a live team Drive share of the person', async () => {
  await setUp('gmail')
  await connect('alice', 'gmail')
  const now = new Date().toISOString()
  A.ctx.db.query("INSERT INTO drive_team_shares (id, name, owner_user_id, config_key, account, scopes, secret_enc, key_version, folders, status, version, expires_at, created_at, updated_at) VALUES ('share-1', 'Sales', 'alice', 'k', '{}', 'drive.readonly', 'sealed', 1, '[]', 'connected', 1, '2099-01-01', ?, ?)").run(now, now)
  expect((await apps.disconnect('alice', 'gmail')).revocation).toBe('not_needed')
  expect(google.revoked).toEqual([])
  // someone else's share does not count; a share that stopped (tokens gone) neither
  A.ctx.db.query("UPDATE drive_team_shares SET owner_user_id='carol' WHERE id='share-1'").run()
  await connect('alice', 'gmail')
  expect((await apps.disconnect('alice', 'gmail')).revocation).toBe('revoked')
  A.ctx.db.query("UPDATE drive_team_shares SET owner_user_id='alice', secret_enc=NULL, status='needs_reconnect' WHERE id='share-1'").run()
  await connect('alice', 'gmail')
  expect((await apps.disconnect('alice', 'gmail')).revocation).toBe('revoked')
  expect(google.revoked).toHaveLength(2)
})

test('hosted: signs in through the hosting service with the app; an older one that refuses the app says "not available yet"', async () => {
  ;(A.ctx.config as any).deployment = 'hosted'
  const gd = new FakeGoogleDrive(), broker = new FakeDriveBroker(gd)
  broker.onAccess = (token, who) => lib.tokens.set(token, who)
  const fetcher = async (raw: string, init: RequestInit = {}) => {
    if (raw === GOOGLE_USERINFO) {
      const who = lib.tokens.get(new Headers(init.headers).get('authorization')?.replace('Bearer ', '') ?? '')
      return who ? Response.json({ sub: `sub-${who}`, name: who, email: `${who}@acme.example` }) : Response.json({}, { status: 401 })
    }
    return broker.fetch(raw, init)
  }
  const drive = googleDriveOf(A.ctx, { config: null, fetch: fetcher, broker: broker.options() })
  apps = googleAppsOf(A.ctx, { fetch: fetcher })
  expect((await A.json('/api/admin/google-apps', { as: 'carol' })).body.apps[0]).toMatchObject({ configured: false, source: 'none', blocked: 'hosted', redirectUri: null })
  expect(await drive.checkBroker()).toBe(true)
  expect((await A.json('/api/admin/google-apps', { as: 'carol' })).body.apps[0]).toMatchObject({ configured: true, source: 'service', canSetUp: false })
  expect((await put('carol', '/api/admin/google-apps/gmail/client', { clientId: 'x', clientSecret: 'y' })).body.error.params.reason).toBe('setup_hosted')
  const f = await apps.authorize('alice', 'alice-session', 'gmail')
  const start = broker.requests.find((r) => r.path === DRIVE_BROKER_PATHS.start)!
  expect(JSON.parse(start.body)).toMatchObject({ v: 1, purpose: 'personal', app: 'gmail' })
  expect(await apps.callback(broker.browserReturn(f.authorizationUrl, 'alice'), browser('alice'))).toBe(true)
  const view = await apps.complete('alice', 'alice-session', 'gmail', f.flowId)
  expect(view).toMatchObject({ status: 'connected' })
  // the library refuses the token (it ran out): one refresh through the hosting service, for Gmail
  lib.tokens.clear()
  broker.onAccess = (token, who) => lib.tokens.set(token, who)
  const row = getRow(A.ctx.db, (A.ctx.db.query("SELECT id FROM integrations WHERE google_app='gmail'").get() as { id: string }).id)!
  const { integrationsOf } = await import('../../server/src/integrations/connections/service')
  const r = await integrationsOf(A.ctx).callTool(row, 'search_gmail_messages', { query: 'lunch' })
  expect(JSON.stringify(r)).toContain('Lunch on Friday')
  expect(broker.refreshApps).toEqual(['gmail'])
  // disconnecting the last sign-in revokes through the hosting service
  expect((await apps.disconnect('alice', 'gmail')).revocation).toBe('revoked')
  expect(broker.revoked).toHaveLength(1)
  // an older control plane refuses the app field: the card says it is not available yet
  broker.appsSupported = false
  await expect(apps.authorize('bob', 'bob-session', 'calendar')).rejects.toMatchObject({ reason: 'service_limited' })
  expect(apps.view('bob', 'calendar')).toMatchObject({ available: false, reason: 'service_limited' })
  expect(apps.view('bob', 'gmail')).toMatchObject({ available: true })
})

test('Google Drive\'s members switch: on for a new team; a team that existed keeps what it had (migration 340)', () => {
  // makeCApp's people are added after the migrations ran: a new team
  expect(membersCanConnect(A.ctx.db)).toBe(true)
  const dir = path.join(WORK, `c-google-apps-mig-${process.pid}-${i}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, 'm'), { recursive: true })
  for (const f of fs.readdirSync(MIGRATIONS_DIR)) if (f.endsWith('.sql') && Number(f.slice(0, 3)) < 340) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, 'm', f))
  const old = openDb(path.join(dir, 'app.db'), { migrationsDir: path.join(dir, 'm') })
  old.query("INSERT INTO users (id, username, name, role) VALUES ('olga', 'olga', 'Olga', 'owner')").run()
  migrate(old)
  expect(membersCanConnect(old)).toBe(false)
  expect(old.query("SELECT value FROM settings WHERE key='integrations.driveMembers'").get()).toEqual({ value: 'false' })
  // the new column and table are there, and only the four apps fit
  expect(() => old.query("INSERT INTO integrations (id, scope, owner_user_id, kind, name, slug, url, auth, status, created_at, updated_at, google_app) VALUES ('x','personal','olga','mcp','n','s','https://google-apps.invalid/x','oauth','connected','t','t','drive')").run()).toThrow()
  old.close()
  // a team whose members had turned it on keeps it on
  const dir2 = path.join(dir, 'b')
  fs.mkdirSync(dir2)
  const on = openDb(path.join(dir2, 'app.db'), { migrationsDir: path.join(dir, 'm') })
  on.query("INSERT INTO users (id, username, name, role) VALUES ('olga', 'olga', 'Olga', 'owner')").run()
  on.query("INSERT INTO settings (key, value) VALUES ('integrations.driveMembers', 'true')").run()
  migrate(on)
  expect(membersCanConnect(on)).toBe(true)
  on.close()
})

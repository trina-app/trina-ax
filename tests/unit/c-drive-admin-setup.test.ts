// Setting up Google Drive from Admin › App connectors (integrations/google-drive/admin-setup.ts): who may, where the
// client goes, what the page may not change, and that the client secret never comes back.
import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { googleDriveOf } from '../../server/src/integrations/google-drive/oauth'
import { readDriveConfig } from '../../server/src/integrations/google-drive/config'
import { toolRegistry } from '../../server/src/tools/registry'
import { resolveLayout } from '../../server/src/system/layout'
import type { Logger } from '../../server/src/log'

const HOST = 'team.example.test'
const REDIRECT = `https://${HOST}/api/integrations/google-drive/callback`
const SECRET = 'CANARY-admin-setup-secret-7Hq2'
const webClient = (uris = [REDIRECT]) => JSON.stringify({ web: { client_id: 'synthetic-app-client.apps.googleusercontent.com', client_secret: SECRET, redirect_uris: uris, project_id: 'x' } })

let h: Harness | null = null
afterEach(async () => { await h?.close(); h = null; delete process.env.MYCEL_GOOGLE_DRIVE_CLIENT_FILE })
const clientDir = (hh: Harness) => path.join(resolveLayout(hh.ctx.config).secretsDir, 'integrations', 'google-drive')

test('only admins see or change the setup; a member gets 403 and nothing is written', async () => {
  h = await harness('drive-setup-auth', { tunnel: { host: HOST, allowFrom: [], countries: [] } })
  const owner = await withOwner(h)
  const { client: bob } = await addMember(h, owner, { username: 'bob' })
  const { client: ada } = await addMember(h, owner, { username: 'ada', role: 'admin' })
  expect((await bob.try('GET', '/api/admin/google-drive')).status).toBe(403)
  expect((await bob.try('PUT', '/api/admin/google-drive/client', { clientId: 'x', clientSecret: SECRET })).status).toBe(403)
  expect(fs.existsSync(path.join(clientDir(h), 'client.json'))).toBe(false)
  const s = (await ada.try('GET', '/api/admin/google-drive')).body
  expect(s).toEqual({ configured: false, source: 'none', canSetUp: true, blocked: null, redirectUri: REDIRECT, connectedMembers: 0, membersCanConnect: false, sharesOn: 0 })
})

test('an admin sets it up with the downloaded file: a private client.json, members can connect, the tools are offered, the secret never comes back', async () => {
  const lines: string[] = []
  const rec = (m: string, f?: Record<string, unknown>) => { lines.push(m + JSON.stringify(f ?? {})) }
  const log: Logger = { debug: rec, info: rec, warn: rec, error: rec, child: () => log }
  h = await harness('drive-setup-file', { tunnel: { host: HOST, allowFrom: [], countries: [] } }, { log })
  const owner = await withOwner(h)
  const { client: bob } = await addMember(h, owner, { username: 'bob' })
  const reg = toolRegistry(h.ctx.files)
  expect(reg.has('drive_search')).toBe(true)
  expect(reg.available('drive_search')).toBe(false)
  expect((await bob.try('GET', '/api/integrations/google-drive')).body.configured).toBe(false)

  const r = await owner.try('PUT', '/api/admin/google-drive/client', { file: webClient([REDIRECT, 'https://other.example/cb']) })
  expect(r.status).toBe(200)
  expect(r.body).toEqual({ configured: true, source: 'app', canSetUp: true, blocked: null, redirectUri: REDIRECT, connectedMembers: 0, membersCanConnect: false, sharesOn: 0 })
  const file = path.join(clientDir(h), 'client.json')
  const st = fs.statSync(file)
  expect(st.mode & 0o777).toBe(0o600)
  expect(readDriveConfig(file, h.ctx.config.teamRoot)).toEqual({ clientId: 'synthetic-app-client.apps.googleusercontent.com', clientSecret: SECRET, redirectUri: REDIRECT })
  expect(fs.readdirSync(clientDir(h)).filter((n) => n.endsWith('.tmp'))).toEqual([])

  // members now see Drive is there, and the AI is offered its tools, without a restart; connecting their own waits
  // for the admin's switch (a client alone turns nothing on)
  expect((await bob.try('GET', '/api/integrations/google-drive')).body).toMatchObject({ configured: true, status: 'disconnected', personalAllowed: false })
  expect((await bob.try('POST', '/api/integrations/google-drive/authorize', {})).status).toBe(403)
  expect((await bob.try('PUT', '/api/admin/google-drive/members', { on: true })).status).toBe(403)
  expect((await owner.try('PUT', '/api/admin/google-drive/members', { on: true })).body).toMatchObject({ membersCanConnect: true })
  expect((await bob.try('GET', '/api/integrations/google-drive')).body).toMatchObject({ personalAllowed: true })
  expect((await bob.try('POST', '/api/integrations/google-drive/authorize', {})).status).toBe(200)
  expect(h.ctx.db.query("SELECT detail FROM audit_log WHERE action='drive.members_switch'").all()).toEqual([{ detail: JSON.stringify({ on: true }) }])
  expect(reg.available('drive_search')).toBe(true)
  expect(h.ctx.services.turnTools?.find((t) => t.name === 'drive_read')?.available?.({} as never) ?? true).toBe(true)

  // the secret is in the private file only: not in responses, the audit log, settings or logs
  const audit = h.ctx.db.query("SELECT action, detail FROM audit_log WHERE action='drive.client_set'").all() as { action: string; detail: string }[]
  expect(audit).toEqual([{ action: 'drive.client_set', detail: JSON.stringify({ replaced: false }) }])
  const dump = JSON.stringify([r.body, (await owner.try('GET', '/api/admin/google-drive')).body,
    h.ctx.db.query('SELECT * FROM audit_log').all(), h.ctx.db.query('SELECT * FROM settings').all(), lines])
  expect(dump).not.toContain(SECRET)
  expect(dump).not.toContain('synthetic-app-client')
})

test('the client ID and secret work too; replacing it makes connected members connect again', async () => {
  h = await harness('drive-setup-fields', { tunnel: { host: HOST, allowFrom: [], countries: [] } })
  const owner = await withOwner(h)
  expect((await owner.try('PUT', '/api/admin/google-drive/client', { clientId: ' first.apps.googleusercontent.com ', clientSecret: SECRET })).status).toBe(200)
  const svc = googleDriveOf(h.ctx), firstKey = svc.key
  // a connection made with the first client (as completing a flow would leave it)
  const olga = h.ctx.db.query("SELECT id FROM users WHERE username='olga'").get() as { id: string }
  const id = crypto.randomUUID(), now = new Date().toISOString(), expires = new Date(Date.now() + 3600_000)
  const sealed = svc.store.seal(olga.id, id, { accessToken: 'a', refreshToken: 'r', expiresAt: expires.getTime() })
  h.ctx.db.query(`INSERT INTO drive_connections (id, user_id, config_key, account, scopes, secret_enc, key_version, status, version, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, '[]', ?, ?, 'connected', 1, ?, ?, ?)`).run(id, olga.id, firstKey, JSON.stringify({ subject: 's', name: 'Olga', email: 'olga@example.com' }), sealed.enc, sealed.keyVersion, expires.toISOString(), now, now)
  expect((await owner.try('GET', '/api/admin/google-drive')).body.connectedMembers).toBe(1)
  expect((await owner.try('GET', '/api/integrations/google-drive')).body.status).toBe('connected')
  const r = await owner.try('PUT', '/api/admin/google-drive/client', { clientId: 'second.apps.googleusercontent.com', clientSecret: SECRET + '-2' })
  expect(r.status).toBe(200)
  expect(r.body.source).toBe('app')
  expect(svc.key).not.toBe(firstKey)
  expect(r.body.connectedMembers).toBe(0)
  expect((await owner.try('GET', '/api/integrations/google-drive')).body.status).toBe('needs_reconnect')
  const rows = h.ctx.db.query("SELECT detail FROM audit_log WHERE action='drive.client_set' ORDER BY id").all() as { detail: string }[]
  expect(rows.map((x) => JSON.parse(x.detail))).toEqual([{ replaced: false }, { replaced: true }])
})

test('a file without this server\'s redirect URI, a desktop client or junk is refused and nothing is written', async () => {
  h = await harness('drive-setup-bad', { tunnel: { host: HOST, allowFrom: [], countries: [] } })
  const owner = await withOwner(h)
  const bad = [
    { file: webClient(['https://other.example/api/integrations/google-drive/callback']) },
    { file: JSON.stringify({ installed: { client_id: 'a', client_secret: SECRET, redirect_uris: ['http://localhost'] } }) },
    { file: 'not json' },
    { file: JSON.stringify({ clientId: 'a', clientSecret: SECRET, redirectUri: 'https://other.example/api/integrations/google-drive/callback' }) },
    { clientId: 'only-the-id' },
    { file: webClient(), clientId: 'both', clientSecret: SECRET },
  ]
  for (const body of bad) expect((await owner.try('PUT', '/api/admin/google-drive/client', body)).status).toBe(400)
  expect(fs.existsSync(path.join(clientDir(h), 'client.json'))).toBe(false)
  expect(googleDriveOf(h.ctx).config).toBeNull()
})

test('the page may not change it: no public address, a hosted server, the operator\'s client file or environment', async () => {
  h = await harness('drive-setup-nohost')
  let owner = await withOwner(h)
  expect((await owner.try('GET', '/api/admin/google-drive')).body).toMatchObject({ canSetUp: false, blocked: 'public_host', redirectUri: null })
  expect((await owner.try('PUT', '/api/admin/google-drive/client', { clientId: 'a', clientSecret: SECRET })).status).toBe(409)
  await h.close()

  h = await harness('drive-setup-hosted', { tunnel: { host: HOST, allowFrom: [], countries: [] }, deployment: 'hosted' })
  owner = await withOwner(h)
  expect((await owner.try('GET', '/api/admin/google-drive')).body).toMatchObject({ canSetUp: false, blocked: 'hosted', redirectUri: null })
  expect((await owner.try('PUT', '/api/admin/google-drive/client', { clientId: 'a', clientSecret: SECRET })).status).toBe(409)
  await h.close()

  // an operator's own client.json (the installer's): shown as "server", left alone
  h = await harness('drive-setup-operator', { tunnel: { host: HOST, allowFrom: [], countries: [] } })
  const dir = clientDir(h)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const d of [path.dirname(path.dirname(dir)), path.dirname(dir), dir]) fs.chmodSync(d, 0o700)
  const operator = JSON.stringify({ clientId: 'operator', clientSecret: 'operator-secret', redirectUri: REDIRECT })
  fs.writeFileSync(path.join(dir, 'client.json'), operator, { mode: 0o600 })
  googleDriveOf(h.ctx).reload()
  owner = await withOwner(h)
  expect((await owner.try('GET', '/api/admin/google-drive')).body).toMatchObject({ configured: true, source: 'server', canSetUp: false, blocked: 'server' })
  expect((await owner.try('PUT', '/api/admin/google-drive/client', { clientId: 'a', clientSecret: SECRET })).status).toBe(409)
  expect(fs.readFileSync(path.join(dir, 'client.json'), 'utf8')).toBe(operator)
  await h.close()

  // MYCEL_GOOGLE_DRIVE_CLIENT_FILE: the operator's file elsewhere, never written by the app
  process.env.MYCEL_GOOGLE_DRIVE_CLIENT_FILE = path.join(dir, 'elsewhere.json')
  h = await harness('drive-setup-env', { tunnel: { host: HOST, allowFrom: [], countries: [] } })
  owner = await withOwner(h)
  expect((await owner.try('GET', '/api/admin/google-drive')).body).toMatchObject({ configured: false, canSetUp: false, blocked: 'server' })
  expect((await owner.try('PUT', '/api/admin/google-drive/client', { clientId: 'a', clientSecret: SECRET })).status).toBe(409)
})

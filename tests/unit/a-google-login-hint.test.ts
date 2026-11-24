// Sign in with Google, part A2 (docs/AGENTS/plan/20261122-0616-google-login-admin.md): with a connected Google account,
// the Google address of the person's own Gmail, Calendar, Docs and Sheets (and Google Drive, a-google-login-admin.test.ts)
// carries login_hint=<that address>, so Google skips its account picker. Not for the account shared with the team, and
// not for anyone without a connected Google account. Fake Google library on 127.0.0.1 only.
import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import { makeCApp, PEOPLE, type CApp } from '../lib/c-app'
import { APP_CLIENT, FakeGoogle, FakeLibrary, sessionRow } from '../lib/fake-google-apps'
import { DRIVE_CONFIG, FakeGoogleDrive } from '../lib/fake-google-drive'
import { googleAppsOf, type GoogleApps } from '../../server/src/integrations/google-apps/service'
import { googleDriveOf } from '../../server/src/integrations/google-drive/oauth'

setDefaultTimeout(30_000)

let A: CApp, lib: FakeLibrary, apps: GoogleApps, i = 0

beforeAll(() => { lib = new FakeLibrary().start(); process.env.MYCEL_GOOGLE_APPS_LIBRARY_URL = lib.url })
afterAll(() => { lib.stop(); delete process.env.MYCEL_GOOGLE_APPS_LIBRARY_URL })
beforeEach(async () => {
  A = await makeCApp('google-login-hint-' + ++i)
  ;(A.ctx.config as any).tunnel = { host: 'team.example.test' }
  apps = googleAppsOf(A.ctx, { fetch: new FakeGoogle(lib).fetch })
  for (const p of PEOPLE) sessionRow(A.ctx.db, p)
})
afterEach(async () => { await A?.close() })

const linked = (user: string, email: string | null) =>
  A.ctx.db.query("INSERT INTO login_identities (user_id, provider, subject, email, linked_at) VALUES (?, 'google', ?, ?, ?)").run(user, `sub-${user}`, email, new Date().toISOString())
const hint = (url: string) => new URL(url).searchParams.get('login_hint')

test("a person's own Google app picks the Google account they sign in with; the team's account does not", async () => {
  const r = await A.json('/api/admin/google-apps/gmail/client', { method: 'PUT', as: 'carol', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId: APP_CLIENT.clientId, clientSecret: APP_CLIENT.clientSecret }) })
  expect(r.status).toBe(200)
  // nobody connected one yet
  expect(hint((await apps.authorize('alice', 'alice-session', 'gmail')).authorizationUrl)).toBeNull()
  linked('alice', 'alice@acme.example')
  linked('carol', 'carol@acme.example')
  const mine = new URL((await apps.authorize('alice', 'alice-session', 'gmail')).authorizationUrl)
  expect(mine.searchParams.get('login_hint')).toBe('alice@acme.example')
  // the rest of the address is as before
  expect(mine.searchParams.get('prompt')).toBe('consent')
  // someone else's connected account is never anyone else's hint
  expect(hint((await apps.authorize('bob', 'bob-session', 'gmail')).authorizationUrl)).toBeNull()
  // the account shared with the team is often another one: no hint, even for an admin who connected theirs
  expect(hint((await apps.authorize('carol', 'carol-session', 'gmail', 'team')).authorizationUrl)).toBeNull()
  // a row without an address gives no hint
  A.ctx.db.query("UPDATE login_identities SET email = NULL WHERE user_id = 'alice'").run()
  expect(hint((await apps.authorize('alice', 'alice-session', 'gmail')).authorizationUrl)).toBeNull()
})

test('Google Drive: the own Drive gets the hint, a Drive shared with the team does not', async () => {
  const drive = googleDriveOf(A.ctx, { config: DRIVE_CONFIG, fetch: new FakeGoogleDrive().fetch, broker: null })
  linked('carol', 'carol@acme.example')
  expect(hint(drive.authorize('carol', 'carol-session').authorizationUrl)).toBe('carol@acme.example')
  expect(hint(drive.authorize('carol', 'carol-session', {}).authorizationUrl)).toBeNull()
  expect(hint(drive.authorize('bob', 'bob-session').authorizationUrl)).toBeNull()
})

// A member asks the owner and the admins to add an app the team has not set up (server/src/integrations/service-
// requests.ts, shared/src/api/service-requests.ts, migration 343). Covered: only the catalog's apps (any other name is
// refused), members only, an app the member can connect (or one turned off for members) refused, one open request per
// member and app ("already", nothing sent twice), the rate limit, one combined notice per owner or admin and app that
// names the newest asker and counts the others, a new ask arming it again, no admin's name in anything the member gets,
// closing on an admin's setup (Google Drive and a Google app) with a quiet "ready" notice to each asker, the admins'
// notice marked read and saying it was added, and requests that expire or whose member left. A fake Google Workspace
// library on 127.0.0.1 only (the Google apps need one to be offered on this computer).
import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import { SERVICE_REQUESTS_PER_DAY } from '@mycel/shared/api'
import { makeCApp, type CApp, type Person } from '../lib/c-app'
import { APP_CLIENT, FakeLibrary } from '../lib/fake-google-apps'
import { serviceRequestsTick, settleServiceRequests } from '../../server/src/integrations/service-requests'
import { googleAppsOf } from '../../server/src/integrations/google-apps/service'
import { newId } from '../../server/src/db'

setDefaultTimeout(30_000)

const HOST = 'team.example.test'
const DRIVE_REDIRECT = `https://${HOST}/api/integrations/google-drive/callback`
// the fixture's people (tests/lib/fixtures.ts): alice, bob and erin are members, carol an admin, dana the owner
const ADMIN_NAMES = ['Carol', 'Dana']
let A: CApp, lib: FakeLibrary, i = 0

beforeAll(() => { lib = new FakeLibrary().start(); process.env.MYCEL_GOOGLE_APPS_LIBRARY_URL = lib.url })
afterAll(() => { lib.stop(); delete process.env.MYCEL_GOOGLE_APPS_LIBRARY_URL })
beforeEach(async () => {
  A = await makeCApp('service-requests-' + ++i)
  ;(A.ctx.config as any).tunnel = { host: HOST }
})
afterEach(async () => { await A?.close() })

const send = (as: Person, method: string, p: string, body?: unknown) =>
  A.json(p, { method, as, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
const ask = (as: Person, service: unknown) => send(as, 'POST', '/api/integrations/service-requests', { service })
const mine = async (as: Person) => (await send(as, 'GET', '/api/integrations/service-requests')).body.items as { service: string; askedAt: string }[]
const inbox = async (as: Person) => (await send(as, 'GET', '/api/notifications')).body.items as any[]
const notices = async (as: Person, code: string) => (await inbox(as)).filter((x) => x.code === code)
const openRows = (service?: string) => (A.ctx.db.query(`SELECT user_id, service FROM service_requests WHERE closed_at IS NULL ${service ? 'AND service = ?' : ''} ORDER BY created_at`).all(...(service ? [service] : [])) as { user_id: string; service: string }[])
const setUpGmail = async (app = 'gmail') => expect((await send('carol', 'PUT', `/api/admin/google-apps/${app}/client`, { clientId: APP_CLIENT.clientId, clientSecret: APP_CLIENT.clientSecret })).status).toBe(200)
const noAdminNames = (text: string) => { for (const n of ADMIN_NAMES) expect(text).not.toContain(n) }

test('only the catalog\'s apps, only members, never an app the member can connect or one turned off for members', async () => {
  // anything but Google Drive and the Google apps: refused before anything is written
  for (const s of ['notion', 'slack', 'https://mcp.notion.com/mcp', '../gmail', 'Gmail', 'gmail ', '<b>gmail</b>', 'x'.repeat(64)]) {
    const r = await ask('alice', s)
    expect({ s, status: r.status, reason: r.body.error?.params?.reason }).toEqual({ s, status: 400, reason: 'unknown_service' })
  }
  for (const s of ['', 'x'.repeat(65), 7, null]) expect((await ask('alice', s)).status).toBe(400)
  expect((await send('alice', 'POST', '/api/integrations/service-requests', { service: 'gmail', note: 'please' })).status).toBe(400)
  // owners and admins set it up themselves
  for (const who of ['carol', 'dana'] as const) {
    const r = await ask(who, 'gmail')
    expect(r.status).toBe(403)
    expect(r.body.error.params.reason).toBe('admin')
    expect(await mine(who)).toEqual([])
  }
  expect(openRows()).toEqual([])
  // an app the member can connect themselves: nothing to ask for
  await setUpGmail('gmail')
  const r = await ask('alice', 'gmail')
  expect(r.status).toBe(409)
  expect(r.body.error.params.reason).toBe('can_connect')
  // set up but turned off for members: the admin chose that, so there is no request to make
  await setUpGmail('docs')
  expect((await send('carol', 'PUT', '/api/admin/google-apps/docs/members', { on: false })).status).toBe(200)
  const off = await ask('alice', 'docs')
  expect(off.status).toBe(409)
  expect(off.body.error.params.reason).toBe('not_requestable')
  expect(openRows()).toEqual([])
  expect(await notices('carol', 'service.request')).toEqual([])
})

test('one open request per member and app; one notice per admin and app naming the newest asker; nothing sent twice', async () => {
  const first = await ask('alice', 'gmail')
  expect(first.status).toBe(200)
  expect(first.body).toMatchObject({ service: 'gmail', state: 'sent' })
  expect(await mine('alice')).toEqual([{ service: 'gmail', askedAt: first.body.askedAt }])
  // the owner and the admin each have one notice, which opens the setup (open), with the asker's name
  for (const who of ['carol', 'dana'] as const) {
    const n = await notices(who, 'service.request')
    expect(n).toHaveLength(1)
    expect(n[0]).toMatchObject({ sourceId: 'gmail', readAt: null, link: null, serviceRequest: { service: 'gmail', name: 'Alice Kim', others: 0, open: true } })
  }
  // members get nothing
  for (const who of ['alice', 'bob'] as const) expect(await notices(who, 'service.request')).toEqual([])
  // asking again (another window, a double tap): "already", the same time, no second row, no second notice
  const again = await ask('alice', 'gmail')
  expect(again.body).toEqual({ service: 'gmail', state: 'already', askedAt: first.body.askedAt })
  expect(openRows('gmail')).toHaveLength(1)
  expect(A.ctx.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'service_request.ask' AND actor_id = 'alice'").get()).toEqual({ n: 1 })
  // the admin reads it; Bob and Erin ask: the same notice, unread again, the newest asker first and the others counted
  const read = (await notices('carol', 'service.request'))[0]
  await send('carol', 'POST', `/api/notifications/${read.id}/read`)
  expect((await notices('carol', 'service.request'))[0].readAt).not.toBeNull()
  await ask('bob', 'gmail')
  await new Promise((r) => setTimeout(r, 5))
  await ask('erin', 'gmail')
  const combined = await notices('carol', 'service.request')
  expect(combined).toHaveLength(1)
  expect(combined[0]).toMatchObject({ id: read.id, readAt: null, serviceRequest: { service: 'gmail', name: 'Erin Yoo', others: 2, open: true } })
  expect(A.ctx.db.query("SELECT COUNT(*) AS n FROM service_request_notices WHERE user_id = 'carol'").get()).toEqual({ n: 1 })
  // another app is another notice
  await ask('alice', 'calendar')
  expect((await notices('dana', 'service.request')).map((x) => x.sourceId).sort()).toEqual(['calendar', 'gmail'])
  expect((await mine('alice')).map((x) => x.service)).toEqual(['gmail', 'calendar'])
})

test('nothing a member gets names an admin', async () => {
  const r = await ask('alice', 'sheets')
  noAdminNames(JSON.stringify(r.body))
  noAdminNames(JSON.stringify(await mine('alice')))
  noAdminNames(JSON.stringify((await ask('alice', 'sheets')).body))
  await setUpGmail('sheets')
  const all = await inbox('alice')
  const ready = all.filter((x) => x.code === 'service.ready')
  expect(ready).toHaveLength(1)
  expect(ready[0].serviceRequest).toEqual({ service: 'sheets' })
  noAdminNames(JSON.stringify(all))
  // a refused ask says why with a code, not with someone's name
  noAdminNames(JSON.stringify((await ask('alice', 'sheets')).body))
})

test(`at most ${SERVICE_REQUESTS_PER_DAY} requests a member a day`, async () => {
  const day = new Date(Date.now() - 3600_000).toISOString()
  for (let n = 0; n < SERVICE_REQUESTS_PER_DAY; n++) {
    A.ctx.db.query("INSERT INTO service_requests (id, user_id, service, created_at, closed_at, closed_reason) VALUES (?, 'erin', 'gmail', ?, ?, 'expired')").run(newId(), day, day)
  }
  const r = await ask('erin', 'calendar')
  expect(r.status).toBe(429)
  expect(r.body.error.params.reason).toBe('rate_limited')
  expect(openRows()).toEqual([])
  expect(await notices('carol', 'service.request')).toEqual([])
  // another member is not held back, and yesterday's requests do not count
  expect((await ask('bob', 'calendar')).status).toBe(200)
  A.ctx.db.query("UPDATE service_requests SET created_at = ? WHERE user_id = 'erin'").run(new Date(Date.now() - 25 * 3600_000).toISOString())
  expect((await ask('erin', 'calendar')).body.state).toBe('sent')
})

test('a Google app set up: the requests close, each asker gets one quiet notice, the admins\' notice is read and says added', async () => {
  await ask('alice', 'gmail')
  await ask('bob', 'gmail')
  await ask('bob', 'calendar')
  await setUpGmail('gmail')
  expect(openRows().map((r) => `${r.user_id}:${r.service}`)).toEqual(['bob:calendar'])
  expect(await mine('alice')).toEqual([])
  expect((await mine('bob')).map((x) => x.service)).toEqual(['calendar'])
  for (const who of ['alice', 'bob'] as const) {
    const ready = await notices(who, 'service.ready')
    expect(ready).toHaveLength(1)
    expect(ready[0]).toMatchObject({ readAt: null, link: null, serviceRequest: { service: 'gmail' } })
  }
  // never pushed: no delivery row for a push
  expect(A.ctx.db.query('SELECT COUNT(*) AS n FROM push_deliveries').get()).toEqual({ n: 0 })
  const done = (await notices('carol', 'service.request')).find((x) => x.sourceId === 'gmail')
  expect(done).toMatchObject({ serviceRequest: { service: 'gmail', name: 'Bob Lee', others: 1, open: false, added: true } })
  expect(done.readAt).not.toBeNull()
  // calendar still waits
  expect((await notices('carol', 'service.request')).find((x) => x.sourceId === 'calendar')).toMatchObject({ readAt: null, serviceRequest: { open: true, name: 'Bob Lee' } })
  // a second pass changes nothing (one notice each)
  expect(settleServiceRequests(A.ctx)).toBe(0)
  expect(await notices('alice', 'service.ready')).toHaveLength(1)
})

test('Google Drive set up in Admin › Connected apps closes its requests; turned off for members it waits for the switch', async () => {
  const before = await send('alice', 'GET', '/api/integrations/google-drive')
  expect(before.body.configured).toBe(false)
  expect((await ask('alice', 'google-drive')).body.state).toBe('sent')
  // the members' switch off first: set up, but members still cannot connect it, so the request waits
  expect((await send('dana', 'PUT', '/api/admin/google-drive/members', { on: false })).status).toBe(200)
  const file = JSON.stringify({ web: { client_id: 'synthetic-drive.apps.googleusercontent.com', client_secret: 'CANARY-drive-secret-41', redirect_uris: [DRIVE_REDIRECT] } })
  expect((await send('dana', 'PUT', '/api/admin/google-drive/client', { file })).status).toBe(200)
  expect(openRows('google-drive')).toHaveLength(1)
  expect(await notices('alice', 'service.ready')).toEqual([])
  // and nobody can ask for it now: it is not "not set up"
  expect((await ask('bob', 'google-drive')).body.error.params.reason).toBe('not_requestable')
  expect((await send('dana', 'PUT', '/api/admin/google-drive/members', { on: true })).status).toBe(200)
  expect(openRows('google-drive')).toEqual([])
  expect((await notices('alice', 'service.ready'))[0]).toMatchObject({ serviceRequest: { service: 'google-drive' } })
  expect((await notices('dana', 'service.request'))[0]).toMatchObject({ serviceRequest: { service: 'google-drive', open: false, added: true } })
  noAdminNames(JSON.stringify(await inbox('alice')))
})

test('requests expire after 30 days and close when their member leaves or becomes an admin; then they may ask again', async () => {
  await ask('alice', 'gmail')
  await ask('bob', 'gmail')
  await ask('erin', 'calendar')
  A.ctx.db.query("UPDATE service_requests SET created_at = ? WHERE user_id = 'erin'").run(new Date(Date.now() - 31 * 86_400_000).toISOString())
  A.ctx.db.query("UPDATE users SET deleted_at = ? WHERE id = 'alice'").run(new Date().toISOString())
  A.ctx.db.query("UPDATE users SET role = 'admin' WHERE id = 'bob'").run()
  expect(settleServiceRequests(A.ctx)).toBe(3)
  expect(A.ctx.db.query('SELECT user_id, closed_reason FROM service_requests ORDER BY user_id').all()).toEqual([
    { user_id: 'alice', closed_reason: 'left' }, { user_id: 'bob', closed_reason: 'left' }, { user_id: 'erin', closed_reason: 'expired' },
  ])
  // nobody is told it is ready, and the admins' notices count as read
  for (const who of ['alice', 'bob', 'erin'] as const) expect(A.ctx.db.query("SELECT COUNT(*) AS n FROM service_request_notices WHERE user_id = ? AND event_type = 'service.ready'").get(who)).toEqual({ n: 0 })
  const carol = await notices('carol', 'service.request')
  expect(carol.every((x) => x.readAt !== null && x.serviceRequest.open === false && !x.serviceRequest.added)).toBe(true)
  // an expired request is no longer "already": Erin may ask again
  expect((await ask('erin', 'calendar')).body.state).toBe('sent')
})

test('someone who is no longer an owner or admin sees the app only, without the names', async () => {
  await ask('alice', 'gmail')
  A.ctx.db.query("UPDATE users SET role = 'member' WHERE id = 'carol'").run()
  const n = (await notices('carol', 'service.request'))[0]
  expect(n.serviceRequest).toEqual({ service: 'gmail' })
  expect(JSON.stringify(n)).not.toContain('Alice')
  // an unknown app id in an old row is shown as nothing
  A.ctx.db.query("INSERT INTO service_request_notices (id, user_id, event_type, source_id, created_at) VALUES (?, 'dana', 'service.request', 'notion', ?)").run(newId(), new Date().toISOString())
  const odd = (await notices('dana', 'service.request')).find((x) => x.sourceId === 'notion')
  expect(odd.serviceRequest).toBeUndefined()
})

test('the 30-second check: a setup made elsewhere closes the requests; the admins\' notices follow who is an owner or admin now', async () => {
  await ask('alice', 'calendar')
  await ask('bob', 'gmail')
  // set up without the route (as an operator or another server process would): the check closes it
  googleAppsOf(A.ctx).setClient('carol', 'calendar', { clientId: APP_CLIENT.clientId, clientSecret: APP_CLIENT.clientSecret })
  expect(openRows('calendar')).toHaveLength(1)
  serviceRequestsTick(A.ctx)
  expect(openRows('calendar')).toEqual([])
  expect((await notices('alice', 'service.ready'))[0]).toMatchObject({ serviceRequest: { service: 'calendar' } })
  // Carol is no longer an admin: her notices go (nothing there is hers to do); Erin became one: she gets the open app's
  A.ctx.db.query("UPDATE users SET role = 'member' WHERE id = 'carol'").run()
  A.ctx.db.query("UPDATE users SET role = 'admin' WHERE id = 'erin'").run()
  serviceRequestsTick(A.ctx)
  expect(A.ctx.db.query("SELECT COUNT(*) AS n FROM service_request_notices WHERE user_id = 'carol'").get()).toEqual({ n: 0 })
  expect(A.ctx.db.query("SELECT source_id, read_at FROM service_request_notices WHERE user_id = 'erin' AND event_type = 'service.request'").all()).toEqual([{ source_id: 'gmail', read_at: null }])
  // the owner's stay; a second pass adds nothing
  serviceRequestsTick(A.ctx)
  expect(A.ctx.db.query("SELECT COUNT(*) AS n FROM service_request_notices WHERE event_type = 'service.request'").get()).toEqual({ n: 3 })
})

test('an app whose setup is not the admins\' to make cannot be asked for: a hosted team, an operator\'s file', async () => {
  const env = 'MYCEL_GOOGLE_SHEETS_CLIENT_FILE'
  process.env[env] = '/nonexistent/acme-sheets-client.json'
  try {
    const r = await ask('alice', 'sheets')
    expect(r.status).toBe(409)
    expect(r.body.error.params.reason).toBe('not_requestable')
  } finally { delete process.env[env] }
  ;(A.ctx.config as any).deployment = 'hosted'
  for (const s of ['gmail', 'google-drive']) {
    const r = await ask('alice', s)
    expect({ s, status: r.status, reason: r.body.error.params.reason }).toEqual({ s, status: 409, reason: 'not_requestable' })
  }
  expect(openRows()).toEqual([])
})

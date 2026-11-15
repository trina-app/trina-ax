// QA TC-2945: "A connection needs you to sign in again" (Settings › Notifications) was only ever sent for Google Drive.
// A person's own connection (here one added by its address, with a key) that was working and turns to "needs sign-in"
// now tells its owner too (server/src/integrations/connections/service.ts tellSignInAgain): one Inbox row naming it
// that opens its page, once per move from connected into needs sign-in, none while the last one is unread, never
// to anyone else, not for a connection that never worked, and not for a team connection. A fake MCP server on
// 127.0.0.1 (tests/lib/fake-services.ts, net testAllow) answers 401 when told to.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { makeCApp, type CApp, type Person } from '../lib/c-app'
import { FakeServices, MCP_KEY } from '../lib/fake-services'
import { integrationsOf } from '../../server/src/integrations/connections/service'

setDefaultTimeout(30_000)

let A: CApp, fake: FakeServices
beforeAll(async () => {
  A = await makeCApp('c-connection-reconnect-notice')
  fake = new FakeServices()
  integrationsOf(A.ctx, { net: fake.net() })
})
afterAll(async () => { fake?.stop(); await A?.close() })
afterEach(() => { fake.listStatus = null })

const send = (as: Person, method: string, p: string, body?: unknown) =>
  A.json(p, { method, as, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
const reconnects = async (as: Person) => ((await send(as, 'GET', '/api/notifications')).body.items as any[]).filter((x) => x.code === 'connection.reconnect')
const check = async (as: Person, id: string) => (await send(as, 'POST', `/api/integrations/${id}/refresh`, {})).body

test('a working connection that turns to needs sign-in tells its owner once, by name, with its page', async () => {
  const made = await send('alice', 'POST', '/api/integrations', { kind: 'mcp', name: 'Tasks', url: `${fake.base}/mcp-key`, auth: 'bearer', secret: MCP_KEY })
  expect(made.body.status).toBe('connected')
  const id = made.body.id as string
  expect(await reconnects('alice')).toEqual([])

  // the service stops taking the key
  fake.listStatus = 401
  expect((await check('alice', id)).status).toBe('needs_auth')
  let n = await reconnects('alice')
  expect(n.length).toBe(1)
  expect(n[0]).toMatchObject({ link: 'connections', readAt: null, connection: { id, name: 'Tasks', googleApp: null } })
  expect(n[0].sourceId.startsWith(`${id}_`)).toBe(true)
  // the notice carries no key, address or error words
  expect(JSON.stringify(n[0])).not.toContain(MCP_KEY)
  expect(JSON.stringify(n[0])).not.toContain(fake.base)
  // shown (not held back): the setting is on by default, so it rings and is pushed like Google Drive's
  expect(A.ctx.db.query("SELECT suppressed FROM notification_inbox WHERE event_type='connection.reconnect' AND user_id='alice'").all()).toEqual([{ suppressed: 0 }])

  // still refused: no second notice (no move into needs sign-in)
  await check('alice', id)
  expect((await reconnects('alice')).length).toBe(1)
  // working again, then refused again while the first is unread: still one
  fake.listStatus = null
  expect((await check('alice', id)).status).toBe('connected')
  fake.listStatus = 401
  await check('alice', id)
  expect((await reconnects('alice')).length).toBe(1)
  // read it: the next time it stops working is a new notice
  expect((await send('alice', 'POST', `/api/notifications/${n[0].id}/read`)).status).toBe(200)
  fake.listStatus = null
  await check('alice', id)
  fake.listStatus = 401
  await check('alice', id)
  n = await reconnects('alice')
  expect(n.length).toBe(2)
  expect(n.filter((x) => x.readAt === null).length).toBe(1)

  // nobody else hears of it, admins included
  for (const who of ['bob', 'carol', 'dana'] as const) expect(await reconnects(who)).toEqual([])

  // once the connection is deleted its notice stays, as the generic line without its name or page
  expect((await send('alice', 'DELETE', `/api/integrations/${id}`)).status).toBe(204)
  expect((await reconnects('alice')).every((x) => x.connection === undefined)).toBe(true)
})

test('not for a connection that never worked, nor for one whose key was just changed', async () => {
  // a wrong key from the start: the person is there and the page says so; no notice
  fake.listStatus = 401
  const made = await send('bob', 'POST', '/api/integrations', { kind: 'mcp', name: 'Wrong key', url: `${fake.base}/mcp-key`, auth: 'bearer', secret: 'not-the-key' })
  expect(made.body.status).toBe('needs_auth')
  await check('bob', made.body.id)
  expect(await reconnects('bob')).toEqual([])
  // working, then edited with a wrong key: the edit's own check, no notice
  fake.listStatus = null
  const ok = await send('bob', 'POST', '/api/integrations', { kind: 'mcp', name: 'Edited', url: `${fake.base}/mcp-key`, auth: 'bearer', secret: MCP_KEY })
  expect(ok.body.status).toBe('connected')
  const edited = await send('bob', 'PATCH', `/api/integrations/${ok.body.id}`, { secret: 'not-the-key' })
  expect(edited.body.status).toBe('needs_auth')
  expect(await reconnects('bob')).toEqual([])
})

test('a team connection that needs a sign-in tells nobody (who should hear is an admin question, left open)', async () => {
  const made = await send('carol', 'POST', '/api/admin/integrations', { kind: 'mcp', name: 'Team tasks', url: `${fake.base}/mcp-key`, auth: 'bearer', secret: MCP_KEY })
  expect(made.body.status).toBe('connected')
  fake.listStatus = 401
  expect((await check('carol', made.body.id)).status).toBe('needs_auth')
  for (const who of ['alice', 'bob', 'carol', 'dana', 'erin'] as const) expect((await reconnects(who)).filter((x) => x.connection?.id === made.body.id || x.sourceId.startsWith(made.body.id))).toEqual([])
})

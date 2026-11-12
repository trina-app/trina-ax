// QA TC-133: a member asks the owner and the admins to add any service of the app's list (shared/src/service-catalog.ts,
// by its id), not only Google Drive and the Google apps (server/src/integrations/service-requests.ts). Covered: a listed
// id is asked for and its address or name is refused; the owner and the admins get the notice and see the open requests
// (GET /api/admin/service-requests, admins only); a member takes their own request back (it still counts toward the day's
// limit, and the admins' notice is read once none is left); an admin dismisses them (nobody is told, they may ask
// again); a team connection to the service's official address closes the requests of the members who may use it (each
// is told, 'service.ready') and leaves the others open; then asking is refused as can_connect. A member's own
// connection to it does not stop the ask (the request is for the team's).
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import { makeCApp, type CApp, type Person } from '../lib/c-app'

setDefaultTimeout(30_000)

let A: CApp, i = 0
beforeEach(async () => { A = await makeCApp('service-requests-catalog-' + ++i) })
afterEach(async () => { await A?.close() })

const send = (as: Person, method: string, p: string, body?: unknown) =>
  A.json(p, { method, as, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
const ask = (as: Person, service: unknown) => send(as, 'POST', '/api/integrations/service-requests', { service })
const mine = async (as: Person) => (await send(as, 'GET', '/api/integrations/service-requests')).body.items as { service: string }[]
const notices = async (as: Person, code: string) => ((await send(as, 'GET', '/api/notifications')).body.items as any[]).filter((x) => x.code === code)
const teamList = async (as: Person = 'carol') => (await send(as, 'GET', '/api/admin/service-requests')).body.items as { service: string; askers: { id: string; name: string }[] }[]
const team = (access: unknown) => send('carol', 'POST', '/api/admin/integrations', { kind: 'mcp', name: 'Notion', url: 'https://mcp.notion.com/mcp', auth: 'oauth', writePolicy: 'ask', access })

test('a listed service is asked for by its id; the admins get the notice and see who asked; members cannot read that list', async () => {
  const r = await ask('alice', 'notion')
  expect(r.status).toBe(200)
  expect(r.body).toMatchObject({ service: 'notion', state: 'sent' })
  expect((await ask('erin', 'linear')).body.state).toBe('sent')
  expect((await ask('erin', 'notion')).body.state).toBe('sent')
  for (const who of ['carol', 'dana'] as const) {
    const n = await notices(who, 'service.request')
    expect(n.map((x) => x.serviceRequest.service).sort()).toEqual(['linear', 'notion'])
  }
  const list = await teamList()
  expect(list.find((x) => x.service === 'notion')!.askers.map((a) => a.id)).toEqual(['erin', 'alice'])
  expect(list.find((x) => x.service === 'linear')!.askers.map((a) => a.id)).toEqual(['erin'])
  expect((await send('alice', 'GET', '/api/admin/service-requests')).status).toBe(403)
  // never an address or a display name: only the id
  for (const s of ['https://mcp.notion.com/mcp', 'Notion', 'mcp.notion.com']) expect((await ask('alice', s)).status).toBe(400)
})

test('a member takes their own request back: the admins\' list and notice follow; it still counts toward the day\'s limit', async () => {
  await ask('alice', 'notion')
  const r = await send('alice', 'DELETE', '/api/integrations/service-requests/notion')
  expect(r.status).toBe(204)
  expect(await mine('alice')).toEqual([])
  expect(await teamList()).toEqual([])
  expect((await notices('carol', 'service.request'))[0].readAt).not.toBeNull()
  expect(A.ctx.db.query("SELECT 1 FROM audit_log WHERE action = 'service_request.withdraw'").get()).toBeTruthy()
  // nothing open: nothing happens; an unknown id is refused
  expect((await send('alice', 'DELETE', '/api/integrations/service-requests/notion')).status).toBe(204)
  expect((await send('alice', 'DELETE', '/api/integrations/service-requests/slack')).status).toBe(400)
  // another member's request is not theirs to take back
  await ask('erin', 'notion')
  await send('alice', 'DELETE', '/api/integrations/service-requests/notion')
  expect((await mine('erin')).map((x) => x.service)).toEqual(['notion'])
  // asking and taking back cannot go round the limit: the withdrawn ones count
  for (let n = 0; n < 9; n++) { await ask('alice', 'linear'); await send('alice', 'DELETE', '/api/integrations/service-requests/linear') }
  expect((await ask('alice', 'figma')).status).toBe(429)
})

test('an admin dismisses the requests for a service: nobody is told, they may ask again; members cannot dismiss', async () => {
  await ask('alice', 'notion')
  expect((await send('alice', 'POST', '/api/admin/service-requests/notion/dismiss', {})).status).toBe(403)
  expect((await send('carol', 'POST', '/api/admin/service-requests/notion/dismiss', {})).status).toBe(204)
  expect(await teamList()).toEqual([])
  expect(await mine('alice')).toEqual([])
  expect(await notices('alice', 'service.ready')).toEqual([])
  expect(A.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'service_request.dismiss'").get()).toEqual({ detail: JSON.stringify({ service: 'notion', requests: 1 }) })
  expect((await ask('alice', 'notion')).body.state).toBe('sent')
})

test('a team connection to its official address closes the requests of those who may use it, who are told; the others wait', async () => {
  await ask('alice', 'notion')
  await ask('erin', 'notion')
  // only erin may use the team's Notion
  const t = await team({ everyone: false, groups: [], users: ['erin'] })
  expect(t.status).toBe(201)
  expect((await mine('erin'))).toEqual([])
  expect((await notices('erin', 'service.ready')).map((x) => x.serviceRequest.service)).toEqual(['notion'])
  expect((await mine('alice')).map((x) => x.service)).toEqual(['notion'])
  expect((await ask('erin', 'notion')).body.error.params.reason).toBe('can_connect')
  // the admin lets everyone use it: alice's closes too
  expect((await send('carol', 'PATCH', `/api/integrations/${t.body.id}`, { access: { everyone: true, groups: [], users: [] } })).status).toBe(200)
  expect(await mine('alice')).toEqual([])
  expect((await notices('alice', 'service.ready'))).toHaveLength(1)
  expect(await teamList()).toEqual([])
})

test('a member\'s own connection to the service does not stop the ask for the team\'s', async () => {
  A.ctx.db.query("INSERT INTO settings (key, value) VALUES ('personalIntegrations', 'true') ON CONFLICT(key) DO UPDATE SET value='true'").run()
  const own = await send('alice', 'POST', '/api/integrations', { kind: 'mcp', name: 'Notion', url: 'https://mcp.notion.com/mcp', auth: 'oauth', writePolicy: 'ask' })
  expect(own.status).toBe(201)
  expect((await ask('alice', 'notion')).body.state).toBe('sent')
})

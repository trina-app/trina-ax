// An admin asks a member to connect a service as the member's own connection (server/src/integrations/connections/
// requests.ts, docs/INTEGRATIONS.md "Asking a member to connect"): only admins ask; only the member asked sees, answers
// or declines it (admins and the owner of the team get 404); the key goes through the member's own create path and never
// reaches an admin (responses, audit, inbox, database, logs); the connection is the member's alone, checked on every
// call; a sign-in request connects when the sign-in finishes; withdraw and the 7-day expiry end it. Fake services only.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { API_KEY, FakeServices, MCP_KEY } from '../lib/fake-services'
import { CallError, integrationsOf } from '../../server/src/integrations/connections/service'
import { getRow, mayUse } from '../../server/src/integrations/connections/store'
import { createLogger } from '../../server/src/log'

setDefaultTimeout(30_000)

let h: Harness, fake: FakeServices
let olga: Client, ada: Client, bob: Client, cara: Client
let ids: Record<'olga' | 'ada' | 'bob' | 'cara', string>
let shift = 0
const logs: string[] = []

beforeAll(async () => {
  fake = new FakeServices()
  h = await harness('c-int-requests', {}, { log: createLogger({ level: 'debug', sink: (l) => logs.push(l) }) })
  olga = await withOwner(h)
  const a = await addMember(h, olga, { username: 'ada', role: 'admin' })
  const b = await addMember(h, olga, { username: 'bob' })
  const c = await addMember(h, olga, { username: 'cara' })
  ada = a.client; bob = b.client; cara = c.client
  ids = { olga: (await olga.call('GET', '/api/me')).user.id, ada: a.id, bob: b.id, cara: c.id }
  fake.now = Date.now()
  integrationsOf(h.ctx, { net: fake.net(), now: () => Date.now() + shift })
})
afterAll(async () => { await h?.close(); fake?.stop() })

const ask = (by: Client, body: Record<string, unknown>) => by.try('POST', '/api/admin/integration-requests', body)
const mcpKey = () => ({ userId: ids.bob, kind: 'mcp', name: 'Tasks', url: `${fake.base}/mcp-key`, auth: 'bearer' })
const adminList = async (as: Client = ada) => (await as.call('GET', '/api/admin/integration-requests')).items as any[]
const stateOf = async (id: string) => (await adminList()).find((r) => r.id === id)?.state
const everything = () => ['integrations', 'integration_requests', 'integration_request_notices', 'audit_log', 'notification_inbox']
  .map((t) => JSON.stringify(h.ctx.db.query(`SELECT * FROM ${t}`).all())).join('\n') + logs.join('\n')

describe('asking', () => {
  test('a member, or anyone signed out, cannot ask; an admin can, and the member gets a notice and a link', async () => {
    expect((await ask(bob, mcpKey())).status).toBe(403)
    expect((await h.client().try('POST', '/api/admin/integration-requests', mcpKey())).status).toBe(401)
    expect((await bob.try('GET', '/api/admin/integration-requests')).status).toBe(403)
    const before = Date.now()
    const r = await ask(ada, mcpKey())
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ kind: 'mcp', name: 'Tasks', url: `${fake.base}/mcp-key`, auth: 'bearer', state: 'waiting', endedAt: null, user: { id: ids.bob, name: 'BOB' }, requestedBy: { id: ids.ada, name: 'ADA' } })
    expect(r.body.link).toBe(`http://team.localhost/settings/integrations?request=${r.body.id}`)
    const days = (Date.parse(r.body.expiresAt) - Date.parse(r.body.createdAt)) / 86_400_000
    expect(days).toBe(7)
    expect(Date.parse(r.body.createdAt)).toBeGreaterThanOrEqual(before - 1000)
    // the member's inbox (no setting turns it off) and a live banner with the way to it; nobody else hears of it
    const inbox = await bob.call('GET', '/api/notifications')
    expect(inbox.items).toContainEqual(expect.objectContaining({ eventType: 'integration.request', sourceId: r.body.id, link: 'integrations', chatId: null }))
    expect((await cara.call('GET', '/api/notifications')).items.some((n: any) => n.sourceId === r.body.id)).toBe(false)
    const banner = h.hub.events.find((e) => e.kind === 'publish' && e.target === ids.bob && (e.data as any).data?.code === 'integration_request') as any
    expect(banner.data.data.link).toBe(`/settings/integrations?request=${r.body.id}`)
    expect(banner.data.data.message).toContain('Tasks')
    expect(h.hub.events.some((e) => e.kind === 'publish' && e.target !== ids.bob && (e.data as any).data?.code === 'integration_request')).toBe(false)
    // the member sees it waiting
    expect((await bob.call('GET', '/api/integration-requests')).items.map((x: any) => x.id)).toEqual([r.body.id])
    expect((await cara.call('GET', '/api/integration-requests')).items).toEqual([])
    // activity log: who asked whom, for which service (the admin's own words; a request holds no key)
    const a = h.ctx.db.query("SELECT actor_id, detail FROM audit_log WHERE action = 'integration_request.create' AND target = ?").get(r.body.id) as { actor_id: string; detail: string }
    expect(a.actor_id).toBe(ids.ada)
    expect(JSON.parse(a.detail)).toEqual({ user: ids.bob, kind: 'mcp', name: 'Tasks', host: new URL(fake.base).host, auth: 'bearer' })
    // one waiting request per member and address
    const again = await ask(ada, mcpKey())
    expect(again.status).toBe(409)
    // the owner of the team is an admin too
    const owner = await ask(olga, { ...mcpKey(), userId: ids.cara, url: `${fake.base}/mcp-key?team=1` })
    expect(owner.status).toBe(201)
    expect((await ada.call('POST', `/api/admin/integration-requests/${owner.body.id}/withdraw`, {})).state).toBe('withdrawn')
  })

  test('what may be asked: a key or a sign-in (no "none"), sign-in for MCP only, a public address, a member of the team', async () => {
    const bad = async (body: Record<string, unknown>, field: string) => {
      const r = await ask(ada, body)
      expect(r.status, JSON.stringify(body)).toBe(400)
      expect(Object.keys(r.body.error.fields ?? {}).some((k) => k.startsWith(`body.${field}`)), JSON.stringify(r.body)).toBe(true)
    }
    await bad({ ...mcpKey(), auth: 'none', url: `${fake.base}/mcp-open` }, 'auth')
    await bad({ ...mcpKey(), kind: 'http', auth: 'oauth' }, 'auth')
    await bad({ ...mcpKey(), auth: 'header' }, 'authHeader')
    await bad({ ...mcpKey(), auth: 'header', authHeader: 'Host' }, 'authHeader')
    await bad({ ...mcpKey(), url: 'https://10.0.0.1/mcp' }, 'url')
    await bad({ ...mcpKey(), url: 'http://example.com/mcp' }, 'url')
    await bad({ ...mcpKey(), userId: 'nobody' }, 'userId')
    // a request never carries a key: one sent with it is refused, not quietly dropped
    const key = await ask(ada, { ...mcpKey(), userId: ids.cara, secret: MCP_KEY })
    expect(key.status).toBe(400)
    expect(JSON.stringify(key.body)).not.toContain(MCP_KEY)
    expect(h.ctx.db.query('SELECT count(*) AS n FROM integration_requests WHERE user_id = ?').get(ids.cara)).toEqual({ n: 1 })
    // the member's connection is made where they add their own: refused while the team does not allow that
    await olga.call('PATCH', '/api/admin/settings', { personalIntegrations: false })
    try {
      const off = await ask(ada, { ...mcpKey(), userId: ids.cara })
      expect(off.status).toBe(409)
    } finally { await olga.call('PATCH', '/api/admin/settings', { personalIntegrations: true }) }
  })
})

describe('answering with a key', () => {
  let req: any, conn: any
  test('only the member asked sees and answers it: other members, admins and the owner of the team get 404', async () => {
    req = (await adminList()).find((r) => r.user.id === ids.bob && r.state === 'waiting' && r.name === 'Tasks')
    expect(req).toBeDefined()
    for (const who of [cara, ada, olga]) {
      expect((await who.try('GET', `/api/integration-requests/${req.id}`)).status).toBe(404)
      expect((await who.try('POST', `/api/integration-requests/${req.id}/complete`, { secret: MCP_KEY })).status).toBe(404)
      expect((await who.try('POST', `/api/integration-requests/${req.id}/decline`, {})).status).toBe(404)
    }
    expect(h.ctx.db.query("SELECT count(*) AS n FROM integrations WHERE scope = 'personal'").get()).toEqual({ n: 0 })
    expect(await stateOf(req.id)).toBe('waiting')
    expect(await bob.call('GET', `/api/integration-requests/${req.id}`)).toMatchObject({ id: req.id, state: 'waiting' })
  })

  test('the key is required, "run without asking" stays the team\'s, then it is the member\'s own connection', async () => {
    const none = await bob.try('POST', `/api/integration-requests/${req.id}/complete`, {})
    expect(none.status).toBe(400)
    expect(Object.keys(none.body.error.fields)).toEqual(['body.secret'])
    expect((await bob.try('POST', `/api/integration-requests/${req.id}/complete`, { secret: MCP_KEY, writePolicy: 'allow' })).status).toBe(400)
    expect((await bob.try('POST', `/api/integration-requests/${req.id}/complete`, { secret: MCP_KEY, extra: 1 })).status).toBe(400)
    expect(await stateOf(req.id)).toBe('waiting')
    const r = await bob.try('POST', `/api/integration-requests/${req.id}/complete`, { secret: MCP_KEY, writePolicy: 'deny' })
    expect(r.status).toBe(200)
    conn = r.body
    // made through the member's own create path: checked at once, the service's tools saved, the key never shown
    expect(conn).toMatchObject({ scope: 'personal', kind: 'mcp', name: 'Tasks', url: `${fake.base}/mcp-key`, auth: 'bearer', status: 'connected', hasSecret: true, writePolicy: 'deny', canManage: true, access: null })
    expect(conn.tools.map((t: any) => t.name)).toContain('search_tasks')
    expect(JSON.stringify(r.body)).not.toContain(MCP_KEY)
    expect(getRow(h.ctx.db, conn.id)).toMatchObject({ owner_user_id: ids.bob, created_by: ids.bob })
    expect((await bob.call('GET', '/api/integrations')).items.map((i: any) => i.id)).toContain(conn.id)
    expect((await bob.call('GET', '/api/integration-requests')).items).toEqual([])
    // the admin sees that it is connected, and nothing of the connection itself
    const seen = (await adminList()).find((x) => x.id === req.id)
    expect(seen).toMatchObject({ state: 'connected' })
    expect(Date.parse(seen.endedAt)).toBeGreaterThan(0)
    const audit = h.ctx.db.query("SELECT actor_id, detail FROM audit_log WHERE action = 'integration_request.complete' AND target = ?").get(req.id) as { actor_id: string; detail: string }
    expect(audit.actor_id).toBe(ids.bob)
    // the connection's own entry, as for one the member adds: without its name or address
    const created = h.ctx.db.query("SELECT actor_id, detail FROM audit_log WHERE action = 'integration.create' AND target = ?").get(conn.id) as { actor_id: string; detail: string }
    expect(created.actor_id).toBe(ids.bob)
    expect(JSON.parse(created.detail)).toEqual({ scope: 'personal', kind: 'mcp', auth: 'bearer' })
    // answered once: a second answer makes nothing
    const twice = await bob.try('POST', `/api/integration-requests/${req.id}/complete`, { secret: MCP_KEY })
    expect(twice.status).toBe(409)
    expect(twice.body.error.params).toEqual({ state: 'connected' })
    expect(h.ctx.db.query("SELECT count(*) AS n FROM integrations WHERE scope = 'personal'").get()).toEqual({ n: 1 })
  })

  test('the admin never gets the key, and cannot see, change or use the member\'s connection; who may use it is checked on every call', async () => {
    const adminViews = [
      await ada.call('GET', '/api/admin/integration-requests'),
      await ada.call('GET', '/api/admin/integrations'),
      await ada.call('GET', '/api/integrations'),
      await ada.call('GET', '/api/admin/audit?limit=200'),
      await ada.call('GET', '/api/notifications'),
      await olga.call('GET', '/api/admin/audit?limit=200'),
    ]
    for (const v of adminViews) expect(JSON.stringify(v)).not.toContain(MCP_KEY)
    expect(JSON.stringify(adminViews.slice(1, 3))).not.toContain(conn.id)
    expect((await ada.try('PATCH', `/api/integrations/${conn.id}`, { name: 'mine' })).status).toBe(404)
    expect((await ada.try('POST', `/api/integrations/${conn.id}/refresh`, {})).status).toBe(404)
    expect((await olga.try('DELETE', `/api/integrations/${conn.id}`)).status).toBe(404)
    expect(everything()).not.toContain(MCP_KEY)
    const row = getRow(h.ctx.db, conn.id)!
    expect(mayUse(h.ctx.db, row, ids.bob)).toBe(true)
    for (const who of [ids.ada, ids.olga, ids.cara]) {
      expect(mayUse(h.ctx.db, row, who)).toBe(false)
      expect(() => integrationsOf(h.ctx).forCall(who, conn.id)).toThrow(CallError)
    }
    expect(integrationsOf(h.ctx).forCall(ids.bob, conn.id).id).toBe(conn.id)
    // and it stays a personal connection: the team switch takes it out of the member's chats too
    await olga.call('PATCH', '/api/admin/settings', { personalIntegrations: false })
    try { expect(() => integrationsOf(h.ctx).forCall(ids.bob, conn.id)).toThrow(CallError) }
    finally { await olga.call('PATCH', '/api/admin/settings', { personalIntegrations: true }) }
  })
})

describe('ending a request', () => {
  const api = () => ({ userId: ids.cara, kind: 'http', name: 'Ledger', url: `${fake.base}/hdr/v1`, auth: 'header', authHeader: 'X-API-Key', notes: 'GET /tasks lists tasks' })

  test('an admin withdraws it: the member can no longer answer or decline it; a member cannot withdraw', async () => {
    const r = (await ask(ada, api())).body
    expect(r).toMatchObject({ auth: 'header', authHeader: 'X-API-Key', notes: 'GET /tasks lists tasks' })
    expect((await bob.try('POST', `/api/admin/integration-requests/${r.id}/withdraw`, {})).status).toBe(403)
    expect((await cara.try('POST', `/api/admin/integration-requests/${r.id}/withdraw`, {})).status).toBe(403)
    const w = await ada.call('POST', `/api/admin/integration-requests/${r.id}/withdraw`, {})
    expect(w).toMatchObject({ state: 'withdrawn' })
    expect(w.endedAt).not.toBeNull()
    const audit = h.ctx.db.query("SELECT actor_id FROM audit_log WHERE action = 'integration_request.withdraw' AND target = ?").get(r.id) as { actor_id: string }
    expect(audit.actor_id).toBe(ids.ada)
    const done = await cara.try('POST', `/api/integration-requests/${r.id}/complete`, { secret: API_KEY })
    expect(done.status).toBe(409)
    expect(done.body.error.params).toEqual({ state: 'withdrawn' })
    expect((await cara.try('POST', `/api/integration-requests/${r.id}/decline`, {})).status).toBe(409)
    expect((await ada.try('POST', `/api/admin/integration-requests/${r.id}/withdraw`, {})).status).toBe(409)
    expect(await cara.call('GET', `/api/integration-requests/${r.id}`)).toMatchObject({ state: 'withdrawn' })
    expect((await cara.call('GET', '/api/integration-requests')).items).toEqual([])
    expect(h.ctx.db.query("SELECT count(*) AS n FROM integrations WHERE owner_user_id = ?").get(ids.cara)).toEqual({ n: 0 })
    expect((await ada.try('POST', '/api/admin/integration-requests/00000000-0000-7000-8000-000000000000/withdraw', {})).status).toBe(404)
  })

  test('after 7 days it has expired: no answer, no withdraw; the admin sees it expired', async () => {
    const r = (await ask(ada, api())).body
    shift = 7 * 86_400_000 - 60_000
    try {
      expect((await cara.call('GET', '/api/integration-requests')).items.map((x: any) => x.id)).toEqual([r.id])
      shift = 7 * 86_400_000 + 60_000
      expect((await cara.call('GET', '/api/integration-requests')).items).toEqual([])
      expect(await cara.call('GET', `/api/integration-requests/${r.id}`)).toMatchObject({ state: 'expired', endedAt: null })
      const late = await cara.try('POST', `/api/integration-requests/${r.id}/complete`, { secret: API_KEY })
      expect(late.status).toBe(409)
      expect(late.body.error.params).toEqual({ state: 'expired' })
      expect((await cara.try('POST', `/api/integration-requests/${r.id}/decline`, {})).status).toBe(409)
      expect((await ada.try('POST', `/api/admin/integration-requests/${r.id}/withdraw`, {})).status).toBe(409)
      expect(await stateOf(r.id)).toBe('expired')
      // an expired request does not block asking again
      const again = await ask(ada, api())
      expect(again.status).toBe(201)
      await ada.call('POST', `/api/admin/integration-requests/${again.body.id}/withdraw`, {})
      // 30 days after it ended, it leaves the admin's list
      shift = 38 * 86_400_000
      expect((await adminList()).some((x) => x.id === r.id)).toBe(false)
    } finally { shift = 0 }
    expect(h.ctx.db.query("SELECT count(*) AS n FROM integrations WHERE owner_user_id = ?").get(ids.cara)).toEqual({ n: 0 })
  })

  test('the member declines it; the admin sees that', async () => {
    const r = (await ask(ada, api())).body
    const d = await cara.call('POST', `/api/integration-requests/${r.id}/decline`, {})
    expect(d).toMatchObject({ state: 'declined' })
    expect(await stateOf(r.id)).toBe('declined')
    const audit = h.ctx.db.query("SELECT actor_id FROM audit_log WHERE action = 'integration_request.decline' AND target = ?").get(r.id) as { actor_id: string }
    expect(audit.actor_id).toBe(ids.cara)
    expect((await cara.try('POST', `/api/integration-requests/${r.id}/complete`, { secret: API_KEY })).status).toBe(409)
  })
})

test('a sign-in request: the member\'s connection is made to sign in at, and the request is connected when the sign-in finishes', async () => {
  const r = (await ask(ada, { userId: ids.cara, kind: 'mcp', name: 'Board', url: `${fake.base}/mcp-oauth`, auth: 'oauth' })).body
  // no key goes with a sign-in
  expect((await cara.try('POST', `/api/integration-requests/${r.id}/complete`, { secret: 'x'.repeat(12) })).status).toBe(400)
  const c = await cara.call('POST', `/api/integration-requests/${r.id}/complete`, {})
  expect(c).toMatchObject({ scope: 'personal', auth: 'oauth', status: 'needs_auth', hasSecret: false })
  expect(await stateOf(r.id)).toBe('waiting')
  // answering again before signing in gives the same connection, not another
  expect((await cara.call('POST', `/api/integration-requests/${r.id}/complete`, {})).id).toBe(c.id)
  expect(h.ctx.db.query("SELECT count(*) AS n FROM integrations WHERE owner_user_id = ?").get(ids.cara)).toEqual({ n: 1 })
  // the admin cannot sign in at it
  expect((await ada.try('POST', `/api/integrations/${c.id}/authorize`, {})).status).toBe(404)
  const f = await cara.call('POST', `/api/integrations/${c.id}/authorize`, {})
  const cb = fake.authorize(f.authorizationUrl)
  expect((await cara.raw('GET', '/api/integrations/oauth/callback?' + new URLSearchParams(cb))).status).toBe(200)
  expect((await cara.call('GET', '/api/integrations')).items.find((i: any) => i.id === c.id)).toMatchObject({ status: 'connected', hasSecret: true })
  expect(await stateOf(r.id)).toBe('connected')
  const audit = h.ctx.db.query("SELECT actor_id FROM audit_log WHERE action = 'integration_request.complete' AND target = ?").get(r.id) as { actor_id: string }
  expect(audit.actor_id).toBe(ids.cara)
  expect((await cara.try('POST', `/api/integration-requests/${r.id}/complete`, {})).status).toBe(409)
  // the tokens reach nobody: not the admin's views, not the database in clear, not the logs
  const tokens = [...fake.issued]
  expect(tokens.length).toBeGreaterThan(0)
  const adminText = JSON.stringify([await adminList(), await ada.call('GET', '/api/admin/audit?limit=200')])
  for (const t of tokens) { expect(adminText).not.toContain(t); expect(everything()).not.toContain(t) }
})

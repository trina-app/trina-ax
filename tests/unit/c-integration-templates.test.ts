// Connection templates (server/src/integrations/connections/templates.ts, docs/INTEGRATIONS.md "Templates"): an admin
// registers a service once, each member it is for connects it with their own key. Checked here: only admins make and
// change templates, and a template never takes a key; only members it is for see or connect it (admins included: being
// an admin is not a rule); the member's key goes through their own create path and never reaches an admin (responses,
// audit, database outside the sealed column, logs); the connection is usable only by its member while the template
// covers them, also when the team turned members' own connections off; the member cannot move it to another address;
// a new address or sign-in method, a rule that leaves a member out, a group change and deleting the template all drop
// the members' keys; a member can disconnect. Fake services only.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { FakeServices, MCP_KEY } from '../lib/fake-services'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { getRow, mayUse, usable } from '../../server/src/integrations/connections/store'
import { templatesOf } from '../../server/src/integrations/connections/templates'
import { createLogger } from '../../server/src/log'

setDefaultTimeout(30_000)

let h: Harness, fake: FakeServices
let olga: Client, ada: Client, bob: Client, cara: Client
let ids: Record<'olga' | 'ada' | 'bob' | 'cara', string>
const logs: string[] = []
const OTHER_KEY = 'CANARY-cara-key-7710'

beforeAll(async () => {
  fake = new FakeServices()
  h = await harness('c-int-templates', {}, { log: createLogger({ level: 'debug', sink: (l) => logs.push(l) }) })
  olga = await withOwner(h)
  const a = await addMember(h, olga, { username: 'ada', role: 'admin' })
  const b = await addMember(h, olga, { username: 'bob' })
  const c = await addMember(h, olga, { username: 'cara' })
  ada = a.client; bob = b.client; cara = c.client
  ids = { olga: (await olga.call('GET', '/api/me')).user.id, ada: a.id, bob: b.id, cara: c.id }
  fake.now = Date.now()
  integrationsOf(h.ctx, { net: fake.net(), now: () => Date.now() })
})
afterAll(async () => { await h?.close(); fake?.stop() })

const nobody = { everyone: false, groups: [] as string[], users: [] as string[] }
const tpl = (over: Record<string, unknown> = {}) => ({ kind: 'mcp', name: 'Tasks', url: `${fake.base}/mcp-key`, auth: 'bearer', notes: 'Use your own Tasks key.', access: { ...nobody, users: [ids.bob, ids.cara] }, ...over })
const make = async (body = tpl()) => { const r = await ada.try('POST', '/api/admin/integration-templates', body); expect(r.status).toBe(201); return r.body }
const mine = async (as: Client) => (await as.call('GET', '/api/integration-templates')).items as any[]
const connect = (as: Client, id: string, body: Record<string, unknown>) => as.try('POST', `/api/integration-templates/${id}/connect`, body)
const everythingButSealed = () => ['integration_templates', 'integration_template_access', 'audit_log', 'notification_inbox']
  .map((t) => JSON.stringify(h.ctx.db.query(`SELECT * FROM ${t}`).all())).join('\n')
  + JSON.stringify(h.ctx.db.query('SELECT id, scope, owner_user_id, name, url, auth, auth_header, notes, status, last_error, template_id FROM integrations').all())
  + logs.join('\n')

describe('making a template', () => {
  test('only admins make, list, change and delete templates; a template never takes a key', async () => {
    expect((await bob.try('POST', '/api/admin/integration-templates', tpl())).status).toBe(403)
    expect((await bob.try('GET', '/api/admin/integration-templates')).status).toBe(403)
    expect((await h.client().try('POST', '/api/admin/integration-templates', tpl())).status).toBe(401)
    // strict: a key sent with a template is refused, not dropped
    expect((await ada.try('POST', '/api/admin/integration-templates', { ...tpl(), secret: MCP_KEY })).status).toBe(400)
    // a template is for a member's own key or sign-in: no "none"
    expect((await ada.try('POST', '/api/admin/integration-templates', { ...tpl(), auth: 'none' })).status).toBe(400)
    // the same address checks as a connection: no private or office addresses (a name that resolves to one is refused when a member connects)
    expect((await ada.try('POST', '/api/admin/integration-templates', { ...tpl(), url: 'https://10.0.0.5/mcp' })).status).toBe(400)
    const t = await make()
    expect(t).toMatchObject({ kind: 'mcp', name: 'Tasks', auth: 'bearer', connected: 0, access: { everyone: false, users: expect.arrayContaining([ids.bob, ids.cara]) }, createdBy: { id: ids.ada } })
    expect((await bob.try('PATCH', `/api/admin/integration-templates/${t.id}`, { name: 'x' })).status).toBe(403)
    expect((await bob.try('DELETE', `/api/admin/integration-templates/${t.id}`)).status).toBe(403)
    const list = (await olga.call('GET', '/api/admin/integration-templates')).items
    expect(list.map((x: any) => x.id)).toContain(t.id)
    await ada.call('DELETE', `/api/admin/integration-templates/${t.id}`)
  })
})

describe('members connect their own key', () => {
  test('only members it is for see and connect it; the admin sees a count, never the key', async () => {
    const t = await make(tpl({ access: { ...nobody, users: [ids.bob] } }))
    // bob sees it, not connected yet; cara (not in the rule) and ada (an admin, not in the rule) do not
    expect((await mine(bob)).find((x) => x.id === t.id)).toMatchObject({ name: 'Tasks', connection: null, auth: 'bearer' })
    expect((await mine(cara)).some((x) => x.id === t.id)).toBe(false)
    expect((await mine(ada)).some((x) => x.id === t.id)).toBe(false)
    expect((await connect(cara, t.id, { secret: OTHER_KEY })).status).toBe(404)
    expect((await connect(ada, t.id, { secret: OTHER_KEY })).status).toBe(404)
    // a key is needed for a key template
    expect((await connect(bob, t.id, {})).status).toBe(400)
    const r = await connect(bob, t.id, { secret: MCP_KEY })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ scope: 'personal', templateId: t.id, status: 'connected', hasSecret: true, url: `${fake.base}/mcp-key` })
    expect(JSON.stringify(r.body)).not.toContain(MCP_KEY)
    // the admin: one connected, and nothing of the key anywhere they can look
    const admin = (await ada.call('GET', '/api/admin/integration-templates')).items.find((x: any) => x.id === t.id)
    expect(admin.connected).toBe(1)
    expect(JSON.stringify(admin)).not.toContain(MCP_KEY)
    expect(JSON.stringify(await ada.call('GET', '/api/admin/integrations'))).not.toContain(r.body.id)
    expect((await ada.try('GET', `/api/integrations`)).body.items.some((i: any) => i.id === r.body.id)).toBe(false)
    expect(everythingButSealed()).not.toContain(MCP_KEY)
    // the admin cannot change, use or delete bob's connection
    expect((await ada.try('PATCH', `/api/integrations/${r.body.id}`, { secret: OTHER_KEY })).status).toBe(404)
    expect((await ada.try('DELETE', `/api/integrations/${r.body.id}`)).status).toBe(404)
    expect((await ada.try('POST', `/api/integrations/${r.body.id}/authorize`, {})).status).toBe(404)
    await ada.call('DELETE', `/api/admin/integration-templates/${t.id}`)
  })

  test('the connection is its member\'s alone, also with members\' own connections turned off', async () => {
    const t = await make()
    const b = (await connect(bob, t.id, { secret: MCP_KEY })).body
    const c = (await connect(cara, t.id, { secret: OTHER_KEY })).body
    expect(b.id).not.toBe(c.id)
    const rowB = getRow(h.ctx.db, b.id)!
    // cross-member: cara can neither use nor see bob's connection, and her chats get only her own
    expect(mayUse(h.ctx.db, rowB, ids.cara)).toBe(false)
    expect(mayUse(h.ctx.db, rowB, ids.bob)).toBe(true)
    expect(usable(h.ctx.db, ids.cara).map((r) => r.id)).toEqual(expect.arrayContaining([c.id]))
    expect(usable(h.ctx.db, ids.cara).map((r) => r.id)).not.toContain(b.id)
    expect((await cara.try('PATCH', `/api/integrations/${b.id}`, { secret: OTHER_KEY })).status).toBe(404)
    expect((await cara.try('DELETE', `/api/integrations/${b.id}`)).status).toBe(404)
    // the secrets hidden in cara's turns are hers, never bob's key
    expect(integrationsOf(h.ctx).secretsFor(ids.cara)).not.toContain(MCP_KEY)
    // members' own connections off: the admin registered this service, so it still works
    await olga.call('PATCH', '/api/admin/settings', { personalIntegrations: false })
    try {
      expect(mayUse(h.ctx.db, getRow(h.ctx.db, b.id)!, ids.bob)).toBe(true)
      expect(usable(h.ctx.db, ids.bob).map((r) => r.id)).toContain(b.id)
      // connecting still works too
      expect((await connect(bob, t.id, { secret: MCP_KEY })).status).toBe(200)
    } finally { await olga.call('PATCH', '/api/admin/settings', { personalIntegrations: true }) }
    await ada.call('DELETE', `/api/admin/integration-templates/${t.id}`)
  })

  test('the key only goes to the template\'s address: the member cannot move it, only replace the key', async () => {
    const t = await make(tpl({ access: { ...nobody, users: [ids.bob] } }))
    const b = (await connect(bob, t.id, { secret: MCP_KEY })).body
    for (const patch of [{ url: `${fake.base}/mcp-open` }, { auth: 'header', authHeader: 'X-Api-Key' }, { name: 'Mine' }, { notes: 'x' }]) {
      const r = await bob.try('PATCH', `/api/integrations/${b.id}`, patch)
      expect(r.status).toBe(400)
    }
    expect(getRow(h.ctx.db, b.id)!.url).toBe(`${fake.base}/mcp-key`)
    // a new key and the write rule are the member's
    const r = await bob.try('PATCH', `/api/integrations/${b.id}`, { secret: MCP_KEY, writePolicy: 'deny' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ writePolicy: 'deny', hasSecret: true })
    // "run without asking" stays the team's choice
    expect((await bob.try('PATCH', `/api/integrations/${b.id}`, { writePolicy: 'allow' })).status).toBe(400)
    // connecting again with a key replaces the key, it does not make a second connection
    const again = await connect(bob, t.id, { secret: MCP_KEY })
    expect(again.body.id).toBe(b.id)
    expect((h.ctx.db.query('SELECT count(*) AS n FROM integrations WHERE template_id = ?').get(t.id) as { n: number }).n).toBe(1)
    await ada.call('DELETE', `/api/admin/integration-templates/${t.id}`)
  })

  test('a member can disconnect at any time; connecting again makes a new one', async () => {
    const t = await make(tpl({ access: { ...nobody, users: [ids.bob] } }))
    const b = (await connect(bob, t.id, { secret: MCP_KEY })).body
    expect((await bob.try('DELETE', `/api/integrations/${b.id}`)).status).toBe(204)
    expect(getRow(h.ctx.db, b.id)).toBeNull()
    expect((await mine(bob)).find((x) => x.id === t.id).connection).toBeNull()
    expect((await ada.call('GET', '/api/admin/integration-templates')).items.find((x: any) => x.id === t.id).connected).toBe(0)
    const again = (await connect(bob, t.id, { secret: MCP_KEY })).body
    expect(again.id).not.toBe(b.id)
    await ada.call('DELETE', `/api/admin/integration-templates/${t.id}`)
  })

  test('a sign-in template makes the connection to sign in at next; connecting again gives the same one', async () => {
    const t = await make(tpl({ name: 'Docs', url: `${fake.base}/mcp-oauth`, auth: 'oauth', access: { ...nobody, users: [ids.bob] } }))
    expect((await connect(bob, t.id, { secret: MCP_KEY })).status).toBe(400)
    const a = (await connect(bob, t.id, {})).body
    expect(a).toMatchObject({ auth: 'oauth', status: 'needs_auth', hasSecret: false, templateId: t.id })
    const b = (await connect(bob, t.id, {})).body
    expect(b.id).toBe(a.id)
    // signing in starts at the member's own connection
    const start = await bob.try('POST', `/api/integrations/${a.id}/authorize`, {})
    expect(start.status).toBe(200)
    expect(start.body.authorizationUrl).toContain(`${fake.base}/as/authorize`)
    await ada.call('DELETE', `/api/admin/integration-templates/${t.id}`)
  })
})

describe('the template changes, the keys go', () => {
  test('a new address or sign-in method drops every member\'s connection and key; a new name follows', async () => {
    const t = await make()
    const b = (await connect(bob, t.id, { secret: MCP_KEY })).body
    const c = (await connect(cara, t.id, { secret: OTHER_KEY })).body
    // a new name and note: the members' connections follow, keys stay
    await ada.call('PATCH', `/api/admin/integration-templates/${t.id}`, { name: 'Tasks HQ', notes: 'New note' })
    expect(getRow(h.ctx.db, b.id)).toMatchObject({ name: 'Tasks HQ', notes: 'New note' })
    expect(getRow(h.ctx.db, b.id)!.secret_enc).not.toBeNull()
    // a new address: both connections (and keys) go, the members connect again
    const moved = (await ada.call('PATCH', `/api/admin/integration-templates/${t.id}`, { url: `${fake.base}/mcp-header`, auth: 'header', authHeader: 'X-Api-Key' }))
    expect(moved).toMatchObject({ connected: 0, auth: 'header', authHeader: 'X-Api-Key' })
    expect(getRow(h.ctx.db, b.id)).toBeNull()
    expect(getRow(h.ctx.db, c.id)).toBeNull()
    expect((await mine(bob)).find((x) => x.id === t.id)).toMatchObject({ connection: null, auth: 'header', url: `${fake.base}/mcp-header` })
    const a = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'integration_template.update' AND target = ? ORDER BY id DESC LIMIT 1").get(t.id) as { detail: string }
    expect(JSON.parse(a.detail)).toMatchObject({ keysDropped: true })
    const drops = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'integration.delete' AND target IN (?, ?)").all(b.id, c.id) as { detail: string }[]
    expect(drops.map((d) => JSON.parse(d.detail).why)).toEqual(['template_moved', 'template_moved'])
    // a new connection goes to the new address with the new header
    const again = (await connect(bob, t.id, { secret: MCP_KEY })).body
    expect(again).toMatchObject({ url: `${fake.base}/mcp-header`, auth: 'header', authHeader: 'X-Api-Key', status: 'connected' })
    await ada.call('DELETE', `/api/admin/integration-templates/${t.id}`)
  })

  test('a rule that leaves a member out drops their connection; a group change is refused at once and swept', async () => {
    const g = (await ada.call('POST', '/api/admin/groups', { name: 'Ops', memberIds: [ids.bob, ids.cara] }))
    const t = await make(tpl({ access: { ...nobody, groups: [g.id] } }))
    const b = (await connect(bob, t.id, { secret: MCP_KEY })).body
    const c = (await connect(cara, t.id, { secret: OTHER_KEY })).body
    // cara leaves the group: she cannot use it from that moment, and her key goes at the next sweep
    await ada.call('PATCH', `/api/admin/groups/${g.id}`, { memberIds: [ids.bob] })
    expect(mayUse(h.ctx.db, getRow(h.ctx.db, c.id)!, ids.cara)).toBe(false)
    expect(usable(h.ctx.db, ids.cara).map((r) => r.id)).not.toContain(c.id)
    expect((await mine(cara)).some((x) => x.id === t.id)).toBe(false)
    expect(getRow(h.ctx.db, c.id)).toBeNull()
    expect(getRow(h.ctx.db, b.id)).not.toBeNull()
    // the rule changes to a person who is not bob: bob's connection goes with the change
    await ada.call('PATCH', `/api/admin/integration-templates/${t.id}`, { access: { ...nobody, users: [ids.cara] } })
    expect(getRow(h.ctx.db, b.id)).toBeNull()
    await ada.call('DELETE', `/api/admin/integration-templates/${t.id}`)
  })

  test('deleting the template deletes every member\'s connection and key, and revokes sign-ins', async () => {
    const t = await make()
    const b = (await connect(bob, t.id, { secret: MCP_KEY })).body
    const c = (await connect(cara, t.id, { secret: OTHER_KEY })).body
    expect((await ada.try('DELETE', `/api/admin/integration-templates/${t.id}`)).status).toBe(204)
    expect(getRow(h.ctx.db, b.id)).toBeNull()
    expect(getRow(h.ctx.db, c.id)).toBeNull()
    expect((await mine(bob)).some((x) => x.id === t.id)).toBe(false)
    expect((await connect(bob, t.id, { secret: MCP_KEY })).status).toBe(404)
    const a = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'integration_template.delete' AND target = ?").get(t.id) as { detail: string }
    expect(JSON.parse(a.detail)).toMatchObject({ connections: 2 })
  })

  test('a member removed from the team loses their connection made from a template', async () => {
    const d = await addMember(h, olga, { username: 'dan' })
    const t = await make(tpl({ access: { everyone: true, groups: [], users: [] } }))
    const r = (await connect(d.client, t.id, { secret: MCP_KEY })).body
    expect(getRow(h.ctx.db, r.id)).not.toBeNull()
    expect((await olga.try('DELETE', `/api/admin/users/${d.id}`)).status).toBeLessThan(300)
    expect(getRow(h.ctx.db, r.id)).toBeNull()
    await ada.call('DELETE', `/api/admin/integration-templates/${t.id}`)
  })

  test('a template that disappears while a member connects leaves no connection behind', async () => {
    const t = await make(tpl({ access: { ...nobody, users: [ids.bob] } }))
    // the sweep finds a connection whose template is gone (e.g. an older build deleted the template row only)
    const b = (await connect(bob, t.id, { secret: MCP_KEY })).body
    h.ctx.db.query('DELETE FROM integration_templates WHERE id = ?').run(t.id)
    expect(mayUse(h.ctx.db, getRow(h.ctx.db, b.id)!, ids.bob)).toBe(false)
    await templatesOf(h.ctx).sweep()
    expect(getRow(h.ctx.db, b.id)).toBeNull()
  })
})

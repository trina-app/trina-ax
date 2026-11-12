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
import { API_KEY, FakeServices, MCP_KEY } from '../lib/fake-services'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { getRow, mayUse, usable } from '../../server/src/integrations/connections/store'
import { templatesOf } from '../../server/src/integrations/connections/templates'
import { createLogger } from '../../server/src/log'
import { connectRows } from '../../server/src/chat/connect-service'
import { integrationToolProvider } from '../../server/src/integrations/connections/tools'
import { TurnFiles } from '../../server/src/files/service'
import type { TurnToolContext } from '../../server/src/services'
import { notificationsOf } from '../../server/src/notifications/service'

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
/** the template's version as this member sees it now (what the app sends back when connecting) */
const versionOf = async (as: Client, id: string) => (await mine(as)).find((x) => x.id === id)?.version ?? 1
const connect = async (as: Client, id: string, body: Record<string, unknown>) => as.try('POST', `/api/integration-templates/${id}/connect`, { version: await versionOf(as, id), ...body })
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
  test('a template made without saying who it is for is for the whole team: every member sees it at once', async () => {
    const { access: _access, ...noAudience } = tpl({ name: 'Wiki' })
    const t = await make(noAudience as ReturnType<typeof tpl>)
    expect(t.access).toEqual({ everyone: true, groups: [], users: [] })
    for (const who of [bob, cara]) expect((await mine(who)).map((x) => x.id)).toContain(t.id)
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

// ---------------- the independent security review of the templates (PR #78) ----------------
const callback = (q: Record<string, string>) => '/api/integrations/oauth/callback?' + new URLSearchParams(q)
/** the member signs in at their connection made from a sign-in template (the fake service approves at once) */
async function signIn(as: Client, connId: string) {
  const f = await as.call('POST', `/api/integrations/${connId}/authorize`, {})
  const cb = fake.authorize(f.authorizationUrl)
  return { flow: f, res: await as.raw('GET', callback(cb)) }
}
const until = async (ok: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await Bun.sleep(20); return ok() }
const oauthTpl = (users: string[]) => tpl({ name: 'Docs', url: `${fake.base}/mcp-oauth`, auth: 'oauth', access: { ...nobody, users } })

describe('security review: where a key can go', () => {
  test('a template address with a key or any query is refused; a member never sees a query, even an older one', async () => {
    const key = 'CANARY-admin-team-key-5521x9Qp'
    for (const url of [`${fake.base}/mcp-key?api_key=${key}`, `${fake.base}/mcp-key?instance=a8F3k29dK3x`, `${fake.base}/mcp-key#token=x`]) {
      const r = await ada.try('POST', '/api/admin/integration-templates', tpl({ url }))
      expect(r.status, url).toBe(400)
      expect(Object.keys(r.body.error.fields ?? {})).toContain('body.url')
    }
    const t = await make(tpl({ access: { ...nobody, users: [ids.bob] } }))
    expect((await ada.try('PATCH', `/api/admin/integration-templates/${t.id}`, { url: `${fake.base}/mcp-key?api_key=${key}` })).status).toBe(400)
    // an admin's request to one member: a key in its address is refused too (a plain query stays allowed there)
    expect((await ada.try('POST', '/api/admin/integration-requests', { userId: ids.bob, kind: 'mcp', name: 'Q', url: `${fake.base}/mcp-key?api_key=${key}`, auth: 'bearer' })).status).toBe(400)
    // a template an older build kept with a query: its member sees the bare address everywhere
    const b = (await connect(bob, t.id, { secret: MCP_KEY })).body
    h.ctx.db.query('UPDATE integration_templates SET url = ? WHERE id = ?').run(`${fake.base}/mcp-key?api_key=${key}`, t.id)
    h.ctx.db.query('UPDATE integrations SET url = ? WHERE id = ?').run(`${fake.base}/mcp-key?api_key=${key}`, b.id)
    const listed = (await bob.call('GET', '/api/integrations')).items.find((i: any) => i.id === b.id)
    expect(listed.url).toBe(`${fake.base}/mcp-key`)
    const shared = (await mine(bob)).find((x) => x.id === t.id)
    expect(shared.url).toBe(`${fake.base}/mcp-key`)
    expect(JSON.stringify(shared)).not.toContain(key)
    await ada.call('DELETE', `/api/admin/integration-templates/${t.id}`)
  })

  test('connecting an older version of the template is refused; a template that changes while connecting leaves nothing', async () => {
    const t = await make(tpl({ access: { ...nobody, users: [ids.bob] } }))
    const seen = await versionOf(bob, t.id)
    await ada.call('PATCH', `/api/admin/integration-templates/${t.id}`, { url: `${fake.base}/mcp-header`, auth: 'header', authHeader: 'X-Api-Key' })
    // bob agreed to the old address: his key does not go to the new one
    const stale = await bob.try('POST', `/api/integration-templates/${t.id}/connect`, { version: seen, secret: MCP_KEY })
    expect(stale.status).toBe(409)
    expect((h.ctx.db.query('SELECT count(*) AS n FROM integrations WHERE template_id = ?').get(t.id) as { n: number }).n).toBe(0)
    // the version is required
    expect((await bob.try('POST', `/api/integration-templates/${t.id}/connect`, { secret: MCP_KEY })).status).toBe(400)
    // the template changes while the connection is being made (there and back again counts): nothing stays
    await ada.call('PATCH', `/api/admin/integration-templates/${t.id}`, { url: `${fake.base}/mcp-key`, auth: 'bearer' })
    const svc = integrationsOf(h.ctx)
    const create = svc.create.bind(svc)
    svc.create = async (...a: Parameters<typeof create>) => {
      const made = await create(...a)
      h.ctx.db.query('UPDATE integration_templates SET url = ?, version = version + 1 WHERE id = ?').run(`${fake.base}/mcp-open`, t.id)
      h.ctx.db.query('UPDATE integration_templates SET url = ?, version = version + 1 WHERE id = ?').run(`${fake.base}/mcp-key`, t.id)
      return made
    }
    try {
      const r = await connect(bob, t.id, { secret: MCP_KEY })
      expect(r.status).toBe(409)
    } finally { svc.create = create }
    expect((h.ctx.db.query('SELECT count(*) AS n FROM integrations WHERE template_id = ?').get(t.id) as { n: number }).n).toBe(0)
    await ada.call('DELETE', `/api/admin/integration-templates/${t.id}`)
  })

  test('the member cannot change the key\'s header either, alone or to none', async () => {
    const t = await make(tpl({ url: `${fake.base}/mcp-header`, auth: 'header', authHeader: 'X-Api-Key', access: { ...nobody, users: [ids.bob] } }))
    const b = (await connect(bob, t.id, { secret: MCP_KEY })).body
    for (const patch of [{ authHeader: 'X-Other-Key' }, { authHeader: null }]) expect((await bob.try('PATCH', `/api/integrations/${b.id}`, patch)).status).toBe(400)
    expect(getRow(h.ctx.db, b.id)).toMatchObject({ auth: 'header', auth_header: 'X-Api-Key' })
    await ada.call('DELETE', `/api/admin/integration-templates/${t.id}`)
  })
})

describe('security review: cleanup and consent', () => {
  test('a deleted member or group leaves the template rules (and team connections\'), so the rules can still be changed', async () => {
    const d = await addMember(h, olga, { username: 'dina' })
    const g = await ada.call('POST', '/api/admin/groups', { name: 'Gone', memberIds: [ids.bob] })
    const t = await make(tpl({ access: { everyone: false, groups: [g.id], users: [ids.bob, d.id] } }))
    const team = (await ada.try('POST', '/api/admin/integrations', { kind: 'mcp', name: 'Open', url: `${fake.base}/mcp-open`, auth: 'none', access: { everyone: false, groups: [g.id], users: [] } })).body
    expect((await olga.try('DELETE', `/api/admin/users/${d.id}`)).status).toBeLessThan(300)
    expect((await ada.try('DELETE', `/api/admin/groups/${g.id}`)).status).toBeLessThan(300)
    expect(h.ctx.db.query('SELECT count(*) AS n FROM integration_template_access WHERE subject_id IN (?, ?)').get(d.id, g.id)).toEqual({ n: 0 })
    expect(h.ctx.db.query('SELECT count(*) AS n FROM integration_access WHERE subject_id = ?').get(g.id)).toEqual({ n: 0 })
    const now = (await ada.call('GET', '/api/admin/integration-templates')).items.find((x: any) => x.id === t.id)
    expect(now.access).toMatchObject({ groups: [], users: [ids.bob] })
    // the rule as the admin sees it can be saved again, with someone added
    expect((await ada.try('PATCH', `/api/admin/integration-templates/${t.id}`, { access: { ...now.access, users: [ids.bob, ids.cara] } })).status).toBe(200)
    expect((await ada.try('PATCH', `/api/integrations/${team.id}`, { access: { everyone: false, groups: [], users: [ids.cara] } })).status).toBe(200)
    await ada.call('DELETE', `/api/admin/integration-templates/${t.id}`)
    await ada.call('DELETE', `/api/integrations/${team.id}`)
  })

  test('a deleted member\'s sign-in at a template\'s service is revoked there', async () => {
    const e = await addMember(h, olga, { username: 'emil' })
    const t = await make(oauthTpl([e.id]))
    const c = (await connect(e.client, t.id, {})).body
    expect((await signIn(e.client, c.id)).res.status).toBe(200)
    expect(getRow(h.ctx.db, c.id)!.secret_enc).not.toBeNull()
    const before = fake.revoked.length
    expect((await olga.try('DELETE', `/api/admin/users/${e.id}`)).status).toBeLessThan(300)
    expect(getRow(h.ctx.db, c.id)).toBeNull()
    expect(await until(() => fake.revoked.length > before)).toBe(true)
    expect(fake.revoked.at(-1)).toStartWith('CANARY-refresh-')
    await ada.call('DELETE', `/api/admin/integration-templates/${t.id}`)
  })

  test('deleting a template, or moving it, revokes its members\' sign-ins at the service', async () => {
    for (const change of ['delete', 'move'] as const) {
      const t = await make(oauthTpl([ids.bob]))
      const c = (await connect(bob, t.id, {})).body
      expect((await signIn(bob, c.id)).res.status).toBe(200)
      const before = fake.revoked.length
      if (change === 'delete') await ada.call('DELETE', `/api/admin/integration-templates/${t.id}`)
      else await ada.call('PATCH', `/api/admin/integration-templates/${t.id}`, { url: `${fake.base}/mcp-key`, auth: 'bearer' })
      expect(getRow(h.ctx.db, c.id)).toBeNull()
      // an admin's change waits for the service to be told
      expect(fake.revoked.length, change).toBe(before + 1)
      if (change === 'move') await ada.call('DELETE', `/api/admin/integration-templates/${t.id}`)
    }
  })

  test('a new name or note keeps a sign-in in progress and a token refresh', async () => {
    const t = await make(oauthTpl([ids.bob]))
    const c = (await connect(bob, t.id, {})).body
    // renamed while the member is at the service's sign-in page: the sign-in still completes
    const f = await bob.call('POST', `/api/integrations/${c.id}/authorize`, {})
    await ada.call('PATCH', `/api/admin/integration-templates/${t.id}`, { name: 'Docs renamed' })
    expect((await bob.raw('GET', callback(fake.authorize(f.authorizationUrl)))).status).toBe(200)
    expect(await bob.call('GET', `/api/integrations/flows/${f.flowId}`)).toMatchObject({ state: 'completed' })
    // renamed while a token refresh runs: the new tokens are kept, the call goes through
    const svc = integrationsOf(h.ctx)
    const sealed = getRow(h.ctx.db, c.id)!.secret_enc
    fake.access.clear()
    let release!: () => void
    fake.delayRefresh = () => new Promise<void>((r) => { release = r })
    const call = svc.callTool(getRow(h.ctx.db, c.id)!, 'search_tasks', { q: 'x' })
    expect(await until(() => typeof release === 'function')).toBe(true)
    await ada.call('PATCH', `/api/admin/integration-templates/${t.id}`, { notes: 'A new note' })
    fake.delayRefresh = null
    release()
    await call
    const row = getRow(h.ctx.db, c.id)!
    expect(row).toMatchObject({ name: 'Docs renamed', notes: 'A new note' })
    expect(row.secret_enc).not.toBe(sealed)
    await ada.call('DELETE', `/api/admin/integration-templates/${t.id}`)
  })

  test('the activity log never says which template a member connected, or who connected it', async () => {
    const t = await make(tpl({ access: { ...nobody, users: [ids.bob] } }))
    const b = (await connect(bob, t.id, { secret: MCP_KEY })).body
    expect(h.ctx.db.query("SELECT count(*) AS n FROM audit_log WHERE action = 'integration_template.connect'").get()).toEqual({ n: 0 })
    const made = JSON.parse((h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'integration.create' AND target = ?").get(b.id) as { detail: string }).detail)
    expect(made).toEqual({ scope: 'personal', kind: 'mcp', auth: 'bearer' })
    await ada.call('PATCH', `/api/admin/integration-templates/${t.id}`, { url: `${fake.base}/mcp-open`, auth: 'bearer' })
    const dropped = JSON.parse((h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'integration.delete' AND target = ?").get(b.id) as { detail: string }).detail)
    expect(dropped).toEqual({ scope: 'personal', kind: 'mcp', auth: 'bearer', why: 'template_moved' })
    await ada.call('DELETE', `/api/admin/integration-templates/${t.id}`)
  })

  test('loading a list does not wait for a slow service to be told; a connection that left its template\'s address goes', async () => {
    const g = await ada.call('POST', '/api/admin/groups', { name: 'Slow', memberIds: [ids.bob] })
    const t = await make(tpl({ name: 'Docs', url: `${fake.base}/mcp-oauth`, auth: 'oauth', access: { ...nobody, groups: [g.id] } }))
    const c = (await connect(bob, t.id, {})).body
    expect((await signIn(bob, c.id)).res.status).toBe(200)
    await ada.call('PATCH', `/api/admin/groups/${g.id}`, { memberIds: [] })
    let release!: () => void
    const before = fake.revoked.length
    fake.delayRevoke = () => new Promise<void>((r) => { release = r })
    try {
      const listed = await Promise.race([mine(bob).then(() => 'listed'), Bun.sleep(3000).then(() => 'waited')])
      expect(listed).toBe('listed')
      expect(getRow(h.ctx.db, c.id)).toBeNull()
    } finally { fake.delayRevoke = null; await until(() => typeof release === 'function'); release?.() }
    expect(await until(() => fake.revoked.length > before)).toBe(true)
    // a member's connection whose address is not its template's any more (an older build let it change) goes too
    const k = await make(tpl({ access: { ...nobody, users: [ids.bob] } }))
    const b = (await connect(bob, k.id, { secret: MCP_KEY })).body
    h.ctx.db.query('UPDATE integrations SET url = ? WHERE id = ?').run(`${fake.base}/mcp-open`, b.id)
    await mine(bob)
    expect(getRow(h.ctx.db, b.id)).toBeNull()
    await ada.call('DELETE', `/api/admin/integration-templates/${t.id}`)
    await ada.call('DELETE', `/api/admin/integration-templates/${k.id}`)
  })
})

describe('security review: in chats', () => {
  const turnFor = (userId: string) => {
    const chatId = crypto.randomUUID(), turnId = crypto.randomUUID()
    h.ctx.db.query('INSERT INTO chats (id, user_id, title) VALUES (?,?,?)').run(chatId, userId, 'review')
    h.ctx.db.query("INSERT INTO turns (id, chat_id, user_id, engine, status) VALUES (?,?,?, 'claude-code', 'running')").run(turnId, chatId, userId)
    const built = integrationToolProvider(h.ctx).build({ userId, chatId, turnId, browser: false, scheduled: false })
    const files = { user: h.ctx.files.principal(userId), turnId, files: new TurnFiles() } as TurnToolContext['files']
    const tc: TurnToolContext = { turnId, chatId, userId, messageId: 'm', locale: 'en', signal: new AbortController().signal, files }
    return { built, tc }
  }

  test('the connect card counts no template connection toward the limit, and does not offer an unusable one as already there', async () => {
    const t = await make(tpl({ access: { ...nobody, users: [ids.bob] } }))
    const b = (await connect(bob, t.id, { secret: MCP_KEY })).body
    let rows = connectRows(h.ctx.db, ids.bob, 'personal')
    expect(rows.rows.map((r) => r.id)).toContain(b.id)
    expect(rows.count).toBe(rows.rows.filter((r) => r.scope === 'personal' && !r.template_id).length)
    expect(rows.rows.filter((r) => r.template_id).length).toBeGreaterThan(0)
    // the template no longer covers bob (before any sweep): his old connection is not "already there"
    h.ctx.db.query('DELETE FROM integration_template_access WHERE template_id = ?').run(t.id)
    rows = connectRows(h.ctx.db, ids.bob, 'personal')
    expect(rows.rows.map((r) => r.id)).not.toContain(b.id)
    await ada.call('DELETE', `/api/admin/integration-templates/${t.id}`)
  })

  test('a template\'s note reaches the AI as the admin\'s note', async () => {
    const t = await make(tpl({ kind: 'http', name: 'Board API', url: `${fake.base}/api/v1`, notes: 'Boards are under /boards.', access: { ...nobody, users: [ids.bob] } }))
    const b = (await connect(bob, t.id, { secret: API_KEY })).body
    const { built } = turnFor(ids.bob)
    const api = built.tools.find((x) => x.name === 'api_request')!
    expect(api.description).toContain('Note from your team admin: Boards are under /boards.')
    expect(api.description).not.toContain('from whoever connected it): Boards')
    expect(b.templateId).toBe(t.id)
    await ada.call('DELETE', `/api/admin/integration-templates/${t.id}`)
  })

  test('a tool built for a turn is refused once a group change leaves the member out', async () => {
    const g = await ada.call('POST', '/api/admin/groups', { name: 'Turn', memberIds: [ids.bob] })
    const t = await make(tpl({ access: { ...nobody, groups: [g.id] } }))
    await connect(bob, t.id, { secret: MCP_KEY })
    const { built, tc } = turnFor(ids.bob)
    const tool = built.tools.find((x) => x.name.includes('search_tasks'))!
    expect(tool).toBeDefined()
    const ok = await tool.call({ q: 'a' }, tc)
    expect(!!ok.isError).toBe(false)
    const calls = fake.calls.length
    await ada.call('PATCH', `/api/admin/groups/${g.id}`, { memberIds: [] })
    const refused = await tool.call({ q: 'b' }, tc)
    expect(refused.isError).toBe(true)
    expect(fake.calls.length).toBe(calls)
    await ada.call('DELETE', `/api/admin/integration-templates/${t.id}`)
  })
})

// The brief's R2, R4 and R5 (docs/INTEGRATIONS.md "Templates"): the people a template is for are told in their inbox,
// once each and only them, wherever it comes from (made for them, a rule change, a group they join, joining the team
// while it is for everyone); told again to reconnect when its address changes; and an admin sees who connected it and
// when, or whose key stopped working: names and states, never a key, an address or anything the service returned.
describe('the brief: notices and who connected', () => {
  const inbox = async (as: Client) => (await as.call('GET', '/api/notifications?limit=100')).items as any[]
  const of = async (as: Client, id: string, event = 'integration.template') => (await inbox(as)).filter((n) => n.eventType === event && (n.template?.id === id || n.sourceId.startsWith(id)))
  const reconcile = () => notificationsOf(h.ctx).reconcile()

  test('R2: each person a template is for is told once in their inbox, never its maker or anyone else', async () => {
    const t = await make(tpl({ name: 'Notice Board', access: { ...nobody, users: [ids.bob, ids.cara, ids.ada] } }))
    for (const who of [bob, cara]) {
      const n = await of(who, t.id)
      expect(n.length).toBe(1)
      expect(n[0]).toMatchObject({ eventType: 'integration.template', template: { id: t.id, name: 'Notice Board' }, link: 'integrations', readAt: null })
      // metadata only: never the address or a key
      expect(JSON.stringify(n)).not.toContain(fake.base)
    }
    // the admin who made it is not told about their own template; someone it is not for is never told
    expect((await of(ada, t.id)).length).toBe(0)
    expect((await of(olga, t.id)).length).toBe(0)
    // again and again: still one each, also after the notice itself is gone (30 days): no second notice
    reconcile(); reconcile()
    expect((await of(bob, t.id)).length).toBe(1)
    h.ctx.db.query('DELETE FROM integration_template_notices WHERE source_id = ?').run(t.id)
    reconcile()
    expect((await of(bob, t.id)).length).toBe(0)
    await ada.call('DELETE', `/api/admin/integration-templates/${t.id}`)
  })

  test('R2: a rule change, a group someone joins, and joining the team while it is for everyone reach them too', async () => {
    const g = await ada.call('POST', '/api/admin/groups', { name: 'Notified', memberIds: [] })
    const t = await make(tpl({ name: 'Group Wiki', access: { ...nobody, groups: [g.id] } }))
    expect((await of(cara, t.id)).length).toBe(0)
    await ada.call('PATCH', `/api/admin/groups/${g.id}`, { memberIds: [ids.cara] })
    reconcile()
    expect((await of(cara, t.id)).length).toBe(1)
    // a rule that now names bob: told at once
    await ada.call('PATCH', `/api/admin/integration-templates/${t.id}`, { access: { ...nobody, groups: [g.id], users: [ids.bob] } })
    expect((await of(bob, t.id)).length).toBe(1)
    // someone who joins the team while a template is for everyone is told; one who connected it already is not
    const e = await make(tpl({ name: 'Everyone Wiki', access: { everyone: true, groups: [], users: [] } }))
    h.ctx.db.query('DELETE FROM integration_template_offers WHERE template_id = ? AND user_id = ?').run(e.id, ids.cara)
    h.ctx.db.query('DELETE FROM integration_template_notices WHERE source_id = ? AND user_id = ?').run(e.id, ids.cara)
    await connect(cara, e.id, { secret: MCP_KEY })
    reconcile()
    expect((await of(cara, e.id)).length).toBe(0)
    // someone who joins is not told at join about a template already there (docs/DECISIONS.md "A welcome for invited
    // people"): Connected apps lists it, and opening it counts as told, with no notice
    const dave = await addMember(h, olga, { username: 'dave' })
    reconcile()
    expect((await of(dave.client, e.id)).length).toBe(0)
    expect((await mine(dave.client)).some((x) => x.id === e.id)).toBe(true)
    reconcile()
    expect((await of(dave.client, e.id)).length).toBe(0)
    expect(h.ctx.db.query('SELECT 1 FROM integration_template_offers WHERE template_id = ? AND user_id = ?').get(e.id, dave.id)).toBeTruthy()
    // one who never opens it is told once their welcome days are over
    const erin = await addMember(h, olga, { username: 'erin' })
    reconcile()
    expect((await of(erin.client, e.id)).length).toBe(0)
    h.ctx.db.query("UPDATE member_welcome SET joined_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ?").run(erin.id)
    reconcile()
    expect((await of(erin.client, e.id)).length).toBe(1)
    // a template made after they joined is news: told at once
    const later = await make(tpl({ name: 'Later Wiki', access: { ...nobody, users: [dave.id] } }))
    expect((await of(dave.client, later.id)).length).toBe(1)
    await ada.call('DELETE', `/api/admin/integration-templates/${later.id}`)
    await ada.call('DELETE', `/api/admin/integration-templates/${t.id}`)
    await ada.call('DELETE', `/api/admin/integration-templates/${e.id}`)
  })

  test('R5: a new address drops the key and tells only the members who had connected it to reconnect', async () => {
    const t = await make(tpl({ name: 'Moving Tasks', access: { ...nobody, users: [ids.bob, ids.cara] } }))
    await connect(bob, t.id, { secret: MCP_KEY })
    await ada.call('PATCH', `/api/admin/integration-templates/${t.id}`, { url: `${fake.base}/mcp-open`, auth: 'bearer' })
    const n = await of(bob, t.id, 'integration.template_reconnect')
    expect(n.length).toBe(1)
    expect(n[0]).toMatchObject({ template: { id: t.id, name: 'Moving Tasks' }, link: 'integrations' })
    expect(JSON.stringify(n)).not.toContain(MCP_KEY)
    expect(JSON.stringify(n)).not.toContain(fake.base)
    expect((await of(cara, t.id, 'integration.template_reconnect')).length).toBe(0)
    // a new name is not a move: no second reconnect notice
    await ada.call('PATCH', `/api/admin/integration-templates/${t.id}`, { name: 'Moving Tasks 2' })
    expect((await of(bob, t.id, 'integration.template_reconnect')).length).toBe(1)
    await ada.call('DELETE', `/api/admin/integration-templates/${t.id}`)
  })

  test('R4: an admin sees who it is for, who connected and when, and whose key stopped working; never a key', async () => {
    const t = await make(tpl({ name: 'Seen Tasks', access: { ...nobody, users: [ids.bob, ids.cara] } }))
    const c = (await connect(bob, t.id, { secret: MCP_KEY })).body
    // members cannot see it; an unknown template is 404
    expect((await bob.try('GET', `/api/admin/integration-templates/${t.id}/members`)).status).toBe(403)
    expect((await ada.try('GET', '/api/admin/integration-templates/nope/members')).status).toBe(404)
    const r = await ada.call('GET', `/api/admin/integration-templates/${t.id}/members`)
    const by = Object.fromEntries(r.items.map((m: any) => [m.user.id, m]))
    expect(Object.keys(by).sort()).toEqual([ids.bob, ids.cara].sort())
    expect(by[ids.bob]).toMatchObject({ state: 'connected', since: expect.any(String) })
    expect(by[ids.cara]).toEqual({ user: { id: ids.cara, name: expect.any(String) }, state: 'not_connected', since: null })
    // only names and states: no key, address, tools or service data
    const text = JSON.stringify(r)
    for (const s of [MCP_KEY, fake.base, 'search_tasks', 'sealed', 'secret']) expect(text).not.toContain(s)
    // a key the service refused shows as stopped working
    h.ctx.db.query("UPDATE integrations SET status = 'needs_auth' WHERE id = ?").run(c.id)
    const again = await ada.call('GET', `/api/admin/integration-templates/${t.id}/members`)
    expect(again.items.find((m: any) => m.user.id === ids.bob).state).toBe('stopped')
    await ada.call('DELETE', `/api/admin/integration-templates/${t.id}`)
  })
})

describe('security review 2', () => {
  const inbox = async (as: Client) => (await as.call('GET', '/api/notifications?limit=100')).items as any[]
  const of = async (as: Client, id: string, event = 'integration.template') => (await inbox(as)).filter((n) => n.eventType === event && (n.template?.id === id || n.sourceId.startsWith(id)))

  test('#1 the template backstop is one set query: a big team stays fast, and the same people are told', async () => {
    const db = h.ctx.db
    const now = new Date().toISOString()
    const g = crypto.randomUUID()
    db.query('INSERT INTO groups (id, name) VALUES (?, ?)').run(g, 'Scale group')
    const addUser = db.query("INSERT INTO users (id, username, name, password_hash, role, status, must_change_password, locale_follows_team, prefs, created_at) VALUES (?, ?, ?, 'x', 'member', 'active', 0, 1, '{}', ?)")
    const users: string[] = []
    db.transaction(() => {
      for (let i = 0; i < 2000; i++) { const id = `scale-${i}`; users.push(id); addUser.run(id, id, id, now) }
      for (let i = 0; i < 20; i++) db.query('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(g, users[i]!)
    })()
    const tIns = db.query("INSERT INTO integration_templates (id, created_by, kind, name, url, auth, created_at, updated_at) VALUES (?, ?, 'mcp', ?, ?, 'bearer', ?, ?)")
    const aIns = db.query("INSERT INTO integration_template_access (template_id, subject_type, subject_id) VALUES (?, 'group', ?)")
    const tids: string[] = []
    db.transaction(() => { for (let i = 0; i < 50; i++) { const id = crypto.randomUUID(); tids.push(id); tIns.run(id, ids.ada, `Scale ${i}`, `${fake.base}/mcp-key`, now, now); aIns.run(id, g) } })()
    try {
      const service = notificationsOf(h.ctx)
      const t0 = performance.now()
      const told = service.offerTemplates({ limit: 100_000 })
      const first = performance.now() - t0
      // 50 templates x the 20 group members, nobody else (the old loops took seconds here)
      expect(told).toBe(50 * 20)
      expect(first).toBeLessThan(1500)
      const offers = db.query(`SELECT count(*) n, count(DISTINCT user_id) u FROM integration_template_offers WHERE template_id IN (${tids.map(() => '?').join(',')})`).get(...tids) as { n: number; u: number }
      expect(offers).toEqual({ n: 1000, u: 20 })
      // the next backstop pass finds nothing owed and is cheap
      const t1 = performance.now()
      expect(service.offerTemplates()).toBe(0)
      expect(performance.now() - t1).toBeLessThan(1000)
      // a per-pass cap: the backstop never does more than its batch at once
      db.query(`DELETE FROM integration_template_offers WHERE template_id IN (${tids.map(() => '?').join(',')})`).run(...tids)
      expect(service.offerTemplates({ limit: 300 })).toBe(300)
    } finally {
      db.query(`DELETE FROM integration_templates WHERE id IN (${tids.map(() => '?').join(',')})`).run(...tids)
      db.query("DELETE FROM users WHERE id LIKE 'scale-%'").run()
      db.query('DELETE FROM groups WHERE id = ?').run(g)
    }
  })

  test('#1 joining a group or being made active again tells them at once, without waiting for the backstop', async () => {
    const g = await ada.call('POST', '/api/admin/groups', { name: 'Event group', memberIds: [] })
    const t = await make(tpl({ name: 'Event Board', access: { ...nobody, groups: [g.id] } }))
    // no reconcile() between: the group change itself offers it
    await ada.call('PATCH', `/api/admin/groups/${g.id}`, { memberIds: [ids.cara] })
    expect((await of(cara, t.id)).length).toBe(1)
    await ada.call('DELETE', `/api/admin/integration-templates/${t.id}`)
  })

  test('#4 a template name with hidden text, a double quote or a control character is refused; notes too', async () => {
    for (const name of ['Wi​ki', 'Tasks‮', 'The "board"', 'Line\nbreak', 'Tab\there']) {
      const r = await ada.try('POST', '/api/admin/integration-templates', tpl({ name }))
      expect(r.status).toBe(400)
    }
    expect((await ada.try('POST', '/api/admin/integration-templates', tpl({ name: 'Notes test', notes: 'read​ this' }))).status).toBe(400)
    const t = await make(tpl({ name: 'Plain Name' }))
    expect((await ada.try('PATCH', `/api/admin/integration-templates/${t.id}`, { name: 'Bad⁦name' })).status).toBe(400)
    await ada.call('DELETE', `/api/admin/integration-templates/${t.id}`)
  })

  test('#5 a new address and a narrower rule at once: only members still covered are asked to reconnect', async () => {
    const t = await make(tpl({ name: 'Narrowed', access: { ...nobody, users: [ids.bob, ids.cara] } }))
    const bobRow = (await connect(bob, t.id, { secret: MCP_KEY })).body.id
    const caraRow = (await connect(cara, t.id, { secret: MCP_KEY })).body.id
    await ada.call('PATCH', `/api/admin/integration-templates/${t.id}`, { url: `${fake.base}/mcp-open`, access: { ...nobody, users: [ids.bob] } })
    expect((await of(bob, t.id, 'integration.template_reconnect')).length).toBe(1)
    expect((await of(cara, t.id, 'integration.template_reconnect')).length).toBe(0)
    // cara's connection went as "no longer for her", bob's as "moved"
    const why = (id: string) => JSON.parse((h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'integration.delete' AND target = ?").get(id) as { detail: string }).detail).why
    expect(why(bobRow)).toBe('template_moved')
    expect(why(caraRow)).toBe('not_covered')
    await ada.call('DELETE', `/api/admin/integration-templates/${t.id}`)
  })
})

describe('QA follow-ups (dev 1565b39f1)', () => {
  test('a member is never told which admin made a template; the admin\'s list keeps the name', async () => {
    const t = await make(tpl({ name: 'Unnamed Maker' }))
    const seen = (await mine(bob)).find((x) => x.id === t.id)
    expect(seen.createdBy).toBeNull()
    expect(JSON.stringify(await mine(bob))).not.toContain('ADA')
    expect((await ada.call('GET', '/api/admin/integration-templates')).items.find((x: any) => x.id === t.id).createdBy).toMatchObject({ id: ids.ada })
    await ada.call('DELETE', `/api/admin/integration-templates/${t.id}`)
  })

  test('a dropped connection tells its member\'s open pages to read their lists again, once, and nobody else', async () => {
    const t = await make(tpl({ name: 'Stale Row', access: { ...nobody, users: [ids.bob, ids.cara] } }))
    const row = (await connect(bob, t.id, { secret: MCP_KEY })).body.id
    const told = (who: string) => h.hub.events.filter((e) => e.kind === 'publish' && e.target === who && (e.data as any).data?.code === 'integrations_changed').length
    const bobBefore = told(ids.bob), caraBefore = told(ids.cara), adaBefore = told(ids.ada)
    // a new address (as a new app does) drops bob's connection: his page is told, quietly (no text)
    await ada.call('PATCH', `/api/admin/integration-templates/${t.id}`, { url: `${fake.base}/mcp-open` })
    expect(told(ids.bob)).toBe(bobBefore + 1)
    const ev = h.hub.events.filter((e) => e.kind === 'publish' && e.target === ids.bob && (e.data as any).data?.code === 'integrations_changed').at(-1) as any
    expect(ev.data).toEqual({ type: 'notice', data: { level: 'info', code: 'integrations_changed', message: '' } })
    // cara had not connected it; the admin has nothing of theirs dropped
    expect(told(ids.cara)).toBe(caraBefore)
    expect(told(ids.ada)).toBe(adaBefore)
    // the old row's actions answer 404, which the page takes as "read the list again"
    expect((await bob.try('POST', `/api/integrations/${row}/refresh`, {})).status).toBe(404)
    // nothing left to drop: deleting the template tells nobody again
    await ada.call('DELETE', `/api/admin/integration-templates/${t.id}`)
    expect(told(ids.bob)).toBe(bobBefore + 1)
  })
})

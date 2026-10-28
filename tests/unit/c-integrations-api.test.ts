// External-service connections over the API (server/src/integrations/connections, docs/INTEGRATIONS.md): creating and
// checking MCP servers and HTTP APIs, the saved tool list, personal connections kept to their owner (admins included),
// team connections managed by admins and used only by the people their rules name, the team switch for personal
// connections, keys that never come back and that a new address drops, private addresses and redirects refused, limits.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { makeCApp, type CApp } from '../lib/c-app'
import { API_KEY, FakeServices, MCP_KEY } from '../lib/fake-services'
import { integrationsOf } from '../../server/src/integrations/connections/service'

setDefaultTimeout(30_000)

let A: CApp, fake: FakeServices
beforeAll(async () => {
  A = await makeCApp('c-integrations-api')
  fake = new FakeServices()
  integrationsOf(A.ctx, { net: fake.net() })
})
afterAll(async () => { fake?.stop(); await A?.close() })

const post = (as: any, p: string, body: unknown) => A.json(p, { method: 'POST', as, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const patch = (as: any, id: string, body: unknown) => A.json(`/api/integrations/${id}`, { method: 'PATCH', as, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const del = (as: any, id: string) => A.json(`/api/integrations/${id}`, { method: 'DELETE', as })
const list = async (as: any) => (await A.json('/api/integrations', { as })).body
const dbText = () => JSON.stringify(A.ctx.db.query('SELECT * FROM integrations').all()) + JSON.stringify(A.ctx.db.query('SELECT * FROM audit_log').all()) + JSON.stringify(A.ctx.db.query('SELECT * FROM integration_access').all())

describe('personal connections', () => {
  let tasks: any
  test('an MCP server with a key: checked at once, its tools saved (all pages; unusable schemas left out), the key never shown', async () => {
    const r = await post('alice', '/api/integrations', { kind: 'mcp', name: 'Tasks', url: `${fake.base}/mcp-key`, auth: 'bearer', secret: MCP_KEY })
    expect(r.status).toBe(201)
    tasks = r.body
    expect(tasks).toMatchObject({ scope: 'personal', kind: 'mcp', slug: 'tasks', status: 'connected', hasSecret: true, lastError: null, writePolicy: 'ask', canManage: true, access: null })
    expect(tasks.tools.map((t: any) => t.name)).toEqual(['search_tasks', 'create_task', 'inject', 'rpc_fail'])
    expect(tasks.tools.find((t: any) => t.name === 'search_tasks').readOnly).toBe(true)
    expect(tasks.tools.find((t: any) => t.name === 'create_task')).toMatchObject({ readOnly: false, title: 'Create a task' })
    expect(fake.seen.filter((s) => s.path === '/mcp-key' && s.body.includes('tools/list')).length).toBe(3)
    expect(JSON.stringify(r.body)).not.toContain(MCP_KEY)
    expect(JSON.stringify(await list('alice'))).not.toContain(MCP_KEY)
    expect(dbText()).not.toContain(MCP_KEY)
    const audit = A.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'integration.create' AND target = ?").get(tasks.id) as { detail: string }
    // a member's own connection: what kind, not its name or address
    expect(JSON.parse(audit.detail)).toEqual({ scope: 'personal', kind: 'mcp', auth: 'bearer' })
  })

  test('someone else\'s personal connection is not there for anyone: members, admins and the owner of the team', async () => {
    for (const who of ['bob', 'carol', 'dana'] as const) {
      expect(JSON.stringify(await list(who))).not.toContain(tasks.id)
      expect((await patch(who, tasks.id, { name: 'mine now' })).status).toBe(404)
      expect((await del(who, tasks.id)).status).toBe(404)
      expect((await post(who, `/api/integrations/${tasks.id}/refresh`, {})).status).toBe(404)
    }
    expect((await A.json('/api/admin/integrations', { as: 'carol' })).body.items.some((i: any) => i.id === tasks.id)).toBe(false)
  })

  test('a new address or another way of sending the key drops the key, unless a new one comes with it', async () => {
    let r = await patch('alice', tasks.id, { url: `${fake.base}/mcp-key?v=2` })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ hasSecret: false, status: 'error', tools: [] })
    expect(r.body.lastError).toContain('no key')
    r = await patch('alice', tasks.id, { secret: MCP_KEY })
    expect(r.body).toMatchObject({ hasSecret: true, status: 'connected' })
    r = await patch('alice', tasks.id, { auth: 'header', authHeader: 'X-Api-Key' })
    expect(r.body).toMatchObject({ hasSecret: false, status: 'error', authHeader: 'X-Api-Key' })
    r = await patch('alice', tasks.id, { url: `${fake.base}/mcp-header`, secret: MCP_KEY })
    expect(r.body).toMatchObject({ hasSecret: true, status: 'connected', url: `${fake.base}/mcp-header` })
    r = await patch('alice', tasks.id, { auth: 'bearer', url: `${fake.base}/mcp-key`, secret: MCP_KEY })
    expect(r.body).toMatchObject({ hasSecret: true, status: 'connected', authHeader: null })
    // a name or the write policy keeps it
    r = await patch('alice', tasks.id, { name: 'Task board', writePolicy: 'deny' })
    expect(r.body).toMatchObject({ hasSecret: true, name: 'Task board', writePolicy: 'deny' })
    expect((await patch('alice', tasks.id, { clearSecret: true })).body.hasSecret).toBe(false)
    expect((await patch('alice', tasks.id, { secret: MCP_KEY, writePolicy: 'ask', name: 'Tasks' })).body.status).toBe('connected')
    expect((await patch('alice', tasks.id, { auth: 'none', secret: MCP_KEY })).status).toBe(400)
    const host = await patch('alice', tasks.id, { auth: 'header', authHeader: 'Host' })
    expect(host.status).toBe(400)
    expect(host.body.error.fields['body.authHeader']).toBe('This header name cannot be used.')
    const changes = A.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'integration.update' AND target = ?").all(tasks.id) as { detail: string }[]
    expect(changes.map((c) => JSON.parse(c.detail).secret)).toContain('removed')
    expect(dbText()).not.toContain(MCP_KEY)
  })

  test('an HTTP API with a key: reachable and accepted is connected; a wrong key needs a new one', async () => {
    const ok = await post('alice', '/api/integrations', { kind: 'http', name: 'AI PM', url: `${fake.base}/api/v1`, auth: 'bearer', secret: API_KEY, notes: 'GET /tasks lists tasks' })
    expect(ok.status).toBe(201)
    expect(ok.body).toMatchObject({ slug: 'aipm', status: 'connected', notes: 'GET /tasks lists tasks', tools: [] })
    const wrong = await post('alice', '/api/integrations', { kind: 'http', name: 'AI PM', url: `${fake.base}/api/v1`, auth: 'bearer', secret: 'nope' })
    expect(wrong.body).toMatchObject({ slug: 'aipm2', status: 'needs_auth' })
    expect(wrong.body.lastError).toContain('HTTP 401')
    expect((await del('alice', wrong.body.id)).status).toBe(204)
    expect(dbText()).not.toContain(API_KEY)
    expect((await post('alice', '/api/integrations', { kind: 'http', name: 'x', url: `${fake.base}/api/v1`, auth: 'oauth' })).status).toBe(400)
    const taken = await post('alice', '/api/integrations', { kind: 'http', name: 'x', slug: 'aipm', url: `${fake.base}/api/v1`, auth: 'none' })
    expect(taken.status).toBe(400)
    expect(taken.body.error.fields['body.slug']).toBe('This short name is already in use.')
    // a key connection without a key is not set up yet; a sign-in one waits for the sign-in
    const nokey = await post('alice', '/api/integrations', { kind: 'http', name: 'No key', url: `${fake.base}/api/v1`, auth: 'bearer' })
    expect(nokey.body).toMatchObject({ status: 'error', hasSecret: false })
    expect(nokey.body.lastError).toContain('no key')
    const signin = await post('alice', '/api/integrations', { kind: 'mcp', name: 'Sign in', url: `${fake.base}/mcp-oauth`, auth: 'oauth' })
    expect(signin.body).toMatchObject({ status: 'needs_auth', hasSecret: false })
    for (const id of [nokey.body.id, signin.body.id]) await del('alice', id)
  })

  test('private, local and office addresses are refused; redirects are reported, not followed', async () => {
    for (const url of ['https://localhost/mcp', 'https://10.0.0.1/mcp', 'https://[::1]/mcp', 'https://printer.local/x', 'https://169.254.169.254/latest']) {
      const r = await post('alice', '/api/integrations', { kind: 'mcp', name: 'x', url, auth: 'none' })
      expect(r.status, url).toBe(400)
      expect(r.body.error.fields['body.url'], url).toContain('office network')
    }
    expect((await post('alice', '/api/integrations', { kind: 'mcp', name: 'x', url: 'http://example.com/mcp', auth: 'none' })).status).toBe(400)
    const dns = await post('alice', '/api/integrations', { kind: 'mcp', name: 'Intranet', url: 'https://intranet.test/mcp', auth: 'none' })
    expect(dns.body).toMatchObject({ status: 'error' })
    expect(dns.body.lastError).toContain('office network')
    const before = fake.seen.filter((s) => s.path === '/mcp-open').length
    const red = await post('alice', '/api/integrations', { kind: 'mcp', name: 'Moved', url: `${fake.base}/mcp-redirect`, auth: 'none' })
    expect(red.body).toMatchObject({ status: 'error' })
    expect(red.body.lastError).toContain('HTTP 307')
    expect(fake.seen.filter((s) => s.path === '/mcp-open').length).toBe(before)
    for (const id of [dns.body.id, red.body.id]) await del('alice', id)
  })

  test('limits: 20 personal connections per person', async () => {
    const now = new Date().toISOString()
    for (let i = 0; i < 20; i++) A.ctx.db.query(`INSERT INTO integrations (id, scope, owner_user_id, created_by, kind, name, slug, url, auth, status, created_at, updated_at)
      VALUES (?, 'personal', 'erin', 'erin', 'http', 'n', ?, 'https://svc.test/x', 'none', 'connected', ?, ?)`).run(`lim-${i}`, `s${i}`, now, now)
    const r = await post('erin', '/api/integrations', { kind: 'http', name: 'one more', url: `${fake.base}/api/v1`, auth: 'none' })
    expect(r.status).toBe(409)
    expect(r.body.error.message).toContain('20')
    A.ctx.db.query("DELETE FROM integrations WHERE id LIKE 'lim-%'").run()
  })
})

describe('team connections', () => {
  let team: any
  test('only admins make them; nobody uses one until the admin says who', async () => {
    expect((await post('alice', '/api/admin/integrations', { kind: 'mcp', name: 'Team tasks', url: `${fake.base}/mcp-open`, auth: 'none' })).status).toBe(403)
    const r = await post('carol', '/api/admin/integrations', { kind: 'mcp', name: 'Team tasks', url: `${fake.base}/mcp-open`, auth: 'none' })
    expect(r.status).toBe(201)
    team = r.body
    expect(team).toMatchObject({ scope: 'team', status: 'connected', access: { everyone: false, groups: [], users: [] }, canManage: true, createdBy: { id: 'carol', name: 'Carol Park' } })
    const audit = A.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'integration.create' AND target = ?").get(team.id) as { detail: string }
    expect(JSON.parse(audit.detail)).toMatchObject({ scope: 'team', name: 'Team tasks', host: new URL(fake.base).host, access: { everyone: false } })
    for (const who of ['alice', 'bob', 'carol', 'dana'] as const) expect(JSON.stringify(await list(who)), who).not.toContain(team.id)
  })

  test('access rules: a group\'s members see and use it, others do not; admins manage it without being users', async () => {
    let r = await patch('carol', team.id, { access: { everyone: false, groups: ['marketing'], users: [] } })
    expect(r.body.access).toEqual({ everyone: false, groups: ['marketing'], users: [] })
    const alice = (await list('alice')).items.find((i: any) => i.id === team.id)
    expect(alice).toMatchObject({ canManage: false, access: null, scope: 'team' })
    expect(JSON.stringify(await list('bob'))).not.toContain(team.id)
    expect(JSON.stringify(await list('carol'))).not.toContain(team.id) // an admin is not a user by being an admin
    expect((await A.json('/api/admin/integrations', { as: 'carol' })).body.items.find((i: any) => i.id === team.id).access.groups).toEqual(['marketing'])
    expect((await patch('alice', team.id, { name: 'mine' })).status).toBe(403)
    expect((await patch('bob', team.id, { name: 'mine' })).status).toBe(404)
    expect((await del('alice', team.id)).status).toBe(403)
    r = await patch('carol', team.id, { access: { everyone: false, groups: [], users: ['bob'] } })
    expect(JSON.stringify(await list('bob'))).toContain(team.id)
    expect(JSON.stringify(await list('alice'))).not.toContain(team.id)
    expect((await patch('carol', team.id, { access: { everyone: false, groups: ['no-such-group'], users: [] } })).status).toBe(400)
    // who may use it is part of the change in the admin audit (before and after)
    const changes = (A.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'integration.update' AND target = ?").all(team.id) as { detail: string }[]).map((c) => JSON.parse(c.detail))
    expect(changes.length).toBe(2)
    expect(changes[1]).toMatchObject({ changed: ['access'], access: { before: { groups: ['marketing'] }, after: { users: ['bob'] } } })
    expect(A.ctx.db.query("SELECT DISTINCT action FROM audit_log WHERE action LIKE 'integration.%' ORDER BY action").all()).toEqual([{ action: 'integration.create' }, { action: 'integration.delete' }, { action: 'integration.update' }])
    expect((await patch('carol', team.id, { access: { everyone: true, groups: [], users: [] } })).status).toBe(200)
    expect((await post('alice', '/api/integrations', { kind: 'mcp', name: 'x', url: `${fake.base}/mcp-open`, auth: 'none', access: { everyone: true, groups: [], users: [] } })).status).toBe(400)
  })

  test('limits: 50 team connections', async () => {
    const now = new Date().toISOString()
    const n = (A.ctx.db.query("SELECT count(*) AS n FROM integrations WHERE scope = 'team'").get() as { n: number }).n
    for (let i = n; i < 50; i++) A.ctx.db.query(`INSERT INTO integrations (id, scope, owner_user_id, created_by, kind, name, slug, url, auth, status, created_at, updated_at)
      VALUES (?, 'team', NULL, 'carol', 'http', 'n', ?, 'https://svc.test/x', 'none', 'connected', ?, ?)`).run(`tlim-${i}`, `t${i}`, now, now)
    expect((await post('carol', '/api/admin/integrations', { kind: 'http', name: 'one more', url: `${fake.base}/api/v1`, auth: 'none' })).status).toBe(409)
    A.ctx.db.query("DELETE FROM integrations WHERE id LIKE 'tlim-%'").run()
  })

  test('people who only use it see its address without the query (keys belong in the key field)', async () => {
    await patch('carol', team.id, { url: `${fake.base}/mcp-open?tenant=7` })
    expect((await list('alice')).items.find((i: any) => i.id === team.id).url).toBe(`${fake.base}/mcp-open`)
    expect((await A.json('/api/admin/integrations', { as: 'carol' })).body.items.find((i: any) => i.id === team.id).url).toBe(`${fake.base}/mcp-open?tenant=7`)
  })

  test('deleting: gone for everyone, audited', async () => {
    expect((await del('carol', team.id)).status).toBe(204)
    expect(A.ctx.db.query('SELECT count(*) AS n FROM integration_access WHERE integration_id = ?').get(team.id)).toEqual({ n: 0 })
    expect(A.ctx.db.query("SELECT count(*) AS n FROM audit_log WHERE action = 'integration.delete' AND target = ?").get(team.id)).toEqual({ n: 1 })
  })
})

describe('the team switch for personal connections', () => {
  test('off: none can be added (403), the existing ones stay listed so they can be removed; on again: allowed', async () => {
    const set = (v: boolean) => A.json('/api/admin/settings', { method: 'PATCH', as: 'dana', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ personalIntegrations: v }) })
    expect((await set(false)).status).toBe(200)
    const r = await post('alice', '/api/integrations', { kind: 'mcp', name: 'More', url: `${fake.base}/mcp-open`, auth: 'none' })
    expect(r.status).toBe(403)
    expect(r.body.error.message).toContain('turned off')
    const l = await list('alice')
    expect(l.personalAllowed).toBe(false)
    expect(l.items.some((i: any) => i.scope === 'personal')).toBe(true)
    await set(true)
    expect((await list('alice')).personalAllowed).toBe(true)
  })
})

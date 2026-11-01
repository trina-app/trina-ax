// How many tools a connection keeps and one answer offers (docs/DECISIONS.md "Connection tools: deferred, found and
// called"): a connection keeps every tool its service lists up to a hard ceiling (mcp.ts MAX_TOOLS, said as "N of M"
// past it), and an answer offers as tools of their own the connections that fit its budget (MAX_TURN_TOOLS tools,
// MAX_TURN_TOOL_CHARS characters); the others are looked up with find_tools and run with call_tool, so the
// per-answer budget no longer leaves a connection with no tools. The deferred tools themselves: c-integration-deferred-
// tools.test.ts.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { makeCApp, type CApp } from '../lib/c-app'
import { FakeServices } from '../lib/fake-services'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { CALL_TOOL, FIND_TOOLS, integrationToolProvider, MAX_TURN_TOOLS } from '../../server/src/integrations/connections/tools'

setDefaultTimeout(30_000)

let A: CApp, fake: FakeServices
beforeAll(async () => {
  A = await makeCApp('c-integration-tool-caps')
  fake = new FakeServices()
  integrationsOf(A.ctx, { net: fake.net() })
})
afterAll(async () => { fake?.stop(); await A?.close() })

const post = (as: any, p: string, body: unknown) => A.json(p, { method: 'POST', as, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const many = (n: number, prefix = 't') => Array.from({ length: n }, (_, i) => ({ name: `${prefix}${i}`, description: `tool ${i}`, inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }))
const prompt = (user: string) => integrationToolProvider(A.ctx).build({ userId: user, chatId: A.chat(user as never), turnId: 't', browser: false, scheduled: false })

describe('a connection keeps every tool its service lists', () => {
  test('150 offered over four pages: all 150 kept, no "N of M"; one answer offers them all', async () => {
    fake.tools = many(150)
    fake.pageSize = 40
    const r = await post('alice', '/api/integrations', { kind: 'mcp', name: 'Big', url: `${fake.base}/mcp-open`, auth: 'none' })
    expect(r.status).toBe(201)
    expect(r.body.tools).toHaveLength(150)
    expect(r.body.toolsTotal).toBeUndefined()
    expect(fake.seen.filter((s) => s.path === '/mcp-open' && s.body.includes('tools/list')).length).toBe(4)
    const built = prompt('alice')
    expect(built.tools).toHaveLength(150)
    expect(built.prompt).toContain('- Big (personal connection, MCP server): 150 tools named my_big__…\n')
  })

  test('a list an older server cut at 100: said as "100 of 150" until the connection is checked again, then all of them', async () => {
    const big = (await A.json('/api/integrations', { as: 'alice' })).body.items.find((i: any) => i.name === 'Big')
    const row = A.ctx.db.query('SELECT tools_json FROM integrations WHERE id = ?').get(big.id) as { tools_json: string }
    A.ctx.db.query('UPDATE integrations SET tools_json = ?, tools_total = 150 WHERE id = ?').run(JSON.stringify(JSON.parse(row.tools_json).slice(0, 100)), big.id)
    const old = (await A.json('/api/integrations', { as: 'alice' })).body.items.find((i: any) => i.id === big.id)
    expect([old.tools.length, old.toolsTotal]).toEqual([100, 150])
    expect(prompt('alice').prompt).toContain('- Big (personal connection, MCP server): 100 tools named my_big__… (the service offers 150 tools; 100 were saved when the connection was last checked; if the user needs one that is not here, say so: whoever manages the connection can check it again in its settings)')
    const again = await post('alice', `/api/integrations/${big.id}/refresh`, {})
    expect([again.body.tools.length, again.body.toolsTotal]).toEqual([150, undefined])
  })

  test('a service with fewer tools; checking again after it shrank keeps what it lists now', async () => {
    fake.tools = many(30, 's')
    const small = await post('alice', '/api/integrations', { kind: 'mcp', name: 'Small', url: `${fake.base}/mcp-open?small`, auth: 'none' })
    expect(small.body.tools).toHaveLength(30)
    expect(small.body.toolsTotal).toBeUndefined()
    expect(prompt('alice').prompt).toContain('- Small (personal connection, MCP server): 30 tools named my_small__…\n')
    const big = (await A.json('/api/integrations', { as: 'alice' })).body.items.find((i: any) => i.name === 'Big')
    const again = await post('alice', `/api/integrations/${big.id}/refresh`, {})
    expect(again.body.tools).toHaveLength(30)
  })

  test(`over the ${MAX_TURN_TOOLS} tools of one answer: the connection that does not fit is looked up, the others stay tools`, async () => {
    fake.tools = many(150)
    const big = (await A.json('/api/integrations', { as: 'alice' })).body.items.find((i: any) => i.name === 'Big')
    await post('alice', `/api/integrations/${big.id}/refresh`, {})
    await post('alice', '/api/integrations', { kind: 'mcp', name: 'Huge', url: `${fake.base}/mcp-open?huge`, auth: 'none' })
    const built = prompt('alice')
    const names = built.tools.map((t) => t.name)
    // by name: Big (150) fits, Huge (150 more) does not and is looked up, Small (30 more, 180) fits
    expect(names.filter((n) => n.startsWith('my_big__'))).toHaveLength(150)
    expect(names.filter((n) => n.startsWith('my_huge__'))).toHaveLength(0)
    expect(names.filter((n) => n.startsWith('my_small__'))).toHaveLength(30)
    expect(names).toEqual(expect.arrayContaining([FIND_TOOLS, CALL_TOOL]))
    expect(names.length).toBeLessThanOrEqual(MAX_TURN_TOOLS + 2)
    expect(built.prompt).toContain('- Huge (personal connection, MCP server): 150 tools, not loaded: look them up with find_tools and run them with call_tool')
    expect(built.prompt).toContain('- Small (personal connection, MCP server): 30 tools named my_small__…\n')
    expect(built.prompt).not.toMatch(/: 0 tools named/)
  })
})

describe('a big catalog in one page', () => {
  test('over 1 MiB in one tools/list page (Higgsfield sends 186 tools, about 1.07 MB) is read and kept whole', async () => {
    const before = { tools: fake.tools, pageSize: fake.pageSize }
    fake.tools = many(185, 'h').map((t) => ({ ...t, description: `${t.description} ${'x'.repeat(6000)}` }))
    fake.pageSize = 1000
    try {
      const r = await post('bob', '/api/integrations', { kind: 'mcp', name: 'Catalog', url: `${fake.base}/mcp-open?catalog`, auth: 'none' })
      expect(r.status).toBe(201)
      expect(r.body.status).toBe('connected')
      // descriptions are kept up to 1,000 characters each
      expect(r.body.tools).toHaveLength(185)
      expect(r.body.toolsTotal).toBeUndefined()
      await A.json(`/api/integrations/${r.body.id}`, { method: 'DELETE', as: 'bob' })
    } finally { Object.assign(fake, before) }
  })
})

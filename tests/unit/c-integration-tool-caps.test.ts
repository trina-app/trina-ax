// The tool caps of external-service connections are said, not hidden (docs/DECISIONS.md "Skills: the whole list, the
// skill tool"): a service that offers more than the 100 tools the server keeps per connection is saved as "100 of
// 150" (Settings > External services shows it), and the AI's instructions say how many of a connection's tools it
// has when the per-connection cap or the 200-tools-per-answer cap left some out. The caps themselves stay.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { makeCApp, type CApp } from '../lib/c-app'
import { FakeServices } from '../lib/fake-services'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { MAX_TOOLS } from '../../server/src/integrations/connections/mcp'
import { integrationToolProvider, MAX_TURN_TOOLS } from '../../server/src/integrations/connections/tools'

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

describe('more tools than the server keeps', () => {
  test('150 offered: 100 kept and "100 of 150" saved, shown and told to the AI', async () => {
    fake.tools = many(150)
    fake.pageSize = 40
    const r = await post('alice', '/api/integrations', { kind: 'mcp', name: 'Big', url: `${fake.base}/mcp-open`, auth: 'none' })
    expect(r.status).toBe(201)
    expect(r.body.tools).toHaveLength(MAX_TOOLS)
    expect(r.body.toolsTotal).toBe(150)
    // every page was read to count them
    expect(fake.seen.filter((s) => s.path === '/mcp-open' && s.body.includes('tools/list')).length).toBe(4)
    const list = (await A.json('/api/integrations', { as: 'alice' })).body
    expect(list.items.find((i: any) => i.id === r.body.id).toolsTotal).toBe(150)
    const built = prompt('alice')
    expect(built.tools).toHaveLength(MAX_TOOLS)
    expect(built.prompt).toContain('- Big (personal connection, MCP server): 100 tools named my_big__… (100 of the 150 tools the service offers: the team server keeps the first 100 of a connection')
  })

  test('a service with fewer tools than the cap has no total; checking again after it shrank clears it', async () => {
    fake.tools = many(30, 's')
    const small = await post('alice', '/api/integrations', { kind: 'mcp', name: 'Small', url: `${fake.base}/mcp-open?small`, auth: 'none' })
    expect(small.body.tools).toHaveLength(30)
    expect(small.body.toolsTotal).toBeUndefined()
    expect(prompt('alice').prompt).toContain('- Small (personal connection, MCP server): 30 tools named my_small__…\n')
    const big = (await A.json('/api/integrations', { as: 'alice' })).body.items.find((i: any) => i.name === 'Big')
    const again = await post('alice', `/api/integrations/${big.id}/refresh`, {})
    expect(again.body.tools).toHaveLength(30)
    expect(again.body.toolsTotal).toBeUndefined()
  })

  test(`the ${MAX_TURN_TOOLS} tools of one answer: a connection left out is named with how many it has`, async () => {
    fake.tools = many(150)
    const big = (await A.json('/api/integrations', { as: 'alice' })).body.items.find((i: any) => i.name === 'Big')
    await post('alice', `/api/integrations/${big.id}/refresh`, {})
    await post('alice', '/api/integrations', { kind: 'mcp', name: 'Huge', url: `${fake.base}/mcp-open?huge`, auth: 'none' })
    const built = prompt('alice')
    expect(built.tools.length).toBeLessThanOrEqual(MAX_TURN_TOOLS)
    // connections are taken by name: Big (100), Huge (100), then Small gets none
    expect(built.prompt).toContain('- Small (personal connection, MCP server): 0 tools named my_small__… (0 of the 30 tools the service offers: one answer can have at most 200 tools from all connections together')
  })
})

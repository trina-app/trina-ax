// What reading MCP tool lists costs the server (mcp.ts listTools, store.ts savedTools). "Check again" reads tools/list
// until the list kept is full (1,000 tools or 4,000,000 characters), 20 pages or 16 MiB, so a server that pages on
// forever costs at most that (it was 100 pages of 8 MiB), and Settings and the AI say "N of more than N" when pages
// were left unread. A turn reads the connections without their saved lists and takes each list, parsed, from memory by
// (connection, tools_rev): parsed once, read again when it changes; who may use a connection and which of its tools
// are turned off are still read with every turn and every call.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { makeCApp, type CApp, type Person } from '../lib/c-app'
import { FakeServices } from '../lib/fake-services'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { MAX_SCHEMAS_CHARS, MCP_LIST_MAX_PAGES, MCP_LIST_TOTAL_BYTES } from '../../server/src/integrations/connections/mcp'
import { getRow, savedTools, ToolLists, toolListsOf, usable } from '../../server/src/integrations/connections/store'
import { CALL_TOOL, FIND_TOOLS, integrationToolProvider } from '../../server/src/integrations/connections/tools'
import { TurnFiles } from '../../server/src/files/service'
import type { TurnToolContext } from '../../server/src/services'

setDefaultTimeout(60_000)

let A: CApp, fake: FakeServices
const send = (method: string) => (as: Person, p: string, body?: unknown) =>
  A.json(p, { method, as, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
const post = send('POST'), patch = send('PATCH'), del = send('DELETE')
const tool = (name: string) => ({ name, description: `${name} tool`, inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, annotations: { readOnlyHint: true } })
/** the tools/list requests the fake server had for this address */
const pages = (path: string) => fake.seen.filter((s) => s.path === path && s.body.includes('"tools/list"')).length
const listOf = (id: string) => savedTools(A.ctx.db, getRow(A.ctx.db, id)!)

beforeAll(async () => {
  A = await makeCApp('c-integration-tool-load')
  fake = new FakeServices()
  integrationsOf(A.ctx, { net: fake.net() })
})
afterAll(async () => { fake?.stop(); await A?.close() })

function turn(user: Person) {
  const chat = A.chat(user)
  const turnId = A.turn(user, chat)
  const built = integrationToolProvider(A.ctx).build({ userId: user, chatId: chat, turnId, browser: false, scheduled: false })
  const files = { user: A.ctx.files.principal(user), turnId, files: new TurnFiles() } as TurnToolContext['files']
  const tc: TurnToolContext = { turnId, chatId: chat, userId: user, messageId: 'm', locale: 'en', signal: new AbortController().signal, files }
  const tools = new Map(built.tools.map((t) => [t.name, t]))
  const call = async (name: string, args: unknown) => {
    const t = tools.get(name)
    if (!t) throw new Error(`no tool ${name}; have ${[...tools.keys()].join(', ')}`)
    const r = await t.call(args, tc)
    return { text: r.content.map((c) => (c.type === 'text' ? c.text : '')).join(''), isError: !!r.isError, summary: r.summary ?? '' }
  }
  const named = (prefix: string) => [...tools.keys()].filter((n) => n.startsWith(prefix))
  return { tools, named, prompt: built.prompt ?? '', call }
}

describe('reading tools/list', () => {
  test(`a server that pages on forever: ${MCP_LIST_MAX_PAGES} pages are read, their tools kept and said as "20 of more than 20"`, async () => {
    // every page has a new tool and names a next page; a name seen before counts once
    fake.endless = (n) => [tool(`page${n}`), tool('page0')]
    let id = ''
    try {
      const r = await post('alice', '/api/integrations', { kind: 'mcp', name: 'Forever', url: `${fake.base}/mcp-open?forever`, auth: 'none' })
      id = r.body.id
      expect(r.body.status).toBe('connected')
      expect(pages('/mcp-open?forever')).toBe(MCP_LIST_MAX_PAGES)
      expect(r.body.tools.map((t: any) => t.name)).toEqual(Array.from({ length: MCP_LIST_MAX_PAGES }, (_, i) => `page${i}`))
      expect([r.body.toolsTotal, r.body.toolsTotalMore]).toEqual([MCP_LIST_MAX_PAGES, true])
      // the server's ceiling, not a list an older server cut: "check again" is not said
      const line = turn('alice').prompt.split('\n').find((l) => l.startsWith('- Forever '))!
      expect(line).toContain(`(the service offers more than ${MCP_LIST_MAX_PAGES} tools; the team server keeps the first ${MCP_LIST_MAX_PAGES} of a connection;`)
      expect(line).not.toContain('check it again')
      // "Check again" reads the same number of pages again
      await post('alice', `/api/integrations/${id}/refresh`, {})
      expect(pages('/mcp-open?forever')).toBe(2 * MCP_LIST_MAX_PAGES)
    } finally {
      fake.endless = null
      if (id) await del('alice', `/api/integrations/${id}`)
    }
  })

  test(`big pages on forever, of tools that cannot be kept: at most ${MCP_LIST_TOTAL_BYTES / 1024 / 1024} MiB is read, the pages before are kept`, async () => {
    // about 3 MiB a page: a tool without an object schema (never kept) and a small one
    const junk = 'x'.repeat(3 * 1024 * 1024)
    fake.endless = (n) => [{ name: `junk${n}`, description: junk, inputSchema: { type: 'string' } }, tool(`page${n}`)]
    let id = ''
    try {
      const r = await post('alice', '/api/integrations', { kind: 'mcp', name: 'Heavy', url: `${fake.base}/mcp-open?heavy`, auth: 'none' })
      id = r.body.id
      expect(r.body.status).toBe('connected')
      // five pages are read whole (15 MiB); the sixth is cut at the 1 MiB left and not kept (it was 100 pages, 300 MiB)
      expect(pages('/mcp-open?heavy')).toBe(6)
      expect(r.body.tools.map((t: any) => t.name)).toEqual(['page0', 'page1', 'page2', 'page3', 'page4'])
      expect([r.body.toolsTotal, r.body.toolsTotalMore]).toEqual([5, true])
    } finally {
      fake.endless = null
      if (id) await del('alice', `/api/integrations/${id}`)
    }
  })

  test('the list kept is full of long schemas (4,000,000 characters): the pages after it are not read', async () => {
    const long = (name: string) => ({ name, description: 'long tool', inputSchema: { type: 'object', properties: { q: { type: 'string', description: 'x'.repeat(29_900) } } } })
    const cost = JSON.stringify(long('t').inputSchema).length + 'long tool'.length
    const kept = Math.floor(MAX_SCHEMAS_CHARS / cost)
    fake.endless = (n) => Array.from({ length: 50 }, (_, i) => long(`t${n * 50 + i}`))
    let id = ''
    try {
      const r = await post('alice', '/api/integrations', { kind: 'mcp', name: 'Long', url: `${fake.base}/mcp-open?long`, auth: 'none' })
      id = r.body.id
      const read = Math.ceil((kept + 1) / 50)
      expect(read).toBe(3)
      expect(pages('/mcp-open?long')).toBe(read)
      expect(r.body.tools).toHaveLength(kept)
      // counted in the pages read; the service names more pages
      expect([r.body.toolsTotal, r.body.toolsTotalMore]).toEqual([read * 50, true])
    } finally {
      fake.endless = null
      if (id) await del('alice', `/api/integrations/${id}`)
    }
  })

  test('a list that ends: counted whole, no "more than"', async () => {
    fake.tools = Array.from({ length: 30 }, (_, i) => tool(`s${i}`))
    fake.pageSize = 4
    try {
      const r = await post('alice', '/api/integrations', { kind: 'mcp', name: 'Ends', url: `${fake.base}/mcp-open?ends`, auth: 'none' })
      expect(pages('/mcp-open?ends')).toBe(8)
      expect(r.body.tools).toHaveLength(30)
      expect([r.body.toolsTotal, r.body.toolsTotalMore]).toEqual([undefined, undefined])
      await del('alice', `/api/integrations/${r.body.id}`)
    } finally { fake.pageSize = 2 }
  })
})

describe('saved tool lists in memory', () => {
  test('a turn reads connections without their lists and parses each list once; a changed list is picked up', async () => {
    fake.tools = [tool('alpha'), tool('beta')]
    fake.pageSize = 100
    const c = (await post('bob', '/api/integrations', { kind: 'mcp', name: 'Lists', url: `${fake.base}/mcp-open?lists`, auth: 'none' })).body
    try {
      // the rows a turn reads do not carry the saved lists (each can be 4,000,000 characters)
      const rows = usable(A.ctx.db, 'bob')
      expect(rows.map((r) => r.id)).toContain(c.id)
      expect(rows.some((r) => 'tools_json' in r)).toBe(false)
      const first = listOf(c.id)
      expect(turn('bob').named('my_lists__')).toEqual(['my_lists__alpha', 'my_lists__beta'])
      // the same parsed list for every turn and call, frozen (shared: nothing may change it)
      expect(turn('bob').named('my_lists__')).toEqual(['my_lists__alpha', 'my_lists__beta'])
      expect(listOf(c.id)).toBe(first)
      expect(Object.isFrozen(first) && Object.isFrozen(first[0]) && Object.isFrozen((first[0]!.inputSchema as any).properties.q)).toBe(true)
      // checked again with the same list: tools_rev does not move, the list is not parsed again
      const rev = getRow(A.ctx.db, c.id)!.tools_rev
      await post('bob', `/api/integrations/${c.id}/refresh`, {})
      expect(getRow(A.ctx.db, c.id)!.tools_rev).toBe(rev)
      expect(listOf(c.id)).toBe(first)
      // the service changed its list: "Check again" saves it and the next turn has it
      fake.tools = [tool('alpha'), tool('gamma')]
      await post('bob', `/api/integrations/${c.id}/refresh`, {})
      expect(getRow(A.ctx.db, c.id)!.tools_rev).toBe(rev + 1)
      expect(turn('bob').named('my_lists__')).toEqual(['my_lists__alpha', 'my_lists__gamma'])
      expect(listOf(c.id)).not.toBe(first)
      // any other write of the list too (the trigger moves tools_rev with tools_json), in a turn and in Settings
      A.ctx.db.query('UPDATE integrations SET tools_json = ? WHERE id = ?').run(JSON.stringify([{ name: 'delta', title: null, description: 'd', readOnly: true, inputSchema: { type: 'object' } }]), c.id)
      expect(turn('bob').named('my_lists__')).toEqual(['my_lists__delta'])
      const shown = (await A.json('/api/integrations', { as: 'bob' })).body.items.find((i: any) => i.id === c.id)
      expect(shown.tools.map((t: any) => t.name)).toEqual(['delta'])
      // a new address empties the list (and the next check saves the new one)
      fake.tools = [tool('epsilon')]
      await patch('bob', `/api/integrations/${c.id}`, { url: `${fake.base}/mcp-open?lists2` })
      expect(turn('bob').named('my_lists__')).toEqual(['my_lists__epsilon'])
    } finally {
      await del('bob', `/api/integrations/${c.id}`)
      fake.pageSize = 2
    }
    // a connection deleted: its list is not held any more
    expect(toolListsOf(A.ctx.db).ids()).not.toContain(c.id)
  })

  test('turned-off tools and who may use a connection are still checked with every call, not held with the list', async () => {
    fake.tools = [tool('alpha'), tool('beta')]
    fake.pageSize = 100
    const own = (await post('erin', '/api/integrations', { kind: 'mcp', name: 'Own', url: `${fake.base}/mcp-open?own`, auth: 'none' })).body
    // a team connection too long for one answer: found with find_tools, run with call_tool
    const wide = (name: string) => ({ ...tool(name), inputSchema: { type: 'object', properties: { q: { type: 'string', description: 'x'.repeat(30_000) } } } })
    fake.tools = [wide('alpha'), wide('beta')]
    const shared = (await post('carol', '/api/admin/integrations', { kind: 'mcp', name: 'Shared', url: `${fake.base}/mcp-open?shared`, auth: 'none', access: { everyone: false, groups: ['marketing'], users: [] } })).body
    try {
      const heldOwn = listOf(own.id), heldShared = listOf(shared.id)
      const e = turn('erin')
      expect(e.named('my_own__')).toEqual(['my_own__alpha', 'my_own__beta'])
      expect(e.named('team_shared__')).toEqual([])
      expect(e.tools.has(CALL_TOOL) && e.tools.has(FIND_TOOLS)).toBe(true)
      // turned off after the turn began, as a tool of its own and through call_tool: refused, nothing reaches the service
      await post('erin', `/api/integrations/${own.id}/tools`, { name: 'alpha', enabled: false })
      await post('carol', `/api/integrations/${shared.id}/tools`, { name: 'alpha', enabled: false })
      const before = fake.calls.length
      expect(await e.call('my_own__alpha', { q: 'x' })).toMatchObject({ isError: true, summary: 'my_own__alpha -> tool off' })
      expect(await e.call(CALL_TOOL, { name: 'team_shared__alpha', arguments: { q: 'x' } })).toMatchObject({ isError: true, summary: 'team_shared__alpha -> tool off' })
      expect((await e.call(FIND_TOOLS, { query: 'select:team_shared__alpha,team_shared__beta' })).text).not.toContain('## team_shared__alpha')
      expect(fake.calls.length).toBe(before)
      // the lists in memory are the same ones: a switch changes no list
      expect(listOf(own.id)).toBe(heldOwn)
      expect(listOf(shared.id)).toBe(heldShared)
      // the next turn does not have them; the tools still on run
      const next = turn('erin')
      expect(next.named('my_own__')).toEqual(['my_own__beta'])
      expect(next.prompt).toContain('1 more turned off by whoever manages this connection')
      expect((await e.call('my_own__beta', { q: 'x' })).isError).toBe(false)
      expect((await e.call(CALL_TOOL, { name: 'team_shared__beta', arguments: { q: 'x' } })).isError).toBe(false)
      // who may use the team connection, taken away after the turn began
      await patch('carol', `/api/integrations/${shared.id}`, { access: { everyone: false, groups: [], users: [] } })
      expect(await e.call(CALL_TOOL, { name: 'team_shared__beta', arguments: { q: 'x' } })).toMatchObject({ isError: true, summary: 'team_shared__beta -> no access' })
      expect(turn('erin').tools.has(CALL_TOOL)).toBe(false)
    } finally {
      await del('erin', `/api/integrations/${own.id}`)
      await del('carol', `/api/integrations/${shared.id}`)
      fake.pageSize = 2
    }
  })

  test('held by size, the list used longest ago first', () => {
    const list = (name: string) => [tool(name)] as never[]
    const lists = new ToolLists(100)
    lists.set('a', 1, list('a'), 40)
    lists.set('b', 1, list('b'), 40)
    expect(lists.get('a', 1)).toBeDefined()
    // c does not fit with both: b was used longest ago
    lists.set('c', 1, list('c'), 40)
    expect(lists.ids()).toEqual(['a', 'c'])
    expect(lists.size).toBe(80)
    // another tools_rev is another list; the new one replaces the old
    expect(lists.get('a', 2)).toBeUndefined()
    lists.set('a', 2, list('a2'), 10)
    expect([lists.ids(), lists.size]).toEqual([['c', 'a'], 50])
    // a list bigger than the whole budget is not held
    lists.set('d', 1, list('d'), 101)
    expect([lists.ids(), lists.size]).toEqual([['c', 'a'], 50])
    lists.drop('c')
    expect([lists.ids(), lists.size]).toEqual([['a'], 10])
  })
})

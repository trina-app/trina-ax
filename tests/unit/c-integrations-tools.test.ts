// The AI's tools for external-service connections (server/src/integrations/connections/tools.ts): made per person at
// the start of a turn from the saved tool lists, every call checked again (who may use it now), writes refused / asked
// on the server's card / allowed by the connection's write policy, answers wrapped as external data, the chat's read
// scope and taint, api_request kept under its connection's address, name length mapping and limits.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { TEAM_TOOL_PREFIX } from '@mycel/shared'
import { makeCApp, type CApp, type Person } from '../lib/c-app'
import { API_KEY, FakeServices, MCP_KEY } from '../lib/fake-services'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { buildUrl, integrationToolProvider, MAX_RESULT_CHARS, toolName } from '../../server/src/integrations/connections/tools'
import { readScope, sourceLabel, widening } from '../../server/src/chat/read-scope'
import { TurnFiles } from '../../server/src/files/service'
import type { TurnTool, TurnToolContext } from '../../server/src/services'

setDefaultTimeout(30_000)

let A: CApp, fake: FakeServices
let tasks: any, aipm: any, team: any
const post = (as: Person, p: string, body: unknown) => A.json(p, { method: 'POST', as, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const patch = (as: Person, id: string, body: unknown) => A.json(`/api/integrations/${id}`, { method: 'PATCH', as, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

beforeAll(async () => {
  A = await makeCApp('c-integrations-tools')
  fake = new FakeServices()
  integrationsOf(A.ctx, { net: fake.net() })
  tasks = (await post('alice', '/api/integrations', { kind: 'mcp', name: 'Tasks', url: `${fake.base}/mcp-key`, auth: 'bearer', secret: MCP_KEY })).body
  aipm = (await post('alice', '/api/integrations', { kind: 'http', name: 'AI PM', url: `${fake.base}/api/v1`, auth: 'bearer', secret: API_KEY, notes: 'GET /tasks lists the tasks; POST /tasks makes one.' })).body
  team = (await post('carol', '/api/admin/integrations', { kind: 'mcp', name: 'Team board', url: `${fake.base}/mcp-open`, auth: 'none', access: { everyone: false, groups: ['marketing'], users: [] } })).body
  expect([tasks.status, aipm.status, team.status]).toEqual(['connected', 'connected', 'connected'])
})
afterAll(async () => { fake?.stop(); await A?.close() })

type Asked = { answer: boolean; questions: string[] }
const ask = (answer: boolean): Asked => ({ answer, questions: [] })

function turn(user: Person, o: { person?: Asked; scheduled?: boolean; chat?: string } = {}) {
  const chat = o.chat ?? A.chat(user)
  const turnId = A.turn(user, chat)
  const built = integrationToolProvider(A.ctx).build({ userId: user, chatId: chat, turnId, browser: false, scheduled: !!o.scheduled })
  const files = { user: A.ctx.files.principal(user), turnId, files: new TurnFiles() } as TurnToolContext['files']
  if (o.person) { const p = o.person; files.person = { locale: 'en', async confirm(q) { p.questions.push(q); return p.answer }, *turnUrls() {} } }
  const tc: TurnToolContext = { turnId, chatId: chat, userId: user, messageId: 'm', locale: 'en', signal: new AbortController().signal, files }
  const tools = new Map(built.tools.map((t) => [t.name, t]))
  const call = async (name: string, args: unknown) => {
    const t = tools.get(name) as TurnTool
    if (!t) throw new Error(`no tool ${name}; have ${[...tools.keys()].join(', ')}`)
    const r = await t.call(args, tc)
    return { text: r.content.map((c) => (c.type === 'text' ? c.text : '')).join(''), isError: !!r.isError, summary: r.summary ?? '' }
  }
  return { chat, turnId, tools, prompt: built.prompt, call }
}

describe('tools made per person', () => {
  test('the owner gets her connections\' tools and api_request; others do not; an admin is not a user of a team connection', () => {
    const a = turn('alice')
    expect([...a.tools.keys()]).toEqual(['my_tasks__search_tasks', 'my_tasks__create_task', 'my_tasks__inject', 'my_tasks__rpc_fail',
      'team_teamboard__search_tasks', 'team_teamboard__create_task', 'team_teamboard__inject', 'team_teamboard__rpc_fail', 'api_request'])
    expect(a.tools.get('my_tasks__create_task')!.description).toStartWith('[Tasks, personal connection] Create a task: Create a task')
    expect(a.tools.get('my_tasks__create_task')!.description).toContain('Changes something')
    expect(a.tools.get('team_teamboard__search_tasks')!.description).toStartWith('[Team board, team connection]')
    expect(a.tools.get('my_tasks__create_task')!.label!({ title: 'x' }, 'ko')).toBe('Tasks · create_task')
    expect(a.tools.get('api_request')!.label!({ connection: 'my_aipm', method: 'post', path: '/tasks?x=1' }, 'en')).toBe('AI PM · POST /tasks')
    const api = a.tools.get('api_request')!
    expect(api.description).toContain('"my_aipm": AI PM (personal connection)')
    expect(api.description).toContain('POST /tasks makes one.')
    expect((api.inputSchema.properties as any).connection.enum).toEqual(['my_aipm'])
    expect(a.prompt).toContain('## Connected services')
    expect(a.prompt).toContain('Tasks (personal connection, MCP server)')
    expect(a.prompt).toContain('external data')
    expect(a.prompt).toContain('shows as [hidden key]; you cannot see or send it.')
    for (const t of a.tools.values()) {
      expect(TEAM_TOOL_PREFIX.length + t.name.length).toBeLessThanOrEqual(64)
      expect(t.name).toMatch(/^[a-zA-Z0-9_-]+$/)
      expect(t.description + JSON.stringify(t.inputSchema)).not.toContain(MCP_KEY)
      expect(t.description).not.toContain(API_KEY)
    }
    expect(turn('erin').tools.has('team_teamboard__search_tasks')).toBe(true) // marketing
    expect(turn('erin').tools.has('my_tasks__search_tasks')).toBe(false)
    expect(turn('bob').tools.size).toBe(0)
    expect(turn('bob').prompt).toBeNull()
    expect(turn('carol').tools.size).toBe(0)
  })

  test('long and odd remote names become valid names of at most 64 characters with the prefix, mapped back to the remote name', async () => {
    const long = 'x'.repeat(70)
    const n1 = toolName('team_abcdefghijkl', long, new Set())!
    expect(TEAM_TOOL_PREFIX.length + n1.length).toBeLessThanOrEqual(64)
    expect(n1).toMatch(/^team_abcdefghijkl__x+_[0-9a-f]{8}$/)
    expect(toolName('my_a', 'files.read/v2', new Set())).toBe('my_a__files_read_v2')
    expect(toolName('my_a', 'files_read_v2', new Set(['my_a__files_read_v2']))).toMatch(/^my_a__files_read_v2_[0-9a-f]{8}$/)
    const saved = fake.tools
    fake.tools = [{ name: long, description: 'long', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }, { name: 'files.read', description: 'dotted', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }]
    try {
      await post('alice', `/api/integrations/${tasks.id}/refresh`, {})
      const a = turn('alice')
      const names = [...a.tools.keys()].filter((n) => n.startsWith('my_tasks__'))
      expect(names).toHaveLength(2)
      for (const n of names) expect(TEAM_TOOL_PREFIX.length + n.length).toBeLessThanOrEqual(64)
      await a.call(names[0]!, { a: 1 })
      await a.call('my_tasks__files_read', {})
      expect(fake.calls.slice(-2).map((c) => c.name)).toEqual([long, 'files.read'])
    } finally {
      fake.tools = saved
      await post('alice', `/api/integrations/${tasks.id}/refresh`, {})
    }
  })

  test('limits: at most 100 tools per connection are kept', async () => {
    const saved = fake.tools
    fake.tools = Array.from({ length: 130 }, (_, i) => ({ name: `t${i}`, description: '', inputSchema: { type: 'object' } }))
    fake.pageSize = 50
    try {
      const r = await post('alice', `/api/integrations/${tasks.id}/refresh`, {})
      expect(r.body.tools).toHaveLength(100)
    } finally {
      fake.tools = saved; fake.pageSize = 2
      await post('alice', `/api/integrations/${tasks.id}/refresh`, {})
    }
  })
})

describe('calls', () => {
  test('a read-only tool runs without asking; the answer is external data, the chat is marked and remembers where it came from', async () => {
    const p = ask(false)
    const a = turn('alice', { person: p })
    const r = await a.call('my_tasks__search_tasks', { q: 'plan' })
    expect(r.isError).toBe(false)
    expect(p.questions).toHaveLength(0)
    expect(r.text).toContain('<external_data source="Tasks">')
    expect(r.text).toContain('search_tasks: {"q":"plan"}')
    expect(r.summary).toBe('my_tasks__search_tasks -> ok (26 chars)')
    expect(fake.calls.at(-1)).toMatchObject({ name: 'search_tasks', args: { q: 'plan' }, auth: `Bearer ${MCP_KEY}` })
    expect(readScope(A.ctx.db, a.chat)).toEqual([{ type: 'user', id: 'alice' }])
    expect(A.ctx.db.query('SELECT session_tainted AS t FROM chats WHERE id = ?').get(a.chat)).toEqual({ t: 1 })
    expect(r.text + r.summary).not.toContain(MCP_KEY)
    const last = A.ctx.db.query('SELECT last_used_at FROM integrations WHERE id = ?').get(tasks.id) as { last_used_at: string | null }
    expect(last.last_used_at).not.toBeNull()
    // an answer that pretends to close the block stays inside it
    const inj = await turn('alice').call('my_tasks__inject', {})
    expect(inj.text.match(/<\/external_data>/g)).toHaveLength(1)
    expect(inj.text).toContain('‹/external_data>')
    // a JSON-RPC error is the tool's answer: an error result, still external data for the chat
    const bad = await turn('alice').call('my_tasks__rpc_fail', {})
    expect(bad).toMatchObject({ isError: true })
    expect(bad.text).toContain('task store is read-only today')
  })

  test('write policy "ask": the server\'s card names the connection, the tool and what is sent; yes sends, no sends nothing', async () => {
    const no = ask(false)
    const before = fake.calls.length
    const r0 = await turn('alice', { person: no }).call('my_tasks__create_task', { title: 'Quarterly plan' })
    expect(r0.isError).toBe(true)
    expect(r0.text).toContain('did not allow')
    expect(r0.summary).toBe('my_tasks__create_task -> not allowed by the user')
    expect(no.questions).toHaveLength(1)
    expect(no.questions[0]).toContain('The AI wants to do this at Tasks: create_task')
    expect(no.questions[0]).toContain('{"title":"Quarterly plan"}')
    expect(fake.calls.length).toBe(before)
    const yes = ask(true)
    const r = await turn('alice', { person: yes }).call('my_tasks__create_task', { title: 'Q'.repeat(500) })
    expect(r.isError).toBe(false)
    expect(r.summary).toContain('(confirmed by the user)')
    expect(yes.questions[0]!.length).toBeLessThan(500) // the first 300 characters of what is sent
    expect(fake.calls.at(-1)!.name).toBe('create_task')
  })

  test('nobody to ask (a scheduled run, no person): refused unless the policy is "allow"; "deny" refuses without asking', async () => {
    const before = fake.calls.length
    expect((await turn('alice', { scheduled: true, person: ask(true) }).call('my_tasks__create_task', { title: 'x' })).summary).toBe('my_tasks__create_task -> refused (nobody to ask)')
    expect((await turn('alice').call('my_tasks__create_task', { title: 'x' })).summary).toBe('my_tasks__create_task -> refused (nobody to ask)')
    expect((await turn('alice', { scheduled: true }).call('my_tasks__search_tasks', {})).isError).toBe(false) // reads still run
    await patch('alice', tasks.id, { writePolicy: 'deny' })
    const p = ask(true)
    const d = await turn('alice', { person: p }).call('my_tasks__create_task', { title: 'x' })
    expect(d.summary).toBe('my_tasks__create_task -> refused (write policy deny)')
    expect(p.questions).toHaveLength(0)
    await patch('alice', tasks.id, { writePolicy: 'allow' })
    const s = await turn('alice', { scheduled: true }).call('my_tasks__create_task', { title: 'by schedule' })
    expect(s.isError).toBe(false)
    expect(fake.calls.filter((c) => c.name === 'create_task').length - fake.calls.slice(0, before).filter((c) => c.name === 'create_task').length).toBe(1)
    await patch('alice', tasks.id, { writePolicy: 'ask' })
  })

  test('who may use it is checked on every call: a removed rule, a disabled account, the team switch', async () => {
    const e = turn('erin')
    expect((await e.call('team_teamboard__search_tasks', {})).isError).toBe(false)
    await patch('carol', team.id, { access: { everyone: false, groups: [], users: [] } })
    const r = await e.call('team_teamboard__search_tasks', {})
    expect(r).toMatchObject({ isError: true, summary: 'team_teamboard__search_tasks -> no access' })
    await patch('carol', team.id, { access: { everyone: false, groups: ['marketing'], users: [] } })
    const a = turn('alice')
    A.ctx.db.query("UPDATE users SET status = 'disabled' WHERE id = 'alice'").run()
    expect((await a.call('my_tasks__search_tasks', {})).summary).toBe('my_tasks__search_tasks -> no access')
    A.ctx.db.query("UPDATE users SET status = 'active' WHERE id = 'alice'").run()
    A.ctx.db.query("INSERT INTO settings (key, value) VALUES ('personalIntegrations', 'false')").run()
    try {
      expect((await a.call('my_tasks__search_tasks', {})).summary).toBe('my_tasks__search_tasks -> no access')
      expect([...turn('alice').tools.keys()].some((n) => n.startsWith('my_') || n === 'api_request')).toBe(false)
      expect(turn('alice').tools.has('team_teamboard__search_tasks')).toBe(true)
    } finally { A.ctx.db.query("DELETE FROM settings WHERE key = 'personalIntegrations'").run() }
  })

  test('read scope: an answer from a team connection for one group makes saving to shared/ ask; one for everyone does not', async () => {
    const e = turn('erin')
    await e.call('team_teamboard__search_tasks', {})
    expect(readScope(A.ctx.db, e.chat)).toEqual([{ type: 'integration', id: team.id }])
    const w = widening(A.ctx.db, e.chat, ['shared', 'notes.md'])
    expect(w?.narrower).toEqual([{ type: 'integration', id: team.id }])
    expect(sourceLabel(A.ctx.db, w!.narrower[0]!, 'erin', { mine: 'mine', root: 'root' })).toBe('Team board')
    expect(widening(A.ctx.db, e.chat, ['users', 'erin', 'notes.md'])).toBeNull() // fewer people
    // the group's folder too: admins can read it there but may not use the connection
    expect(widening(A.ctx.db, e.chat, ['groups', 'marketing', 'notes.md'])).not.toBeNull()
    await patch('carol', team.id, { access: { everyone: true, groups: [], users: [] } })
    expect(widening(A.ctx.db, e.chat, ['shared', 'notes.md'])).toBeNull()
    await patch('carol', team.id, { access: { everyone: false, groups: ['marketing'], users: [] } })
    // a personal connection's answer counts as the person's own folder
    const a = turn('alice')
    await a.call('my_tasks__search_tasks', {})
    expect(widening(A.ctx.db, a.chat, ['shared', 'x.md'])?.narrower).toEqual([{ type: 'user', id: 'alice' }])
  })

  test('answers are cut for the AI; event-stream replies that stay open; a forgotten session starts again', async () => {
    const saved = fake.tools
    fake.tools = [...saved, { name: 'huge', description: '', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }]
    await post('alice', `/api/integrations/${tasks.id}/refresh`, {})
    const t0 = Date.now()
    fake.sse = true; fake.keepOpen = true
    try {
      const r = await turn('alice').call('my_tasks__search_tasks', { q: 'sse' })
      expect(r.text).toContain('search_tasks: {"q":"sse"}')
      expect(Date.now() - t0).toBeLessThan(4000)
      fake.sessions.clear()
      expect((await turn('alice').call('my_tasks__search_tasks', { q: 'again' })).text).toContain('"again"')
    } finally { fake.sse = false; fake.keepOpen = false; fake.tools = saved }
    await post('alice', `/api/integrations/${tasks.id}/refresh`, {})
    expect(MAX_RESULT_CHARS).toBe(40_000)
  })
})

describe('api_request', () => {
  test('GET with query: the answer with status and type, the key sent only to the connection\'s address', async () => {
    const a = turn('alice', { person: ask(false) })
    const r = await a.call('api_request', { connection: 'my_aipm', method: 'get', path: '/tasks?status=open', query: { page: 2, tag: ['a', 'b'] } })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('AI PM answered GET /api/v1/tasks: HTTP 200, application/json')
    expect(r.text).toContain('"Write the plan"')
    expect(r.text).toContain('"status":"open","page":"2"')
    expect(r.summary).toMatch(/^api_request my_aipm GET \/api\/v1\/tasks -> 200 \(\d+ B\)$/)
    const seen = fake.seen.at(-1)!
    expect(seen.path).toBe('/api/v1/tasks?status=open&page=2&tag=a&tag=b')
    expect(seen.headers.authorization).toBe(`Bearer ${API_KEY}`)
    expect(r.text + r.summary).not.toContain(API_KEY)
    // the connection's own path written out is taken as it is; so is a full address under it
    expect((await a.call('api_request', { connection: 'aipm', method: 'GET', path: '/api/v1/tasks' })).isError).toBe(false)
    expect((await a.call('api_request', { connection: 'my_aipm', method: 'GET', path: `${fake.base}/api/v1/tasks` })).isError).toBe(false)
  })

  test('the path cannot leave the connection\'s address', async () => {
    const a = turn('alice')
    const before = fake.seen.length
    for (const path of ['../admin', '/x/../../admin', '/%2e%2e/admin', '/a%2Fb', '//evil.example/x', 'https://evil.example/api/v1/tasks', `https://${'svc.test'}:1/api/v1`, '/a\\b', '/a#b', '/a b']) {
      const r = await a.call('api_request', { connection: 'my_aipm', method: 'GET', path })
      expect(r.isError, path).toBe(true)
      expect(r.summary, path).toBe('api_request my_aipm GET -> bad path')
    }
    expect(fake.seen.length).toBe(before)
    expect(() => buildUrl('https://h.example/v1', '/v1x/a')).not.toThrow()
    expect(buildUrl('https://h.example/v1', '/v1x/a')).toBe('https://h.example/v1/v1x/a')
    expect(buildUrl('https://h.example/v1?key=k', 'tasks')).toBe('https://h.example/v1/tasks?key=k')
    expect((await a.call('api_request', { connection: 'my_other', method: 'GET', path: '/x' })).summary).toBe('api_request my_other GET -> unknown connection')
    expect((await a.call('api_request', { connection: 'my_aipm', method: 'GET', path: '/x', headers: { Authorization: 'x' } })).text).toContain('Invalid input')
  })

  test('the AI\'s input cannot have the key put anywhere: placeholders are sent as written, the key goes only in its header', async () => {
    const marks = ['{{key}}', '{{ secrets.api_key }}', '${API_KEY}', '$API_KEY', '%KEY%', '<key>', '{secret}', '{{token}}', '[hidden key]']
    const a = turn('alice', { person: ask(true) })
    const before = fake.seen.length
    const r = await a.call('api_request', { connection: 'my_aipm', method: 'POST', path: `/tasks?x=${encodeURIComponent('{{key}}')}`, query: Object.fromEntries(marks.map((m, i) => [`q${i}`, m])), body: { title: '{{key}}', all: marks } })
    expect(r.isError).toBe(false)
    const m = await a.call('my_tasks__search_tasks', { q: '{{key}}', all: marks })
    expect(m.isError).toBe(false)
    const sent = fake.seen.slice(before)
    expect(sent).toHaveLength(2)
    const [api, mcp] = sent as [typeof sent[0], typeof sent[0]]
    const q = new URL('https://x' + api.path).searchParams
    expect([q.get('x'), ...marks.map((_, i) => q.get(`q${i}`))]).toEqual(['{{key}}', ...marks])
    expect(JSON.parse(api.body)).toEqual({ title: '{{key}}', all: marks })
    expect(fake.calls.at(-1)).toMatchObject({ name: 'search_tasks', args: { q: '{{key}}', all: marks }, auth: `Bearer ${MCP_KEY}` })
    // the key is in exactly one header of each request, the one the connection names
    for (const [s, key] of [[api, API_KEY], [mcp, MCP_KEY]] as const) {
      expect(s.path + s.body).not.toContain(key)
      expect(Object.entries(s.headers).filter(([, v]) => v.includes(key))).toEqual([['authorization', `Bearer ${key}`]])
    }
    // no input field can carry a header or another address (the input is strict)
    for (const extra of [{ headers: { 'X-Api-Key': '{{key}}' } }, { auth: 'none' }, { url: 'https://evil.example/' }, { connectionUrl: 'https://evil.example/' }]) {
      expect((await a.call('api_request', { connection: 'my_aipm', method: 'GET', path: '/tasks', ...extra })).summary).toBe('api_request -> invalid input')
    }
  })

  test('changes ask first and send JSON; redirects are reported, never followed; big and binary answers', async () => {
    const yes = ask(true)
    const a = turn('alice', { person: yes })
    const r = await a.call('api_request', { connection: 'my_aipm', method: 'POST', path: '/tasks', body: { title: 'New' } })
    expect(r.text).toContain('HTTP 201')
    expect(r.text).toContain('"type":"application/json"')
    expect(yes.questions[0]).toContain('The AI wants to do this at AI PM: POST /api/v1/tasks')
    expect(yes.questions[0]).toContain('{"title":"New"}')
    expect(r.summary).toContain('(confirmed by the user)')
    const del = await a.call('api_request', { connection: 'my_aipm', method: 'DELETE', path: '/tasks/7' })
    expect(del.text).toContain('HTTP 204')
    expect(yes.questions).toHaveLength(2)
    expect((await a.call('api_request', { connection: 'my_aipm', method: 'GET', path: '/tasks', body: { x: 1 } })).text).toContain('GET and HEAD send no body')
    const red = await a.call('api_request', { connection: 'my_aipm', method: 'GET', path: '/redirect' })
    expect(red.isError).toBe(true)
    expect(red.text).toContain('redirect (HTTP 302); redirects are not followed')
    expect(fake.seen.some((s) => s.path.includes('steal'))).toBe(false)
    const big = await a.call('api_request', { connection: 'my_aipm', method: 'GET', path: '/big' })
    expect(big.text).toContain('(cut at 1 MB)')
    expect(big.text).toContain(`(cut to ${MAX_RESULT_CHARS} characters)`)
    expect(big.text.length).toBeLessThan(MAX_RESULT_CHARS + 1000)
    expect((await a.call('api_request', { connection: 'my_aipm', method: 'GET', path: '/image' })).text).toContain('binary content')
    const inj = await a.call('api_request', { connection: 'my_aipm', method: 'GET', path: '/inject' })
    expect(inj.text.match(/<\/external_data>/g)).toHaveLength(1)
    expect(yes.questions).toHaveLength(2)
  })

  test('a refused key marks the connection; the person fixes it in Settings', async () => {
    const id = (await post('alice', '/api/integrations', { kind: 'http', name: 'Header API', url: `${fake.base}/hdr/v1`, auth: 'header', authHeader: 'X-Api-Key', secret: API_KEY })).body.id
    const a = turn('alice')
    expect((await a.call('api_request', { connection: 'my_headerapi', method: 'GET', path: '/tasks' })).isError).toBe(false)
    expect(fake.seen.at(-1)!.headers['x-api-key']).toBe(API_KEY)
    expect(fake.seen.at(-1)!.headers.authorization).toBeUndefined()
    await patch('alice', id, { secret: 'wrong' })
    expect((await A.json('/api/integrations', { as: 'alice' })).body.items.find((i: any) => i.id === id).status).toBe('needs_auth')
    await A.json(`/api/integrations/${id}`, { method: 'DELETE', as: 'alice' })
  })
})

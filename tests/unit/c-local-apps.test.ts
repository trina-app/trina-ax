// Apps on the person's own computer as connectors (docs/decisions/20261118-local-app-connectors.md), on the server:
// kind 'local' is the person's own connection only (team connections, templates, requests, the connect card and other
// people never make, fill or use one), it is checked and called only through the desktop window of the person (the
// local relay, a fake desktop app here that answers as an MCP server), the AI is told in plain words when the message
// came from elsewhere, and the team's switch turns it off.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, LocalAppSpec, LOCAL_APP_PRESETS, localCommandKey, localCommandLines, type ServerFrame } from '@mycel/shared/api'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { getRow, mayUse, usable } from '../../server/src/integrations/connections/store'
import { setSetting } from '../../server/src/admin/settings'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const DESK = 'win-local-desk1'
const WEB = 'win-local-web01'
const SPEC = { adapter: 'mcp' as const, command: 'aside', args: ['mcp'], env: ['ASIDE_TOKEN'] }

let h: Harness
let desk: TestSocket
let web: TestSocket
let stop: () => void
/** what the fake desktop app was sent, in order */
const seen: { method: string; connectionId: string; turnId: string | null }[] = []
beforeAll(async () => {
  h = await startHarness({ name: 'c-local-apps', relay: { windowGoneMs: 600, sweepMs: 100 } })
  desk = await h.ws('alice', { windowId: DESK, client: 'desktop' })
  await desk.next('hello')
  web = await h.ws('alice', { windowId: WEB })
  await web.next('hello')
  stop = serveLocal(desk)
})
afterAll(async () => { stop?.(); desk?.close(); web?.close(); await h?.close() })

/** the desktop app: answer local.call as an MCP server would (initialize, tools/list, tools/call echo) */
function serveLocal(sock: TestSocket) {
  const done = new Set<string>()
  const timer = setInterval(() => {
    for (const f of sock.frames as ServerFrame[]) {
      if (f.type !== 'local.call' || done.has(f.data.call.callId)) continue
      const call = f.data.call
      done.add(call.callId)
      sock.send({ type: 'local.ack', callId: call.callId })
      const m = call.message as { id?: string; method: string; params?: { name?: string; arguments?: { text?: string } } }
      seen.push({ method: m.method, connectionId: call.connectionId, turnId: call.turnId })
      if (call.name === 'Declined') { sock.send({ type: 'local.result', result: { callId: call.callId, ok: false, failure: 'declined', error: 'Cancel' } }); continue }
      const result = m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } }
        : m.method === 'tools/list' ? { tools: [{ name: 'echo', description: 'Say it back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, annotations: { readOnlyHint: true } }] }
        : m.method === 'tools/call' ? { content: [{ type: 'text', text: `echo: ${m.params?.arguments?.text ?? ''}` }] }
        : null
      sock.send({ type: 'local.result', result: { callId: call.callId, ok: true, message: m.id === undefined ? null : { jsonrpc: '2.0', id: m.id, result } } })
    }
  }, 20)
  return () => clearInterval(timer)
}

const deskApi = () => h.api('alice', { window: DESK, client: 'desktop' })
let made: Awaited<ReturnType<ReturnType<typeof deskApi>['call']>> & { id: string }

describe('the shared shape', () => {
  test('the known tools are valid specs; the confirm\'s key covers the command and its template, not words', () => {
    for (const p of LOCAL_APP_PRESETS) expect(LocalAppSpec.safeParse(p.spec).success).toBe(true)
    expect(localCommandLines(SPEC)).toEqual(['aside mcp'])
    const ego = LOCAL_APP_PRESETS.find((p) => p.id === 'ego-lite')!.spec
    expect(localCommandLines(ego)).toEqual(['ego-browser skill', 'ego-browser nodejs < script'])
    expect(localCommandKey({ ...SPEC, env: [] })).toBe(localCommandKey(SPEC))
    expect(localCommandKey({ ...SPEC, args: ['mcp', '--computer-use'] })).not.toBe(localCommandKey(SPEC))
    expect(localCommandLines({ ...SPEC, args: ["it's", 'a b'] })).toEqual([`aside 'it'\\''s' 'a b'`])
    // a slot named nowhere, stdin for a number, two tools of one name: refused
    const tool = { name: 'run', description: '', args: [{ slot: 'x' }], slots: [], readOnly: false }
    expect(LocalAppSpec.safeParse({ adapter: 'cli', command: 'x', env: [], tools: [tool] }).success).toBe(false)
    expect(LocalAppSpec.safeParse({ adapter: 'cli', command: 'x', env: [], tools: [{ ...tool, args: [], stdin: 'n', slots: [{ name: 'n', description: '', type: 'number', required: true }] }] }).success).toBe(false)
    expect(LocalAppSpec.safeParse({ adapter: 'mcp', command: 'a\nb', args: [], env: [] }).success).toBe(false)
  })
})

describe('kind local: the person\'s own, through their desktop window', () => {
  test('added from the desktop window: checked there at once, its tools saved; the command shape only', async () => {
    made = await deskApi().call(API.createLocalIntegration, { body: { name: 'Aside', spec: SPEC } }) as typeof made
    expect(made).toMatchObject({ kind: 'local', scope: 'personal', status: 'connected', url: '', auth: 'none', local: SPEC, canManage: true })
    expect(made.tools.map((t: { name: string }) => t.name)).toEqual(['echo'])
    expect(seen.map((s) => s.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
    expect(seen.every((s) => s.connectionId === made.id && s.turnId === null)).toBe(true)
    expect(web.frames.some((f) => f.type === 'local.call')).toBe(false)
    const row = getRow(h.ctx.db, made.id)!
    expect(row.url).toBe(`https://local-app.invalid/${made.id}`)
    expect(JSON.parse(row.local_app!)).toEqual(SPEC)
  })

  test('from the web it is saved but not checked; Check again from the web changes nothing', async () => {
    const n = seen.length
    const other = await h.api('alice', { window: WEB, client: 'web' }).call(API.createLocalIntegration, { body: { name: 'Later', spec: { ...SPEC, args: ['mcp', '--incognito'] } } })
    expect(other).toMatchObject({ kind: 'local', status: 'error', lastErrorReason: 'local_offline' })
    expect(other.lastError).toContain('desktop app')
    const again = await h.api('alice', { window: WEB, client: 'web' }).call(API.refreshIntegration, { params: { id: other.id }, body: {} })
    expect(again.status).toBe('error')
    expect(seen.length).toBe(n)
    await h.api('alice').call(API.deleteIntegration, { params: { id: other.id } })
  })

  test('a message from the desktop window: the tool is offered and its call goes to that window only', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const r = await ask(h, desk, 'alice', chat.id, fake({ echo: 'tools' }, { say: ' | ' }, { tool: 'my_aside__echo', args: { text: 'hi' }, sayResult: true }), { window: DESK, client: 'desktop' })
    const [tools, result] = r.done.content.split(' | ')
    expect(tools!.split(',')).toContain('my_aside__echo')
    expect(result).toContain('echo: hi')
    expect(seen.some((s) => s.method === 'tools/call' && s.turnId === r.started.turnId)).toBe(true)
    expect(web.frames.some((f) => f.type === 'local.call')).toBe(false)
  })

  test('a message from the web: no tool, and the AI is told it works only from the desktop app on that computer', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const r = await ask(h, web, 'alice', chat.id, fake({ echo: 'tools' }, { say: ' | ' }, { echo: 'system' }), { window: WEB, client: 'web' })
    const [tools, system] = r.done.content.split(' | ')
    expect(tools!.split(',')).not.toContain('my_aside__echo')
    expect(system).toContain('Aside (an app on the user\'s own computer, personal connection): not usable in this answer, because it works only when the user writes from the')
    expect(system).toContain('desktop app on that computer')
  })

  test('Cancel on the computer: stored as not connected there, said in plain words', async () => {
    const d = await deskApi().call(API.createLocalIntegration, { body: { name: 'Declined', spec: { ...SPEC, args: ['mcp', '--host', 'local'] } } })
    expect(d).toMatchObject({ status: 'error', lastErrorReason: 'local_declined' })
    expect(d.lastError).toContain('Cancel')
    await h.api('alice').call(API.deleteIntegration, { params: { id: d.id } })
  })

  test('a new command is checked again (the desktop app asks again for it); the same one changes nothing', async () => {
    const n = seen.length
    const same = await deskApi().call(API.updateLocalIntegration, { params: { id: made.id }, body: { spec: SPEC } })
    expect(same.updatedAt).toBe(made.updatedAt)
    const changed = await deskApi().call(API.updateLocalIntegration, { params: { id: made.id }, body: { spec: { ...SPEC, args: ['mcp', '--computer-use'] } } })
    expect(changed).toMatchObject({ status: 'connected', local: { args: ['mcp', '--computer-use'] } })
    expect(seen.slice(n).map((s) => s.method)).toContain('tools/list')
    made = await deskApi().call(API.updateLocalIntegration, { params: { id: made.id }, body: { spec: SPEC } }) as typeof made
  })
})

describe('refused everywhere else', () => {
  const remote = { name: 'Aside', url: 'https://example.com/mcp', auth: 'none' }
  test('team connections, templates, requests and the generic form take no local kind', async () => {
    const st = (p: string, body: unknown, user = 'carol') => h.req(user, p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.status)
    expect(await st('/api/admin/integrations', { kind: 'local', ...remote, access: { everyone: true, groups: [], users: [] } })).toBe(400)
    expect(await st('/api/admin/integration-templates', { kind: 'local', ...remote, auth: 'bearer' })).toBe(400)
    expect(await st('/api/admin/integration-requests', { kind: 'local', ...remote, auth: 'bearer', userId: 'alice' })).toBe(400)
    expect(await st('/api/integrations', { kind: 'local', ...remote }, 'alice')).toBe(400)
    // a team-only field or a value is never taken with the command
    expect(await st('/api/integrations/local', { name: 'X', spec: SPEC, access: { everyone: true, groups: [], users: [] } }, 'alice')).toBe(400)
    expect(await st('/api/integrations/local', { name: 'X', spec: { ...SPEC, env: ['TOKEN=abc'] } }, 'alice')).toBe(400)
  })

  test('no address, key or sign-in to change; someone else cannot see, change or use it', async () => {
    const patch = (body: unknown, user = 'alice', p = `/api/integrations/${made.id}`) => h.req(user, p, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.status)
    expect(await patch({ url: 'https://example.com/mcp' })).toBe(400)
    expect(await patch({ secret: 'k' })).toBe(400)
    expect(await patch({ name: 'Aside' }, 'bob')).toBe(404)
    expect(await patch({ spec: SPEC }, 'carol', `/api/integrations/${made.id}/local`)).toBe(404)
    expect((await h.req('bob', `/api/integrations/${made.id}/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404)
    expect(mayUse(h.ctx.db, getRow(h.ctx.db, made.id)!, 'bob')).toBe(false)
    expect(usable(h.ctx.db, 'bob').some((r) => r.id === made.id)).toBe(false)
    // a row made team-wide by hand is used by nobody, its owner included
    h.ctx.db.query("INSERT INTO integrations (id, scope, owner_user_id, created_by, kind, name, slug, url, auth, write_policy, status, created_at, updated_at, local_app) VALUES ('team-local', 'team', NULL, 'carol', 'mcp', 'T', 't', 'https://local-app.invalid/x', 'none', 'ask', 'connected', 'x', 'x', ?)").run(JSON.stringify(SPEC))
    h.ctx.db.query("INSERT INTO integration_access (integration_id, subject_type, subject_id) VALUES ('team-local', 'everyone', '')").run()
    expect(mayUse(h.ctx.db, getRow(h.ctx.db, 'team-local')!, 'alice')).toBe(false)
    expect(usable(h.ctx.db, 'alice').some((r) => r.id === 'team-local')).toBe(false)
    h.ctx.db.query("DELETE FROM integrations WHERE id = 'team-local'").run()
  })

  test('the connect card never makes or fills one', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const r = await ask(h, desk, 'alice', chat.id, fake({ tool: 'connect_service', args: { connection: made.id, name: 'Aside' }, sayResult: true }), { window: DESK, client: 'desktop' })
    expect(r.done.content).toContain('is an app on the person\'s computer')
    expect(r.done.content).toContain('No card was shown')
    expect(desk.frames.some((f) => f.type === 'turn.request' && f.data.turnId === r.started.turnId)).toBe(false)
  })

  test('the team switch: off, none is added and the ones there leave the chats; on again, back', async () => {
    setSetting(h.ctx.db, 'localApps', false)
    try {
      expect((await h.req('alice', '/api/integrations/local', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'X', spec: SPEC }) })).status).toBe(403)
      expect(usable(h.ctx.db, 'alice').some((r) => r.id === made.id)).toBe(false)
      const list = await h.api('alice').call(API.listIntegrations)
      expect(list.items.find((i) => i.id === made.id)).toMatchObject({ personalOff: true })
    } finally { setSetting(h.ctx.db, 'localApps', true) }
    expect(usable(h.ctx.db, 'alice').some((r) => r.id === made.id)).toBe(true)
    setSetting(h.ctx.db, 'personalIntegrations', false)
    try {
      expect(usable(h.ctx.db, 'alice').some((r) => r.id === made.id)).toBe(false)
    } finally { setSetting(h.ctx.db, 'personalIntegrations', true) }
  })

  test('the long-poll endpoints answer only the person\'s own window calls', async () => {
    expect((await h.req('alice', `/api/local-apps/calls?windowId=${WEB}&waitMs=0`)).status).toBe(200)
    expect((await h.req('alice', '/api/local-apps/calls?waitMs=0')).status).toBe(400)
    expect((await h.req(null, `/api/local-apps/calls?windowId=${WEB}&waitMs=0`)).status).toBe(401)
    const post = await h.req('bob', '/api/local-apps/results', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callId: 'nope', ok: true }) })
    expect(post.status).toBe(404)
  })
})

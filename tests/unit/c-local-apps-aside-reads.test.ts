// Aside's reads (docs/decisions/20261118-local-app-connectors.md "Aside's reads"): Aside 1.26 marks none of its tools
// (no MCP annotations), so every one of them counted as a change and listing profiles asked on the "send" card ("What
// it sends: {}"). For the listed Aside connector (exactly `aside mcp`) Trina keeps its own read list
// (LOCAL_APP_PRESETS reads): browser_profiles and memory_search run without a card; repl and exec still ask. A command
// the person typed, even one that starts aside, gets no list. A list saved before the change counts at once.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, LOCAL_APP_PRESETS, presetReads, type LocalAppSpec, type ServerFrame } from '@mycel/shared/api'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { getRow, savedTools } from '../../server/src/integrations/connections/store'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const DESK = 'win-aside-reads1'
const ASIDE = LOCAL_APP_PRESETS.find((p) => p.id === 'aside')!.spec
const TYPED: LocalAppSpec = { adapter: 'mcp', command: 'aside', args: ['mcp', '--account', 'u2'], env: [] }
/** Aside 1.26.1115's tools/list, as it is: no annotations on any tool */
const ASIDE_TOOLS = [
  { name: 'browser_profiles', description: "List browser profile IDs, labels, and connection status for this MCP server's host and account.", inputSchema: { type: 'object', properties: {} } },
  { name: 'repl', description: 'Run Playwright-style JavaScript in Aside Browser.', inputSchema: { type: 'object', properties: { title: { type: 'string' }, code: { type: 'string' }, profile_id: { type: 'string' } } } },
  { name: 'memory_search', description: "Semantically search the Aside browser user's memory.", inputSchema: { type: 'object', properties: { queries: { type: 'array', items: { type: 'string' } } } } },
  { name: 'exec', description: 'Run the browser agent on logged-in sites.', inputSchema: { type: 'object', properties: { prompt: { type: 'string' } } } },
]

let h: Harness
let desk: TestSocket
let stop: () => void
const calls: string[] = []
beforeAll(async () => {
  h = await startHarness({ name: 'c-local-apps-aside-reads', relay: { windowGoneMs: 600, sweepMs: 100 } })
  desk = await h.ws('alice', { windowId: DESK, client: 'desktop' })
  await desk.next('hello')
  const done = new Set<string>()
  const timer = setInterval(() => {
    for (const f of desk.frames as ServerFrame[]) {
      if (f.type !== 'local.call' || done.has(f.data.call.callId)) continue
      const call = f.data.call
      done.add(call.callId)
      desk.send({ type: 'local.ack', callId: call.callId })
      const m = call.message as { id?: string; method: string; params?: { name?: string } }
      if (m.method === 'tools/call') calls.push(m.params?.name ?? '')
      const result = m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'aside', version: '1.26.1115.1556' } }
        : m.method === 'tools/list' ? { tools: ASIDE_TOOLS }
        : m.method === 'tools/call' ? { content: [{ type: 'text', text: m.params?.name === 'browser_profiles' ? JSON.stringify({ profiles: [{ profileId: 'p1', label: 'Work', connected: true }] }) : `ran ${m.params?.name}` }] }
        : null
      desk.send({ type: 'local.result', result: { callId: call.callId, ok: true, message: m.id === undefined ? null : { jsonrpc: '2.0', id: m.id, result } } })
    }
  }, 20)
  stop = () => clearInterval(timer)
})
afterAll(async () => { stop?.(); desk?.close(); await h?.close() })

const deskApi = () => h.api('alice', { window: DESK, client: 'desktop' })

describe('Aside: Trina\'s own read list for the listed command', () => {
  test('only the exact listed command gets the list; a typed command, another program or none gets nothing', () => {
    expect([...presetReads(ASIDE)].sort()).toEqual(['browser_profiles', 'memory_search'])
    expect(presetReads({ ...ASIDE, env: ['X'] }).size).toBe(2)
    expect(presetReads(TYPED).size).toBe(0)
    expect(presetReads({ adapter: 'mcp', command: '/usr/local/bin/aside', args: ['mcp'], env: [] }).size).toBe(0)
    expect(presetReads(null).size).toBe(0)
  })

  let id = ''
  test('Settings shows the two reads as reads, repl and exec as changes', async () => {
    const made = await deskApi().call(API.createLocalIntegration, { body: { name: 'Aside', spec: ASIDE } })
    id = made.id
    expect(made.status).toBe('connected')
    expect(made.tools.map((t) => [t.name, t.readOnly])).toEqual([['browser_profiles', true], ['repl', false], ['memory_search', true], ['exec', false]])
  })

  test('listing profiles and searching memory run with no card; repl still asks on its card', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const r = await ask(h, desk, 'alice', chat.id, fake(
      { tool: 'my_aside__browser_profiles', args: {}, sayResult: true }, { say: ' | ' },
      { tool: 'my_aside__memory_search', args: { queries: ['weekly report'] }, sayResult: true },
    ), { window: DESK, client: 'desktop', ms: 30_000 })
    expect(r.done.content).toContain('"profileId":"p1"')
    expect(r.done.content).toContain('ran memory_search')
    expect(desk.frames.some((f) => f.type === 'turn.request' && f.data.turnId === r.started.turnId)).toBe(false)
    expect(calls).toEqual(['browser_profiles', 'memory_search'])

    const started = await deskApi().call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ tool: 'my_aside__repl', args: { title: 't', code: 'console.log(1)' }, sayResult: true }), clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    const card = await desk.next('turn.request', (f) => f.data.turnId === started.turnId, 30_000)
    const q = card.data.request as { requestId: string; options?: { value: string }[] }
    expect(calls).toEqual(['browser_profiles', 'memory_search'])
    await h.api('alice').call(API.answerTurn, { params: { id: started.turnId }, body: { kind: 'ask_user', requestId: q.requestId, answer: q.options!.find((o) => o.value !== 'always')!.value } })
    await desk.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
  })

  test('a list saved before this change (all marked as changes) counts at once, with no new check', () => {
    const before = ASIDE_TOOLS.map((t) => ({ name: t.name, title: null, description: t.description, readOnly: false, inputSchema: t.inputSchema }))
    h.ctx.db.query('UPDATE integrations SET tools_json = ? WHERE id = ?').run(JSON.stringify(before), id)
    const row = getRow(h.ctx.db, id)!
    expect(savedTools(h.ctx.db, row).map((t) => [t.name, t.readOnly])).toEqual([['browser_profiles', true], ['repl', false], ['memory_search', true], ['exec', false]])
  })

  test('a command the person typed with the same tools: every tool asks, browser_profiles too', async () => {
    const typed = await deskApi().call(API.createLocalIntegration, { body: { name: 'Aside two', slug: 'asidetwo', spec: TYPED } })
    expect(typed.tools.every((t) => !t.readOnly)).toBe(true)
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const started = await deskApi().call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ tool: 'my_asidetwo__browser_profiles', args: {}, sayResult: true }), clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    const card = await desk.next('turn.request', (f) => f.data.turnId === started.turnId, 30_000)
    const q = card.data.request as { requestId: string; options?: { value: string }[] }
    await h.api('alice').call(API.answerTurn, { params: { id: started.turnId }, body: { kind: 'ask_user', requestId: q.requestId, answer: q.options!.find((o) => o.value !== 'always')!.value } })
    await desk.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
  })
})

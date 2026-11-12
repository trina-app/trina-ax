// The same answer goes on after a connect (owner decision 2026-11-12, QA TC-128; docs/INTEGRATIONS.md "Connecting from
// a chat"): the person asks for something a service they have not connected would answer, the AI shows the connect
// card, the person finishes it, and the AI goes on in the SAME answer with the new connection's tools, without the
// question being sent again. Real turns with the fake engine (tests/lib/b-fake-engine.ts, {"afterContinue": [...]}
// is what the resumed run does). Also: "not now" and a card whose time runs out leave the answer as before (no
// continuation); only the turn's person can finish the card, and the tools the answer goes on with are that person's
// only (another person's connection never comes in); the per-answer round limit still holds; an answer without a
// connect runs once; the API engine lists the tools again from its next round.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import type { EngineEvent } from '@mycel/shared'
import { startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { FakeServices } from '../lib/fake-services'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { CONNECTED_NEXT } from '../../server/src/chat/connect-service'
import { CONTINUE_NOTE_START } from '../../server/src/chat/turn'
import { runApiAgent, type ApiEngineConf } from '../../server/src/engine/api-agent'

setDefaultTimeout(60_000)

const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness, svc: FakeServices
const published: { userId: string; ev: any }[] = []

beforeAll(async () => {
  h = await startHarness({ name: 'connect-continue', askUserTimeoutMs: 4000, turnTimeoutMs: 60_000 })
  h.ctx.db.query("INSERT INTO settings (key, value) VALUES ('personalIntegrations', 'true') ON CONFLICT(key) DO UPDATE SET value='true'").run()
  const hub = h.rt().hub
  const publish = hub.publish.bind(hub), publishTo = hub.publishTo.bind(hub)
  hub.publish = (userId, ev) => { published.push({ userId, ev: JSON.parse(JSON.stringify(ev)) }); publish(userId, ev) }
  hub.publishTo = (userId, w, ev) => { published.push({ userId, ev: JSON.parse(JSON.stringify(ev)) }); return publishTo(userId, w, ev) }
  svc = new FakeServices()
  integrationsOf(h.ctx, { net: svc.net() })
})
afterAll(async () => { svc?.stop(); await h?.close() })

/** a new chat whose one message runs these directives */
async function send(user: string, ...ds: unknown[]) {
  const chat = await h.api(user).call(API.createChat, { body: {} })
  const r = await h.api(user).call(API.sendMessage, { params: { id: chat.id }, body: { content: fake(...ds), clientMessageId: cm(), attachmentIds: [] } })
  return { chatId: chat.id, turnId: r.turnId, messageId: r.assistantMessage.id }
}
/** "summarize my Notion page": the tool the answer needs (not there yet), the card, then what the continuation does */
const connect = (name: string, url: string, after: unknown[] = [], extra: unknown[] = []) => [
  { tool: 'connect_service', args: { name, kind: 'mcp', url, auth: 'none', why: 'to read your page' }, sayResult: true },
  ...extra,
  { afterContinue: after },
]
const cardOf = (turnId: string) => waitFor(() => published.find((p) => p.ev.type === 'turn.request' && p.ev.data.turnId === turnId)?.ev.data.request, { timeoutMs: 20_000, what: 'connect card' })
async function doneOf(messageId: string): Promise<{ content: string; steps: any[] }> {
  const d = await waitFor(() => published.find((p) => p.ev.type === 'message.done' && p.ev.data.messageId === messageId), { timeoutMs: 40_000, what: 'message.done' })
  return d!.ev.data.message
}
async function post(user: string, turnId: string, body: unknown) {
  const r = await h.req(user, `/api/turns/${turnId}/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const text = await r.text()
  return { status: r.status, body: text ? JSON.parse(text) : null }
}
const events = (turnId: string) => h.ctx.db.query("SELECT tool, summary, ok FROM tool_events WHERE turn_id = ? AND tool <> '(connect)' ORDER BY id").all(turnId) as { tool: string; summary: string; ok: number }[]
const userMessages = (chatId: string) => (h.ctx.db.query("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND role = 'user'").get(chatId) as { n: number }).n
const resultOf = (content: string) => JSON.parse(content.slice(content.indexOf('{'), content.indexOf('}', content.indexOf('"next"')) + 1))

describe('the same answer goes on after a connect', () => {
  test('connected on the card: the answer resumes with the new tool and uses it; one message, one turn', async () => {
    const url = `${svc.base}/mcp-open?c=1`
    // before the card the tool is not the answer's (the old rule); after it, the same answer calls it
    const t = await send('alice', { tool: 'my_notion__search_tasks', args: { q: 'launch' } }, ...connect('Notion', url, [
      { say: 'CONTINUED ' }, { echo: 'message' }, { say: ' | ' },
      { tool: 'my_notion__search_tasks', args: { q: 'launch' }, sayLength: true },
    ]))
    const card = await cardOf(t.turnId)
    expect(card).toMatchObject({ kind: 'connect_service', name: 'Notion' })
    const r = await post('alice', t.turnId, { action: 'connect', requestId: card.requestId })
    expect(r.body).toMatchObject({ state: 'connected', status: 'connected' })
    const m = await doneOf(t.messageId)
    // the connect result tells the AI the answer goes on (Claude: end this step)
    expect(resultOf(m.content)).toMatchObject({ connected: true, name: 'Notion', next: CONNECTED_NEXT.step })
    expect(resultOf(m.content).tools).toContain('search_tasks')
    // then the same answer went on: the server's note (not the person's question again), and the new tool worked
    const after = m.content.slice(m.content.indexOf('CONTINUED '))
    expect(after).toContain(CONTINUE_NOTE_START)
    expect(after).toContain('"Notion" is connected now')
    expect(after).toContain('my_notion__search_tasks')
    expect(after).toMatch(/length=\d+/)
    const ev = events(t.turnId)
    expect(ev.map((e) => [e.tool, e.ok])).toEqual([['my_notion__search_tasks', 0], ['connect_service', 1], ['my_notion__search_tasks', 1]])
    // one question, one answer: nothing was sent again
    expect(userMessages(t.chatId)).toBe(1)
    expect(h.ctx.db.query('SELECT COUNT(*) AS n FROM turns WHERE chat_id = ?').get(t.chatId)).toEqual({ n: 1 })
    expect(h.ctx.db.query('SELECT status FROM turns WHERE id = ?').get(t.turnId)).toEqual({ status: 'done' })
    // the steps of both parts are on the one answer
    expect(m.steps.filter((s) => s.tool === 'my_notion__search_tasks').map((s) => s.status)).toEqual(['error', 'ok'])
  })

  test('"not now" on the card: no continuation, the answer ends as before', async () => {
    const url = `${svc.base}/mcp-open?c=skip`
    const t = await send('alice', ...connect('Skipped', url, [{ say: 'CONTINUED' }]))
    const card = await cardOf(t.turnId)
    expect((await post('alice', t.turnId, { action: 'skip', requestId: card.requestId })).body).toEqual({ state: 'skipped' })
    const m = await doneOf(t.messageId)
    expect(m.content).toContain('{"skipped":true}')
    expect(m.content).not.toContain('CONTINUED')
    expect(m.content).not.toContain(CONTINUE_NOTE_START)
    expect(events(t.turnId).map((e) => e.tool)).toEqual(['connect_service'])
    expect(h.ctx.db.query('SELECT status FROM turns WHERE id = ?').get(t.turnId)).toEqual({ status: 'done' })
  })

  test('the card\'s time runs out: no continuation, nothing connected, the turn ends clean', async () => {
    const url = `${svc.base}/mcp-open?c=timeout`
    const t = await send('alice', ...connect('Late', url, [{ say: 'CONTINUED' }]))
    await cardOf(t.turnId)
    const m = await doneOf(t.messageId)
    expect(m.content).toContain('{"skipped":true}')
    expect(m.content).not.toContain('CONTINUED')
    expect(h.ctx.db.query('SELECT id FROM integrations WHERE url = ?').all(url)).toEqual([])
    expect(h.ctx.db.query('SELECT status FROM turns WHERE id = ?').get(t.turnId)).toEqual({ status: 'done' })
    expect(await h.api('alice').call(API.listTurnRequests, { params: { id: t.chatId } }).then((r) => r.items)).toEqual([])
  })

  test('only the asker finishes the card, and the answer goes on with the asker\'s connections only', async () => {
    // bob has a connection of his own; it never comes into alice's answer
    await h.api('bob').call(API.createIntegration, { body: { kind: 'mcp', name: 'Bob board', url: `${svc.base}/mcp-open?bob=1`, auth: 'none', writePolicy: 'ask' } })
    const url = `${svc.base}/mcp-open?c=other`
    const t = await send('alice', ...connect('Alice board', url, [{ say: 'CONTINUED ' }, { echo: 'tools' }]))
    const card = await cardOf(t.turnId)
    // another person: the turn is not theirs (404), nothing is made
    expect((await post('bob', t.turnId, { action: 'connect', requestId: card.requestId })).status).toBe(404)
    expect((await post('carol', t.turnId, { action: 'connect', requestId: card.requestId })).status).toBe(404)
    expect(h.ctx.db.query('SELECT id FROM integrations WHERE url = ?').all(url)).toEqual([])
    expect((await post('alice', t.turnId, { action: 'connect', requestId: card.requestId })).body.state).toBe('connected')
    const m = await doneOf(t.messageId)
    const tools = m.content.slice(m.content.indexOf('CONTINUED ') + 10).split('\n')[0]!.split(',')
    expect(tools).toContain('my_aliceboard__search_tasks')
    expect(tools.some((n) => n.includes('bob'))).toBe(false)
  })

  test('the round limit holds: an answer with no rounds left does not go on', async () => {
    const rt = h.rt()
    const before = rt.maxEngineTurns
    rt.maxEngineTurns = 2
    try {
      const url = `${svc.base}/mcp-open?c=limit`
      const t = await send('alice', ...connect('Limited', url, [{ say: 'CONTINUED' }]))
      const card = await cardOf(t.turnId)
      expect((await post('alice', t.turnId, { action: 'connect', requestId: card.requestId })).body.state).toBe('connected')
      const m = await doneOf(t.messageId)
      expect(resultOf(m.content)).toMatchObject({ connected: true })
      expect(m.content).not.toContain('CONTINUED')
    } finally { rt.maxEngineTurns = before }
  })

  test('two cards in one answer: it goes on after each, at most twice', async () => {
    const t = await send('alice',
      { tool: 'connect_service', args: { name: 'First', kind: 'mcp', url: `${svc.base}/mcp-open?c=two1`, auth: 'none' } },
      { afterContinue: [{ say: 'ONE ' }, { tool: 'connect_service', args: { name: 'Second', kind: 'mcp', url: `${svc.base}/mcp-open?c=two2`, auth: 'none' } }] },
      { afterContinue: [{ say: 'TWO ' }, { tool: 'my_second__search_tasks', args: { q: 'x' }, sayLength: true }] })
    const first = await cardOf(t.turnId)
    expect((await post('alice', t.turnId, { action: 'connect', requestId: first.requestId })).body.state).toBe('connected')
    const second = await waitFor(() => published.filter((p) => p.ev.type === 'turn.request' && p.ev.data.turnId === t.turnId)[1]?.ev.data.request, { timeoutMs: 20_000, what: 'second card' })
    expect(second.name).toBe('Second')
    expect((await post('alice', t.turnId, { action: 'connect', requestId: second.requestId })).body.state).toBe('connected')
    const m = await doneOf(t.messageId)
    expect(m.content).toContain('ONE ')
    expect(m.content).toContain('TWO ')
    expect(m.content).toMatch(/TWO \s*length=\d+/)
    expect(events(t.turnId).map((e) => [e.tool, e.ok])).toEqual([['connect_service', 1], ['connect_service', 1], ['my_second__search_tasks', 1]])
  })

  test('an answer without a connect runs once (no note, no second run)', async () => {
    const t = await send('alice', { say: 'plain ' }, { afterContinue: [{ say: 'CONTINUED' }] }, { echo: 'resume' })
    const m = await doneOf(t.messageId)
    expect(m.content).toBe('plain resumed=false')
  })
})

describe('the API engine', () => {
  test('a tool set built again during the answer is listed again from the next round', async () => {
    const conf: ApiEngineConf = { baseUrl: 'https://api.example/v1', model: 'm-1', label: 'M1', key: 'sk-test' }
    const sse = (calls: { id: string; name: string }[]) => [
      ...calls.map((c, i) => ({ choices: [{ delta: { tool_calls: [{ index: i, id: c.id, function: { name: c.name, arguments: '{}' } }] } }] })),
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ].map((l) => `data: ${JSON.stringify(l)}\n\n`).join('') + 'data: [DONE]\n\n'
    const replies = [sse([{ id: 'c1', name: 'connect_service' }]), sse([{ id: 'c2', name: 'my_notion__search' }]), sse([])]
    const bodies: any[] = []
    const f = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response(replies.shift()!) }) as unknown as typeof fetch
    let tools = ['connect_service']
    let changed = false
    const rpc = async (m: any) => {
      if (m.method === 'tools/list') return { result: { tools: tools.map((name) => ({ name, description: name, inputSchema: { type: 'object' } })) } }
      if (m.params.name === 'connect_service') { tools = [...tools, 'my_notion__search']; changed = true }
      return { result: { content: [{ type: 'text', text: 'ok' }] } }
    }
    const out: EngineEvent[] = []
    await runApiAgent({ conf, systemPrompt: 's', message: 'summarize my Notion page', rpc, emit: (e) => out.push(e), signal: new AbortController().signal, fetchFn: f,
      toolsChanged: () => { const c = changed; changed = false; return c } })
    expect(bodies.map((b) => b.tools.map((t: any) => t.function.name))).toEqual([['connect_service'], ['connect_service', 'my_notion__search'], ['connect_service', 'my_notion__search']])
    expect(out.filter((e) => e.type === 'tool_end').map((e) => (e as { ok: boolean }).ok)).toEqual([true, true])
  })
})

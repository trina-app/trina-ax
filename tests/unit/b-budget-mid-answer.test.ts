// The person's "block" budget during an answer, not only before it starts (owner decision 2026-11-11): the engine's
// usage goes on the turn row as it comes, so this person's other answers see it, the budget is checked again after
// each usage and between the API engine's rounds, and a used-up budget ends the answer with the budget message.
//   - Claude Code's running usage (one model call's tokens in its stream) stops the answer before the run's total
//   - four answers of one person at once near the limit: all stop, the total stays near the limit
//   - the API engine: the round whose usage used the budget up runs none of its tool calls, and no next round is sent
//   - an answer cut off keeps what it used; the model proxy's count replaces the engine's (never added to it)
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type EngineId } from '@mycel/shared/api'
import type { EngineEvent } from '@mycel/shared'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { runApiAgent, writeApiEngine, type ApiEngineConf } from '../../server/src/engine/api-agent'
import { budgetBlock } from '../../server/src/admin/budgets'
import { brokerOf } from '../../server/src/credentials/maintenance'
import { listRows } from '../../server/src/credentials/store'
import { ClaudeStreamParser } from '../../server/src/engine/claude-parse'

setDefaultTimeout(90_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')

/** SSE body of one Chat Completions answer: text, tool calls, usage */
function sse(o: { text?: string; calls?: { id: string; name: string; args: string }[]; usage: { prompt_tokens: number; completion_tokens: number } }): string {
  const lines: unknown[] = []
  if (o.text) lines.push({ choices: [{ delta: { content: o.text } }] })
  for (const [i, c] of (o.calls ?? []).entries()) lines.push({ choices: [{ delta: { tool_calls: [{ index: i, id: c.id, function: { name: c.name, arguments: c.args } }] } }] })
  lines.push({ choices: [], usage: o.usage })
  return lines.map((l) => `data: ${JSON.stringify(l)}\n\n`).join('') + 'data: [DONE]\n\n'
}

let h: Harness
let alice: TestSocket
let mock: ReturnType<typeof Bun.serve>
const script: string[] = []
const seen: unknown[] = []
const used = () => (h.ctx.db.query("SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS n FROM turns WHERE user_id = 'alice'").get() as { n: number }).n
/** a block budget of alice's: `room` tokens left from what she used so far */
const budget = (id: string, room: number) => h.ctx.db.query("INSERT INTO budgets (id, subject_type, subject_id, period, limit_usd, limit_tokens, action) VALUES (?, 'user', 'alice', 'day', 0, ?, 'block')").run(id, used() + room)
const drop = (id: string) => h.ctx.db.query('DELETE FROM budgets WHERE id = ?').run(id)
const newChat = (engine: EngineId = 'claude-code') => h.api('alice').call(API.createChat, { body: { engine } })
const turnRow = (id: string) => h.ctx.db.query('SELECT input_tokens, output_tokens, cost_usd, usage_source FROM turns WHERE id = ?').get(id) as { input_tokens: number; output_tokens: number; cost_usd: number | null; usage_source: string | null }

beforeAll(async () => {
  mock = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) { if (req.method === 'GET') return Response.json({ data: [{ id: 'm-1' }] }); seen.push(await req.json()); return new Response(script.shift() ?? sse({ text: '(no script)', usage: { prompt_tokens: 1, completion_tokens: 1 } })) } })
  h = await startHarness({ name: 'budget-mid-answer', concurrency: 4 })
  writeApiEngine(h.ctx.config.dataDir, { baseUrl: `http://127.0.0.1:${mock.port}/v1`, model: 'm-1', label: 'M1' })
  const confs = h.rt().engines.get()
  confs.api = { baseUrl: `http://127.0.0.1:${mock.port}/v1`, model: 'm-1', label: 'M1', key: null }
  delete confs.problems.api
  alice = await h.ws('alice'); await alice.next('hello')
})
afterAll(async () => { await h.close(); mock.stop(true) })

describe('subscription engines: the running usage', () => {
  test('a model call that uses the budget up stops the answer at once, with the budget message; its tokens stay counted', async () => {
    budget('b-run', 1000)
    try {
      const chat = await newChat()
      const t0 = Date.now()
      const { started, done } = await ask(h, alice, 'alice', chat.id, fake({ say: 'Part one.' }, { callUsage: { input: 900, output: 200 } }, { sleep: 8000 }, { say: 'Never said.' }), { ms: 30_000 })
      expect(Date.now() - t0).toBeLessThan(7000) // stopped, not at the run's end
      expect(done.status).toBe('error')
      expect(done.error?.code).toBe('budget_exceeded')
      expect(done.error?.message).toBe(budgetBlock(h.ctx.db, 'alice', 'en')!.message)
      expect(done.content).toContain('Part one.')
      expect(done.content).not.toContain('Never said.')
      // the run never gave its total (it was ended): the model call's own tokens are what the turn used
      expect(turnRow(started.turnId)).toMatchObject({ input_tokens: 900, output_tokens: 200, usage_source: 'engine' })
    } finally { drop('b-run') }
  })

  test('a step still running when the budget stopped the answer is saved as cut off, not as done', async () => {
    budget('b-step', 1000)
    try {
      const chat = await newChat()
      const { done } = await ask(h, alice, 'alice', chat.id, fake({ toolStarted: 'list', args: { path: 'shared' } }, { callUsage: { input: 1500, output: 0 } }, { sleep: 8000 }), { ms: 30_000 })
      expect(done.error?.code).toBe('budget_exceeded')
      expect(done.steps.find((s) => s.tool === 'list')?.status).toBe('error')
    } finally { drop('b-step') }
  })

  test('the parser: each model call\'s tokens as it ends, the main AI\'s and a sub-agent\'s (the run\'s total replaces them)', () => {
    const p = new ClaudeStreamParser()
    const ev = (event: unknown, parent?: string) => p.push(JSON.stringify({ type: 'stream_event', event, ...(parent ? { parent_tool_use_id: parent } : {}) }))
    expect(ev({ type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5, output_tokens: 1 } } })).toEqual([])
    expect(ev({ type: 'message_start', message: { usage: { input_tokens: 7, output_tokens: 1 } } }, 'toolu_a')).toEqual([])
    expect(ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }, 'toolu_a')).toEqual([{ type: 'usage', running: true, inputTokens: 7, outputTokens: 3 }])
    expect(ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 40 } })).toEqual([{ type: 'usage', running: true, inputTokens: 105, outputTokens: 40 }])
  })

  test('under the budget the run\'s own total replaces the running estimates (never both)', async () => {
    const chat = await newChat()
    const { started, done } = await ask(h, alice, 'alice', chat.id, fake({ callUsage: { input: 40, output: 4 } }, { say: 'ok' }), { ms: 30_000 })
    expect(done.status).toBe('done')
    // the fake engine's result says 100 / 20 for the whole run
    expect(turnRow(started.turnId)).toMatchObject({ input_tokens: 100, output_tokens: 20, usage_source: 'engine' })
  })

  test('four answers of one person at once near the limit: every one stops, the total stays near the limit', async () => {
    const before = used()
    budget('b-par', 1000)
    try {
      const steps = Array.from({ length: 8 }, () => [{ callUsage: { input: 100, output: 0 } }, { sleep: 400 }]).flat()
      const chats = await Promise.all([0, 1, 2, 3].map(() => newChat()))
      const sent = await Promise.all(chats.map((c) => h.api('alice').call(API.sendMessage, { params: { id: c.id }, body: { content: fake({ say: 'go' }, ...steps, { say: 'Never said.' }), clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })))
      const done = await Promise.all(sent.map((r) => alice.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 40_000)))
      for (const d of done) {
        expect(d.data.message.status).toBe('error')
        expect(d.data.message.error?.code).toBe('budget_exceeded')
        expect(d.data.message.content).not.toContain('Never said.')
      }
      // 4 × 800 tokens were scripted; the answers stopped once together they reached 1000 (each at most one more call)
      const spent = used() - before
      expect(spent).toBeGreaterThanOrEqual(1000)
      expect(spent).toBeLessThanOrEqual(1000 + 4 * 100)
    } finally { drop('b-par') }
  })

  test('the model proxy\'s count replaces what the engine wrote for the turn (authoritative, never added)', async () => {
    const chat = await newChat()
    const { started } = await ask(h, alice, 'alice', chat.id, fake({ say: 'ok' }), { ms: 30_000 })
    expect(turnRow(started.turnId)).toMatchObject({ input_tokens: 100, output_tokens: 20, usage_source: 'engine' })
    const cred = listRows(h.ctx.db).find((r) => r.kind === 'anthropic-api-key')!
    const broker = brokerOf(h.ctx)
    broker.record(cred.id, started.turnId, 'claude-sonnet-4-5', { input_tokens: 7, output_tokens: 3 })
    broker.record(cred.id, started.turnId, 'claude-sonnet-4-5', { input_tokens: 5, output_tokens: 1 })
    expect(turnRow(started.turnId)).toMatchObject({ input_tokens: 12, output_tokens: 4, usage_source: 'proxy' })
  })
})

describe('the API engine: between rounds', () => {
  test('the round that used the budget up runs none of its tool calls; no next round is sent', async () => {
    budget('b-api', 1000)
    try {
      seen.length = 0
      script.push(
        sse({ text: 'Looking. ', calls: [{ id: 'c1', name: 'list', args: '{"path":"shared"}' }], usage: { prompt_tokens: 500, completion_tokens: 10 } }),
        sse({ text: 'More. ', calls: [{ id: 'c2', name: 'list', args: '{"path":"shared"}' }], usage: { prompt_tokens: 600, completion_tokens: 10 } }),
        sse({ text: 'Never said.', usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      )
      const chat = await newChat('api' as EngineId)
      const r = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: 'look', clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [], engine: 'api' as EngineId } })
      const done = (await alice.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 30_000)).data.message
      expect(done.status).toBe('error')
      expect(done.error?.code).toBe('budget_exceeded')
      expect(done.content).not.toContain('Never said.')
      expect(seen).toHaveLength(2)
      const calls = h.ctx.db.query("SELECT tool_use_id FROM tool_events WHERE turn_id = ? AND tool = 'list'").all(r.turnId) as { tool_use_id: string }[]
      expect(calls.map((c) => c.tool_use_id)).not.toContain('c2')
      expect(turnRow(r.turnId)).toMatchObject({ input_tokens: 1100, output_tokens: 20 })
      script.length = 0
    } finally { drop('b-api') }
  })

  test('runApiAgent: an abort during a round\'s usage, or before the next round, sends nothing more', async () => {
    const conf: ApiEngineConf = { baseUrl: 'https://api.example/v1', model: 'm-1', label: 'M1', key: 'sk-test' }
    const rpc = async (m: any) => m.method === 'tools/list' ? { result: { tools: [{ name: 'list', description: 'List', inputSchema: { type: 'object' } }] } } : { result: { content: [{ type: 'text', text: 'a.md' }] } }
    const round = () => sse({ calls: [{ id: `c${Math.random()}`, name: 'list', args: '{}' }], usage: { prompt_tokens: 10, completion_tokens: 1 } })
    // aborted by the usage event: the round's tool calls are not run
    let sent = 0, ran = 0
    const a = new AbortController()
    const f = (async () => { sent++; return new Response(round()) }) as unknown as typeof fetch
    await runApiAgent({ conf, systemPrompt: 's', message: 'm', rpc: async (m: any) => { if (m.method === 'tools/call') ran++; return rpc(m) }, emit: (e: EngineEvent) => { if (e.type === 'usage') a.abort() }, signal: a.signal, fetchFn: f })
    expect([sent, ran]).toEqual([1, 0])
    // aborted by the check before the third round
    sent = 0; ran = 0
    const b = new AbortController()
    let rounds = 0
    await runApiAgent({ conf, systemPrompt: 's', message: 'm', rpc: async (m: any) => { if (m.method === 'tools/call') ran++; return rpc(m) }, emit: () => {}, signal: b.signal, fetchFn: f, beforeRound: () => { if (++rounds === 2) b.abort() } })
    expect([sent, ran]).toEqual([2, 2])
  })
})

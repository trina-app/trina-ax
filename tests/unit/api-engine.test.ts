// The "api" engine (server/src/engine/api-agent.ts): the agent loop against a stand-in OpenAI-compatible API (stream,
// tool calls, errors, stop), and a whole chat turn through the real runtime where the model's tool calls go through
// the same MCP handler as the other engines (permissions, audit).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, type EngineId } from '@mycel/shared/api'
import type { EngineEvent } from '@mycel/shared'
import { readApiEngine, runApiAgent, writeApiEngine, type ApiEngineConf } from '../../server/src/engine/api-agent'
import { setMemberChoice } from '../../server/src/admin/engine-choice'
import { startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'

setDefaultTimeout(60_000)

/** SSE body of a Chat Completions stream: text pieces, then tool calls, then usage. */
function sse(o: { text?: string[]; calls?: { id: string; name: string; args: string }[] }): string {
  const lines: string[] = []
  for (const t of o.text ?? []) lines.push(JSON.stringify({ choices: [{ delta: { content: t } }] }))
  for (const [i, c] of (o.calls ?? []).entries()) {
    lines.push(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: i, id: c.id, function: { name: c.name, arguments: '' } }] } }] }))
    // arguments arrive in pieces
    lines.push(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: c.args.slice(0, 5) } }] } }] }))
    lines.push(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: c.args.slice(5) } }] } }] }))
  }
  lines.push(JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
  return lines.map((l) => `data: ${l}\n\n`).join('') + 'data: [DONE]\n\n'
}

const conf: ApiEngineConf = { baseUrl: 'https://api.example/v1', model: 'm-1', label: 'M1', key: 'sk-test' }

describe('agent loop', () => {
  test('stream text, call a tool (prefix stripped, arguments in pieces), answer with the result', async () => {
    const bodies: any[] = []
    const replies = [sse({ text: ['Let me look. '], calls: [{ id: 'c1', name: 'mcp__team__list', args: '{"path":"shared"}' }] }), sse({ text: ['There is ', 'a.md.'] })]
    const f = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response(replies.shift()!) }) as unknown as typeof fetch
    const calls: any[] = []
    const rpc = async (m: any) => {
      calls.push(m)
      if (m.method === 'tools/list') return { result: { tools: [{ name: 'list', description: 'List a folder', inputSchema: { type: 'object' } }] } }
      return { result: { content: [{ type: 'text', text: 'a.md' }] } }
    }
    const events: EngineEvent[] = []
    await runApiAgent({ conf, systemPrompt: 'sys', message: 'what is in shared?', rpc, emit: (e) => events.push(e), signal: new AbortController().signal, fetchFn: f })
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('Let me look. There is a.md.')
    expect(calls[1]).toMatchObject({ method: 'tools/call', params: { name: 'list', arguments: { path: 'shared' } } })
    expect(events.find((e) => e.type === 'tool_start')).toMatchObject({ id: 'c1', name: 'list' })
    expect(events.find((e) => e.type === 'tool_end')).toMatchObject({ id: 'c1', ok: true, output: 'a.md' })
    expect(events.filter((e) => e.type === 'usage')).toHaveLength(2)
    // the second request carries the tool round
    expect(bodies[0]).toMatchObject({ model: 'm-1', stream: true, tools: [{ type: 'function', function: { name: 'list' } }] })
    expect(bodies[1].messages.slice(-2)).toEqual([
      { role: 'assistant', content: 'Let me look. ', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list', arguments: '{"path":"shared"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'a.md' },
    ])
  })
  test('errors: a refused key is "auth", a long prompt is "context", no network is "crash"', async () => {
    const run = async (f: typeof fetch) => {
      const events: EngineEvent[] = []
      await runApiAgent({ conf, systemPrompt: 's', message: 'm', rpc: async () => ({ result: { tools: [] } }), emit: (e) => events.push(e), signal: new AbortController().signal, fetchFn: f })
      return events.find((e) => e.type === 'error') as { code: string } | undefined
    }
    expect((await run((async () => new Response('bad key', { status: 401 })) as unknown as typeof fetch))?.code).toBe('auth')
    expect((await run((async () => new Response('maximum context length exceeded', { status: 400 })) as unknown as typeof fetch))?.code).toBe('context')
    expect((await run((async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch))?.code).toBe('crash')
  })
  test('settings file and key', () => {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mycel-api-'))
    expect(readApiEngine(dir)).toBeNull()
    writeApiEngine(dir, { baseUrl: 'https://x.example/v1/', model: 'gpt-x', label: 'X', key: 'sk-1' })
    expect(readApiEngine(dir)).toEqual({ baseUrl: 'https://x.example/v1', model: 'gpt-x', label: 'X', key: 'sk-1' })
    writeApiEngine(dir, { baseUrl: 'https://x.example/v1', model: 'gpt-y', key: null })
    expect(readApiEngine(dir)).toEqual({ baseUrl: 'https://x.example/v1', model: 'gpt-y', label: 'gpt-y', key: null })
    expect((fs.statSync(path.join(dir, 'engine-api.json')).mode & 0o777).toString(8)).toBe('600')
  })
})

describe('a chat turn with the api engine', () => {
  let h: Harness
  let mock: ReturnType<typeof Bun.serve>
  const script: string[] = []
  const seen: any[] = []
  beforeAll(async () => {
    mock = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) { if (req.method === 'GET') return Response.json({ data: [] }) /* the status check's /models */; seen.push(await req.json()); return new Response(script.shift() ?? sse({ text: ['(no script)'] })) } })
    h = await startHarness({ name: 'api-engine' })
    // set up like the owner does in Admin > AI engines; members may pick the engine
    writeApiEngine(h.ctx.config.dataDir, { baseUrl: `http://127.0.0.1:${mock.port}/v1`, model: 'm-1', label: 'M1' })
    // the harness's engines are the scripted ones: hand the turn the same settings
    const confs = h.rt().engines.get()
    confs.api = { baseUrl: `http://127.0.0.1:${mock.port}/v1`, model: 'm-1', label: 'M1', key: null }
    delete confs.problems.api
    setMemberChoice(h.ctx, { mode: 'everyone', groupIds: [], userIds: [] })
  })
  afterAll(async () => { await h.close(); mock.stop(true) })

  test('offered like the other engines: in GET /api/engines with its display name and model', async () => {
    const r = await h.api('alice').call(API.chatEngines)
    expect(r.engines.find((e) => e.id === 'api')).toEqual({ id: 'api', label: 'M1', models: [{ id: 'm-1', label: 'M1' }] })
  })

  test('tools go through the team handler: allowed reads work, a hidden folder is refused, both are audited', async () => {
    script.push(
      sse({ calls: [{ id: 'c1', name: 'read', args: JSON.stringify({ file_path: 'groups/재무/budget.md' }) }, { id: 'c2', name: 'list', args: JSON.stringify({ path: 'shared' }) }] }),
      sse({ text: ['Done reading.'] }),
    )
    const chat = await h.api('alice').call(API.createChat, { body: { engine: 'api' as EngineId } })
    const r = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: 'look around', clientMessageId: `cm-${Date.now()}`, attachmentIds: [], engine: 'api' as EngineId } })
    await waitFor(() => (h.ctx.db.query('SELECT status FROM messages WHERE id = ?').get(r.assistantMessage.id) as { status: string }).status !== 'streaming', { timeoutMs: 20_000 })
    const m = h.ctx.db.query('SELECT status, content, steps, engine FROM messages WHERE id = ?').get(r.assistantMessage.id) as { status: string; content: string; steps: string; engine: string }
    expect(m).toMatchObject({ status: 'done', content: 'Done reading.', engine: 'api' })
    const steps = JSON.parse(m.steps) as { tool: string; status: string }[]
    expect(steps.map((s) => [s.tool, s.status])).toEqual([['read', 'error'], ['list', 'ok']])
    // the model got the refusal text back, and the system prompt is the team's
    const toolMsgs = seen[1].messages.filter((x: any) => x.role === 'tool')
    expect(toolMsgs[0].content).toMatch(/not found or no access/i)
    expect(seen[0].messages[0].content).toContain('team assistant')
    const audit = h.ctx.db.query("SELECT tool, ok FROM tool_events WHERE turn_id = ? AND tool IN ('read', 'list') ORDER BY id").all(r.turnId)
    expect(audit).toEqual([{ tool: 'read', ok: 0 }, { tool: 'list', ok: 1 }])
  })
})

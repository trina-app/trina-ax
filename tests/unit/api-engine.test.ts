// The "api" engine (server/src/engine/api-agent.ts): the agent loop against a stand-in OpenAI-compatible API (stream,
// tool calls, errors, stop), and a whole chat turn through the real runtime where the model's tool calls go through
// the same MCP handler as the other engines (permissions, audit). Also: provider errors by kind (B-API-5), the cost
// of a request (B-API-3), the Admin status check of address, key and model (B-API-4, B-API-6), and one chat switched
// between the API engine and Codex (API-24).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, CHAT_ERROR_MESSAGES, type EngineId } from '@mycel/shared/api'
import type { EngineEvent } from '@mycel/shared'
import { errorOf, readApiEngine, redact, runApiAgent, usageEvent, writeApiEngine, type ApiEngineConf } from '../../server/src/engine/api-agent'
import { checkEngine, modelListed, type EngineEnv } from '../../server/src/admin/engines'
import { usage as usageReport } from '../../server/src/admin/budgets'
import { setMemberChoice } from '../../server/src/admin/engine-choice'
import { startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'

setDefaultTimeout(60_000)

/** SSE body of a Chat Completions stream: text pieces, then tool calls, then usage. */
function sse(o: { text?: string[]; calls?: { id: string; name: string; args: string }[]; usage?: Record<string, unknown>; id?: string }): string {
  const lines: string[] = []
  if (o.id) lines.push(JSON.stringify({ id: o.id, choices: [{ delta: { role: 'assistant' } }] }))
  for (const t of o.text ?? []) lines.push(JSON.stringify({ choices: [{ delta: { content: t } }] }))
  for (const [i, c] of (o.calls ?? []).entries()) {
    lines.push(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: i, id: c.id, function: { name: c.name, arguments: '' } }] } }] }))
    // arguments arrive in pieces
    lines.push(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: c.args.slice(0, 5) } }] } }] }))
    lines.push(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: c.args.slice(5) } }] } }] }))
  }
  lines.push(JSON.stringify({ choices: [], usage: o.usage ?? { prompt_tokens: 10, completion_tokens: 5 } }))
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
  test('the round limit ends with a limit event (not an error, no English text in the answer)', async () => {
    const f = (async () => new Response(sse({ text: ['Working. '], calls: [{ id: `c${crypto.randomUUID()}`, name: 'list', args: '{"path":"shared"}' }] }))) as unknown as typeof fetch
    const rpc = async (m: any) => (m.method === 'tools/list' ? { result: { tools: [{ name: 'list', description: 'List', inputSchema: { type: 'object' } }] } } : { result: { content: [{ type: 'text', text: 'a.md' }] } })
    const events: EngineEvent[] = []
    await runApiAgent({ conf, systemPrompt: 's', message: 'm', rpc, emit: (e) => events.push(e), signal: new AbortController().signal, fetchFn: f, maxSteps: 3 })
    expect(events.filter((e) => e.type === 'tool_start')).toHaveLength(3)
    expect(events.filter((e) => e.type === 'error')).toEqual([])
    expect(events.slice(-2)).toEqual([{ type: 'limit', kind: 'turns' }, { type: 'done' }])
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('Working. Working. Working. ')
  })
  const runErr = async (f: typeof fetch, o: { headersTimeoutMs?: number; c?: ApiEngineConf } = {}) => {
    const events: EngineEvent[] = []
    await runApiAgent({ conf: o.c ?? conf, systemPrompt: 's', message: 'm', rpc: async () => ({ result: { tools: [] } }), emit: (e) => events.push(e), signal: new AbortController().signal, fetchFn: f, headersTimeoutMs: o.headersTimeoutMs })
    return { err: events.find((e) => e.type === 'error') as { code: string; status?: number; message: string } | undefined, events }
  }
  const answer = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch
  test('errors: a refused key is "auth", a long prompt is "context", no network is "endpoint_unreachable"', async () => {
    expect((await runErr(answer(401, 'bad key'))).err).toMatchObject({ code: 'auth', status: 401 })
    expect((await runErr(answer(400, 'maximum context length exceeded'))).err?.code).toBe('context')
    expect((await runErr((async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch)).err?.code).toBe('endpoint_unreachable')
  })
  test('B-API-5: provider answers by kind (OpenRouter, OpenAI, Ollama spellings), with the status, without the key', () => {
    expect(errorOf(400, '{"error":{"message":"deepseek/nope is not a valid model ID","code":400}}')).toMatchObject({ code: 'model_not_found', status: 400 })
    expect(errorOf(404, '{"error":{"message":"The model `gpt-4.1-x` does not exist or you do not have access to it.","code":"model_not_found"}}').code).toBe('model_not_found')
    expect(errorOf(404, '{"error":"model \'llama9\' not found"}').code).toBe('model_not_found')
    // a wrong address (no /v1): the path is not there, no word about a model
    expect(errorOf(404, '<html>Not Found</html>')).toMatchObject({ code: 'endpoint_unreachable', status: 404 })
    expect(errorOf(429, 'slow down')).toMatchObject({ code: 'rate_limit', status: 429 })
    expect(errorOf(502, 'bad gateway')).toMatchObject({ code: 'provider_error', status: 502 })
    expect(errorOf(402, 'Insufficient credits')).toMatchObject({ code: 'provider_error', status: 402 })
    // "this model does not support tools" is not a missing model
    expect(errorOf(400, 'No endpoints found that support tool use. This model does not support tools').code).toBe('provider_error')
    // the key never reaches the log text
    const e = errorOf(401, 'Incorrect API key provided: sk-or-v1-secretsecret1234 (Bearer abcdefgh12345678)', 'sk-or-v1-secretsecret1234')
    expect(e.message).not.toContain('secretsecret')
    expect(e.message).not.toContain('abcdefgh12345678')
    expect(redact('key sk-proj-ABCDEFGH12345 here', null)).toBe('key [key] here')
  })
  test('B-API-5: an error inside the stream keeps its status; a closed port and a silent address are "endpoint_unreachable"', async () => {
    const inStream = 'data: ' + JSON.stringify({ error: { code: 502, message: 'upstream down' } }) + '\n\n'
    expect((await runErr((async () => new Response(inStream)) as unknown as typeof fetch)).err).toMatchObject({ code: 'provider_error', status: 502 })
    const closed = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('x') })
    const port = closed.port
    closed.stop(true)
    expect((await runErr(fetch, { c: { ...conf, baseUrl: `http://127.0.0.1:${port}/v1` } })).err?.code).toBe('endpoint_unreachable')
    // accepts the connection, never answers: stopped after the headers time limit, not at the turn's
    const silent = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Promise<Response>(() => {}) })
    try {
      const t0 = Date.now()
      const r = await runErr(fetch, { c: { ...conf, baseUrl: `http://127.0.0.1:${silent.port}/v1` }, headersTimeoutMs: 300 })
      expect(r.err?.code).toBe('endpoint_unreachable')
      expect(Date.now() - t0).toBeLessThan(5000)
    } finally { silent.stop(true) }
  })
  test('B-API-3: the provider\'s cost and request id, else the list price, else tokens with the cost unknown (never free)', async () => {
    // OpenRouter: usage.cost (USD) and the generation id; usage repeated on two chunks counts once
    let body: any = null
    const or = sse({ id: 'gen-123', text: ['hi'], usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0042 } })
    const twice = or.replace('data: [DONE]', 'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0042 } }) + '\n\ndata: [DONE]')
    const f = (async (_u: string, init: RequestInit) => { body = JSON.parse(String(init.body)); return new Response(twice) }) as unknown as typeof fetch
    const { events } = await runErr(f, { c: { ...conf, baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-v4-flash' } })
    expect(events.filter((e) => e.type === 'usage')).toEqual([{ type: 'usage', inputTokens: 100, outputTokens: 20, costUsd: 0.0042, requestId: 'gen-123' }])
    expect(body.usage).toEqual({ include: true })
    // other providers are not sent OpenRouter's field
    let other: any = null
    await runErr((async (_u: string, init: RequestInit) => { other = JSON.parse(String(init.body)); return new Response(sse({ text: ['x'] })) }) as unknown as typeof fetch)
    expect(other.usage).toBeUndefined()
    // a model of the price table (also as "vendor/model"): the list price
    expect(usageEvent('openai/gpt-5', { prompt_tokens: 1_000_000, completion_tokens: 0 }, undefined)).toEqual({ type: 'usage', inputTokens: 1_000_000, outputTokens: 0, costUsd: 1.25 })
    expect(usageEvent('anthropic/claude-sonnet-4.5', { prompt_tokens: 0, completion_tokens: 1_000_000 }, undefined).costUsd).toBe(15)
    // unknown model, no provider cost: tokens, and the cost is unknown (not 0)
    expect(usageEvent('deepseek/deepseek-v4-flash', { prompt_tokens: 7, completion_tokens: 3 }, 'chatcmpl-1')).toEqual({ type: 'usage', inputTokens: 7, outputTokens: 3, costUnknown: true, requestId: 'chatcmpl-1' })
    // a free model's real 0 from the provider stays 0
    expect(usageEvent('x/y:free', { prompt_tokens: 1, completion_tokens: 1, cost: 0 }, undefined).costUsd).toBe(0)
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

describe('B-API-4 / B-API-6: the Admin status check of the API engine', () => {
  let srv: ReturnType<typeof Bun.serve>
  let reply: { models: Response | (() => Response); key?: number } = { models: Response.json({ data: [] }) }
  const hits: string[] = []
  beforeAll(() => {
    srv = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) {
      const u = new URL(req.url)
      hits.push(u.pathname)
      if (u.pathname.endsWith('/key')) return new Response('{}', { status: reply.key ?? 200 })
      const m = reply.models
      return typeof m === 'function' ? m() : m.clone()
    } })
  })
  afterAll(() => srv.stop(true))
  const check = async (model: string, models: Response | (() => Response), baseUrl = `http://127.0.0.1:${srv.port}/v1`) => {
    reply = { models }
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mycel-api-check-'))
    writeApiEngine(dir, { baseUrl, model, label: 'DeepSeek', key: 'sk-test-12345678' })
    return checkEngine('api', { dataDir: dir } as EngineEnv, true, 'en')
  }
  test('labelled by its kind (API key, provider host), not as a subscription sign-in', async () => {
    const s = await check('deepseek/deepseek-v4-flash', Response.json({ data: [{ id: 'deepseek/deepseek-v4-flash' }] }))
    expect(s).toMatchObject({ id: 'api', status: 'ok', detail: null, authMode: 'api-key', provider: `127.0.0.1:${srv.port}`, models: [{ id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek' }] })
  })
  test('a model the provider does not list is an error that names the model', async () => {
    const s = await check('deepseek/no-such', Response.json({ data: [{ id: 'deepseek/deepseek-v4-flash' }] }))
    expect(s.status).toBe('error')
    expect(s.detail).toContain('deepseek/no-such')
  })
  test('refused key, HTTP error, no list, closed port: each its own status and words', async () => {
    expect(await check('m', new Response('no', { status: 401 }))).toMatchObject({ status: 'not_logged_in', detail: expect.stringContaining('refused') })
    expect(await check('m', new Response('down', { status: 500 }))).toMatchObject({ status: 'error', detail: expect.stringContaining('HTTP 500') })
    expect(await check('m', new Response('nope', { status: 404 }))).toMatchObject({ status: 'ok', detail: expect.stringContaining('not checked') })
    expect(await check('m', Response.json({ data: [] }))).toMatchObject({ status: 'ok', detail: expect.stringContaining('not checked') })
    const closed = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('x') })
    const port = closed.port
    closed.stop(true)
    const s = await check('m', Response.json({ data: [] }), `http://127.0.0.1:${port}/v1`)
    expect(s).toMatchObject({ status: 'error', detail: expect.stringContaining('could not be reached') })
    expect(String(s.detail).includes('sk-test-12345678')).toBe(false)
  })
  test('OpenRouter (public model list): a refused key is found by GET /key; no key check address is said', async () => {
    const real = globalThis.fetch
    const paths: string[] = []
    let keyStatus = 401
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (u.host !== 'openrouter.ai') return real(input, init)
      paths.push(u.pathname)
      if (u.pathname.endsWith('/key')) return new Response('{}', { status: keyStatus })
      return Response.json({ data: [{ id: 'deepseek/deepseek-v4-flash' }] })
    }) as typeof fetch
    try {
      const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mycel-api-or-'))
      writeApiEngine(dir, { baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-v4-flash', label: 'DeepSeek', key: 'sk-or-v1-bad' })
      expect(await checkEngine('api', { dataDir: dir } as EngineEnv, true, 'en')).toMatchObject({ status: 'not_logged_in', provider: 'openrouter.ai' })
      expect(paths).toEqual(['/api/v1/key'])
      keyStatus = 200
      expect(await checkEngine('api', { dataDir: dir } as EngineEnv, true, 'en')).toMatchObject({ status: 'ok', detail: null })
      keyStatus = 404
      paths.length = 0
      expect(await checkEngine('api', { dataDir: dir } as EngineEnv, true, 'en')).toMatchObject({ status: 'ok', detail: expect.stringContaining('key was not checked') })
      expect(paths).toEqual(['/api/v1/key', '/api/v1/auth/key', '/api/v1/models'])
    } finally { globalThis.fetch = real }
  })
  test('model ids as Gemini (models/…) and Ollama (…:latest) list them', () => {
    expect(modelListed(['models/gemini-2.5-flash'], 'gemini-2.5-flash')).toBe(true)
    expect(modelListed(['llama3:latest'], 'llama3')).toBe(true)
    expect(modelListed(['gpt-5'], 'gpt-5-mini')).toBe(false)
  })
})

describe('a chat turn with the api engine', () => {
  let h: Harness
  let mock: ReturnType<typeof Bun.serve>
  const script: (string | (() => Response))[] = []
  const seen: any[] = []
  beforeAll(async () => {
    mock = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) { if (req.method === 'GET') return Response.json({ data: [{ id: 'm-1' }] }) /* the status check's /models */; seen.push(await req.json()); const next = script.shift(); return typeof next === 'function' ? next() : new Response(next ?? sse({ text: ['(no script)'] })) } })
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

  const send = async (chatId: string, content: string, engine: EngineId) => {
    const r = await h.api('alice').call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: `cm-${crypto.randomUUID()}`, attachmentIds: [], engine } })
    await waitFor(() => (h.ctx.db.query('SELECT status FROM messages WHERE id = ?').get(r.assistantMessage.id) as { status: string }).status !== 'streaming', { timeoutMs: 20_000 })
    const m = h.ctx.db.query('SELECT status, content, engine, error FROM messages WHERE id = ?').get(r.assistantMessage.id) as { status: string; content: string; engine: string; error: string | null }
    const t = h.ctx.db.query('SELECT engine, model, input_tokens, output_tokens, cost_usd, usage_source FROM turns WHERE id = ?').get(r.turnId) as Record<string, unknown>
    return { m: { ...m, error: m.error ? JSON.parse(m.error) : null }, t }
  }

  test('B-API-3: an unpriced request keeps its tokens, is marked "price unknown" (not free), and records the model', async () => {
    script.push(sse({ id: 'chatcmpl-9', text: ['Priced?'], usage: { prompt_tokens: 40, completion_tokens: 2 } }))
    const chat = await h.api('alice').call(API.createChat, { body: { engine: 'api' as EngineId } })
    const { m, t } = await send(chat.id, 'cost check', 'api' as EngineId)
    expect(m.status).toBe('done')
    expect(t).toMatchObject({ engine: 'api', model: 'm-1', input_tokens: 40, output_tokens: 2, cost_usd: 0, usage_source: 'engine_unpriced' })
    const rep = usageReport(h.ctx.db, { groupBy: 'engine' })
    expect(rep.rows.find((r) => r.key === 'api')?.unpricedTurns).toBeGreaterThanOrEqual(1)
    expect(rep.totals.unpricedTurns).toBeGreaterThanOrEqual(1)
  })

  test('B-API-3: a paid request keeps the provider\'s cost through the turn (not 0)', async () => {
    script.push(sse({ id: 'gen-1', text: ['Paid.'], usage: { prompt_tokens: 50, completion_tokens: 5, cost: 0.0031 } }))
    const chat = await h.api('alice').call(API.createChat, { body: { engine: 'api' as EngineId } })
    const { m, t } = await send(chat.id, 'paid', 'api' as EngineId)
    expect(m.status).toBe('done')
    expect(t).toMatchObject({ engine: 'api', model: 'm-1', input_tokens: 50, output_tokens: 5, cost_usd: 0.0031, usage_source: 'engine' })
  })

  test('B-API-5: a wrong model and a provider failure become their own localized errors in the chat', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: { engine: 'api' as EngineId } })
    script.push(() => Response.json({ error: { message: 'm-1 is not a valid model ID', code: 400 } }, { status: 400 }))
    const a = await send(chat.id, 'one', 'api' as EngineId)
    expect(a.m.status).toBe('error')
    expect(a.m.error).toMatchObject({ code: 'engine_unavailable', params: { reason: 'model_not_found', status: 400 } })
    expect(a.m.error.message).toContain(CHAT_ERROR_MESSAGES.model_not_found.en)
    script.push(() => new Response('bad gateway', { status: 502 }))
    const b = await send(chat.id, 'two', 'api' as EngineId)
    expect(b.m.error).toMatchObject({ params: { reason: 'provider_error', status: 502 } })
    expect(b.m.error.message).toBe(`${CHAT_ERROR_MESSAGES.provider_error.en} (HTTP 502)`)
  })

  test('API-24: one chat goes from the API engine to Codex and back; each answer carries the conversation so far', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: { engine: 'api' as EngineId } })
    script.push(sse({ text: ['API says kiwi.'] }))
    const one = await send(chat.id, 'first question', 'api' as EngineId)
    expect(one.m).toMatchObject({ status: 'done', content: 'API says kiwi.', engine: 'api' })
    const two = await send(chat.id, '@fake ' + JSON.stringify({ echo: 'system' }), 'codex' as EngineId)
    expect(two.m).toMatchObject({ status: 'done', engine: 'codex' })
    expect(two.t).toMatchObject({ engine: 'codex' })
    // Codex got the API engine's answer as history
    expect(two.m.content).toContain('API says kiwi.')
    const before = seen.length
    script.push(sse({ text: ['Back on API.'] }))
    const three = await send(chat.id, 'third question', 'api' as EngineId)
    expect(three.m).toMatchObject({ status: 'done', content: 'Back on API.', engine: 'api' })
    // the API request holds the whole branch: the first exchange and Codex's turn
    const sys = String(seen[before].messages[0].content)
    expect(sys).toContain('first question')
    expect(sys).toContain('API says kiwi.')
    expect(seen[before].model).toBe('m-1')
    expect((await h.api('alice').call(API.getChat, { params: { id: chat.id } })).engine).toBe('api')
  })
})

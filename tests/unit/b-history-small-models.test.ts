// QA TC-4940: the API engine's history window is counted against the model's own context
// (docs/decisions/20261118-history-small-models.md). A local model (Ollama, LM Studio) with 8k-32k tokens got the
// window made for Claude (40,000 tokens) and overflowed: "This conversation got too long", or with Ollama a silent cut
// of the prompt's start (the instructions).
//   - the context size is learned from the model's server (Ollama /api/ps and /api/show, LM Studio, llama.cpp, the
//     OpenAI-compatible /models list) or from a refusal that names it; the key goes only to the /models address
//   - the window is what the instructions, tools and message leave, with room for the answer; a summary that would
//     not fit is shortened; the chat says plainly that the model is small
//   - a model the instructions alone overflow: a plain error, and no request is sent
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import { CHAT_ERROR_MESSAGES } from '@mycel/shared/api'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { estimateTokens, historyBlock, historyTrimmed, HISTORY_MAX_TOKENS, summaryWithin } from '../../server/src/chat/prompt'
import { summaryTarget, uncovered, setSummaryAiForTests, resetSummaryStateForTests } from '../../server/src/chat/history-summary'
import { ANSWER_ROOM_MIN, historyFit } from '../../server/src/chat/history-fit'
import { apiContextSize, contextFromRefusal, isLocalApiAddress, LOCAL_GUESS_TOKENS, noteContextRefusal, noteContextUsage, PROBE_BODY_MAX, resetApiContextForTests } from '../../server/src/engine/api-context'
import { API_GROUNDING_RULES, writeApiEngine, type ApiEngineConf } from '../../server/src/engine/api-agent'

setDefaultTimeout(60_000)

const msg = (role: 'user' | 'assistant', n: number, c = 'x') => ({ role, content: `${role} ${n} ${c.repeat(4_000)}` })
/** 20 messages of about 1,000 tokens each */
const long = Array.from({ length: 20 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', i))

describe('the window fits the budget it is given', () => {
  test('a small budget keeps only what fits; the default one is unchanged', () => {
    const small = historyBlock(long, null, 3_000)
    expect(estimateTokens(small)).toBeLessThan(3_200)
    expect(small).toContain('user 18')
    expect(small).toMatch(/\(18 earlier messages omitted\)/)
    expect(historyTrimmed(long, null, 3_000)).toBe(true)
    // the default window holds all 20
    expect(historyTrimmed(long, null)).toBe(false)
    expect(historyBlock(long, null)).toContain('user 0')
  })

  test('no room: every message is left out, none half-cut', () => {
    const b = historyBlock(long, { text: 'S', count: 4 }, 0)
    expect(b).not.toContain('user ')
    expect(b).not.toContain('<conversation_summary>')
    expect(b).toMatch(/\(20 earlier messages omitted\)/)
  })

  test('a summary larger than half the window is shortened, its beginning kept', () => {
    const text = `GOAL first. ${'fact '.repeat(1_500)}LAST-WORD`
    const s = summaryWithin({ text, count: 10 }, 2_000)
    expect(s.text).toStartWith('GOAL first.')
    expect(s.text).not.toContain('LAST-WORD')
    expect(s.text).toContain('did not fit this AI model')
    expect(estimateTokens(s.text)).toBeLessThanOrEqual(1_000)
    // the default window keeps it whole
    expect(summaryWithin({ text, count: 10 }).text).toBe(text)
    const block = historyBlock(long, { text, count: 10 }, 2_000)
    expect(estimateTokens(block)).toBeLessThan(2_300)
    expect(block).toContain('Summary of the first 10 messages')
  })

  test('the summary path follows the smaller window', () => {
    // 20,000 tokens of history: nothing to summarize for the default window, most of it for a 4,000-token one
    expect(uncovered(long, null)).toBe(0)
    expect(uncovered(long, null, 4_000)).toBeGreaterThan(15)
    expect(summaryTarget(long, 4_000)).toBeGreaterThan(summaryTarget(long))
    expect(uncovered(long, { text: 'S', count: 18 }, 4_000)).toBe(0)
  })
})

describe('historyFit', () => {
  const instructions = 'i'.repeat(4 * 6_000) // 6,000 tokens
  const tools = 't'.repeat(4 * 3_000)
  test('a big model keeps the default window', () => {
    expect(historyFit({ contextTokens: 200_000, instructions, tools, message: 'hi' })).toEqual({ budget: HISTORY_MAX_TOKENS, overflows: false, limited: false })
  })
  test('a 32k model: what the instructions, tools and message leave, a fifth kept for the answer', () => {
    const f = historyFit({ contextTokens: 32_768, instructions, tools, message: 'hi' })
    expect(f.limited).toBe(true)
    expect(f.overflows).toBe(false)
    // 32,768 - 6,553 room - (9,001 * 1.15)
    expect(f.budget).toBeGreaterThan(15_500)
    expect(f.budget).toBeLessThan(16_000)
  })
  test('an 8k model the instructions fill: no history, and it overflows', () => {
    const f = historyFit({ contextTokens: 8_192, instructions, tools, message: 'hi' })
    expect(f.budget).toBe(0)
    expect(f.overflows).toBe(true)
    expect(historyFit({ contextTokens: 16_384, instructions, tools, message: 'hi' }).overflows).toBe(false)
    expect(ANSWER_ROOM_MIN).toBe(2_048)
  })
})

describe('the context size', () => {
  beforeEach(() => resetApiContextForTests())
  const conf = (baseUrl: string, model = 'm', key: string | null = null): ApiEngineConf => ({ baseUrl, model, label: model, key })
  /** a fake server: path -> JSON (404 for others); every request's path and Authorization header is kept */
  function server(routes: Record<string, unknown>) {
    const seen: { path: string; auth: string | null }[] = []
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      seen.push({ path: u.pathname, auth: new Headers(init?.headers).get('authorization') })
      const r = routes[u.pathname]
      return r === undefined ? new Response('not found', { status: 404 }) : Response.json(r)
    }) as typeof fetch
    return { fetchFn, seen }
  }

  test('Ollama: the loaded size first, then num_ctx; its trained length is a guess only', async () => {
    const a = server({ '/api/ps': { models: [{ name: 'qwen3:8b', model: 'qwen3:8b', context_length: 8192 }] } })
    expect(await apiContextSize(conf('http://127.0.0.1:11434/v1', 'qwen3:8b'), { fetchFn: a.fetchFn })).toEqual({ tokens: 8192, exact: true, source: 'ollama' })
    resetApiContextForTests()
    const b = server({ '/api/ps': { models: [] }, '/api/show': { parameters: 'temperature 0.7\nnum_ctx 16384', model_info: { 'qwen3.context_length': 40960 } } })
    expect(await apiContextSize(conf('http://127.0.0.1:11434/v1', 'qwen3:8b'), { fetchFn: b.fetchFn })).toEqual({ tokens: 16384, exact: true, source: 'ollama' })
    resetApiContextForTests()
    const c = server({ '/api/ps': { models: [] }, '/api/show': { parameters: '', model_info: { 'llama.context_length': 8192 } } })
    expect(await apiContextSize(conf('http://127.0.0.1:11434/v1', 'llama3'), { fetchFn: c.fetchFn })).toEqual({ tokens: 8192, exact: false, source: 'ollama' })
  })

  test('LM Studio: the loaded context length', async () => {
    const a = server({ '/api/v0/models/gemma-3-12b': { id: 'gemma-3-12b', state: 'loaded', max_context_length: 131072, loaded_context_length: 4096 } })
    expect(await apiContextSize(conf('http://localhost:1234/v1', 'gemma-3-12b'), { fetchFn: a.fetchFn })).toEqual({ tokens: 4096, exact: true, source: 'lmstudio' })
  })

  test('llama.cpp /props, vLLM and OpenRouter model lists', async () => {
    const a = server({ '/props': { default_generation_settings: { n_ctx: 12288 } } })
    expect((await apiContextSize(conf('http://192.168.1.20:8080/v1'), { fetchFn: a.fetchFn }))?.tokens).toBe(12288)
    resetApiContextForTests()
    const b = server({ '/v1/models': { data: [{ id: 'other', max_model_len: 1 }, { id: 'm', max_model_len: 24576 }] } })
    expect(await apiContextSize(conf('http://10.0.0.5:8000/v1'), { fetchFn: b.fetchFn })).toEqual({ tokens: 24576, exact: true, source: 'models' })
    resetApiContextForTests()
    const c = server({ '/api/v1/models': { data: [{ id: 'meta-llama/llama-3.1-8b-instruct', context_length: 131072 }] } })
    expect((await apiContextSize(conf('https://openrouter.ai/api/v1', 'meta-llama/llama-3.1-8b-instruct', 'sk-or-secret'), { fetchFn: c.fetchFn }))?.tokens).toBe(131072)
    // the key went only to the address it was saved for, never to /api/ps, /api/show or /api/v0 of that host
    for (const s of c.seen) expect(s.auth === null || s.path === '/api/v1/models').toBe(true)
    expect(c.seen.find((s) => s.path === '/api/v1/models')?.auth).toBe('Bearer sk-or-secret')
  })

  test('nothing said: a local address is a guess of 32k, a cloud one stays unknown', async () => {
    const a = server({})
    expect(await apiContextSize(conf('http://127.0.0.1:9999/v1'), { fetchFn: a.fetchFn })).toEqual({ tokens: LOCAL_GUESS_TOKENS, exact: false, source: 'local-guess' })
    expect(await apiContextSize(conf('https://api.example.com/v1'), { fetchFn: a.fetchFn })).toBeNull()
    expect(isLocalApiAddress('http://ollama.local:11434/v1')).toBe(true)
    expect(isLocalApiAddress('http://[::1]:11434/v1')).toBe(true)
    expect(isLocalApiAddress('https://api.openai.com/v1')).toBe(false)
  })

  test('probes are cached; a refusal\'s number is kept and wins when smaller', async () => {
    const a = server({ '/api/ps': { models: [{ name: 'm', context_length: 32768 }] } })
    const c = conf('http://127.0.0.1:11434/v1')
    await apiContextSize(c, { fetchFn: a.fetchFn })
    const n = a.seen.length
    await apiContextSize(c, { fetchFn: a.fetchFn })
    expect(a.seen.length).toBe(n)
    expect(noteContextRefusal(c, 'HTTP 400: {"error":{"message":"This model\'s maximum context length is 8,192 tokens. However, you requested 9000 tokens"}}')).toBe(8192)
    // never exact: it only shrinks the window
    expect(await apiContextSize(c, { fetchFn: a.fetchFn })).toEqual({ tokens: 8192, exact: false, source: 'refusal' })
    // a request with more tokens went through: the number was wrong and is forgotten
    noteContextUsage(c, 9_000)
    expect(await apiContextSize(c, { fetchFn: a.fetchFn })).toEqual({ tokens: 32768, exact: true, source: 'ollama' })
  })

  test('a refusal that echoes other text: only the provider\'s own sentence counts, never quotes or JSON in it', () => {
    // a tool argument or the person's words repeated in the error
    expect(contextFromRefusal('HTTP 400: {"error":{"message":"Invalid value \\"the context length is 600 tokens\\" for argument path"}}')).toBeNull()
    expect(contextFromRefusal('HTTP 400: {"error":{"message":"bad request: {\\"note\\": \\"maximum context length is 600 tokens\\"}"}}')).toBeNull()
    expect(contextFromRefusal('HTTP 400: bad tool call `maximum context length is 600 tokens`')).toBeNull()
    expect(contextFromRefusal('HTTP 400: {"error":{"message":"context_length 600 is what the user wrote"}}')).toBeNull()
    expect(contextFromRefusal('HTTP 400: {"error":{"message":"This model\'s maximum context length is 8192 tokens. However, you requested 9100 tokens (\\"maximum context length is 600 tokens\\")."}}')).toBe(8192)
    // llama.cpp's own field, also from a body cut off at 300 characters
    expect(contextFromRefusal('HTTP 400: {"error":{"code":400,"message":"the request exceeds the available context size, try increasing it","type":"exceed_context_size_error","n_prompt_tokens":5000,"n_ctx":4096}}')).toBe(4096)
    expect(contextFromRefusal('HTTP 400: {"error":{"code":400,"message":"This model\'s maximum context length is 16384 tokens. However, your messages resulted in 20000 tok')).toBe(16384)
  })

  test('a cloud provider that says nothing is asked again only after 10 minutes', async () => {
    const a = server({})
    const c = conf('https://api.example.com/v1')
    const t0 = 1_000_000
    expect(await apiContextSize(c, { fetchFn: a.fetchFn, now: t0 })).toBeNull()
    const n = a.seen.length
    expect(await apiContextSize(c, { fetchFn: a.fetchFn, now: t0 + 5 * 60_000 })).toBeNull()
    expect(a.seen.length).toBe(n)
  })

  test('the turn\'s Stop ends the wait for a probe', async () => {
    const slow = (async () => { await Bun.sleep(2_000); return new Response('{}') }) as unknown as typeof fetch
    const stop = new AbortController()
    const t0 = Date.now()
    const p = apiContextSize(conf('http://127.0.0.1:9998/v1'), { fetchFn: slow, signal: stop.signal })
    stop.abort()
    expect(await p).toBeNull()
    expect(Date.now() - t0).toBeLessThan(500)
  })

  test('a probe answer larger than 1 MB is not read', async () => {
    const big = { data: [{ id: 'm', context_length: 8192, pad: 'x'.repeat(PROBE_BODY_MAX) }] }
    const a = server({ '/v1/models': big })
    expect(await apiContextSize(conf('http://10.0.0.7:8000/v1'), { fetchFn: a.fetchFn })).toEqual({ tokens: LOCAL_GUESS_TOKENS, exact: false, source: 'local-guess' })
  })

  test('the API engine is told not to work around a declined card', () => {
    expect(API_GROUNDING_RULES).toMatch(/declines a card[^\n]*another way/)
  })

  test('refusal wordings', () => {
    expect(contextFromRefusal("This model's maximum context length is 4096 tokens")).toBe(4096)
    expect(contextFromRefusal('the request exceeds the available context size (8192 tokens), try increasing it')).toBe(8192)
    expect(contextFromRefusal('Trying to keep the first 5000 tokens when context the overflows. However, the model is loaded with context length of only 4096 tokens')).toBe(4096)
    expect(contextFromRefusal('{"n_ctx": 2048, "n_prompt_tokens": 3000}')).toBe(2048)
    expect(contextFromRefusal('Request too large for gpt-4o on tokens per min (TPM): Limit 30000')).toBeNull()
  })
})

describe('a turn on a small local model (fake OpenAI-compatible server)', () => {
  let h: Harness
  let alice: TestSocket
  let mock: ReturnType<typeof Bun.serve>
  let ctx = 32_768
  let refuse: string | null = null
  const requests: { system: string; tools: unknown[] }[] = []
  let promptTokens = 1
  let silent = false
  const sse = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`

  beforeAll(async () => {
    mock = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
      const p = new URL(req.url).pathname
      if (p === '/api/ps' && silent) return new Response('not found', { status: 404 })
      if (p === '/api/ps') return Response.json({ models: [{ name: 'local-m', model: 'local-m', context_length: ctx }] })
      if (p !== '/v1/chat/completions') return new Response('not found', { status: 404 })
      const body = await req.json() as { messages: { role: string; content: string }[]; tools?: unknown[] }
      requests.push({ system: body.messages[0]!.content, tools: body.tools ?? [] })
      if (refuse) return new Response(refuse, { status: 400 })
      return new Response(sse('ok'))
    } })
    h = await startHarness({ name: 'b-history-small-models' })
    const baseUrl = `http://127.0.0.1:${mock.port}/v1`
    writeApiEngine(h.ctx.config.dataDir, { baseUrl, model: 'local-m', label: 'Local' })
    const confs = h.rt().engines.get()
    confs.api = { baseUrl, model: 'local-m', label: 'Local', key: null }
    delete confs.problems.api
    alice = await h.ws('alice', { windowId: 'win-alice-small' })
    await alice.next('hello')
  })
  afterAll(async () => { setSummaryAiForTests(null); alice?.close(); await h.close(); mock.stop(true) })
  beforeEach(() => { resetApiContextForTests(); resetSummaryStateForTests(); setSummaryAiForTests(() => null); refuse = null; requests.length = 0; promptTokens = 1; silent = false })

  const chatWithHistory = async () => {
    const chat = await h.api('alice').call(API.createChat, { body: { engine: 'api' } })
    // three messages of about 3,750 tokens each, each with its own marker
    for (const w of ['ALPHA', 'BRAVO', 'CHARLIE']) await ask(h, alice, 'alice', chat.id, `${w} ${'word '.repeat(3_000)}`)
    return chat
  }

  test('the request fits the model: instructions, tools and history, with room for the answer; the chat says why', async () => {
    ctx = 32_768
    const chat = await chatWithHistory()
    requests.length = 0
    const { done } = await ask(h, alice, 'alice', chat.id, 'what was the first word?')
    const r = requests.at(-1)!
    const sent = estimateTokens(r.system) + estimateTokens(JSON.stringify(r.tools)) + estimateTokens('what was the first word?')
    // the old window (40,000 tokens) sent all 11,000 tokens of history: more than the model can take with the rest
    expect(sent).toBeLessThan(ctx - ANSWER_ROOM_MIN)
    expect(r.system).toContain('CHARLIE')
    expect(r.system).not.toContain('ALPHA')
    expect(r.system).toMatch(/earlier messages omitted/)
    expect(done.status).toBe('done')
    expect(done.historyTrimmed).toBe(true)
    expect(done.historySmallModel).toBe(true)
  })

  test('a big model keeps the whole history and the usual note', async () => {
    ctx = 1_000_000
    const chat = await chatWithHistory()
    const { done } = await ask(h, alice, 'alice', chat.id, 'and now?')
    expect(requests.at(-1)!.system).toContain('ALPHA')
    expect(done.historyTrimmed).toBeUndefined()
    expect(done.historySmallModel).toBeUndefined()
  })

  test('the summary path: what the small window leaves out is summarized, the summary fitted too', async () => {
    ctx = 32_768
    const calls: string[] = []
    setSummaryAiForTests(() => async (_s, m) => { calls.push(m); return { text: `SUMMARY: ${m.includes('ALPHA') ? 'it started with ALPHA' : '-'}` } })
    const chat = await chatWithHistory()
    requests.length = 0
    const { done } = await ask(h, alice, 'alice', chat.id, 'what was the first word?')
    expect(calls.some((c) => c.includes('ALPHA'))).toBe(true)
    expect(requests.at(-1)!.system).toContain('SUMMARY: it started with ALPHA')
    expect(done.historyTrimmed).toBeUndefined()
  })

  test('a model the instructions alone overflow: a plain error, nothing sent', async () => {
    ctx = 4_096
    const chat = await h.api('alice').call(API.createChat, { body: { engine: 'api' } })
    const { done } = await ask(h, alice, 'alice', chat.id, 'hello')
    expect(requests.length).toBe(0)
    expect(done.status).toBe('error')
    expect(done.error?.params?.reason).toBe('model_too_small')
    expect(done.error?.message).toBe(CHAT_ERROR_MESSAGES.model_too_small.en)
  })

  test('a refusal that names a small size: the model is small (not "continue in a new chat"), and the next turn shrinks the history', async () => {
    ctx = 1_000_000 // the server says a big size, the model refuses with a smaller one
    const chat = await chatWithHistory()
    refuse = JSON.stringify({ error: { message: "This model's maximum context length is 24576 tokens. However, your messages resulted in 30000 tokens." } })
    const one = await ask(h, alice, 'alice', chat.id, 'next')
    expect(one.done.error?.params?.reason).toBe('model_too_small')
    refuse = null
    requests.length = 0
    const two = await ask(h, alice, 'alice', chat.id, 'again')
    const r = requests.at(-1)!
    expect(r.system).not.toContain('ALPHA')
    expect(estimateTokens(r.system) + estimateTokens(JSON.stringify(r.tools))).toBeLessThan(24_576 - ANSWER_ROOM_MIN)
    expect(two.done.status).toBe('done')
  })

  test('a poisoned refusal ("600 tokens" in the provider\'s own words) never refuses a turn, and a larger request clears it', async () => {
    ctx = 1_000_000
    const chat = await h.api('alice').call(API.createChat, { body: { engine: 'api' } })
    refuse = JSON.stringify({ error: { message: "This model's maximum context length is 600 tokens." } })
    await ask(h, alice, 'alice', chat.id, 'first')
    refuse = null
    promptTokens = 30_000
    const two = await ask(h, alice, 'alice', chat.id, 'second')
    // not model_too_small, although 600 tokens cannot hold the instructions: the number was only a refusal's
    expect(two.done.status).toBe('done')
    expect(requests.at(-1)).toBeDefined()
    // the answer reported 30,000 prompt tokens: the 600 is forgotten, the server's 1M counts again
    requests.length = 0
    const three = await ask(h, alice, 'alice', chat.id, 'third')
    expect(three.done.status).toBe('done')
    expect(requests.at(-1)!.system).toContain('first')
  })

  test('a large model refused for an oversized request keeps the usual words', async () => {
    ctx = 1_000_000
    const chat = await h.api('alice').call(API.createChat, { body: { engine: 'api' } })
    refuse = JSON.stringify({ error: { message: "This model's maximum context length is 200000 tokens. However, your messages resulted in 260000 tokens." } })
    const one = await ask(h, alice, 'alice', chat.id, 'read the big file')
    expect(one.done.error?.params?.reason).toBe('context')
  })

  test('a guessed size (a local address that says nothing) never cuts the tool list; a guess the tools alone fill is ignored', async () => {
    silent = true
    const chat = await chatWithHistory()
    requests.length = 0
    const { done } = await ask(h, alice, 'alice', chat.id, 'hello')
    const r = requests.at(-1)!
    expect(JSON.stringify(r.tools)).toContain('intro_deck')
    // the whole list is more than the 32k guess: nothing is known, so the default window keeps the whole history
    expect(r.system).toContain('ALPHA')
    expect(done.historyTrimmed).toBeUndefined()
  })
})

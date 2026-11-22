// The API engine's stable, smaller prompt (docs/decisions/20261120-api-engine-stable-prompt.md): the time goes with
// the message to the minute (QA TC-4824), the instructions are the same from chat to chat, large and rare tools come on
// demand (load_tools, QA TC-4823), Claude models on OpenRouter get cache marks, and a public address waits 10 minutes
// for the first answer (QA TC-4822). The Claude Code and Codex prompts are pinned in engine-prompt-pin.test.ts.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import type { EngineEvent } from '@mycel/shared'
import { HEADERS_TIMEOUT_MS, marksCache, requestMessages, runApiAgent, splitHistory, writeApiEngine, type ApiEngineConf } from '../../server/src/engine/api-agent'
import { API_DEFERRED_TOOLS, apiOfferedTools, LOAD_TOOLS, loadTools, moreToolsNote } from '../../server/src/engine/api-tools-defer'
import { isPatientApiAddress, resetApiContextForTests } from '../../server/src/engine/api-context'
import { apiTimeContext, timeLine } from '../../server/src/chat/prompt'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'

setDefaultTimeout(60_000)

function sse(o: { text?: string[]; calls?: { id: string; name: string; args: string }[] }): string {
  const lines: string[] = []
  for (const t of o.text ?? []) lines.push(JSON.stringify({ choices: [{ delta: { content: t } }] }))
  for (const [i, c] of (o.calls ?? []).entries()) lines.push(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: i, id: c.id, function: { name: c.name, arguments: c.args } }] } }] }))
  lines.push(JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
  return lines.map((l) => `data: ${l}\n\n`).join('') + 'data: [DONE]\n\n'
}
const tool = (name: string, description = `${name} does one thing. More words.`) => ({ name, description, inputSchema: { type: 'object', properties: { x: { type: 'string' } } } })
const asApi = (t: ReturnType<typeof tool>) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.inputSchema } })
const conf: ApiEngineConf = { baseUrl: 'https://api.example/v1', model: 'm-1', label: 'M1', key: 'sk-test' }

describe('the time line', () => {
  test('to the minute, in a turn_context block: two messages in one minute read the same', () => {
    const a = apiTimeContext(new Date('2026-11-20T21:15:07.581Z'), 'UTC')
    const b = apiTimeContext(new Date('2026-11-20T21:15:59.999Z'), 'UTC')
    expect(a).toBe(b)
    expect(a).toMatch(/^<turn_context>\nNow: Friday, November 20, 2026 at 9:15 PM \(UTC\); 2026-11-20T21:15Z UTC\./)
    expect(a).not.toMatch(/\.\d{3}Z/)
    expect(a.endsWith('\n</turn_context>')).toBe(true)
    // the same words as the instructions' line, only the clock is rounded
    const line = timeLine(new Date('2026-11-20T21:15:00Z'), 'UTC')
    expect(a).toContain(line.slice(line.indexOf(' UTC is the team')))
  })
})

describe('tools on demand', () => {
  const all = [tool('read'), tool('intro_deck', 'Make an intro deck. It has many steps.'), tool('write'), tool('edit_pdf'), tool('schedule_list')].map(asApi)
  test('the deferred tools are listed, not sent; load_tools is sent while some are left', () => {
    const { tools, listed } = apiOfferedTools(all)
    expect(tools.map((t) => t.function.name)).toEqual(['read', 'write', LOAD_TOOLS])
    expect(listed.map((t) => t.function.name)).toEqual(['intro_deck', 'edit_pdf', 'schedule_list'])
    expect((tools[2]!.function.parameters as any).properties.names.items.enum).toEqual(['intro_deck', 'edit_pdf', 'schedule_list'])
    const note = moreToolsNote(listed)
    expect(note).toContain('## More tools')
    expect(note).toContain('- intro_deck: Make an intro deck.')
    expect(note).not.toContain('many steps')
  })
  test('loaded tools follow the others in the order they were loaded; the start of the list stays', () => {
    const loaded = new Set<string>()
    expect(loadTools({ names: ['schedule_list', 'intro_deck', 'nope'] }, all, loaded)).toMatchObject({ ok: true })
    const { tools } = apiOfferedTools(all, loaded)
    expect(tools.map((t) => t.function.name)).toEqual(['read', 'write', 'schedule_list', 'intro_deck', LOAD_TOOLS])
    expect(loadTools({ names: ['nope'] }, all, loaded)).toMatchObject({ ok: false })
    loaded.add('edit_pdf')
    expect(apiOfferedTools(all, loaded).tools.map((t) => t.function.name)).not.toContain(LOAD_TOOLS)
  })
  test('the set: decks, video, PDF and Office editing, zip, schedules, access changes, skill files', () => {
    // (22: #365 added promo_video_versions to the video tools a turn loads when it needs them)
    expect(API_DEFERRED_TOOLS.size).toBe(22)
    for (const keep of ['list', 'glob', 'grep', 'read', 'write', 'edit', 'share_file', 'make_file', 'ask_user', 'rooms', 'room_read', 'post_to_room', 'skill']) expect(API_DEFERRED_TOOLS.has(keep)).toBe(false)
  })

  test('in the loop: load_tools adds the tool for the next rounds, is no step the person sees, and a listed tool called by name runs', async () => {
    const bodies: any[] = []
    const replies = [
      sse({ calls: [{ id: 'c1', name: LOAD_TOOLS, args: '{"names":["intro_deck"]}' }] }),
      sse({ calls: [{ id: 'c2', name: 'intro_deck', args: '{"x":"1"}' }, { id: 'c3', name: 'schedule_list', args: '{}' }] }),
      sse({ text: ['Done.'] }),
    ]
    const f = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response(replies.shift()!) }) as unknown as typeof fetch
    const ran: string[] = []
    const rpc = async (m: any) => {
      if (m.method === 'tools/list') return { result: { tools: [tool('read'), tool('intro_deck'), tool('schedule_list')] } }
      ran.push(m.params.name)
      return { result: { content: [{ type: 'text', text: 'ok' }] } }
    }
    const events: EngineEvent[] = []
    await runApiAgent({ conf, systemPrompt: 'sys', message: 'make a deck', rpc, emit: (e) => events.push(e), signal: new AbortController().signal, fetchFn: f })
    const names = (b: any) => b.tools.map((t: any) => t.function.name)
    expect(names(bodies[0])).toEqual(['read', LOAD_TOOLS])
    expect(bodies[0].messages[0].content).toContain('- intro_deck: intro_deck does one thing.')
    expect(names(bodies[1])).toEqual(['read', 'intro_deck', LOAD_TOOLS])
    expect(names(bodies[2])).toEqual(['read', 'intro_deck', 'schedule_list'])
    // the instructions stay the same all answer
    expect(bodies[2].messages[0].content).toBe(bodies[0].messages[0].content)
    expect(bodies[1].messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c1', content: expect.stringContaining('Loaded: intro_deck') })
    expect(ran).toEqual(['intro_deck', 'schedule_list'])
    expect(events.filter((e) => e.type === 'tool_start').map((e) => (e as any).name)).toEqual(['intro_deck', 'schedule_list'])
    expect(events.filter((e) => e.type === 'text').map((e) => (e as any).delta).join('')).toBe('Done.')
  })

  test('a model with a small context (its whole list over toolBudget) gets its list fitted as before, with no load_tools', async () => {
    const bodies: any[] = []
    const f = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response(sse({ text: ['ok'] })) }) as unknown as typeof fetch
    const rpc = async (m: any) => (m.method === 'tools/list' ? { result: { tools: [tool('read'), tool('intro_deck')] } } : { result: { content: [] } })
    await runApiAgent({ conf, systemPrompt: 'sys', message: 'hi', rpc, emit: () => {}, signal: new AbortController().signal, fetchFn: f, toolBudget: 60 })
    expect(bodies[0].tools.map((t: any) => t.function.name)).toEqual(['read'])
    expect(bodies[0].messages[0].content).not.toContain('## More tools')
    expect(bodies[0].messages[0].content).toContain('## Tools this AI model cannot use')
    // a large model whose known size holds the whole list: tools on demand
    bodies.length = 0
    await runApiAgent({ conf, systemPrompt: 'sys', message: 'hi', rpc, emit: () => {}, signal: new AbortController().signal, fetchFn: f, toolBudget: 100_000 })
    expect(bodies[0].tools.map((t: any) => t.function.name)).toEqual(['read', LOAD_TOOLS])
  })
})

describe('cache marks and the history', () => {
  test('the history is the end of the instructions; the fixed part comes first', () => {
    const fixed = 'RULES\n\n## Team skills\nx'
    const history = '<previous_conversation>\nThe conversation so far in this chat (your earlier session is not available; continue from here).\nhi\n</previous_conversation>'
    expect(splitHistory(`${fixed}\n\n${history}`)).toEqual({ fixed, history })
    expect(splitHistory(fixed)).toEqual({ fixed, history: '' })
  })
  test('only Claude models on OpenRouter are marked', () => {
    expect(marksCache({ baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-5.5' })).toBe(true)
    expect(marksCache({ baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5.4' })).toBe(false)
    expect(marksCache({ baseUrl: 'https://api.openai.com/v1', model: 'anthropic/claude-x' })).toBe(false)
  })
  test('marked: the fixed part, the last message and the one last in the round before; unmarked: one string', () => {
    const msgs = [{ role: 'system' as const, content: '' }, { role: 'user' as const, content: 'q' },
      { role: 'assistant' as const, content: null, tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'list', arguments: '{}' } }] },
      { role: 'tool' as const, tool_call_id: 'c1', content: 'r1' }]
    const sys = { fixed: 'F', history: 'H' }
    expect(requestMessages(msgs, sys, { cache: false, prevLast: 1 })).toEqual([{ role: 'system', content: 'F\n\nH' }, ...msgs.slice(1)])
    const m = requestMessages(msgs, sys, { cache: true, prevLast: 1 }) as any[]
    expect(m[0]).toEqual({ role: 'system', content: [{ type: 'text', text: 'F', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'H' }] })
    expect(m[1]).toEqual({ role: 'user', content: [{ type: 'text', text: 'q', cache_control: { type: 'ephemeral' } }] })
    expect(m[2]).toEqual(msgs[2])
    expect(m[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: 'r1', cache_control: { type: 'ephemeral' } }] })
    // the stored messages are not changed
    expect(msgs[1]!.content).toBe('q')
  })
  test('a request to a Claude model on OpenRouter carries the marks', async () => {
    const bodies: any[] = []
    const f = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response(sse({ text: ['ok'] })) }) as unknown as typeof fetch
    const rpc = async (m: any) => (m.method === 'tools/list' ? { result: { tools: [tool('read')] } } : { result: { content: [] } })
    await runApiAgent({ conf: { baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-5.5', label: 'S', key: 'k' }, systemPrompt: 'sys', message: 'hi', rpc, emit: () => {}, signal: new AbortController().signal, fetchFn: f })
    expect(bodies[0].messages[0].content[0]).toMatchObject({ type: 'text', cache_control: { type: 'ephemeral' } })
    expect(bodies[0].messages[0].content[0].text.startsWith('sys')).toBe(true)
    expect(bodies[0].usage).toEqual({ include: true })
  })
})

// review finding 1 on #181 (QA TC-6103): Bun's fetch ends a request on its own after 300 s with no byte ("The operation
// timed out"), measured with Bun 1.3.12 against a server that answers after 330 s; with timeout: false it waited. So the
// request turns Bun's own limit off, for a public address (10 minutes, HEADERS_TIMEOUT_MS) and a local one (no limit).
test("the provider request turns off Bun's own 300 s fetch timeout", async () => {
  const inits: any[] = []
  const f = (async (_u: string, init: any) => { inits.push(init); return new Response(sse({ text: ['ok'] })) }) as unknown as typeof fetch
  const rpc = async (m: any) => (m.method === 'tools/list' ? { result: { tools: [tool('read')] } } : { result: { content: [] } })
  for (const baseUrl of ['https://api.example/v1', 'http://127.0.0.1:11434/v1']) {
    await runApiAgent({ conf: { ...conf, baseUrl }, systemPrompt: 'sys', message: 'hi', rpc, emit: () => {}, signal: new AbortController().signal, fetchFn: f })
  }
  expect(inits.length).toBe(2)
  for (const i of inits) expect(i.timeout).toBe(false)
})

test('a public address waits 10 minutes for the first answer, as Claude Code does; a local one has no limit', () => {
  expect(HEADERS_TIMEOUT_MS).toBe(600_000)
  expect(isPatientApiAddress('https://openrouter.ai/api/v1')).toBe(false)
  expect(isPatientApiAddress('http://127.0.0.1:11434/v1')).toBe(true)
})

describe('a chat turn on the API engine (fake provider)', () => {
  let h: Harness
  let alice: TestSocket
  let mock: ReturnType<typeof Bun.serve>
  const requests: any[] = []
  beforeAll(async () => {
    mock = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
      const p = new URL(req.url).pathname
      if (p === '/api/ps') return Response.json({ models: [{ name: 'm', model: 'm', context_length: 1_000_000 }] })
      if (p !== '/v1/chat/completions') return new Response('not found', { status: 404 })
      requests.push(await req.json())
      return new Response(sse({ text: ['ok'] }))
    } })
    h = await startHarness({ name: 'api-engine-stable-prompt' })
    const baseUrl = `http://127.0.0.1:${mock.port}/v1`
    writeApiEngine(h.ctx.config.dataDir, { baseUrl, model: 'm', label: 'L' })
    const confs = h.rt().engines.get()
    confs.api = { baseUrl, model: 'm', label: 'L', key: null }
    delete confs.problems.api
    alice = await h.ws('alice', { windowId: 'win-alice-stable' })
    await alice.next('hello')
  })
  afterAll(async () => { alice?.close(); await h?.close(); mock?.stop(true) })

  test('two new chats send the same instructions and tools; the time is in front of the message, to the minute', async () => {
    resetApiContextForTests()
    const sent: any[] = []
    for (const q of ['first?', 'second?']) {
      const chat = await h.api('alice').call(API.createChat, { body: { engine: 'api' } })
      requests.length = 0
      const { done } = await ask(h, alice, 'alice', chat.id, q)
      expect(done.status).toBe('done')
      sent.push(requests[0])
      await Bun.sleep(5)
    }
    const [a, b] = sent
    expect(a.messages[0].content).toBe(b.messages[0].content)
    expect(JSON.stringify(a.tools)).toBe(JSON.stringify(b.tools))
    expect(a.messages[0].content).not.toContain('Now: ')
    expect(a.messages[0].content).toContain('## More tools')
    const names = a.tools.map((t: any) => t.function.name)
    expect(names).toContain(LOAD_TOOLS)
    for (const n of names) expect(API_DEFERRED_TOOLS.has(n)).toBe(false)
    expect(a.messages[1].content).toMatch(/^<turn_context>\nNow: .*; \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z UTC\.[\s\S]*\n<\/turn_context>\n\nfirst\?$/)
    // smaller than the whole list it replaces
    expect(JSON.stringify(a.tools).length).toBeLessThan(90_000)
  })
})

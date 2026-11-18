// docs/decisions/20261118-api-images-connector-cap-delete-cards.md (limits audit #31, N25, N20):
// - K: a card detail longer than the card carries keeps its start with its full size; the whole text is read on request
//   by the turn's own person while the card is open (chat/card-fold.ts, GET /api/turns/:id/requests/:requestId/details/:i);
// - F: whether the API engine's model takes images, from what its server says (engine/api-vision.ts), the admin's
//   choice only while it says nothing; the pictures a tool gives go to such a model as image parts after the round's
//   results, a refusal of them goes again without them (engine/api-agent.ts); a whole turn through the real runtime.
// (H: the delete, members and folder access cards are in ai-delete-files, b-project-members-tool, c-folder-access-tool.)
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, type EngineId, type TurnRequest } from '@mycel/shared/api'
import type { EngineEvent } from '@mycel/shared'
import { CARD_TEXT_INLINE, CARD_TEXT_PREVIEW, foldCardDetails } from '../../server/src/chat/card-fold'
import { imageParts, IMAGES_REFUSED, readApiEngine, runApiAgent, writeApiEngine, type ApiEngineConf } from '../../server/src/engine/api-agent'
import { apiSeesImages, apiVisionOf, resetApiVisionForTests, visionByName, visionOfModelEntry, visionOfOllamaShow } from '../../server/src/engine/api-vision'
import { nativeBinDir, ocrBin, which } from '../../server/src/config'
import { visionTools } from '../../server/src/files/vision'
import { isolation } from '../../server/src/tools/isolate'
import { setMemberChoice } from '../../server/src/admin/engine-choice'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { makePng } from '../lib/images'
import { waitFor } from '../lib/wait'

setDefaultTimeout(90_000)

function sse(o: { text?: string[]; calls?: { id: string; name: string; args: string }[] }): string {
  const lines: unknown[] = []
  for (const t of o.text ?? []) lines.push({ choices: [{ delta: { content: t } }] })
  for (const [i, c] of (o.calls ?? []).entries()) lines.push({ choices: [{ delta: { tool_calls: [{ index: i, id: c.id, function: { name: c.name, arguments: c.args } }] } }] })
  lines.push({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })
  return lines.map((l) => `data: ${JSON.stringify(l)}\n\n`).join('') + 'data: [DONE]\n\n'
}
const conf: ApiEngineConf = { baseUrl: 'https://api.example/v1', model: 'm-1', label: 'M1', key: 'sk-test' }
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]).toString('base64')

describe('K: a card detail longer than the card carries', () => {
  const ask = (text: string, more: Record<string, unknown> = {}) => ({ kind: 'ask_user', requestId: 'r1', question: 'q', details: [{ label: 'short', text: 'small' }, { label: 'long', text, exact: true, ...more }] }) as unknown as TurnRequest
  test('the start with its full size and a fold; the whole text kept aside; short ones untouched', () => {
    const long = 'a'.repeat(CARD_TEXT_INLINE + 5)
    const { request, full } = foldCardDetails(ask(long))
    const d = (request as any).details
    expect(d[0]).toEqual({ label: 'short', text: 'small' })
    expect(d[1].text).toHaveLength(CARD_TEXT_INLINE)
    expect(d[1].fullChars).toBe(CARD_TEXT_INLINE + 5)
    expect(d[1].collapsedAt).toBe(CARD_TEXT_PREVIEW)
    // a folded text is not "the exact form one click away" any more: it is the text
    expect(d[1].exact).toBeUndefined()
    expect(full!.get(1)).toBe(long)
    expect(full!.has(0)).toBe(false)
    const same = ask('b'.repeat(CARD_TEXT_INLINE))
    expect(foldCardDetails(same)).toEqual({ request: same, full: null })
  })
  test('never cut inside an emoji; a smaller fold of its own stays', () => {
    const text = 'x'.repeat(CARD_TEXT_INLINE - 1) + '😀' + 'y'.repeat(10)
    const d = (foldCardDetails(ask(text, { collapsedAt: 400 })).request as any).details[1]
    expect(d.text).toBe('x'.repeat(CARD_TEXT_INLINE - 1))
    expect(d.collapsedAt).toBe(400)
  })
})

describe('K: the whole text of an open card, through a real turn', () => {
  let h: Harness
  let sock: TestSocket
  let bob: TestSocket
  beforeAll(async () => {
    h = await startHarness({ name: 'limits-card-fold', askUserTimeoutMs: 8000, stallTimeoutMs: 60_000 })
    fs.mkdirSync(path.join(h.team, 'users/alice'), { recursive: true })
    fs.writeFileSync(path.join(h.team, 'users/alice/fold.md'), 'x\n')
    sock = await h.ws('alice', { windowId: 'win-fold' }); await sock.next('hello')
    bob = await h.ws('bob', { windowId: 'win-fold-bob' }); await bob.next('hello')
  })
  afterAll(async () => { sock?.close(); bob?.close(); await h?.close() })

  test('the event carries the start; the turn\'s own person reads all of it while it is open; nobody else, and not after', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    // an answer that is still running (the engine waits): the turn shows a card with a text of 300,000 characters, as a
    // connection's write would
    const r = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: '@fake {"sleep": 15000}', clientMessageId: `cm-${crypto.randomUUID()}`, attachmentIds: [] } })
    const exec = await waitFor(() => h.rt().execFor(r.turnId), { timeoutMs: 20_000 })
    const long = 'Q'.repeat(150_000) + 'END-OF-TEXT' + 'z'.repeat(150_000)
    const requestId = crypto.randomUUID()
    const answer = exec!.waitForPerson({ kind: 'ask_user', origin: 'server', requestId, question: 'Send this?', options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }], details: [{ label: 'Sends', text: long }] } as TurnRequest, { timeoutMs: 8000 })
    const ev = await waitFor(() => sock.frames.find((f) => f.type === 'turn.request' && f.data.request.requestId === requestId), { timeoutMs: 5000 })
    const shown = ((ev as any).data.request as any).details[0]
    expect(shown.text).toHaveLength(CARD_TEXT_INLINE)
    expect(shown.text).not.toContain('END-OF-TEXT')
    expect(shown.fullChars).toBe(long.length)
    // what a reload reads (GET /api/chats/:id/requests) is the folded card too
    const open = await h.api('alice').call(API.listTurnRequests, { params: { id: chat.id } })
    expect((open.items.find((i) => i.request.requestId === requestId)!.request as any).details[0].text).toHaveLength(CARD_TEXT_INLINE)
    const got = await h.api('alice').call(API.turnRequestDetail, { params: { id: r.turnId, requestId, index: '0' } })
    expect(got.text).toBe(long)
    // another person, another index, another card: nothing
    await expect(h.api('bob').call(API.turnRequestDetail, { params: { id: r.turnId, requestId, index: '0' } })).rejects.toThrow()
    await expect(h.api('alice').call(API.turnRequestDetail, { params: { id: r.turnId, requestId, index: '1' } })).rejects.toThrow()
    await expect(h.api('alice').call(API.turnRequestDetail, { params: { id: r.turnId, requestId: crypto.randomUUID(), index: '0' } })).rejects.toThrow()
    await h.api('alice').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId, answer: 'no' } })
    expect(await answer).toBe('no')
    await expect(h.api('alice').call(API.turnRequestDetail, { params: { id: r.turnId, requestId, index: '0' } })).rejects.toThrow()
    await h.api('alice').call(API.stop, { params: { id: chat.id } }).catch(() => {})
  })
})

describe('F: does the API model take images', () => {
  test('the official endpoints by name; anything else is not guessed from its name', () => {
    expect(visionByName('https://api.openai.com/v1', 'gpt-5.4-mini')).toBe(true)
    expect(visionByName('https://api.openai.com/v1', 'gpt-4o')).toBe(true)
    expect(visionByName('https://api.openai.com/v1', 'gpt-3.5-turbo')).toBe(false)
    expect(visionByName('https://api.openai.com/v1', 'o3-mini')).toBe(false)
    expect(visionByName('https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-2.5-flash')).toBe(true)
    expect(visionByName('https://api.anthropic.com/v1', 'claude-sonnet-5-5')).toBe(true)
    expect(visionByName('https://openrouter.ai/api/v1', 'openai/gpt-4o')).toBeNull()
    expect(visionByName('http://127.0.0.1:11434/v1', 'llava')).toBeNull()
  })
  test('what a model list, Ollama and LM Studio say', () => {
    expect(visionOfModelEntry({ id: 'x', architecture: { input_modalities: ['text', 'image'] } })).toBe(true)
    expect(visionOfModelEntry({ id: 'x', architecture: { input_modalities: ['text'] } })).toBe(false)
    expect(visionOfModelEntry({ id: 'x', capabilities: { vision: true } })).toBe(true)
    expect(visionOfModelEntry({ id: 'x' })).toBeNull()
    expect(visionOfOllamaShow({ capabilities: ['completion', 'vision', 'tools'] })).toBe(true)
    expect(visionOfOllamaShow({ capabilities: ['completion', 'tools'] })).toBe(false)
    expect(visionOfOllamaShow({ model_info: {}, projector_info: { 'clip.has_vision_encoder': true } })).toBe(true)
    expect(visionOfOllamaShow({ error: 'not found' })).toBeNull()
  })

  /** a stand-in provider: path -> answer (a POST gets its body passed) */
  const server = (routes: Record<string, (body: any) => unknown>) => {
    const hits: string[] = []
    const f = (async (u: string, init?: RequestInit) => {
      const p = new URL(u).pathname
      hits.push(`${init?.method ?? 'GET'} ${p} ${(init?.headers as Record<string, string> | undefined)?.Authorization ?? ''}`.trim())
      const r = routes[p]
      return r ? Response.json(r(init?.body ? JSON.parse(String(init.body)) : null)) : new Response('no', { status: 404 })
    }) as unknown as typeof fetch
    return { f, hits }
  }

  test('OpenRouter\'s list (with the key), Ollama /api/show, LM Studio, llama.cpp; nothing said → unknown, then the admin\'s choice', async () => {
    resetApiVisionForTests()
    const or = server({ '/api/v1/models': () => ({ data: [{ id: 'qwen/qwen-vl', architecture: { input_modalities: ['text', 'image'] } }, { id: 'meta/llama-text', architecture: { input_modalities: ['text'] } }] }) })
    const orConf = { baseUrl: 'https://openrouter.ai/api/v1', model: 'qwen/qwen-vl', label: 'Q', key: 'sk-or' }
    expect(await apiVisionOf(orConf, { fetchFn: or.f })).toEqual({ images: true, source: 'models' })
    expect(or.hits).toEqual(['GET /api/v1/models Bearer sk-or'])
    expect((await apiVisionOf({ ...orConf, model: 'meta/llama-text' }, { fetchFn: or.f })).images).toBe(false)
    // cached: the list is not read again for the same model
    await apiVisionOf(orConf, { fetchFn: or.f })
    expect(or.hits).toHaveLength(2)

    const ollama = server({ '/api/show': (b) => ({ capabilities: b.model === 'llava' ? ['completion', 'vision'] : ['completion', 'tools'] }) })
    expect(await apiVisionOf({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'llava', label: 'L', key: null }, { fetchFn: ollama.f })).toEqual({ images: true, source: 'ollama' })
    expect((await apiVisionOf({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3', label: 'L', key: null }, { fetchFn: ollama.f })).images).toBe(false)
    // the key never goes to the other paths of the host
    expect(ollama.hits.filter((x) => x.includes('/api/show')).every((x) => !x.includes('Bearer'))).toBe(true)

    const lms = server({ '/api/v0/models/gemma-3': () => ({ id: 'gemma-3', type: 'vlm' }) })
    expect(await apiVisionOf({ baseUrl: 'http://127.0.0.1:1234/v1', model: 'gemma-3', label: 'G', key: null }, { fetchFn: lms.f })).toEqual({ images: true, source: 'lmstudio' })
    const llama = server({ '/props': () => ({ modalities: { vision: false } }) })
    expect(await apiVisionOf({ baseUrl: 'http://127.0.0.1:8080/v1', model: 'any', label: 'A', key: null }, { fetchFn: llama.f })).toEqual({ images: false, source: 'llamacpp' })

    const silent = server({ '/v1/models': () => ({ data: [{ id: 'mystery' }] }) })
    const mystery = { baseUrl: 'https://llm.example.com/v1', model: 'mystery', label: 'M', key: 'sk-m' }
    expect(await apiVisionOf(mystery, { fetchFn: silent.f })).toEqual({ images: null, source: null })
    expect((await apiSeesImages(mystery, { fetchFn: silent.f })).images).toBe(false)
    expect((await apiSeesImages({ ...mystery, vision: 'on' }, { fetchFn: silent.f })).images).toBe(true)
    // the choice never overrides what the server says
    expect((await apiSeesImages({ ...orConf, model: 'meta/llama-text', vision: 'on' }, { fetchFn: or.f })).images).toBe(false)
  })

  test('the admin\'s choice is kept for the same address and model, dropped for another model, cleared by null', () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'api-vision-'))
    try {
      writeApiEngine(dir, { baseUrl: 'https://llm.example.com/v1', model: 'mystery', key: 'sk-1', vision: 'on' })
      expect(readApiEngine(dir)!.vision).toBe('on')
      writeApiEngine(dir, { baseUrl: 'https://llm.example.com/v1', model: 'mystery', label: 'Renamed' })
      expect(readApiEngine(dir)!.vision).toBe('on')
      writeApiEngine(dir, { baseUrl: 'https://llm.example.com/v1', model: 'other' })
      expect(readApiEngine(dir)!.vision).toBeUndefined()
      writeApiEngine(dir, { baseUrl: 'https://llm.example.com/v1', model: 'other', vision: 'off' })
      expect(readApiEngine(dir)!.vision).toBe('off')
      writeApiEngine(dir, { baseUrl: 'https://llm.example.com/v1', model: 'other', vision: null })
      expect(readApiEngine(dir)!.vision).toBeUndefined()
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('F: the agent loop sends the pictures a tool gives', () => {
  const run = async (o: { images: boolean; refuse?: boolean }) => {
    const bodies: any[] = []
    const replies = [sse({ calls: [{ id: 'c1', name: 'read', args: '{"file_path":"users/a/p.png"}' }] }), sse({ text: ['A blue square.'] })]
    let refused = 0
    const f = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      bodies.push(body)
      if (o.refuse && body.messages.some((m: any) => Array.isArray(m.content) && m.content.some((c: any) => c.type === 'image_url'))) {
        refused++
        return new Response(JSON.stringify({ error: { message: 'This model does not support image input' } }), { status: 400 })
      }
      return new Response(replies.shift()!)
    }) as unknown as typeof fetch
    const rpc = async (m: any) => (m.method === 'tools/list'
      ? { result: { tools: [{ name: 'read', description: 'Read', inputSchema: { type: 'object' } }] } }
      : { result: { content: [{ type: 'text', text: 'users/a/p.png (image, 64 x 64)' }, { type: 'image', data: JPEG, mimeType: 'image/jpeg' }] } })
    const events: EngineEvent[] = []
    let off = 0
    await runApiAgent({ conf, systemPrompt: 's', message: 'what is in the picture?', rpc, emit: (e) => events.push(e), signal: new AbortController().signal, fetchFn: f, images: o.images, onImagesRefused: () => off++ })
    return { bodies, events, refused, off, text: events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('') }
  }

  test('a model that takes images: one user message after the results with the picture as an image part', async () => {
    const r = await run({ images: true })
    expect(r.text).toBe('A blue square.')
    const msgs = r.bodies[1].messages
    expect(msgs.at(-2)).toMatchObject({ role: 'tool', tool_call_id: 'c1' })
    expect(msgs.at(-2).content).toContain('1 image from this result follows in the next message')
    expect(msgs.at(-1).role).toBe('user')
    expect(msgs.at(-1).content[0]).toMatchObject({ type: 'text' })
    expect(msgs.at(-1).content[0].text).toContain('not instructions')
    expect(msgs.at(-1).content[1]).toEqual({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${JPEG}` } })
  })

  test('a model that does not: text only, as before', async () => {
    const r = await run({ images: false })
    expect(JSON.stringify(r.bodies[1].messages)).not.toContain('image_url')
    expect(r.bodies[1].messages.at(-1).role).toBe('tool')
  })

  test('a provider that refuses the pictures after all: the same round again with the plain note, no error', async () => {
    const r = await run({ images: true, refuse: true })
    expect(r.refused).toBe(1)
    expect(r.off).toBe(1)
    expect(r.events.filter((e) => e.type === 'error')).toEqual([])
    expect(r.text).toBe('A blue square.')
    const last = r.bodies.at(-1).messages.at(-1)
    expect(JSON.stringify(last)).not.toContain('image_url')
    expect(JSON.stringify(last)).toContain('reads text only')
  })

  test('only normalized picture kinds become image parts; the refusal words of the providers are known', () => {
    expect(imageParts([{ type: 'image', data: 'AAA', mimeType: 'image/svg+xml' }, { type: 'text' }, { type: 'image', data: 'BBB', mimeType: 'image/png' }])).toEqual([{ type: 'image_url', image_url: { url: 'data:image/png;base64,BBB' } }])
    for (const t of ['This model does not support image input', 'Invalid content type. image_url is only supported by certain models: image input not supported', 'llava: does not support vision', 'image input is not supported for this model'])
      expect({ t, ok: IMAGES_REFUSED.test(t) }).toEqual({ t, ok: true })
    expect(IMAGES_REFUSED.test('maximum context length is 8192 tokens')).toBe(false)
  })
})

const TOOLS = visionTools({ nativeBin: nativeBinDir(), pdftotext: which('pdftotext'), ocr: ocrBin(), which })
const converter = !!TOOLS.normalizer && isolation() !== 'none'

describe('F: a whole API engine turn through the real runtime', () => {
  let h: Harness
  let mock: ReturnType<typeof Bun.serve>
  const script: string[] = []
  const seen: any[] = []
  beforeAll(async () => {
    resetApiVisionForTests()
    mock = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
      const p = new URL(req.url).pathname
      if (req.method === 'GET' && p === '/v1/models') return Response.json({ data: [{ id: 'vis-1', architecture: { input_modalities: ['text', 'image'] } }, { id: 'txt-1', architecture: { input_modalities: ['text'] } }] })
      if (req.method === 'POST' && p === '/v1/chat/completions') { seen.push(await req.json()); return new Response(script.shift() ?? sse({ text: ['(no script)'] })) }
      return new Response('no', { status: 404 })
    } })
    h = await startHarness({ name: 'limits-api-images' })
    fs.writeFileSync(path.join(h.team, 'users/alice/blue.png'), makePng(96, 64))
    setMemberChoice(h.ctx, { mode: 'everyone', groupIds: [], userIds: [] })
  })
  afterAll(async () => { await h?.close(); mock?.stop(true) })

  const turn = async (model: string) => {
    const confs = h.rt().engines.get()
    confs.api = { baseUrl: `http://127.0.0.1:${mock.port}/v1`, model, label: model, key: null }
    delete confs.problems.api
    writeApiEngine(h.ctx.config.dataDir, { baseUrl: `http://127.0.0.1:${mock.port}/v1`, model, label: model })
    seen.length = 0
    script.push(sse({ calls: [{ id: 'c1', name: 'read', args: JSON.stringify({ file_path: 'users/alice/blue.png' }) }] }), sse({ text: ['Seen.'] }))
    const chat = await h.api('alice').call(API.createChat, { body: { engine: 'api' as EngineId } })
    const r = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: 'what colour is blue.png?', clientMessageId: `cm-${crypto.randomUUID()}`, attachmentIds: [], engine: 'api' as EngineId } })
    await waitFor(() => (h.ctx.db.query('SELECT status FROM messages WHERE id = ?').get(r.assistantMessage.id) as { status: string }).status !== 'streaming', { timeoutMs: 30_000 })
    return seen[1]?.messages as any[]
  }

  test.skipIf(!converter)('a model whose list says it takes images sees the picture; a text-only one gets the plain note', async () => {
    const vis = await turn('vis-1')
    const pics = vis.filter((m) => m.role === 'user' && Array.isArray(m.content)).flatMap((m) => m.content).filter((c: any) => c.type === 'image_url')
    expect(pics).toHaveLength(1)
    expect(pics[0].image_url.url.startsWith('data:image/jpeg;base64,/9j/')).toBe(true)
    // (a Mac reads a picture's text with Apple Vision instead of the note: off here, as on Linux)
    const ocr = h.ctx.files.cfg.ocr
    h.ctx.files.cfg.ocr = null
    try {
      const txt = await turn('txt-1')
      expect(JSON.stringify(txt)).not.toContain('image_url')
      expect(txt.find((m) => m.role === 'tool').content).toContain('reads text only')
    } finally { h.ctx.files.cfg.ocr = ocr }
  })
})

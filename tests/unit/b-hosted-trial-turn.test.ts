// Turns on the hosting service's trial AI credit (docs/DECISIONS.md "Z — trial credit on the API engine"): with no AI
// connection a Claude Code (or Codex) chat is answered by the app's own API engine with the trial key and model, never
// by a Claude Code launch; a connection the team adds takes over; the team's Codex fallback still goes first; a used or
// ended credit gives its own error before anything runs, and one used up during an answer stops it there. Scheduled
// runs, company profile drafts (web_fetch only) and a marketing pack skill run from its form (the welcome steps' first
// result) all run on it. Real runtime and launcher, fake Claude Code / Codex engine, a fake OpenRouter (no network).
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, type ProfileDraftState } from '@mycel/shared/api'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { addCred } from '../lib/credentials'
import { waitFor } from '../lib/wait'
import { CONFIRMED } from '../lib/schedule-card'
import { setSetting } from '../../server/src/admin/settings'
import { LIMIT_FALLBACK_KEY } from '../../server/src/admin/engine-choice'
import { credentialsOf } from '../../server/src/credentials/store'
import {
  chargeHostedChat, HOSTED_CHAT_ID, HOSTED_CHAT_KEY_SETTING, HOSTED_CHAT_MAX_TOKENS, HOSTED_CHAT_MODEL, HOSTED_CHAT_USAGE_SETTING, hostedChatHeldUsd,
  hostedChatUsedUsd, writeHostedChatKey,
} from '../../server/src/credentials/hosted-chat'
import { installSkillPack } from '../../server/src/onboarding/skill-packs'
import type { TurnTool } from '../../server/src/services'
import type { LaunchRequest } from '../../shared/src/engine'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const KEY = 'sk-or-v1-TRIAL-TURN-' + 'k'.repeat(40)
const TEAM_KEY = 'sk-ant-api03-TEAM-TURN-' + 't'.repeat(30)
const LIMITED_KEY = 'sk-ant-api03-LIMITED-TURN-' + 'l'.repeat(30)
const OKEY = 'sk-proj-' + 'O'.repeat(40)
/** what OpenRouter reports one trial completion cost */
const COST = 0.001

// the team's own connections: a fake Anthropic (Claude Code through the model proxy) and a fake OpenAI (Codex)
const seen: { key: string | null; model: string }[] = []
const enc = new TextEncoder()
const ev = (o: unknown) => enc.encode(`event: e\ndata: ${JSON.stringify(o)}\n\n`)
const up = Bun.serve({
  port: 0, hostname: '127.0.0.1', idleTimeout: 0,
  async fetch(req) {
    if (new URL(req.url).pathname.endsWith('/responses')) {
      await req.text()
      seen.push({ key: 'openai', model: '' })
      return new Response(`event: x\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'codex answered' })}\n\nevent: x\ndata: ${JSON.stringify({ type: 'response.completed', response: { model: 'gpt-5.4', output: [], usage: { input_tokens: 5, output_tokens: 2 } } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    }
    const body = await req.json() as { model: string }
    const key = req.headers.get('x-api-key')
    seen.push({ key, model: body.model })
    if (key === LIMITED_KEY) return Response.json({ type: 'error', error: { type: 'rate_limit_error', message: 'limit' } }, { status: 429, headers: { 'retry-after': '3600' } })
    return new Response(new ReadableStream<Uint8Array>({ start(c) {
      c.enqueue(ev({ type: 'message_start', message: { model: body.model, usage: { input_tokens: 10, output_tokens: 1 } } }))
      c.enqueue(ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'team answered ' } }))
      c.enqueue(ev({ type: 'message_delta', usage: { output_tokens: 2 } }))
      c.close()
    } }), { headers: { 'content-type': 'text/event-stream' } })
  },
})

// a fake OpenRouter: the trial answers (Chat Completions, streamed)
interface OrBody { model: string; max_tokens?: number; messages: { role: string; content: string | null }[]; tools?: { function: { name: string } }[] }
const orSeen: { path: string; auth: string | null; body: OrBody }[] = []
/** the next completions' answers, in order (default: "trial answered" and its usage) */
let script: ((b: OrBody) => Response)[] = []
const sse = (lines: unknown[]) => new Response(lines.map((l) => `data: ${JSON.stringify(l)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
const say = (text: string) => () => sse([{ id: 'gen-1', choices: [{ delta: { content: text } }] }, { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, cost: COST } }])
const callTool = (name: string, args: unknown) => () => sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${name}-${orSeen.length}`, function: { name, arguments: JSON.stringify(args) } }] } }] },
  { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, cost: COST } }])
const or = Bun.serve({
  port: 0, hostname: '127.0.0.1', idleTimeout: 0,
  async fetch(req) {
    const body = await req.json() as OrBody
    orSeen.push({ path: new URL(req.url).pathname, auth: req.headers.get('authorization'), body })
    return (script.shift() ?? say('trial answered'))(body)
  },
})

let h: Harness
let alice: TestSocket
/** every Claude Code / Codex launch of the turns from here on (env, args, files), as JSON */
const launches: string[] = []
/** the stand-in web_fetch's calls (no network) */
const fetched: string[] = []
let savedTools: TurnTool[] | undefined
beforeAll(async () => {
  const u = `http://127.0.0.1:${up.port}`
  h = await startHarness({ name: 'b-hosted-trial', turnTimeoutMs: 60_000, upstreams: { anthropic: u, openai: u + '/v1', openrouter: `http://127.0.0.1:${or.port}/api/v1` }, credentials: [] })
  alice = await h.ws('alice', { windowId: 'win-alice-trial' }); await alice.next('hello')
  const launcher = (await h.ctx.core()).launcher!
  const orig = launcher.launch.bind(launcher)
  launcher.launch = (req: LaunchRequest) => { launches.push(JSON.stringify(req)); return orig(req) }
  savedTools = h.ctx.services.turnTools
  h.ctx.services.turnTools = [{
    name: 'web_fetch', description: 'test web_fetch', inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
    async call(args) { const url = (args as { url: string }).url; fetched.push(url); return { content: [{ type: 'text', text: `PAGE ${url}: Acme makes quiet desk fans.` }] } },
  }]
})
afterAll(async () => { if (h) h.ctx.services.turnTools = savedTools; alice?.close(); await h?.close(); up.stop(true); or.stop(true) })
const grant = (o: Partial<{ capUsd: number; endsAt: string; enabled: boolean }> = {}) =>
  writeHostedChatKey(credentialsOf(h.ctx), { key: KEY, capUsd: 1, endsAt: new Date(Date.now() + 14 * 86400_000).toISOString(), enabled: true, ...o })
const newChat = (engine: 'claude-code' | 'codex' = 'claude-code', model?: string) => h.api('alice').call(API.createChat, { body: { engine, ...(model ? { model } : {}) } })
const turnRow = (id: string) => h.ctx.db.query('SELECT engine, model, credential_id, cost_usd FROM turns WHERE id = ?').get(id) as { engine: string; model: string; credential_id: string; cost_usd: number }
beforeEach(() => {
  seen.length = 0; orSeen.length = 0; launches.length = 0; script = []; fetched.length = 0
  h.ctx.db.query('DELETE FROM engine_credentials').run()
  h.ctx.db.query('DELETE FROM settings WHERE key IN (?, ?)').run(HOSTED_CHAT_KEY_SETTING, HOSTED_CHAT_USAGE_SETTING)
})

describe('a turn on the trial credit runs on the API engine, never in Claude Code', () => {
  test('nothing connected: a Claude Code chat is answered by the API engine with the trial key, model and max_tokens; no launch at all', async () => {
    grant()
    const chat = await newChat('claude-code', 'opus')
    const { started, done } = await ask(h, alice, 'alice', chat.id, 'hello there', { ms: 30_000 })
    expect(done.status).toBe('done')
    expect(done.content).toContain('trial answered')
    // Claude Code never started; no request reached Anthropic
    expect(launches).toEqual([])
    expect(seen).toEqual([])
    expect(orSeen.map((s) => [s.path, s.auth, s.body.model, s.body.max_tokens])).toEqual([['/api/v1/chat/completions', `Bearer ${KEY}`, HOSTED_CHAT_MODEL, HOSTED_CHAT_MAX_TOKENS]])
    // the API engine's tools: the turn's MCP tools, never a sub-agent; the message as sent
    const tools = (orSeen[0]!.body.tools ?? []).map((t) => t.function.name)
    expect(tools).toContain('read')
    expect(tools.some((t) => /^(agent|task)$/i.test(t))).toBe(false)
    expect(orSeen[0]!.body.messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('hello there') })
    // the turn is the API engine's on the trial model; Usage by connection names the trial credit. The answer keeps the
    // chat's engine (the person never chose the API engine: no switch divider to it and back), its model says what answered
    expect(done.engine).toBe('claude-code')
    expect(done.model).toBe(HOSTED_CHAT_MODEL)
    expect(turnRow(started.turnId)).toEqual({ engine: 'api', model: HOSTED_CHAT_MODEL, credential_id: HOSTED_CHAT_ID, cost_usd: COST })
    expect(hostedChatUsedUsd(h.ctx.db)).toBeCloseTo(COST, 12)
    expect(hostedChatHeldUsd(h.ctx.db)).toBe(0)
    // the chat keeps its engine: once the team connects its own AI, Claude Code answers it again
    expect((await h.api('alice').call(API.getChat, { params: { id: chat.id } })).engine).toBe('claude-code')
  })
  test('a Codex chat with no Codex connection: the same', async () => {
    grant()
    const { done } = await ask(h, alice, 'alice', (await newChat('codex')).id, 'hi', { ms: 30_000 })
    expect(done.content).toContain('trial answered')
    expect(done.engine).toBe('codex')
    expect(launches).toEqual([])
    expect(seen).toEqual([])
  })
  test('a connection the team adds answers instead (Claude Code with the team key); the credit is not touched', async () => {
    grant()
    addCred(credentialsOf(h.ctx), 'anthropic-api-key', TEAM_KEY, { label: 'team' })
    const { done } = await ask(h, alice, 'alice', (await newChat()).id, fake({ modelAny: 'hi' }), { ms: 30_000 })
    expect(done.content).toContain('team answered')
    expect(done.engine).toBe('claude-code')
    expect(seen.map((s) => s.key)).toEqual([TEAM_KEY])
    expect(orSeen).toEqual([])
    expect(hostedChatUsedUsd(h.ctx.db)).toBe(0)
    // the launch never holds the trial key
    expect(launches.length).toBeGreaterThan(0)
    for (const l of launches) expect(l).not.toContain('TRIAL-TURN')
  })
  test('a Claude connection at its limit and a Codex connection: the admin\'s Codex fallback, or the usual wait; never the credit', async () => {
    grant()
    const cc = credentialsOf(h.ctx)
    addCred(cc, 'anthropic-api-key', LIMITED_KEY, { label: 'limited' })
    addCred(cc, 'openai-api-key', OKEY, { label: 'codex' })
    setSetting(h.ctx.db, LIMIT_FALLBACK_KEY, true)
    try {
      const { done } = await ask(h, alice, 'alice', (await newChat()).id, fake({ modelAny: 'hi' }), { ms: 30_000 })
      expect(done.content).toContain('codex answered')
      expect(seen.map((s) => s.key)).toEqual([LIMITED_KEY, 'openai'])
      // the next turn starts with the connection still at its limit: Codex again, the credit untouched
      seen.length = 0
      const next = await ask(h, alice, 'alice', (await newChat()).id, fake({ modelAny: 'hi' }), { ms: 30_000 })
      expect(next.done.content).toContain('codex answered')
      expect(seen.map((s) => s.key)).toEqual(['openai'])
      expect(orSeen).toEqual([])
      expect(hostedChatUsedUsd(h.ctx.db)).toBe(0)
    } finally { setSetting(h.ctx.db, LIMIT_FALLBACK_KEY, false) }
    // without the fallback the connection's limit stands (the team has its own AI, so the credit does not answer)
    seen.length = 0; launches.length = 0
    const r = await ask(h, alice, 'alice', (await newChat()).id, 'hi', { ms: 30_000 })
    expect(r.done.status).toBe('error')
    expect(r.done.error).toMatchObject({ code: 'rate_limited', params: { reason: 'rate_limit' } })
    expect(orSeen).toEqual([])
    expect(hostedChatUsedUsd(h.ctx.db)).toBe(0)
  })
  test('only ChatGPT / Codex connected, "다른 AI로 대신 답하기" on: a Claude Code chat is answered by Codex (a step says so), not by the credit, also once it is used up', async () => {
    grant()
    addCred(credentialsOf(h.ctx), 'openai-api-key', OKEY, { label: 'codex' })
    setSetting(h.ctx.db, LIMIT_FALLBACK_KEY, true)
    try {
      const chat = await newChat('claude-code', 'opus')
      for (const used of [false, true]) {
        if (used) chargeHostedChat(h.ctx.db, 1)
        seen.length = 0
        const { started, done } = await ask(h, alice, 'alice', chat.id, fake({ modelAny: 'hi' }), { ms: 30_000 })
        expect(done.status).toBe('done')
        expect(done.content).toContain('codex answered')
        expect(done.engine).toBe('codex')
        expect(done.steps.map((x: { label: string }) => x.label)).toContain('No AI connection for Claude Code; answering with Codex, which is connected')
        expect(seen.map((x) => x.key)).toEqual(['openai'])
        // a Claude model name means nothing to Codex: its default
        expect(turnRow(started.turnId)).toMatchObject({ engine: 'codex', model: null })
      }
      expect(orSeen).toEqual([])
      expect(hostedChatUsedUsd(h.ctx.db)).toBe(1)
      // the chat keeps its engine: a Claude connection added later answers it again
      expect((await h.api('alice').call(API.getChat, { params: { id: chat.id } })).engine).toBe('claude-code')
    } finally { setSetting(h.ctx.db, LIMIT_FALLBACK_KEY, false) }
  })
  test('no trial key at all (taken away, or the team\'s own server): the switch alone decides; off, the usual "no AI connection" and never the credit', async () => {
    addCred(credentialsOf(h.ctx), 'openai-api-key', OKEY, { label: 'codex' })
    const chat = await newChat('claude-code', 'opus')
    setSetting(h.ctx.db, LIMIT_FALLBACK_KEY, true)
    try {
      const { done } = await ask(h, alice, 'alice', chat.id, fake({ modelAny: 'hi' }), { ms: 30_000 })
      expect(done).toMatchObject({ status: 'done', engine: 'codex' })
      expect(done.content).toContain('codex answered')
    } finally { setSetting(h.ctx.db, LIMIT_FALLBACK_KEY, false) }
    seen.length = 0
    const off = await ask(h, alice, 'alice', chat.id, 'hi', { ms: 30_000 })
    expect(off.done.status).toBe('error')
    expect(off.done.error).toMatchObject({ params: { reason: 'no_credential' } })
    expect(seen).toEqual([])
    // the same with an active credit: the team has AI of its own, so the credit does not answer
    grant()
    const credit = await ask(h, alice, 'alice', chat.id, 'hi', { ms: 30_000 })
    expect(credit.done.error).toMatchObject({ params: { reason: 'no_credential' } })
    expect(orSeen).toEqual([])
  })
})

describe('the composer while the credit answers (GET /api/engines)', () => {
  test('Claude Code and Codex are offered while the credit is active, neither without it or once it is over', async () => {
    const engine = h.ctx.config.engine
    const was = engine.authMode
    engine.authMode = 'managed'
    try {
      const ids = async () => (await h.api('dana').call(API.chatEngines)).engines.map((e) => e.id).sort()
      expect(await ids()).toEqual([])
      grant()
      expect(await ids()).toEqual(['claude-code', 'codex'])
      grant({ enabled: false })
      expect(await ids()).toEqual([])
    } finally { engine.authMode = was }
  })
})

describe('the credit runs out', () => {
  test('used up or ended: its own error before anything runs', async () => {
    grant({ capUsd: 0.5 })
    chargeHostedChat(h.ctx.db, 0.5)
    const used = await ask(h, alice, 'alice', (await newChat()).id, 'hi', { ms: 30_000 })
    expect(used.done.status).toBe('error')
    expect(used.done.error).toMatchObject({ code: 'engine_unavailable', params: { reason: 'trial_credit_used' } })
    grant({ enabled: false })
    const ended = await ask(h, alice, 'alice', (await newChat('codex')).id, 'hi', { ms: 30_000 })
    expect(ended.done.error).toMatchObject({ code: 'engine_unavailable', params: { reason: 'trial_ended' } })
    expect(seen).toEqual([])
    expect(orSeen).toEqual([])
  })
  test('used up during an answer: the completion past the credit is not sent and the answer stops with "used"', async () => {
    grant({ capUsd: COST * 1.5 })
    script = [callTool('list', { path: 'shared' }), callTool('list', { path: 'shared' }), say('never')]
    const { done } = await ask(h, alice, 'alice', (await newChat()).id, 'list it twice', { ms: 30_000 })
    expect(done.status).toBe('error')
    expect(done.error).toMatchObject({ params: { reason: 'trial_credit_used' } })
    // the second completion went while some credit was left; the third was refused before it was sent
    expect(orSeen.length).toBe(2)
    expect(hostedChatHeldUsd(h.ctx.db)).toBe(0)
  })
  test('OpenRouter\'s limit on the key: "used"; the key refused: "ended" (and nothing goes out with it after)', async () => {
    grant()
    script = [() => Response.json({ error: { code: 403, message: 'Key limit exceeded: $5 of $5 used', metadata: { limit_source: 'openrouter_key_limit' } } }, { status: 403 })]
    const limited = await ask(h, alice, 'alice', (await newChat()).id, 'hi', { ms: 30_000 })
    expect(limited.done.error).toMatchObject({ code: 'engine_unavailable', params: { reason: 'trial_credit_used' } })
    script = [() => Response.json({ error: { code: 401, message: 'User not found.' } }, { status: 401 })]
    const refused = await ask(h, alice, 'alice', (await newChat()).id, 'hi', { ms: 30_000 })
    expect(refused.done.error).toMatchObject({ code: 'engine_unavailable', params: { reason: 'trial_ended' } })
    orSeen.length = 0
    const after = await ask(h, alice, 'alice', (await newChat()).id, 'hi', { ms: 30_000 })
    expect(after.done.error).toMatchObject({ params: { reason: 'trial_ended' } })
    expect(orSeen).toEqual([])
    expect(launches).toEqual([])
  })
})

describe('the onboarding paths on the trial credit', () => {
  test('a scheduled run (run now) answers on the API engine', async () => {
    grant()
    const s = h.rt().schedules.create('alice', { title: 'Morning digest', prompt: 'Summarise the week.', repeat: 'daily', time: '09:00' }, undefined, CONFIRMED)
    const r = await h.api('alice').call(API.runScheduleNow, { params: { id: s.id }, body: {} })
    await waitFor(() => (h.ctx.db.query("SELECT status FROM messages WHERE chat_id = ? AND role = 'assistant'").get(r.chatId) as { status: string } | null)?.status !== 'streaming', { timeoutMs: 30_000 })
    const answer = h.ctx.db.query("SELECT content, status, engine FROM messages WHERE chat_id = ? AND role = 'assistant'").get(r.chatId) as { content: string; status: string; engine: string }
    expect(answer).toMatchObject({ status: 'done', engine: 'claude-code' })
    expect(answer.content).toContain('trial answered')
    expect(orSeen[0]!.body.messages.at(-1)!.content).toContain('<scheduled_run title="Morning digest">')
    expect(launches).toEqual([])
  })
  test('a company profile draft: web_fetch on the typed site only, the JSON answer becomes the draft', async () => {
    grant()
    const json = JSON.stringify({ oneLine: 'Acme makes quiet desk fans.', products: 'Desk fans', audience: 'Small offices', tone: ['friendly'], avoid: '',
      sources: [{ field: 'oneLine', url: 'https://www.acme.co.kr/', excerpt: 'Acme makes quiet desk fans.' }] })
    script = [callTool('web_fetch', { url: 'https://evil.example/' }), callTool('web_fetch', { url: 'https://www.acme.co.kr/' }), say('```json\n' + json + '\n```')]
    const r = await h.api('carol').call(API.startProfileDraft, { body: { website: 'www.acme.co.kr' } })
    const s = await waitFor(async () => { const x = await h.api('carol').call(API.getProfileDraft, { params: { chatId: r.chatId } }); return x.status === 'running' ? null : x }, { timeoutMs: 30_000 }) as ProfileDraftState
    expect(s.status).toBe('done')
    expect(s.draft).toMatchObject({ website: 'https://www.acme.co.kr/', oneLine: 'Acme makes quiet desk fans.', products: 'Desk fans', tone: ['friendly'] })
    // its own instructions; web_fetch is its only web tool; the other site was refused, the typed one fetched
    expect(orSeen[0]!.body.messages[0]!.content).toContain('draft the team\'s company profile from the company website')
    const tools = (orSeen[0]!.body.tools ?? []).map((t) => t.function.name)
    expect(tools).toContain('web_fetch')
    expect(tools).not.toContain('web_search')
    expect(fetched).toEqual(['https://www.acme.co.kr/'])
    expect(JSON.stringify(orSeen[1]!.body.messages.at(-1))).toContain('Only pages of acme.co.kr')
    expect(launches).toEqual([])
  })
  test('a pack skill run from its form: the skill goes with the message', async () => {
    grant()
    const pack = installSkillPack(h.ctx, 'dana', 'work')
    const skill = pack.skills.find((x) => x.name === 'humanizer')!
    expect(skill).toBeTruthy()
    const body = fs.readFileSync(path.join(h.team, skill.path), 'utf8')
    // what SkillForm sends (web/src/lib/skillForm.ts composeSkillMessage): "/<name>" and one line per field
    const { done } = await ask(h, alice, 'alice', (await newChat()).id, '/humanizer\nText: Acme desk fan, quiet and small', { ms: 30_000 })
    expect(done.status).toBe('done')
    expect(done.model).toBe(HOSTED_CHAT_MODEL)
    const sent = orSeen[0]!.body.messages.at(-1)!.content!
    expect(sent).toContain('Text: Acme desk fan, quiet and small')
    // the skill's own instructions (a line from its body) reach the model
    const instructions = body.replace(/^---\n[\s\S]*?\n---\n/, '').trim()
    const line = instructions.split('\n').find((l) => l.trim().length > 30)!
    expect(line).toBeTruthy()
    expect(sent).toContain(line)
    expect(sent).toContain('<team_skill name="humanizer"')
    expect(launches).toEqual([])
  })
})

describe('GET /api/admin/trial-credit', () => {
  test('owner and admins: active, used of the cap, the end, the model; members cannot; null without a credit', async () => {
    const engine = h.ctx.config.engine
    const was = engine.authMode
    engine.authMode = 'managed' // the hosted servers that hold a trial credit answer with AI connections
    try {
      expect(await h.api('dana').call(API.trialCredit)).toEqual({ credit: null })
      const endsAt = new Date(Date.now() + 7 * 86400_000).toISOString()
      grant({ capUsd: 10, endsAt })
      chargeHostedChat(h.ctx.db, 2.5)
      for (const who of ['dana', 'carol']) {
        expect(await h.api(who).call(API.trialCredit)).toEqual({ credit: { active: true, state: 'active', usedUsd: 2.5, capUsd: 10, endsAt, model: HOSTED_CHAT_MODEL } })
      }
      const r = await h.req('alice', '/api/admin/trial-credit')
      expect(r.status).toBe(403)
      expect(await r.text()).not.toContain('TRIAL-TURN')
    } finally { engine.authMode = was }
    // a server whose engines use their own sign-in never uses it
    expect(await h.api('dana').call(API.trialCredit)).toEqual({ credit: null })
  })
})

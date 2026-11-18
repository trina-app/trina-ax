// What each kind of provider answer does to a turn and to the account's status (QA TC-4835, docs/decisions/
// 20261118-ai-account-failover.md). Four Claude subscription accounts like a real team: one already refused,
// one at its limit, one whose subscription ended (the provider answers 403 / a billing 400, never 401), one that
// works. The turn must go on to the account that works and mark the ended one, never stop with "account problem".
// Real launcher, fake engine (it reports an upstream error like Claude Code: "API Error: <status> <body>"), fake
// model service.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type CredentialKind } from '@mycel/shared/api'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { getRow, listRows } from '../../server/src/credentials/store'
import { setSetting } from '../../server/src/admin/settings'
import { SHARED_SUBSCRIPTIONS_KEY } from '../../server/src/credentials/policy'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const T = (n: number) => `sk-ant-oat01-TOK${n}` + 'x'.repeat(36)
const OKEY = 'sk-proj-' + 'O'.repeat(40)
type Mode = 'ok' | '401' | '429' | '403' | 'billing' | '500' | 'bad_request' | 'odd_auth'
let modes: Record<string, Mode> = {}
const hits: string[] = []
const enc = new TextEncoder()
const ev = (o: unknown) => enc.encode(`event: e\ndata: ${JSON.stringify(o)}\n\n`)
const err = (status: number, type: string, message: string, headers: Record<string, string> = {}) => Response.json({ type: 'error', error: { type, message } }, { status, headers })
const up = Bun.serve({
  port: 0, hostname: '127.0.0.1', idleTimeout: 0,
  async fetch(req) {
    await req.text()
    const tok = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '')
    hits.push(tok)
    const m = modes[tok] ?? 'ok'
    if (m === '401') return err(401, 'authentication_error', 'OAuth token has been revoked.')
    if (m === '429') return err(429, 'rate_limit_error', 'limit', { 'retry-after': '3600' })
    // what Anthropic answers for a Claude account whose subscription ended: the token still signs in, the account may not use Claude
    if (m === '403') return err(403, 'permission_error', 'OAuth authentication is currently not allowed for this organization.')
    if (m === 'billing') return err(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.')
    if (m === '500') return err(500, 'api_error', 'Internal server error')
    if (m === 'bad_request') return err(400, 'invalid_request_error', 'messages: at least one message is required')
    // a refusal the proxy does not know, which the engine reports as a sign-in problem
    if (m === 'odd_auth') return err(400, 'invalid_request_error', 'OAuth token does not meet scope requirement user:inference')
    return new Response(new ReadableStream<Uint8Array>({ start(c) {
      c.enqueue(ev({ type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 1 } } }))
      c.enqueue(ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `answer by ${tok.slice(13, 17)}` } }))
      c.enqueue(ev({ type: 'message_delta', usage: { output_tokens: 3 } }))
      c.close()
    } }), { headers: { 'content-type': 'text/event-stream' } })
  },
})
let h: Harness
let bob: TestSocket
beforeAll(async () => {
  const u = `http://127.0.0.1:${up.port}`
  h = await startHarness({
    name: 'b-cred-kinds', stallTimeoutMs: 60_000, upstreams: { anthropic: u, openai: u + '/v1' },
    // the order of use: 1 refused, 2 at its limit, 3 subscription ended, 4 works (and a Codex account, never a fallback here)
    credentials: [...[1, 2, 3, 4].map((n) => ({ kind: 'anthropic-oauth' as CredentialKind, secret: T(n), label: `C${n}`, priority: n * 10 })), { kind: 'openai-api-key' as CredentialKind, secret: OKEY, label: 'O', priority: 10 }],
  })
  setSetting(h.ctx.db, SHARED_SUBSCRIPTIONS_KEY, true)
  // a member, like the person who asked in the room's side chat
  bob = await h.ws('bob', { windowId: 'win-bob-kinds' }); await bob.next('hello')
})
afterAll(async () => { bob?.close(); await h?.close(); up.stop(true) })
const idOf = (label: string) => listRows(h.ctx.db).find((r) => r.label === label)!.id
const reset = () => { modes = {}; hits.length = 0; h.ctx.db.query("UPDATE engine_credentials SET status = 'ok', status_code = NULL, limited_until = NULL, disabled = 0").run() }
const newChat = () => h.api('bob').call(API.createChat, { body: { engine: 'claude-code' } })
const run = async () => (await ask(h, bob, 'bob', (await newChat()).id, fake({ modelAny: 'hi' }), { ms: 30_000 })).done
/** the team as the owner saw it: C1 refused, C2 at its limit (both already marked), C3's subscription ended (not marked yet) */
const ownerTeam = (c3: Mode) => {
  reset()
  h.ctx.db.query("UPDATE engine_credentials SET status = 'invalid', status_code = 'upstream_401' WHERE id = ?").run(idOf('C1'))
  h.ctx.db.query('UPDATE engine_credentials SET limited_until = ? WHERE id = ?').run(new Date(Date.now() + 3 * 3600_000).toISOString(), idOf('C2'))
  modes[T(3)] = c3
}

describe('the owner\'s team: refused, limited, subscription ended, healthy', () => {
  test('ended subscription (403): the turn goes on to the healthy account, the ended one is marked refused', async () => {
    ownerTeam('403')
    const done = await run()
    expect(done.status).toBe('done')
    expect(done.content).toContain('answer by TOK4')
    expect(hits).toEqual([T(3), T(4)])
    const c3 = getRow(h.ctx.db, idOf('C3'))!
    expect(c3.status).toBe('invalid')
    expect(c3.status_code).toBe('plan_ended')
    // the next turn skips it without trying it again
    hits.length = 0
    expect((await run()).content).toContain('answer by TOK4')
    expect(hits).toEqual([T(4)])
  })
  test('ended subscription (billing 400): the same', async () => {
    ownerTeam('billing')
    const done = await run()
    expect(done.status).toBe('done')
    expect(done.content).toContain('answer by TOK4')
    expect(getRow(h.ctx.db, idOf('C3'))!.status_code).toBe('plan_ended')
  })
})

describe('each kind of answer from the provider', () => {
  const firstFails = (m: Mode) => { reset(); modes[T(1)] = m }
  test('rejected (401): marked refused, the next account answers', async () => {
    firstFails('401')
    const done = await run()
    expect(done.content).toContain('answer by TOK2')
    expect(getRow(h.ctx.db, idOf('C1'))!.status).toBe('invalid')
  })
  test('limit (long 429): marked limited until its reset, the next account answers', async () => {
    firstFails('429')
    const done = await run()
    expect(done.content).toContain('answer by TOK2')
    const r = getRow(h.ctx.db, idOf('C1'))!
    expect(r.status).toBe('ok')
    expect(r.limited_until).not.toBeNull()
  })
  test('subscription ended (403): marked refused with its own reason, the next account answers', async () => {
    firstFails('403')
    const done = await run()
    expect(done.content).toContain('answer by TOK2')
    expect(getRow(h.ctx.db, idOf('C1'))!.status_code).toBe('plan_ended')
  })
  test('network / provider error (500): not the account\'s fault, nothing is marked, no switch', async () => {
    firstFails('500')
    const done = await run()
    expect(done.status).toBe('error')
    expect(hits.every((x) => x === T(1))).toBe(true)
    const r = getRow(h.ctx.db, idOf('C1'))!
    expect(r.status).toBe('ok')
    expect(r.limited_until).toBeNull()
  })
  test('an unknown request error (400, not billing): the request\'s fault, nothing is marked, no switch', async () => {
    firstFails('bad_request')
    const done = await run()
    expect(done.status).toBe('error')
    expect(hits.every((x) => x === T(1))).toBe(true)
    expect(getRow(h.ctx.db, idOf('C1'))!.status).toBe('ok')
  })
  test('a refusal the proxy does not know but the engine calls a sign-in problem: the next account answers, nothing is marked', async () => {
    firstFails('odd_auth')
    const done = await run()
    expect(done.status).toBe('done')
    expect(done.content).toContain('answer by TOK2')
    expect(getRow(h.ctx.db, idOf('C1'))!.status).toBe('ok')
  })
})

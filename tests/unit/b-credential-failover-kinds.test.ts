// What each kind of provider answer does to a turn and to the account's status (QA TC-4835, docs/decisions/
// 20261118-ai-account-failover.md). Four Claude subscription accounts like a real team: one already refused,
// one at its limit, one whose subscription ended (the provider answers 403 / a billing 400, never 401), one that
// works. The turn must go on to the account that works and mark the ended one, never stop with "account problem".
// Real launcher, fake engine (it reports an upstream error like Claude Code: "API Error: <status> <body>"), fake
// model service.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type CredentialKind } from '@mycel/shared/api'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { credentialsOf, getRow, listRows } from '../../server/src/credentials/store'
import { setSetting } from '../../server/src/admin/settings'
import { SHARED_SUBSCRIPTIONS_KEY } from '../../server/src/credentials/policy'
import { LIMIT_FALLBACK_KEY } from '../../server/src/admin/engine-choice'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const T = (n: number) => `sk-ant-oat01-TOK${n}` + 'x'.repeat(36)
const AKEY = 'sk-ant-api03-AKEY' + 'x'.repeat(36)
const OKEY = 'sk-proj-' + 'O'.repeat(40)
type Mode = 'ok' | '401' | '401ok' | '403blockedok' | '429' | '403plan' | '403region' | 'cf403' | 'noreqid403' | 'billing400' | 'billing402' | 'sub400' | '500' | 'bad_request' | 'authish400'
let modes: Record<string, Mode> = {}
const hits: string[] = []
/** the free checks (count_tokens, GET /models) the proxy made, by token (credentials/confirm.ts) */
const checks: string[] = []
const enc = new TextEncoder()
const ev = (o: unknown) => enc.encode(`event: e\ndata: ${JSON.stringify(o)}\n\n`)
let reqN = 0
/** Anthropic's error answer: its JSON shape and a request-id header */
const err = (status: number, type: string, message: string, headers: Record<string, string> = {}) =>
  Response.json({ type: 'error', error: { type, message } }, { status, headers: { 'request-id': `req_011CTest${++reqN}`, ...headers } })
const up = Bun.serve({
  port: 0, hostname: '127.0.0.1', idleTimeout: 0,
  async fetch(req) {
    await req.text()
    const tok = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '') || (req.headers.get('x-api-key') ?? '')
    const check = /\/count_tokens$|\/models$/.test(new URL(req.url).pathname)
    ;(check ? checks : hits).push(tok)
    const m = modes[tok] ?? 'ok'
    if (check && (m === '401ok' || m === '403blockedok')) return Response.json({ input_tokens: 3 })
    if (m === '401' || m === '401ok') return err(401, 'authentication_error', 'OAuth token has been revoked.')
    if (m === '403blockedok') return err(403, 'permission_error', 'OAuth authentication is currently not allowed for this organization.')
    if (m === '429') return err(429, 'rate_limit_error', 'limit', { 'retry-after': '3600' })
    // what Anthropic answers for a Claude account whose subscription ended: the token still signs in, the account may not use Claude
    if (m === '403plan') return err(403, 'permission_error', 'OAuth authentication is currently not allowed for this organization.')
    if (m === '403region') return err(403, 'permission_error', 'Request not allowed')
    if (m === 'cf403') return new Response('<html><head><title>Attention Required! | Cloudflare</title></head><body>blocked</body></html>', { status: 403, headers: { 'content-type': 'text/html' } })
    if (m === 'noreqid403') return Response.json({ type: 'error', error: { type: 'permission_error', message: 'This organization has been disabled.' } }, { status: 403 })
    if (m === 'billing400') return err(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.')
    if (m === 'billing402') return err(402, 'billing_error', 'Payment required.')
    if (m === 'sub400') return err(400, 'invalid_request_error', 'Extended thinking is not included in your subscription for this model.')
    if (m === '500') return err(500, 'api_error', 'Internal server error')
    if (m === 'bad_request') return err(400, 'invalid_request_error', 'messages: at least one message is required')
    // a refusal the proxy does not read, which the engine reports as a sign-in problem
    if (m === 'authish400') return err(400, 'authentication_error', 'Token rejected for this request.')
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
    credentials: [...[1, 2, 3, 4].map((n) => ({ kind: 'anthropic-oauth' as CredentialKind, secret: T(n), label: `C${n}`, priority: n * 10 })),
      { kind: 'anthropic-api-key' as CredentialKind, secret: AKEY, label: 'A', priority: 90 }, { kind: 'openai-api-key' as CredentialKind, secret: OKEY, label: 'O', priority: 10 }],
  })
  setSetting(h.ctx.db, SHARED_SUBSCRIPTIONS_KEY, true)
  // a member, like the person who asked in the room's side chat
  bob = await h.ws('bob', { windowId: 'win-bob-kinds' }); await bob.next('hello')
})
afterAll(async () => { bob?.close(); await h?.close(); up.stop(true) })
const idOf = (label: string) => listRows(h.ctx.db).find((r) => r.label === label)!.id
const reset = () => {
  modes = {}; hits.length = 0; checks.length = 0
  ;(credentialsOf(h.ctx).extra.confirm as { passedAt?: Map<string, number> } | undefined)?.passedAt?.clear()
  h.ctx.db.query("UPDATE engine_credentials SET status = 'ok', status_code = NULL, limited_until = NULL, disabled = 0").run()
  // the API key answers only in its own test
  h.ctx.db.query("UPDATE engine_credentials SET disabled = 1 WHERE kind = 'anthropic-api-key'").run()
}
const unmarked = (label: string) => { const r = getRow(h.ctx.db, idOf(label))!; expect([r.status, r.status_code, r.limited_until]).toEqual(['ok', null, null]) }
const newChat = () => h.api('bob').call(API.createChat, { body: { engine: 'claude-code' } })
const run = async (...ds: unknown[]) => (await ask(h, bob, 'bob', (await newChat()).id, fake(...(ds.length ? ds : [{ modelAny: 'hi' }])), { ms: 30_000 })).done
/** the team as the owner saw it: C1 refused, C2 at its limit (both already marked), C3's subscription ended (not marked yet) */
const ownerTeam = (c3: Mode) => {
  reset()
  h.ctx.db.query("UPDATE engine_credentials SET status = 'invalid', status_code = 'upstream_401' WHERE id = ?").run(idOf('C1'))
  h.ctx.db.query('UPDATE engine_credentials SET limited_until = ? WHERE id = ?').run(new Date(Date.now() + 3 * 3600_000).toISOString(), idOf('C2'))
  modes[T(3)] = c3
}

describe('the owner\'s team: refused, limited, subscription ended, healthy', () => {
  test('ended subscription (403): the turn goes on to the healthy account, the ended one is marked refused', async () => {
    ownerTeam('403plan')
    const done = await run()
    expect(done.status).toBe('done')
    expect(done.content).toContain('answer by TOK4')
    expect(hits).toEqual([T(3), T(4)])
    const c3 = getRow(h.ctx.db, idOf('C3'))!
    expect(c3.status).toBe('invalid')
    // the org-not-allowed answer has its own code (it can pass), confirmed by one free check, and the answer is kept
    expect(c3.status_code).toBe('org_oauth_blocked')
    expect(checks).toEqual([T(3)])
    const shown = (await h.api('dana').call(API.listCredentials, {})).items.find((x) => x.label === 'C3')!
    expect(shown.providerError).toMatchObject({ status: 403, type: 'permission_error', message: 'OAuth authentication is currently not allowed for this organization.' })
    expect(shown.detail).toMatch(/플랜이나 조직/)
    // the next turn skips it without trying it again
    hits.length = 0
    expect((await run()).content).toContain('answer by TOK4')
    expect(hits).toEqual([T(4)])
  })
  test('ended subscription (billing 400 with the exact credit phrase): the same', async () => {
    ownerTeam('billing400')
    const done = await run()
    expect(done.status).toBe('done')
    expect(done.content).toContain('answer by TOK4')
    expect(getRow(h.ctx.db, idOf('C3'))!.status_code).toBe('plan_ended')
  })
  test('ended subscription (402 billing_error): the same', async () => {
    ownerTeam('billing402')
    const done = await run()
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
  test('organization not allowed (known 403, the same account as before): confirmed and marked org_oauth_blocked, the next account answers', async () => {
    // C3 again: a 403 of another account within minutes would count as this server's problem (below)
    reset(); h.ctx.db.query("UPDATE engine_credentials SET disabled = 1 WHERE label IN ('C1', 'C2')").run(); modes[T(3)] = '403plan'
    const done = await run()
    expect(done.content).toContain('answer by TOK4')
    expect(getRow(h.ctx.db, idOf('C3'))!.status_code).toBe('org_oauth_blocked')
  })
  test('a 401 whose free check passes: not marked, the engine is asked to retry (529); a 401 again marks it and the turn moves on', async () => {
    firstFails('401ok')
    const first = await run()
    expect(checks).toEqual([T(1)])
    expect(hits).toEqual([T(1)])
    expect(first.content ?? '').not.toContain('answer by')
    unmarked('C1')
    // refused again after the check passed: marked without another check, the next account answers
    hits.length = 0; checks.length = 0
    const second = await run()
    expect(second.content).toContain('answer by TOK2')
    expect(checks).toEqual([])
    const c1 = getRow(h.ctx.db, idOf('C1'))!
    expect([c1.status, c1.status_code]).toEqual(['invalid', 'upstream_401'])
  })
  test('an account-level 403 whose free check passes: not marked either', async () => {
    reset(); h.ctx.db.query("UPDATE engine_credentials SET disabled = 1 WHERE label IN ('C1', 'C2')").run(); modes[T(3)] = '403blockedok'
    await run()
    expect(checks).toEqual([T(3)])
    unmarked('C3')
  })
  test('another 403 from Anthropic (a region): skipped in this turn, nothing marked', async () => {
    firstFails('403region')
    const done = await run()
    expect(done.content).toContain('answer by TOK2')
    unmarked('C1')
    // the next turn tries it again (nothing was marked)
    hits.length = 0; await run()
    expect(hits[0]).toBe(T(1))
  })
  test('a Cloudflare HTML 403, or a 403 without request-id: not Anthropic\'s answer, nothing marked, no switch', async () => {
    for (const m of ['cf403', 'noreqid403'] as const) {
      firstFails(m)
      const done = await run()
      expect(done.status).toBe('error')
      expect(hits.every((x) => x === T(1))).toBe(true)
      unmarked('C1')
    }
  })
  test('a 400 that mentions a subscription but is no billing error: nothing marked, no switch', async () => {
    firstFails('sub400')
    const done = await run()
    expect(done.status).toBe('error')
    expect(hits.every((x) => x === T(1))).toBe(true)
    unmarked('C1')
  })
  test('network / provider error (500): not the account\'s fault, nothing is marked, no switch', async () => {
    firstFails('500')
    const done = await run()
    expect(done.status).toBe('error')
    expect(hits.every((x) => x === T(1))).toBe(true)
    unmarked('C1')
  })
  test('an unknown request error (400, not billing): the request\'s fault, nothing is marked, no switch', async () => {
    firstFails('bad_request')
    const done = await run()
    expect(done.status).toBe('error')
    expect(hits.every((x) => x === T(1))).toBe(true)
    unmarked('C1')
  })
  test('an API key out of credit: held as "out of credit", never a rate limit, no Codex fallback', async () => {
    reset()
    h.ctx.db.query("UPDATE engine_credentials SET disabled = CASE WHEN kind = 'anthropic-api-key' THEN 0 ELSE 1 END WHERE kind != 'openai-api-key'").run()
    modes[AKEY] = 'billing400'
    setSetting(h.ctx.db, LIMIT_FALLBACK_KEY, true)
    try {
      const done = await run()
      expect(done.status).toBe('error')
      expect(done.error?.code).not.toBe('rate_limited')
      expect(hits).not.toContain(OKEY)
      const r = getRow(h.ctx.db, idOf('A'))!
      expect([r.status, r.status_code]).toEqual(['ok', 'out_of_credit'])
      expect(r.limited_until).not.toBeNull()
      const c = (await h.api('dana').call(API.listCredentials, {})).items.find((x) => x.label === 'A')!
      expect(c.state).toBe('no_credit')
      expect(c.detail).toMatch(/크레딧/)
      // Re-check after adding credit (the provider takes the key): the hold ends, never a bare limit left behind
      modes[AKEY] = 'ok'
      const checked = await h.api('dana').call(API.checkCredential, { params: { id: idOf('A') } })
      expect(checked.state).toBe('ok')
      const after = getRow(h.ctx.db, idOf('A'))!
      expect([after.status_code, after.limited_until]).toEqual([null, null])
      hits.length = 0
      expect((await run()).content).toContain('answer by AKEY')
    } finally { setSetting(h.ctx.db, LIMIT_FALLBACK_KEY, false) }
  })
})

describe('the turn-side skip', () => {
  test('a refusal the proxy does not read but the engine calls a sign-in problem: the next account answers, nothing is marked', async () => {
    reset(); modes[T(1)] = 'authish400'
    const done = await run()
    expect(done.status).toBe('done')
    expect(done.content).toContain('answer by TOK2')
    unmarked('C1')
  })
  test('the skip path keeps the two-switch cap', async () => {
    reset(); modes[T(1)] = '403region'; modes[T(2)] = 'authish400'; modes[T(3)] = '403region'
    const done = await run()
    expect(done.status).toBe('error')
    expect(hits).toEqual([T(1), T(2), T(3)]) // C4 never tried in this turn
    expect(done.steps.filter((s) => s.tool === 'engine').length).toBe(2)
    for (const l of ['C1', 'C2', 'C3']) unmarked(l)
  })
  test('a tool already ran in the attempt: no switch after a sign-in error or an unexplained 403 (the tool never runs twice)', async () => {
    for (const m of ['authish400', '403region'] as const) {
      reset(); modes[T(1)] = m
      const done = await run({ tool: 'list', args: { path: '/' } }, { modelAny: 'hi' })
      expect(done.status).toBe('error')
      expect(hits).toEqual([T(1)])
      unmarked('C1')
    }
  })
  test('two different accounts refused with a known 403 within minutes: this server\'s problem, the second is not marked', async () => {
    // its own first 403 (C1: marked when this test runs alone, only skipped after the C3 tests above), then C2's within
    // the same minutes: C2 is never marked
    reset(); modes[T(1)] = '403plan'; modes[T(2)] = '403plan'
    const done = await run()
    expect(done.content).toContain('answer by TOK3')
    expect(hits).toEqual([T(1), T(2), T(3)])
    unmarked('C2')
  })
  test('the proxy\'s own refusal (its forwarding rules) with Claude Code\'s "Failed to authenticate" wording: the safety stop, no switch, nothing marked', async () => {
    reset()
    const done = await run({ model: 'hi', modelExtra: { mcp_servers: [{ type: 'url', url: 'https://mcp.example.com', name: 'x' }] }, cliAuthText: true })
    expect(done.status).toBe('error')
    expect(done.error?.params?.reason).toBe('lockdown')
    expect(hits).toEqual([]) // nothing went to the model service
    expect(done.steps.filter((s) => s.tool === 'engine').length).toBe(0)
    for (const l of ['C1', 'C2', 'C3', 'C4']) unmarked(l)
  })
})

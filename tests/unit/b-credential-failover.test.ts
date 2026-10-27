// A turn whose AI connection is refused or hits its limit (docs/DECISIONS.md "AI 연결" D15): the turn goes on with the
// next connection of the same engine (a step and an audit entry say so; at most twice; a fresh session, never the
// other account's), then — only when the admin turned it on and the person has a Codex connection — Codex answers,
// else the answer ends with the time it can be used again. Real launcher, fake engines, fake model services.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type CredentialKind } from '@mycel/shared/api'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { getRow, listRows } from '../../server/src/credentials/store'
import { setSetting } from '../../server/src/admin/settings'
import { LIMIT_FALLBACK_KEY } from '../../server/src/admin/engine-choice'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const K = (n: number) => `sk-ant-api03-KEY${n}` + 'x'.repeat(36)
const OKEY = 'sk-proj-' + 'O'.repeat(40)
let modes: Record<string, 'ok' | '429' | '401'> = {}
const hits: string[] = []
const enc = new TextEncoder()
const ev = (o: unknown) => enc.encode(`event: e\ndata: ${JSON.stringify(o)}\n\n`)
const up = Bun.serve({
  port: 0, hostname: '127.0.0.1', idleTimeout: 0,
  async fetch(req) {
    const u = new URL(req.url)
    await req.text()
    if (u.pathname.endsWith('/responses')) {
      hits.push('openai')
      return new Response(`event: x\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'codex answered' })}\n\nevent: x\ndata: ${JSON.stringify({ type: 'response.completed', response: { model: 'gpt-5.4', output: [], usage: { input_tokens: 5, output_tokens: 2 } } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    }
    const key = req.headers.get('x-api-key') ?? ''
    hits.push(key)
    const m = modes[key] ?? 'ok'
    if (m === '429') return Response.json({ type: 'error', error: { type: 'rate_limit_error', message: 'limit' } }, { status: 429, headers: { 'retry-after': '3600' } })
    if (m === '401') return Response.json({ type: 'error', error: { type: 'authentication_error', message: 'bad key' } }, { status: 401 })
    return new Response(new ReadableStream<Uint8Array>({ start(c) {
      c.enqueue(ev({ type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 1 } } }))
      c.enqueue(ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `answer by ${key.slice(13, 17)}` } }))
      c.enqueue(ev({ type: 'message_delta', usage: { output_tokens: 3 } }))
      c.close()
    } }), { headers: { 'content-type': 'text/event-stream' } })
  },
})
let h: Harness
let alice: TestSocket
beforeAll(async () => {
  const u = `http://127.0.0.1:${up.port}`
  h = await startHarness({
    name: 'b-cred-failover', turnTimeoutMs: 60_000, upstreams: { anthropic: u, openai: u + '/v1' },
    credentials: [...[1, 2, 3, 4].map((n) => ({ kind: 'anthropic-api-key' as CredentialKind, secret: K(n), label: `K${n}`, priority: n * 10 })), { kind: 'openai-api-key' as CredentialKind, secret: OKEY, label: 'O', priority: 10 }],
  })
  alice = await h.ws('alice', { windowId: 'win-alice-fo' }); await alice.next('hello')
})
afterAll(async () => { alice?.close(); await h?.close(); up.stop(true) })
const idOf = (label: string) => listRows(h.ctx.db).find((r) => r.label === label)!.id
const reset = () => { modes = {}; hits.length = 0; h.ctx.db.query("UPDATE engine_credentials SET status = 'ok', status_code = NULL, limited_until = NULL, disabled = 0").run() }
const newChat = () => h.api('alice').call(API.createChat, { body: { engine: 'claude-code' } })

describe('switching connections inside a turn', () => {
  test('the first connection at its limit: the next one answers, with a step, a notice and an audit entry', async () => {
    reset()
    modes[K(1)] = '429'
    const { started, done } = await ask(h, alice, 'alice', (await newChat()).id, fake({ modelAny: 'hi' }), { ms: 30_000 })
    expect(done.status).toBe('done')
    expect(done.content).toContain('answer by KEY2')
    expect(hits).toEqual([K(1), K(2)])
    expect(done.steps.some((s) => s.tool === 'engine' && /another AI connection|다른 AI 연결/.test(s.label))).toBe(true)
    await alice.next('notice', (f) => f.data.code === 'engine_credential_switch', 5000)
    const a = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'engine.credential_switch' AND target = ?").get(started.turnId) as { detail: string }
    expect(JSON.parse(a.detail)).toEqual({ from: idOf('K1'), to: idOf('K2'), reason: 'limited' })
    expect(getRow(h.ctx.db, idOf('K1'))!.limited_until).not.toBeNull()
    // the turn's usage stays with the connection that answered
    expect((h.ctx.db.query('SELECT credential_id FROM turns WHERE id = ?').get(started.turnId) as { credential_id: string }).credential_id).toBe(idOf('K2'))
  })
  test('a refused key: marked refused, the next one answers', async () => {
    reset()
    modes[K(1)] = '401'
    const { done } = await ask(h, alice, 'alice', (await newChat()).id, fake({ modelAny: 'hi' }), { ms: 30_000 })
    expect(done.content).toContain('answer by KEY2')
    expect(getRow(h.ctx.db, idOf('K1'))!.status).toBe('invalid')
    expect(done.steps.some((s) => s.tool === 'engine' && /refused|거절/.test(s.label))).toBe(true)
  })
  test('at most two switches per turn, then the limit error with the time it resets', async () => {
    reset()
    modes[K(1)] = '429'; modes[K(2)] = '429'; modes[K(3)] = '429'
    const { done } = await ask(h, alice, 'alice', (await newChat()).id, fake({ modelAny: 'hi' }), { ms: 30_000 })
    expect(done.status).toBe('error')
    expect(done.error?.code).toBe('rate_limited')
    expect(hits).toEqual([K(1), K(2), K(3)]) // K4 never tried in this turn
    expect(done.steps.filter((s) => s.tool === 'engine').length).toBe(2)
    // the next turn starts on the one that still works
    hits.length = 0
    const next = await ask(h, alice, 'alice', (await newChat()).id, fake({ modelAny: 'hi' }), { ms: 30_000 })
    expect(next.done.content).toContain('answer by KEY4')
    expect(hits).toEqual([K(4)])
  })
  test('every Claude connection at its limit and the admin\'s fallback on: Codex answers (it has a connection)', async () => {
    reset()
    for (const n of [1, 2, 3, 4]) modes[K(n)] = '429'
    setSetting(h.ctx.db, LIMIT_FALLBACK_KEY, true)
    try {
      const { done } = await ask(h, alice, 'alice', (await newChat()).id, fake({ modelAny: 'hi' }), { ms: 30_000 })
      expect(done.status).toBe('done')
      expect(done.content).toContain('codex answered')
      expect(hits.at(-1)).toBe('openai')
      // without a Codex connection the fallback does not happen: the limit error stays
      h.ctx.db.query("UPDATE engine_credentials SET disabled = 1 WHERE kind = 'openai-api-key'").run()
      const r = await ask(h, alice, 'alice', (await newChat()).id, fake({ modelAny: 'hi' }), { ms: 30_000 })
      expect(r.done.error?.code).toBe('rate_limited')
    } finally { setSetting(h.ctx.db, LIMIT_FALLBACK_KEY, false) }
  })
  test('no connection at all for the engine: a clear error before any engine runs', async () => {
    reset()
    h.ctx.db.query("UPDATE engine_credentials SET disabled = 1 WHERE kind = 'anthropic-api-key'").run()
    const { done } = await ask(h, alice, 'alice', (await newChat()).id, fake({ modelAny: 'hi' }), { ms: 30_000 })
    expect(done.status).toBe('error')
    expect(done.error?.code).toBe('engine_unavailable')
    expect(hits).toEqual([])
    reset()
  })
})

// QA on the real engines, 2026-10-30, end to end with the real launcher and the scripted engines (tests/lib/b-fake-engine.ts):
//   B2  a Codex turn on a ChatGPT sign-in is counted by the model proxy (the connection's tokens, requests and "last
//       used"), though chatgpt.com sends its event stream with no content-type and Codex 0.163 hangs up at
//       response.completed
//   B4  Codex's background calls on every ChatGPT turn (accounts/check, settings/user) leave no warning
//   B5  the Stop button, on either engine, while a request waits for the model: the turn is "stopped" without an
//       error, the upstream request is cancelled, the log says it was the person's stop (never "the model service
//       could not be reached"), and nothing is counted or marked against the AI connection
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { addCred, chatgptSecret, fakeJwt } from '../lib/credentials'
import { waitFor } from '../lib/wait'
import { createLogger } from '../../server/src/log'
import { setSetting } from '../../server/src/admin/settings'
import { SHARED_SUBSCRIPTIONS_KEY } from '../../server/src/credentials/policy'
import { credentialsOf, getRow, listRows } from '../../server/src/credentials/store'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const KEY = 'sk-ant-api03-STOP' + 'x'.repeat(36)
const enc = new TextEncoder()

// ---------------- fake model services ----------------
let hold = false
let holding = 0
let aborted = 0
const ev = (o: { type: string; [k: string]: unknown }) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`
const USAGE = { input_tokens: 9277, input_tokens_details: { cached_tokens: 8960 }, output_tokens: 31, output_tokens_details: { reasoning_tokens: 12 }, total_tokens: 9308 }
const msg = { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hi there', annotations: [] }] }
const up = Bun.serve({
  port: 0, hostname: '127.0.0.1', idleTimeout: 0,
  async fetch(req) {
    const u = new URL(req.url)
    await req.text()
    if (hold) {
      holding++
      await new Promise<void>((r) => req.signal.addEventListener('abort', () => { aborted++; r() }))
      return new Response(null, { status: 499 })
    }
    if (u.pathname === '/backend-api/codex/responses') {
      // as chatgpt.com answers: named events, usage only in response.completed, no content-type; the end a moment later
      return new Response(new ReadableStream<Uint8Array>({
        async start(c) {
          c.enqueue(enc.encode(ev({ type: 'response.created', response: { id: 'resp_1', status: 'in_progress', model: 'gpt-5.4', output: [], usage: null } })
            + ev({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'hi' })))
          await Bun.sleep(20)
          c.enqueue(enc.encode(ev({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: ' there' })
            + ev({ type: 'response.output_item.done', output_index: 0, item: msg })
            + ev({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', model: 'gpt-5.4-2026-03-05', output: [msg], usage: USAGE } })))
          await Bun.sleep(300)
          try { c.close() } catch {}
        },
      }))
    }
    return new Response(ev({ type: 'message_start', message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 10, output_tokens: 1 } } })
      + ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'claude answered' } })
      + ev({ type: 'message_delta', usage: { output_tokens: 3 } }), { headers: { 'content-type': 'text/event-stream' } })
  },
})

const lines: Record<string, unknown>[] = []
const proxyLines = () => lines.filter((l) => l.c === 'model-proxy')
let h: Harness
let alice: TestSocket
let G = ''
let K = ''
beforeAll(async () => {
  const u = `http://127.0.0.1:${up.port}`
  h = await startHarness({
    name: 'b-proxy-usage-stop', turnTimeoutMs: 60_000, upstreams: { anthropic: u, chatgpt: u + '/backend-api/codex' },
    credentials: [{ kind: 'anthropic-api-key', secret: KEY, label: 'Team key' }],
    log: createLogger({ level: 'debug', sink: (l) => { try { lines.push(JSON.parse(l)) } catch {} } }),
  })
  setSetting(h.ctx.db, SHARED_SUBSCRIPTIONS_KEY, true)
  G = addCred(credentialsOf(h.ctx), 'chatgpt', chatgptSecret('acc-1', { access: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }) }), { label: 'Team ChatGPT', plan: 'pro' })
  K = listRows(h.ctx.db).find((r) => r.kind === 'anthropic-api-key')!.id
  alice = await h.ws('alice', { windowId: 'win-alice-qa' }); await alice.next('hello')
})
afterAll(async () => { alice?.close(); await h?.close(); up.stop(true) })

const days = (id: string) => h.ctx.db.query('SELECT requests, input_tokens, output_tokens FROM credential_usage_daily WHERE credential_id = ?').all(id)
const newChat = (engine: 'claude-code' | 'codex') => h.api('alice').call(API.createChat, { body: { engine } })

describe('B2 / B4: a Codex turn on a ChatGPT sign-in', () => {
  test('counted by the proxy on the connection (tokens, requests, last used); no warning for its background calls', async () => {
    lines.length = 0
    expect(getRow(h.ctx.db, G)!.last_used_at).toBeNull()
    const { started, done } = await ask(h, alice, 'alice', (await newChat('codex')).id, fake({ codexBackground: true }, { codexModel: 'hi' }), { ms: 30_000 })
    expect(done.status).toBe('done')
    expect(done.content).toBe('background=404,404,404hi there')
    // the proxy's numbers, not the engine's own report (the fake reports 100 / 20 at the end)
    expect(h.ctx.db.query('SELECT credential_id, input_tokens, output_tokens, usage_source FROM turns WHERE id = ?').get(started.turnId))
      .toEqual({ credential_id: G, input_tokens: 9277, output_tokens: 31, usage_source: 'proxy' })
    expect(days(G)).toEqual([{ requests: 1, input_tokens: 9277, output_tokens: 31 }])
    expect(getRow(h.ctx.db, G)!.last_used_at).not.toBeNull()
    // what Admin > AI connections shows
    const list = await h.api('dana').call(API.listCredentials, {})
    const row = list.items.find((c) => c.id === G)!
    expect(row.month).toEqual({ usd: 0, tokens: 9277 + 31, requests: 1 })
    expect(row.lastUsedAt).not.toBeNull()
    expect(proxyLines().filter((l) => l.level === 'warn')).toEqual([])
    expect(proxyLines().filter((l) => l.msg === 'model proxy: answered here').map((l) => l.path)).toEqual([
      '/codex/backend/api/codex/accounts/check', '/codex/backend/api/codex/settings/user', '/codex/backend/api/codex/accounts/check'])
  })
})

describe('B5: Stop while a request waits for the model', () => {
  for (const engine of ['claude-code', 'codex'] as const) {
    test(`${engine}: stopped, no error; the upstream request cancelled; logged as the person's stop; nothing counted`, async () => {
      const cred = engine === 'codex' ? G : K
      const before = days(cred)
      const auditBefore = (h.ctx.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'proxy.%'").get() as { n: number }).n
      lines.length = 0; holding = 0; aborted = 0; hold = true
      try {
        const chat = await newChat(engine)
        const r = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ modelAny: 'wait' }), clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
        expect(await waitFor(() => holding === 1, { timeoutMs: 20_000 })).toBe(true)
        expect((await h.api('alice').call(API.stop, { params: { id: chat.id } })).stopped).toBe(true)
        const done = await alice.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
        expect(done.data.status).toBe('stopped')
        expect(done.data.message.error ?? null).toBeNull()
        expect(await waitFor(() => aborted === 1, { timeoutMs: 10_000 })).toBe(true)
        const path = engine === 'codex' ? '/codex/chatgpt/responses' : '/v1/messages'
        expect(await waitFor(() => proxyLines().some((l) => l.msg === 'model proxy: request ended by a stop'), { timeoutMs: 5000 })).toBe(true)
        expect(proxyLines().map(({ level, msg, path: p, turn, by }) => ({ level, msg, path: p, turn, by }))).toEqual([
          { level: 'info', msg: 'model proxy: request ended by a stop', path, turn: r.turnId, by: 'person' }])
        expect(JSON.stringify(lines)).not.toContain('could not be reached')
        expect(h.ctx.db.query('SELECT status, error FROM turns WHERE id = ?').get(r.turnId)).toEqual({ status: 'stopped', error: null })
        // the AI connection: nothing counted, nothing marked, nothing refused
        expect(days(cred)).toEqual(before)
        expect(getRow(h.ctx.db, cred)).toMatchObject({ status: 'ok', status_code: null, limited_until: null })
        expect((h.ctx.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'proxy.%'").get() as { n: number }).n).toBe(auditBefore)
      } finally { hold = false }
    })
  }
})

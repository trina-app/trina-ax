// The model proxy with several AI connections (docs/DECISIONS.md "AI 연결" D3/D14): a request's credential comes
// only from its token's binding, never from what the engine sends; one connection's 401 / long 429 stays with that
// connection (and survives a proxy restart); a connection switched off or removed during a turn stops the next
// request; a turn's token is useless to another process (peer check) and to the other family's path.
// S-4, S-6, S-14, S-15, S-16.
import { afterAll, describe, expect, test } from 'bun:test'
import net from 'node:net'
import path from 'node:path'
import { makeEnv } from '../lib/env'
import { addCred, testCredCtx } from '../lib/credentials'
import { issueProxyToken, startModelProxy, type ProxyTurnEvent } from '../../server/src/proxy/model-proxy'
import { createBroker } from '../../server/src/credentials/broker'
import { getRow } from '../../server/src/credentials/store'

const env = makeEnv('proxy-credentials')
const KEY_A = 'sk-ant-api03-' + 'A'.repeat(40)
const KEY_B = 'sk-ant-api03-' + 'B'.repeat(40)
let mode: Record<string, 'ok' | '401' | '429long'> = {}
const seen: { key: string; turn: string }[] = []
const upstream = Bun.serve({
  port: 0, hostname: '127.0.0.1',
  async fetch(req) {
    const key = req.headers.get('x-api-key') ?? ''
    const body = await req.json() as { messages: { content: string }[] }
    seen.push({ key, turn: body.messages[0]!.content })
    const m = mode[key] ?? 'ok'
    if (m === '401') return Response.json({ type: 'error', error: { type: 'authentication_error' } }, { status: 401 })
    if (m === '429long') return Response.json({ type: 'error', error: { type: 'rate_limit_error' } }, { status: 429, headers: { 'retry-after': '7200' } })
    return Response.json({ id: 'm', model: 'claude-sonnet-5-5', content: [], usage: { input_tokens: 10, output_tokens: 2 } })
  },
})
for (const [id, user] of [['tA', 'alice'], ['tB', 'bob']]) env.db.query("INSERT INTO turns (id, chat_id, user_id, engine, status) VALUES (?, 'c', ?, 'claude-code', 'running')").run(id, user)
const t = testCredCtx(env.db, path.join(env.fx.data, 'secrets'), { upstreams: { anthropic: `http://127.0.0.1:${upstream.port}` } })
const CA = addCred(t.cc, 'anthropic-api-key', KEY_A, { label: 'A' })
const CB = addCred(t.cc, 'anthropic-api-key', KEY_B, { label: 'B' })
const events: { turn: string; ev: ProxyTurnEvent }[] = []
// the TCP peer of a request belongs to this turn's engine session (the launcher's answer, simulated)
let callerTurn: string | null = null
const proxy = await startModelProxy({ db: env.db, broker: createBroker(t.cc), onTurnEvent: (turn, ev) => events.push({ turn, ev }), peerCheck: async (_c, _s, turnId) => callerTurn === null || callerTurn === turnId })
afterAll(async () => { await proxy.stop(); upstream.stop(true) })

const tok = (turn: string, cred: string, user = turn === 'tA' ? 'alice' : 'bob') => issueProxyToken(env.db, turn, user, { credentialId: cred, family: 'anthropic' })
const call = (token: string, turn: string, extra: Record<string, string> = {}, base = proxy.url) => fetch(base + '/v1/messages', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': token, ...extra },
  body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 5, messages: [{ role: 'user', content: turn }] }),
})
const reset = () => { mode = {}; env.db.query("UPDATE engine_credentials SET status = 'ok', status_code = NULL, limited_until = NULL, disabled = 0").run() }

describe('one turn, one connection', () => {
  test('S-4: alice and bob at the same time on different connections: 1,000 mixed requests, every one with its own key', async () => {
    const ta = tok('tA', CA), tb = tok('tB', CB)
    seen.length = 0
    for (let round = 0; round < 20; round++) {
      const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => (i % 2 ? call(ta, 'tA') : call(tb, 'tB'))))
      for (const r of rs) expect(r.status).toBe(200)
    }
    expect(seen.length).toBe(1000)
    expect(seen.every((s) => (s.turn === 'tA' ? s.key === KEY_A : s.key === KEY_B))).toBe(true)
  })
  test('the engine cannot choose: a key or account header it sends is dropped, the bound connection is used', async () => {
    seen.length = 0
    const r = await call(tok('tA', CA), 'tA', { authorization: 'Bearer ' + KEY_B, 'anthropic-account': CB })
    expect(r.status).toBe(200)
    expect(seen[0]!.key).toBe(KEY_A)
  })
  test('S-6: a process outside the turn cannot use its token (peer check), on either path', async () => {
    const ta = tok('tA', CA)
    callerTurn = 'tB'
    try {
      seen.length = 0
      const r = await call(ta, 'tA')
      expect(r.status).toBe(403)
      expect((await r.json()).error.message).toBe('caller is not part of this turn')
      const tc = issueProxyToken(env.db, 'tA', 'alice', { credentialId: CA, family: 'openai' })
      const c = await fetch(proxy.url + '/codex/openai/responses', { method: 'POST', headers: { authorization: 'Bearer ' + tc, 'content-type': 'application/json' }, body: '{}' })
      expect(c.status).toBe(403)
      expect(seen).toEqual([])
    } finally { callerTurn = null }
  })
})

describe('per-connection state (S-15) and changes during a turn (S-14)', () => {
  test('a 401 marks only that connection refused; the other keeps working', async () => {
    reset(); events.length = 0
    mode[KEY_A] = '401'
    expect((await call(tok('tA', CA), 'tA')).status).toBe(401)
    expect(getRow(env.db, CA)!.status).toBe('invalid')
    expect(getRow(env.db, CB)!.status).toBe('ok')
    expect(events).toContainEqual({ turn: 'tA', ev: { type: 'credential', credentialId: CA, reason: 'invalid' } })
    expect((await call(tok('tB', CB), 'tB')).status).toBe(200)
    reset()
  })
  test('a long 429 limits only that connection, and a restarted proxy still knows it', async () => {
    reset(); events.length = 0
    mode[KEY_A] = '429long'
    const r = await call(tok('tA', CA), 'tA')
    expect(r.status).toBe(403)
    expect(events.at(-1)).toMatchObject({ turn: 'tA', ev: { type: 'rate_limit', credentialId: CA } })
    expect((await call(tok('tB', CB), 'tB')).status).toBe(200)
    mode = {}
    const restarted = await startModelProxy({ db: env.db, broker: createBroker(t.cc) })
    try {
      seen.length = 0
      const again = await call(tok('tA', CA), 'tA', {}, restarted.url)
      expect(again.status).toBe(403)
      expect(Number(again.headers.get('retry-after'))).toBeGreaterThan(7000)
      expect(seen).toEqual([])
    } finally { await restarted.stop() }
    reset()
  })
  test('switched off or removed during the turn: the next request does not go out, the turn hears why', async () => {
    reset(); events.length = 0
    const ta = tok('tA', CA)
    expect((await call(ta, 'tA')).status).toBe(200)
    env.db.query('UPDATE engine_credentials SET disabled = 1 WHERE id = ?').run(CA)
    seen.length = 0
    expect((await call(ta, 'tA')).status).toBe(403)
    expect(seen).toEqual([])
    expect(events.at(-1)!.ev).toEqual({ type: 'credential', credentialId: CA, reason: 'gone' })
    env.db.query('UPDATE engine_credentials SET disabled = 0 WHERE id = ?').run(CA)
    const victim = addCred(t.cc, 'anthropic-api-key', 'sk-ant-api03-' + 'V'.repeat(40))
    const tv = tok('tA', victim)
    env.db.query('DELETE FROM engine_credentials WHERE id = ?').run(victim)
    expect((await call(tv, 'tA')).status).toBe(403)
    expect(seen).toEqual([])
    expect(events.at(-1)!.ev).toEqual({ type: 'credential', credentialId: victim, reason: 'gone' })
    // the turn keeps the usage it had: turns.credential_id stays (no FK)
    reset()
  })
})

describe('S-16: each family on its own path', () => {
  test('a Codex token on /v1, a Claude token on /codex, any turn token for a CONNECT: 403, nothing upstream', async () => {
    seen.length = 0
    const codexTok = issueProxyToken(env.db, 'tA', 'alice', { credentialId: CA, family: 'openai' })
    expect((await call(codexTok, 'tA')).status).toBe(403)
    const claudeTok = tok('tA', CA)
    const r = await fetch(proxy.url + '/codex/chatgpt/responses', { method: 'POST', headers: { authorization: 'Bearer ' + claudeTok, 'content-type': 'application/json' }, body: '{"model":"x"}' })
    expect(r.status).toBe(403)
    const status = await new Promise<string>((res) => {
      const c = net.connect(proxy.port, '127.0.0.1')
      let b = ''
      c.on('connect', () => c.write(`CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\nProxy-Authorization: Basic ${Buffer.from(`turn:${codexTok}`).toString('base64')}\r\n\r\n`))
      c.on('data', (x) => { b += x.toString(); if (b.includes('\r\n')) { c.destroy(); res(b.split('\r\n')[0]!) } })
      c.on('error', (e) => res('error ' + e.message))
    })
    expect(status).toMatch(/^HTTP\/1\.1 403/)
    expect(seen).toEqual([])
  })
})

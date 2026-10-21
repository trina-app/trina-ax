// Relay + relay client end to end inside one process (Bun): Host routing, streaming bodies, headers and the real
// client IP, WebSocket proxying with subprotocol and close codes, offline / unknown pages, the restart hold, auth,
// newer-instance-wins, the registry API, suspension, and the relay log (team ids, bytes, times only).
// The same paths under Node 25 with real processes and faults: tests/relay/f-conformance.test.ts.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  ControlClose, apiSigningString, authorizationHeader, generateTeamKey, keyRotationString, loadPrivateKey, signB64,
  type RelayEvent,
} from '@mycel/shared/relay-protocol'
import type { RelayClient } from '../../server/src/relay-client/client.ts'
import type { VirtualWebSocket } from '../../server/src/services.ts'
import { client, registerTeam, startRelay, teamUrl, until, type InProcessRelay } from '../lib/f-relay'

const PORT = 19163
let R: InProcessRelay
let acme: Awaited<ReturnType<typeof registerTeam>>
let acmeClient: RelayClient
const seen: { ip: string | null; url: string; headers: Record<string, string> }[] = []
const wsClosed: { code: number; reason: string }[] = []

/** the fake team app */
async function app(req: Request, info: { ip: string | null }): Promise<Response> {
  const u = new URL(req.url)
  seen.push({ ip: info.ip, url: req.url, headers: Object.fromEntries(req.headers) })
  if (u.pathname === '/hello') {
    const h = new Headers({ 'content-type': 'application/json' })
    h.append('set-cookie', 'a=1; Path=/')
    h.append('set-cookie', 'b=2; Path=/')
    return new Response(JSON.stringify({ ip: info.ip, url: req.url }), { headers: h })
  }
  if (u.pathname === '/echo') {
    const h = createHash('sha256')
    let n = 0
    for await (const ch of req.body as unknown as AsyncIterable<Uint8Array>) { h.update(ch); n += ch.byteLength }
    return Response.json({ bytes: n, sha256: h.digest('hex') })
  }
  if (u.pathname === '/drip') {
    let i = 0
    return new Response(new ReadableStream<Uint8Array>({
      async pull(c) {
        if (i === 3) { c.close(); return }
        if (i > 0) await Bun.sleep(150)
        c.enqueue(new TextEncoder().encode(`data: ${i++}\n\n`))
      },
    }), { headers: { 'content-type': 'text/event-stream' } })
  }
  if (u.pathname === '/slow') { await Bun.sleep(Number(u.searchParams.get('ms') ?? 1000)); return new Response('late') }
  if (u.pathname === '/big') {
    const n = Number(u.searchParams.get('n'))
    const chunk = new Uint8Array(64 * 1024).fill(42)
    let sent = 0
    return new Response(new ReadableStream<Uint8Array>({
      pull(c) { if (sent >= n) { c.close(); return } const k = Math.min(chunk.byteLength, n - sent); c.enqueue(chunk.subarray(0, k)); sent += k },
    }, { highWaterMark: 0 }))
  }
  return new Response('not found', { status: 404 })
}

/** the fake realtime hub: echo, close on request */
function attachWs(ws: VirtualWebSocket, req: Request): boolean {
  const u = new URL(req.url)
  if (u.searchParams.get('deny')) { ws.close(4401, 'sign in'); return true }
  ws.onMessage = (d) => {
    if (d === 'close-me') { ws.close(4409, 'replaced'); return }
    if (typeof d === 'string' && d.startsWith('big:')) { ws.send('x'.repeat(Number(d.slice(4)))); return }
    ws.send(d)
  }
  ws.onClose = (code, reason) => { wsClosed.push({ code, reason }) }
  ws.send(JSON.stringify({ type: 'hello', protocol: ws.protocol, origin: req.headers.get('origin'), cookie: req.headers.get('cookie') }))
  return true
}

beforeAll(async () => {
  R = await startRelay(PORT, { RELAY_RESPONSE_TIMEOUT_MS: '700', RELAY_HOLD_MS: '1500' })
  acme = await registerTeam(R.base, 'acme')
  acmeClient = client({ url: R.ws, teamId: acme.teamId, kp: acme.kp, fetch: app, attachWs })
  await until(() => acmeClient.state.state === 'connected' && acmeClient.state.conns === 2, 5000, 'acme connected')
})
afterAll(async () => {
  acmeClient?.stop()
  await R?.stop()
})

describe('HTTP through the relay', () => {
  test('Host routing, public URL, real client IP, spoofed IP headers dropped, multiple Set-Cookie kept', async () => {
    const res = await fetch(teamUrl(PORT, 'acme', '/hello?x=1'), { headers: { 'x-forwarded-for': '6.6.6.6', 'cf-connecting-ip': '7.7.7.7', 'x-real-ip': '8.8.8.8' } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ip: string; url: string }
    expect(body.ip).toBe('127.0.0.1')
    expect(body.url).toBe(`http://acme.localhost:${PORT}/hello?x=1`)
    expect(res.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/'])
    const h = seen.at(-1)!.headers
    for (const k of ['x-forwarded-for', 'cf-connecting-ip', 'x-real-ip']) expect(h[k]).toBeUndefined()
  })

  test('request bodies stream to the app intact (chunked and content-length)', async () => {
    const data = new Uint8Array(3 * 1024 * 1024).map((_, i) => (i * 7) % 256)
    const want = createHash('sha256').update(data).digest('hex')
    const r1 = (await (await fetch(teamUrl(PORT, 'acme', '/echo'), { method: 'POST', body: data })).json()) as { bytes: number; sha256: string }
    expect(r1).toEqual({ bytes: data.byteLength, sha256: want })
    let off = 0
    const stream = new ReadableStream<Uint8Array>({ pull(c) { if (off >= data.byteLength) { c.close(); return } c.enqueue(data.subarray(off, off + 100_000)); off += 100_000 } })
    const r2 = (await (await fetch(teamUrl(PORT, 'acme', '/echo'), { method: 'POST', body: stream, duplex: 'half' } as RequestInit)).json()) as { bytes: number; sha256: string }
    expect(r2).toEqual({ bytes: data.byteLength, sha256: want })
  })

  test('responses stream (first event arrives before the end)', async () => {
    const t0 = Date.now()
    const res = await fetch(teamUrl(PORT, 'acme', '/drip'))
    const reader = res.body!.getReader()
    const first = await reader.read()
    const firstAt = Date.now() - t0
    expect(new TextDecoder().decode(first.value)).toContain('data: 0')
    let rest = ''
    for (;;) { const r = await reader.read(); if (r.done) break; rest += new TextDecoder().decode(r.value) }
    expect(rest).toContain('data: 2')
    expect(firstAt).toBeLessThan(Date.now() - t0 - 200)
  })

  test('large download intact', async () => {
    const res = await fetch(teamUrl(PORT, 'acme', `/big?n=${20 * 1024 * 1024}`))
    const b = new Uint8Array(await res.arrayBuffer())
    expect(b.byteLength).toBe(20 * 1024 * 1024)
    expect(b.every((x) => x === 42)).toBe(true)
  })

  test('response timeout counts from the end of the request body: 504', async () => {
    const res = await fetch(teamUrl(PORT, 'acme', '/slow?ms=1500'), { headers: { accept: 'application/json' } })
    expect(res.status).toBe(504)
    expect(((await res.json()) as { error: { code: string; reason: string } }).error).toMatchObject({ code: 'unavailable', reason: 'team_timeout' })
  })

  test("unknown team: 404, HTML for browsers, JSON for the API, in the page's language (not the browser's)", async () => {
    const j = await fetch(teamUrl(PORT, 'nobody', '/api/me'), { headers: { 'accept-language': 'ko' } })
    expect(j.status).toBe(404)
    expect(((await j.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: 'not_found', message: 'This team address is not registered' })
    const h = await fetch(teamUrl(PORT, 'nobody', '/'), { headers: { accept: 'text/html', 'accept-language': 'en', cookie: 'mycel_locale=ko' } })
    expect(h.headers.get('content-type')).toContain('text/html')
    expect(await h.text()).toContain('등록되지 않은 팀 주소입니다')
  })

  test('registered but offline: 503 team_offline after the hold, Retry-After', async () => {
    await registerTeam(R.base, 'sleepy')
    const t0 = Date.now()
    const res = await fetch(teamUrl(PORT, 'sleepy', '/api/x'), { headers: { 'x-mycel-locale': 'id' } })
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('5')
    const e = ((await res.json()) as { error: { code: string; reason: string; message: string } }).error
    expect(e).toMatchObject({ code: 'unavailable', reason: 'team_offline' })
    expect(e.message).toContain('Server tim tidak terhubung')
    expect(Date.now() - t0).toBeLessThan(2500)
  })

  test('restart hold: a request waits for a team that connects within the hold', async () => {
    const late = await registerTeam(R.base, 'late')
    // offline right now; connect 400 ms after the request starts (the team "reconnecting")
    const p = fetch(teamUrl(PORT, 'late', '/hello'))
    let c: RelayClient | null = null
    const timer = setTimeout(() => { c = client({ url: R.ws, teamId: late.teamId, kp: late.kp, fetch: app }) }, 400)
    const res = await p
    clearTimeout(timer)
    expect(res.status).toBe(503) // relay started > hold ago and the team was never online: no hold
    c = c ?? client({ url: R.ws, teamId: late.teamId, kp: late.kp, fetch: app })
    await until(() => c!.state.state === 'connected', 3000, 'late connected')
    // now drop it and ask again while it reconnects: held until it is back
    c.stop()
    await until(() => !R.relay.isOnline(late.teamId), 3000, 'late offline')
    const p2 = fetch(teamUrl(PORT, 'late', '/hello'))
    await Bun.sleep(300)
    const c2 = client({ url: R.ws, teamId: late.teamId, kp: late.kp, fetch: app })
    const res2 = await p2
    expect(res2.status).toBe(200)
    c2.stop()
  })
})

describe('WebSockets through the relay', () => {
  function open(path: string, protocols?: string[]) {
    const ws = new WebSocket(teamUrl(PORT, 'acme', path).replace('http', 'ws'), { protocols, headers: { origin: `http://acme.localhost:${PORT}`, cookie: 'sid=abc' } } as never)
    const msgs: (string | ArrayBuffer)[] = []
    const closed = new Promise<{ code: number; reason: string }>((r) => { ws.onclose = (e) => r({ code: e.code, reason: e.reason }) })
    const opened = new Promise<void>((r, j) => { ws.onopen = () => r(); ws.onerror = () => j(new Error('ws error')) })
    ws.binaryType = 'arraybuffer'
    ws.onmessage = (e) => { msgs.push(e.data) }
    return { ws, msgs, closed, opened }
  }

  test('subprotocol chosen by the team side, cookies and Origin forwarded, text / binary / large messages', async () => {
    const c = open('/api/ws?windowId=abcdefgh', ['mycel.bearer.tok', 'mycel.v1'])
    await c.opened
    expect(c.ws.protocol).toBe('mycel.v1')
    await until(() => c.msgs.length >= 1)
    expect(JSON.parse(c.msgs[0] as string)).toEqual({ type: 'hello', protocol: 'mycel.v1', origin: `http://acme.localhost:${PORT}`, cookie: 'sid=abc' })
    c.ws.send('ping')
    c.ws.send(new Uint8Array([1, 2, 3]))
    c.ws.send('big:300000')
    await until(() => c.msgs.length >= 4, 5000, `4 messages, got ${JSON.stringify(c.msgs.map((m) => typeof m === "string" ? m.slice(0, 20) + ":" + m.length : "bin" + (m as ArrayBuffer).byteLength))}`)
    expect(c.msgs[1]).toBe('ping')
    expect([...new Uint8Array(c.msgs[2] as ArrayBuffer)]).toEqual([1, 2, 3])
    expect((c.msgs[3] as string).length).toBe(300000)
    c.ws.close(4000, 'bye')
    expect((await c.closed).code).toBe(4000)
    await until(() => wsClosed.some((x) => x.code === 4000 && x.reason === 'bye'), 3000, 'hub saw the close')
  })

  test('close codes from the team side reach the browser (4401 do-not-reconnect, 4409 replaced)', async () => {
    const a = open('/api/ws?deny=1')
    expect(await a.closed).toEqual({ code: 4401, reason: 'sign in' })
    const b = open('/api/ws')
    await b.opened
    b.ws.send('close-me')
    expect((await b.closed).code).toBe(4409)
  })

  test('a team without a realtime hub refuses the upgrade; an offline team closes with 1013', async () => {
    const noHub = await registerTeam(R.base, 'nohub')
    const c = client({ url: R.ws, teamId: noHub.teamId, kp: noHub.kp, fetch: app })
    await until(() => c.state.state === 'connected')
    const ws = new WebSocket(teamUrl(PORT, 'nohub', '/api/ws').replace('http', 'ws'))
    const code = await new Promise<number>((r) => { ws.onclose = (e) => r(e.code) })
    expect([1002, 1006]).toContain(code) // handshake failed (HTTP 503)
    c.stop()
    await registerTeam(R.base, 'gone')
    const ws2 = new WebSocket(teamUrl(PORT, 'gone', '/api/ws').replace('http', 'ws'))
    expect(await new Promise<number>((r) => { ws2.onclose = (e) => r(e.code) })).toBe(1013)
  })
})

describe('control connections', () => {
  test('a wrong key is refused (4003, backoff) and the connected team is told once', async () => {
    const events: RelayEvent[] = []
    const t = await registerTeam(R.base, 'keyed')
    const good = client({ url: R.ws, teamId: t.teamId, kp: t.kp, fetch: app, onEvent: (e) => events.push(e) })
    await until(() => good.state.state === 'connected')
    const bad = client({ url: R.ws, teamId: t.teamId, kp: generateTeamKey(), fetch: app, backoffBaseMs: 50, connections: 1 })
    await until(() => bad.state.detail === 'auth_failed', 3000, 'auth failed state')
    expect(bad.state.state).toBe('offline')
    await Bun.sleep(400)
    bad.stop()
    await until(() => events.some((e) => e.type === 'key_rejected'), 3000, 'key_rejected event')
    expect(events.filter((e) => e.type === 'key_rejected')).toHaveLength(1) // rate-limited: once per minute
    expect(good.state.state).toBe('connected')
    good.stop()
  })

  test('newer instance wins: the old one gets 4009 and stays down, the new one is told it took over', async () => {
    const t = await registerTeam(R.base, 'twins')
    const evA: RelayEvent[] = []
    const evB: RelayEvent[] = []
    const A = client({ url: R.ws, teamId: t.teamId, kp: t.kp, fetch: async () => new Response('A'), instance: 'instanceA', onEvent: (e) => evA.push(e) })
    await until(() => A.state.state === 'connected' && A.state.conns === 2)
    const B = client({ url: R.ws, teamId: t.teamId, kp: t.kp, fetch: async () => new Response('B'), instance: 'instanceB', onEvent: (e) => evB.push(e) })
    await until(() => A.state.state === 'replaced', 3000, 'A replaced')
    await until(() => B.state.state === 'connected' && B.state.conns === 2, 3000, 'B connected')
    expect(await (await fetch(teamUrl(PORT, 'twins', '/'))).text()).toBe('B')
    await Bun.sleep(1000)
    expect(A.state.state).toBe('replaced') // no flapping
    expect(B.state.state).toBe('connected')
    expect(evB.some((e) => e.type === 'instance_replaced' && e.by === 'instanceB' && e.previous === 'instanceA')).toBe(true)
    A.stop()
    B.stop()
  })

  test('registry API: signed heartbeat, rename (old name held), key rotation drops the old key, release', async () => {
    const t = await registerTeam(R.base, 'movers')
    const key = loadPrivateKey(t.kp.privatePem)
    const call = async (method: string, p: string, body?: unknown, k = key) => {
      const text = body === undefined ? '' : JSON.stringify(body)
      const ts = Date.now()
      return fetch(`${R.base}${p}`, { method, headers: { authorization: authorizationHeader(t.teamId, ts, signB64(k, apiSigningString(method, p, ts, text))), 'content-type': 'application/json' }, body: text || undefined })
    }
    expect((await call('POST', `/teams/${t.teamId}/heartbeat`, { version: '0.1.0', members: 3 })).status).toBe(200)
    expect((await fetch(`${R.base}/teams/${t.teamId}`)).status).toBe(401)
    const c = client({ url: R.ws, teamId: t.teamId, kp: t.kp, fetch: app })
    await until(() => c.state.state === 'connected')
    const ren = await call('PATCH', `/teams/${t.teamId}`, { name: 'movers-co' })
    expect(((await ren.json()) as { address: string }).address).toBe(`http://movers-co.localhost:${PORT}`)
    expect((await fetch(teamUrl(PORT, 'movers-co', '/hello'))).status).toBe(200)
    expect((await fetch(teamUrl(PORT, 'movers', '/hello'))).status).toBe(404)
    const other = generateTeamKey()
    const taken = await fetch(`${R.base}/teams`, { method: 'POST', body: JSON.stringify({ name: 'movers', publicKey: other.publicKey, ts: Date.now(), nonce: '0', sig: 'x' }) })
    expect(taken.status).toBe(409)
    // rotate with the recovery code (lost key): the connected client is dropped (4003)
    const next = generateTeamKey()
    const rot = await fetch(`${R.base}/teams/${t.teamId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicKey: next.publicKey, newKeySig: signB64(loadPrivateKey(next.privatePem), keyRotationString(t.teamId, next.publicKey)), recoveryCode: t.recoveryCode }) })
    expect(rot.status).toBe(200)
    await until(() => c.state.state === 'offline' && c.state.detail === 'auth_failed', 5000, 'old key dropped')
    c.stop()
    const del = await call('DELETE', `/teams/${t.teamId}`, undefined, loadPrivateKey(next.privatePem))
    expect(del.status).toBe(200)
    expect((await fetch(teamUrl(PORT, 'movers-co', '/hello'))).status).toBe(404)
  })

  test('operator suspension: 403 page, the team server is disconnected with 4010', async () => {
    const t = await registerTeam(R.base, 'naughty')
    const c = client({ url: R.ws, teamId: t.teamId, kp: t.kp, fetch: app, backoffBaseMs: 50 })
    await until(() => c.state.state === 'connected')
    R.relay.registry.setStatus(t.teamId, 'suspended')
    R.relay.invalidateNames()
    expect((await fetch(teamUrl(PORT, 'naughty', '/hello'))).status).toBe(403)
    await until(() => c.state.detail === 'suspended', 7000, 'suspended')
    expect(ControlClose.SUSPENDED).toBe(4010)
    c.stop()
  })
})

describe('relay log', () => {
  test('only team ids, byte counts and times: no client IPs, paths, hosts or names', () => {
    const all = R.logLines.join('\n')
    expect(R.logLines.length).toBeGreaterThan(10)
    expect(all).not.toContain('127.0.0.1')
    expect(all).not.toContain('/hello')
    expect(all).not.toContain('/api/ws')
    expect(all).not.toContain('acme.localhost')
    expect(all).not.toMatch(/"(ip|path|url|host|headers)"/)
    const streams = R.logLines.map((l) => JSON.parse(l)).filter((o) => o.ev === 'stream')
    expect(streams.length).toBeGreaterThan(5)
    for (const s of streams) expect(Object.keys(s).sort()).toEqual(['bytesIn', 'bytesOut', 'ev', 'kind', 'level', 'ms', 't', 'team'])
  })
})

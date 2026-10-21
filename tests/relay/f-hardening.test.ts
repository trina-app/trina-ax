// Review findings against a real Node 25 relay (its HTTP parser and `ws` are what production runs): requests that
// used to drop a team's control connection, a slow-loris upload holding a team stream forever, an upload the app
// never read lingering after the answer, cookies for the parent domain, a misbehaving team server (1xx heads, PING
// flood without reading), and big WebSocket messages sent as fragments. `bun run test:relay`.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import net from 'node:net'
import path from 'node:path'
import fs from 'node:fs'
import { RstCode, type Stream } from '@mycel/shared/relay-protocol'
import type { RelayClient } from '../../server/src/relay-client/client.ts'
import type { VirtualWebSocket } from '../../server/src/services.ts'
import { F_WORK, REPO, client, rawTeam, registerTeam, rssMb, spawnNodeRelay, teamUrl, until, waitHttp, type Proc } from '../lib/f-relay'

const PORT = 19168
const API = `http://127.0.0.1:${PORT}`
const CTL = `ws://127.0.0.1:${PORT}/connect`
let relay: Proc
let victim: Awaited<ReturnType<typeof registerTeam>>
let c: RelayClient
const uploads = { rejected: 0 }

async function app(req: Request): Promise<Response> {
  const u = new URL(req.url)
  if (u.pathname === '/hello') {
    const h = new Headers({ 'content-type': 'text/plain' })
    h.append('set-cookie', 'sid=1; Path=/; Domain=localhost; HttpOnly')
    h.append('set-cookie', 'lang=ko; domain=.localhost ; Path=/')
    h.append('set-cookie', '__Host-x=1; Path=/; Secure')
    return new Response('hello', { headers: h })
  }
  if (u.pathname === '/reject') { uploads.rejected++; return new Response('no thanks', { status: 401 }) } // body never read
  if (u.pathname === '/echo') { let n = 0; for await (const ch of req.body as unknown as AsyncIterable<Uint8Array>) n += ch.byteLength; return Response.json({ n }) }
  return new Response('ok')
}
function attachWs(ws: VirtualWebSocket): boolean {
  ws.onMessage = (d) => {
    if (typeof d === 'string' && d.startsWith('text:')) ws.send('t'.repeat(Number(d.slice(5))))
    else if (typeof d === 'string' && d.startsWith('bin:')) ws.send(new Uint8Array(Number(d.slice(4))).map((_, i) => i % 251))
  }
  return true
}

/** raw HTTP/1.1 exchange; returns the status line */
function raw(req: string | Buffer, o: { stallMs?: number } = {}): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1', () => s.write(req))
    let out = ''
    s.on('data', (d) => { out += d.toString('latin1'); if (out.includes('\r\n')) s.destroy() })
    s.on('close', () => resolve(out.split('\r\n')[0] ?? ''))
    s.on('error', () => resolve('ERR'))
    setTimeout(() => s.destroy(), o.stallMs ?? 5000)
  })
}

beforeAll(async () => {
  relay = spawnNodeRelay(PORT, path.join(F_WORK, `hardening-${Date.now()}`), { RELAY_BODY_IDLE_MS: '800', RELAY_HOLD_MS: '300' }, 'hardening-relay')
  await waitHttp(`${API}/healthz`)
  victim = await registerTeam(API, 'victim')
  c = client({ url: CTL, teamId: victim.teamId, kp: victim.kp, fetch: app, attachWs })
  await until(() => c.state.conns === 2, 5000, 'victim connected')
})
afterAll(() => { c?.stop(); relay?.kill() })

describe('relay hardening (Node 25 relay)', () => {
  test('requests the team server cannot take get 400 from the relay and never drop its control connections', async () => {
    const drops = c.stats.drops
    expect(await raw('GET http://evil.example/x HTTP/1.1\r\nHost: victim.localhost\r\nConnection: close\r\n\r\n')).toContain(' 400 ')
    expect(await raw('OPTIONS * HTTP/1.1\r\nHost: victim.localhost\r\nConnection: close\r\n\r\n')).toContain(' 400 ')
    let many = ''
    for (let i = 0; i < 300; i++) many += `x-h${i}: v\r\n`
    expect(await raw(`GET /a HTTP/1.1\r\nHost: victim.localhost\r\n${many}Connection: close\r\n\r\n`)).toContain(' 400 ')
    // header bytes the team server's runtime refuses: 400 from the team side, not 500 and no dropped connection
    const latin1 = Buffer.concat([Buffer.from('GET /b HTTP/1.1\r\nHost: victim.localhost\r\nx-name: '), Buffer.alloc(200, 0xe9), Buffer.from('\r\nConnection: close\r\n\r\n')])
    expect(await raw(latin1)).toContain(' 400 ')
    // a WebSocket upgrade with an absolute-form target
    expect(await raw('GET http://evil.example/api/ws HTTP/1.1\r\nHost: victim.localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n')).toContain(' 400 ')
    await Bun.sleep(200)
    expect(c.stats.drops).toBe(drops)
    expect(c.state.conns).toBe(2)
    expect(relay.p.exitCode).toBeNull()
    expect((await fetch(teamUrl(PORT, 'victim', '/ok'))).status).toBe(200)
  })

  test('Set-Cookie from a team server is made host-only (no Domain=<parent domain> cookies for other teams)', async () => {
    const res = await fetch(teamUrl(PORT, 'victim', '/hello'))
    const cookies = res.headers.getSetCookie()
    expect(cookies).toEqual(['sid=1; Path=/; HttpOnly', 'lang=ko; Path=/', '__Host-x=1; Path=/; Secure'])
  })

  test('an answer sent before the upload was read is delivered whole, and the upload stops (no lingering stream)', async () => {
    const body = new Uint8Array(20 * 1024 * 1024)
    const t0 = Date.now()
    const res = await fetch(teamUrl(PORT, 'victim', '/reject'), { method: 'POST', body })
    expect(res.status).toBe(401)
    expect(await res.text()).toBe('no thanks')
    expect(Date.now() - t0).toBeLessThan(3000)
    await until(() => c.openStreams() === 0, 3000, 'team streams released')
    // a normal upload still works afterwards
    expect(await (await fetch(teamUrl(PORT, 'victim', '/echo'), { method: 'POST', body: new Uint8Array(3 * 1024 * 1024) })).json()).toEqual({ n: 3 * 1024 * 1024 })
  }, 20_000)

  test('a request body that stops arriving is aborted (408) and frees its team stream', async () => {
    const t0 = Date.now()
    const status = await raw('POST /echo HTTP/1.1\r\nHost: victim.localhost\r\nContent-Length: 100000\r\nAccept: text/html\r\n\r\n0123456789')
    expect(status).toContain(' 408 ')
    expect(Date.now() - t0).toBeLessThan(3000)
    await until(() => c.openStreams() === 0, 3000, 'team stream released')
  })

  test('big WebSocket messages reach the browser intact (sent as fragments, never assembled by the relay)', async () => {
    const ws = new WebSocket(`ws://victim.localhost:${PORT}/api/ws`)
    ws.binaryType = 'arraybuffer'
    const got: (string | ArrayBuffer)[] = []
    ws.onmessage = (e) => got.push(e.data as string | ArrayBuffer)
    await new Promise((r) => { ws.onopen = r })
    ws.send('text:3000000')
    ws.send('bin:300001')
    ws.send('text:3')
    await until(() => got.length >= 3, 10_000, 'three messages')
    expect((got[0] as string).length).toBe(3_000_000)
    expect(/^t+$/.test(got[0] as string)).toBe(true)
    const b = new Uint8Array(got[1] as ArrayBuffer)
    expect(b.byteLength).toBe(300_001)
    expect(b.every((x, i) => x === i % 251)).toBe(true)
    expect(got[2]).toBe('ttt')
    ws.close()
  }, 20_000)

  test('a team server answering an HTTP stream with 101 gets a reset; the visitor gets 502', async () => {
    const evil = await registerTeam(API, 'evilone')
    const t = await rawTeam(CTL, evil.teamId, evil.kp, (s: Stream) => { s.respond({ status: 101, headers: [['upgrade', 'websocket']] }); void s.write(new TextEncoder().encode('HTTP/1.1 200 OK\r\n\r\nsmuggled')) })
    const res = await fetch(teamUrl(PORT, 'evilone', '/'))
    expect(res.status).toBe(502)
    expect(await res.text()).not.toContain('smuggled')
    t.ws.close()
    expect(RstCode.PROTOCOL).toBe(4)
  })

  test('a team server flooding PINGs without reading can not grow the relay memory', async () => {
    const flood = await registerTeam(API, 'flooder')
    const rss0 = rssMb(relay.p.pid)
    const out = path.join(F_WORK, 'hardening-flood.log')
    const fd = fs.openSync(out, 'w')
    const p = Bun.spawn(['node', '--disable-warning=ExperimentalWarning', path.join(REPO, 'tests/relay/flood-team.mjs'), CTL, flood.teamId, Buffer.from(flood.kp.privatePem).toString('base64'), REPO], { stdout: fd, stderr: fd })
    let peak = rss0
    try {
      await until(() => fs.readFileSync(out, 'utf8').includes('authed'), 10_000, 'flooder connected')
      for (let i = 0; i < 16; i++) { await Bun.sleep(250); peak = Math.max(peak, rssMb(relay.p.pid)) }
    } finally {
      p.kill(9)
    }
    // before the fix: +1.5 GB for the same flood, growing with its length; now a plateau of receive buffers and
    // garbage (~200 MB at most, the same for a flood five times longer)
    expect(peak - rss0).toBeLessThan(400)
    // the relay still serves other teams
    expect((await fetch(teamUrl(PORT, 'victim', '/ok'))).status).toBe(200)
  }, 30_000)

  test('a peer that is not a trusted proxy can not choose its client IP with CF-Connecting-IP (production header on)', async () => {
    // the production setting (client IP from CF-Connecting-IP, only Cloudflare's ranges trusted); this test reaches
    // the relay over loopback, like someone reaching the origin without going through Cloudflare
    const port = 19183
    const r = spawnNodeRelay(port, path.join(F_WORK, `hardening-cfip-${Date.now()}`), { RELAY_CLIENT_IP_HEADER: 'cf-connecting-ip' }, 'hardening-cfip-relay')
    let tc: RelayClient | undefined
    try {
      await waitHttp(`http://127.0.0.1:${port}/healthz`)
      const t = await registerTeam(`http://127.0.0.1:${port}`, 'ipcheck')
      tc = client({ url: `ws://127.0.0.1:${port}/connect`, teamId: t.teamId, kp: t.kp, fetch: async (_req, info) => Response.json({ ip: info.ip }) })
      await until(() => tc!.state.state === 'connected', 5000, 'ipcheck connected')
      const res = await fetch(teamUrl(port, 'ipcheck', '/whoami'), { headers: { 'cf-connecting-ip': '10.0.0.5', 'x-forwarded-for': '203.0.113.9' } })
      expect(((await res.json()) as { ip: string }).ip).toBe('127.0.0.1')
    } finally {
      tc?.stop()
      r.kill()
    }
  }, 20_000)
})

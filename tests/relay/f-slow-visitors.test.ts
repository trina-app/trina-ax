// QA TC-199 against a real Node relay: from one machine, connections that ask for a big file and never read the answer
// took every stream of a team, so nobody else could open it, and the relay never closed them. Now one visitor address
// holds at most RELAY_MAX_STREAMS_PER_IP streams of a team (over it: 503 team_busy at once), and an answer the visitor
// stopped reading is cut after RELAY_CLIENT_STALL_MS. Small limits here so the test stays light. `bun run test:relay`.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import net from 'node:net'
import path from 'node:path'
import type { RelayClient } from '../../server/src/relay-client/client.ts'
import { F_WORK, client, registerTeam, spawnNodeRelay, teamUrl, until, waitHttp, type Proc } from '../lib/f-relay'

const PORT = 19189
const API = `http://127.0.0.1:${PORT}`
const CAP = 4
const MB = 1024 * 1024
let relay: Proc
let c: RelayClient
const held: (() => void)[] = []

async function app(req: Request): Promise<Response> {
  const u = new URL(req.url)
  // an answer that stays open until the test lets it go (a stream held by the visitor)
  if (u.pathname === '/hold') return new Response(new ReadableStream({ start(ctl) { ctl.enqueue(new TextEncoder().encode('x')); held.push(() => { try { ctl.close() } catch {} }) } }))
  if (u.pathname === '/big') return new Response(new Uint8Array(Number(u.searchParams.get('mb') ?? 8) * MB).fill(97))
  return new Response('ok')
}

/** A raw request from `ip` (the relay trusts x-test-ip from loopback in this test only) that never reads its answer. */
function deaf(p: string, ip: string): net.Socket {
  const s = net.connect(PORT, '127.0.0.1', () => {
    s.write(`GET ${p} HTTP/1.1\r\nHost: victim.localhost:${PORT}\r\nx-test-ip: ${ip}\r\n\r\n`)
    s.pause()
  })
  s.on('error', () => {})
  return s
}

async function stats(): Promise<{ streams: number; counters: Record<string, number> }> {
  const st = (await (await fetch(`${API}/_stats`)).json()) as { teams: Record<string, { streams: number }>; counters: Record<string, number> }
  return { streams: Object.values(st.teams)[0]?.streams ?? 0, counters: st.counters }
}

beforeAll(async () => {
  relay = spawnNodeRelay(PORT, path.join(F_WORK, `slow-visitors-${Date.now()}`), {
    RELAY_MAX_STREAMS_PER_IP: String(CAP), RELAY_CLIENT_STALL_MS: '1500',
    RELAY_CLIENT_IP_HEADER: 'x-test-ip', RELAY_TRUSTED_PROXIES: '127.0.0.1,::1', RELAY_HOLD_MS: '300',
  }, 'slow-visitors-relay')
  await waitHttp(`${API}/healthz`)
  const team = await registerTeam(API, 'victim')
  c = client({ url: `ws://127.0.0.1:${PORT}/connect`, teamId: team.teamId, kp: team.kp, fetch: app })
  await until(() => c.state.conns === 2, 5000, 'team connected')
})
afterAll(() => { for (const f of held.splice(0)) f(); c?.stop(); relay?.kill() })

describe('slow visitors (Node relay)', () => {
  test('one address holds at most its share of streams; others still get in', async () => {
    const socks = Array.from({ length: CAP }, () => deaf('/hold', '198.51.100.7'))
    try {
      await until(async () => (await stats()).streams === CAP, 5000, 'the address holds its share')
      // the next request from that address is refused at once, without waiting for a stream
      const t0 = Date.now()
      const over = await fetch(teamUrl(PORT, 'victim', '/x'), { headers: { 'x-test-ip': '198.51.100.7' } })
      expect(over.status).toBe(503)
      expect(over.headers.get('x-relay-error')).toBe('team_busy')
      expect(over.headers.get('retry-after')).toBe('5')
      expect(Date.now() - t0).toBeLessThan(250)
      // IPv6 counts by /64: another address of the same line is the same visitor
      for (let i = 0; i < CAP; i++) socks.push(deaf('/hold', `2001:db8:1:2::${i + 1}`))
      await until(async () => (await stats()).streams === 2 * CAP, 5000, 'the IPv6 line holds its share')
      expect((await fetch(teamUrl(PORT, 'victim', '/x'), { headers: { 'x-test-ip': '2001:db8:1:2:ffff::9' } })).status).toBe(503)
      // someone else is served
      const other = await fetch(teamUrl(PORT, 'victim', '/x'), { headers: { 'x-test-ip': '203.0.113.20' } })
      expect(other.status).toBe(200)
      expect(await other.text()).toBe('ok')
      expect((await stats()).counters.httpVisitorLimit).toBe(2)
    } finally {
      for (const s of socks) s.destroy()
      for (const f of held.splice(0)) f()
    }
    // the share comes back once the streams end
    await until(async () => (await stats()).streams === 0, 5000, 'streams released')
    expect((await fetch(teamUrl(PORT, 'victim', '/x'), { headers: { 'x-test-ip': '198.51.100.7' } })).status).toBe(200)
  }, 20_000)

  test('an answer the visitor stopped reading is cut: its team stream and socket are freed', async () => {
    const before = (await stats()).counters.clientStalls ?? 0
    const s = deaf('/big?mb=8', '198.51.100.8')
    let closed = false
    s.on('close', () => { closed = true })
    try {
      await until(async () => (await stats()).streams === 1, 5000, 'the big answer started')
      await until(async () => (await stats()).counters.clientStalls === before + 1, 6000, 'the stalled answer is cut')
      await until(() => c.openStreams() === 0, 3000, 'team stream released')
      expect((await stats()).streams).toBe(0)
      s.resume() // the relay closed the socket: reading it now ends it
      await until(() => closed, 5000, 'socket closed by the relay')
    } finally {
      s.destroy()
    }
  }, 20_000)

  test('a slow visitor that keeps reading is not cut', async () => {
    const before = (await stats()).counters.clientStalls ?? 0
    // about 3 s for 2 MB at 700 KB/s: longer than the 1.5 s stall limit, but every chunk keeps moving
    const p = Bun.spawn(['curl', '-s', '--limit-rate', '700K', '-o', '/dev/null', '-w', '%{http_code} %{size_download}', '-H', 'x-test-ip: 198.51.100.9', teamUrl(PORT, 'victim', '/big?mb=2')])
    const out = await new Response(p.stdout).text()
    await p.exited
    expect(out).toBe(`200 ${2 * MB}`)
    expect((await stats()).counters.clientStalls ?? 0).toBe(before)
  }, 20_000)
})

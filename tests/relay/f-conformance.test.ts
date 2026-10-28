// Relay conformance tests (spike-relay t1-t8, scaled for CI time): a real Node 25 relay process and real team-server
// processes running the relay client. `bun run test:relay`. Faults: slow readers, cancels, SIGSTOP (half-open),
// kill -9 / SIGTERM of the relay, wrong keys, a second instance, thousands of idle sockets.
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { generateTeamKey } from '@mycel/shared/relay-protocol'
import { F_WORK, rssMb, spawnFakeTeam, until, waitHttp } from '../lib/f-relay'
import { chat, debug, expectedSha, lat, logLines, sh, startStack, sum, type Stack } from './harness'

const PORT = 19167
// logs and registries of earlier runs (the 100 MB upload file is kept for reuse)
fs.mkdirSync(F_WORK, { recursive: true })
for (const f of fs.readdirSync(F_WORK)) if (/^t[a-z]+-\d{13}-\d+/.test(f)) fs.rmSync(path.join(F_WORK, f), { recursive: true, force: true })
let S: Stack | null = null
afterEach(() => { S?.stop(); S = null })
const MB = 1024 * 1024
/** The most one TCP connection on this host may buffer in the kernel: send buffer + receive buffer limits (autotuned
 * sizes cap there). Linux: tcp_wmem / tcp_rmem maximums; macOS: the autotuning maximums. */
function socketBufferMax(): number {
  const n = (s: string | undefined) => (Number.isFinite(Number(s)) ? Number(s) : 0)
  if (process.platform === 'linux') {
    const max = (f: string) => { try { return n(fs.readFileSync(f, 'utf8').trim().split(/\s+/)[2]) } catch { return 0 } }
    const sum = max('/proc/sys/net/ipv4/tcp_wmem') + max('/proc/sys/net/ipv4/tcp_rmem')
    if (sum > 0) return sum
  } else if (process.platform === 'darwin') {
    const out = Bun.spawnSync(['sysctl', '-n', 'net.inet.tcp.autosndbufmax', 'net.inet.tcp.autorcvbufmax']).stdout.toString().trim().split(/\s+/)
    const sum = n(out[0]) + n(out[1])
    if (sum > 0) return sum
  }
  return 8 * MB
}
/** measured numbers, printed at the end and saved to tests/.work/f-relay/conformance.json */
const notes: Record<string, unknown> = {}
afterAll(() => {
  console.log(JSON.stringify(notes, null, 1))
  fs.mkdirSync(F_WORK, { recursive: true })
  fs.writeFileSync(path.join(F_WORK, 'conformance.json'), JSON.stringify(notes, null, 1))
})

describe('conformance (Node 25 relay, separate team-server process)', () => {
  test('t1 head-of-line: a 200 MB download does not hold up 5 chat streams; bytes intact', async () => {
    S = await startStack(PORT, { name: 'tone' })
    const N = 200 * MB
    const want = expectedSha(N)
    const dl = sh(`curl -s "${S.base}/bytes?n=${N}" | shasum -a 256 | cut -d' ' -f1`)
    await Bun.sleep(200)
    const chats = Array.from({ length: 5 }, (_, i) => chat(S!.wsBase, `t1-${i}-${Date.now()}`, 60, 20))
    const rs = await Promise.all(chats.map((c) => c.promise))
    expect(await dl).toBe(want)
    const l = lat(rs.flatMap((r) => r.lat))
    expect(sum(rs, 'gaps')).toBe(0)
    expect(sum(rs, 'dups')).toBe(0)
    expect(sum(rs, 'got')).toBe(300)
    notes.t1 = { chatLatencyMs: l, downloadMB: N / MB }
    expect(l.p99).toBeLessThan(250)
  }, 60_000)

  test('t2 slow reader: the producer stays about one window ahead; relay memory flat', async () => {
    S = await startStack(PORT, { name: 'ttwo' })
    const rss0 = rssMb(S.relay.p.pid)
    const slow = Bun.spawn(['curl', '-s', '--limit-rate', '1M', '-o', '/dev/null', `${S.base}/bytes?n=${500 * MB}&rid=slow`])
    // Bytes the reader has not taken yet sit in one window (256 KB) and in the relay -> reader socket's kernel buffers
    // (the team -> relay hop carries at most one window). Those buffers fill in the first half second and their size
    // is the host's, not ours: up to 4 + 4 MB on macOS, 4 + 6 MB with Linux's defaults (12.1 MB produced after 4 s
    // on a Debian server against the old fixed 4 + 8 MB). So: once they are full, the producer goes only as fast as
    // the reader, and the total stays within what was read plus this host's buffer limits.
    await Bun.sleep(2000)
    const a = await debug(S.base, 'slow'), aAt = Date.now()
    await Bun.sleep(2000)
    const d = await debug(S.base, 'slow'), dAt = Date.now()
    const elapsed = (Date.now() - d.lastPullAt) / 1000
    const read = ((dAt - aAt) / 1000) * MB // the reader's 1 MB/s over the interval
    const buffers = socketBufferMax()
    notes.t2 = { producedMB: +(d.produced / MB).toFixed(2), lastTwoSecondsMB: +((d.produced - a.produced) / MB).toFixed(2), socketBuffersMB: +(buffers / MB).toFixed(1), relayRssGrowthMB: +(rssMb(S.relay.p.pid) - rss0).toFixed(1) }
    // without flow control the producer runs at memory speed (hundreds of MB in a second): here, the reader's pace
    // plus at most 3 MB (the relay returns window in steps as the socket drains: ~1.5 MB on Linux; GitHub's Linux
    // runners hold ~2.2 MB more in their socket buffers). Without flow control this is hundreds of MB.
    expect(d.produced - a.produced).toBeLessThan(read + 3 * MB)
    // ~4 MB read in 4 s (curl may burst 1 MB more), one window, and this host's socket buffers between relay and reader
    expect(d.produced).toBeLessThan(5 * MB + 256 * 1024 + buffers)
    expect(elapsed).toBeLessThan(5)
    expect(rssMb(S.relay.p.pid) - rss0).toBeLessThan(40)
    slow.kill(9)
    await until(async () => (await debug(S!.base, 'slow')).cancelAt > 0, 3000, 'cancel reached the app')
  }, 30_000)

  test('t3 uploads: 100 MB chunked / content-length / slow team server, sha256 intact, relay memory bounded', async () => {
    S = await startStack(PORT, { name: 'tthree' })
    const file = path.join(F_WORK, 'up100.bin')
    if (!fs.existsSync(file) || fs.statSync(file).size !== 100 * MB) {
      const b = new Uint8Array(100 * MB)
      for (let i = 0; i < b.length; i += 4096) b[i] = (i / 4096) & 255
      fs.writeFileSync(file, b)
    }
    const want = (await sh(`shasum -a 256 "${file}"`)).split(' ')[0]
    const rss0 = rssMb(S.relay.p.pid)
    let peak = 0
    const sampler = setInterval(() => { peak = Math.max(peak, rssMb(S!.relay.p.pid)) }, 200)
    const modes = {
      'content-length': `curl -s -X POST -H "Expect:" --data-binary @"${file}" "${S.base}/upload"`,
      chunked: `cat "${file}" | curl -s -X POST -H "Transfer-Encoding: chunked" -H "Expect:" --data-binary @- "${S.base}/upload"`,
      'slow-team': `curl -s -X POST -H "Expect:" --data-binary @"${file}" "${S.base}/upload?delay=1"`,
    }
    for (const [mode, cmd] of Object.entries(modes)) {
      const r = JSON.parse(await sh(cmd)) as { bytes: number; sha256: string }
      expect({ mode, ...r }).toEqual({ mode, bytes: 100 * MB, sha256: want })
    }
    clearInterval(sampler)
    notes.t3 = { relayPeakRssGrowthMB: +(peak - rss0).toFixed(1) }
    expect(peak - rss0).toBeLessThan(80)
  }, 120_000)

  test('t4 cancel: aborts reach the team server (GET, slow curl kill, upload kill, POST with a streaming answer)', async () => {
    S = await startStack(PORT, { name: 'tfour' })
    // 1) fetch reading at full speed, aborted after 20 MB
    const ac = new AbortController()
    const r = await fetch(`${S.base}/bytes?n=${1000 * MB}&rid=fa`, { signal: ac.signal })
    const rd = r.body!.getReader()
    let got = 0
    while (got < 20 * MB) got += (await rd.read()).value!.byteLength
    const tAbort = Date.now()
    ac.abort()
    const d1 = await until(async () => { const d = await debug(S!.base, 'fa'); return d.cancelAt ? d : null }, 3000, 'GET cancel')
    expect(d1.cancelAt - tAbort).toBeLessThan(1000)
    expect(d1.produced - got).toBeLessThan(4 * MB)
    // 2) throttled curl killed
    const p2 = Bun.spawn(['curl', '-s', '--limit-rate', '1M', '-o', '/dev/null', `${S.base}/bytes?n=${1000 * MB}&rid=ck`])
    await Bun.sleep(1500)
    const tKill = Date.now()
    p2.kill(9)
    const d2 = await until(async () => { const d = await debug(S!.base, 'ck'); return d.cancelAt ? d : null }, 3000, 'curl cancel')
    expect(d2.cancelAt - tKill).toBeLessThan(1000)
    // 3) upload killed midway: the app's body read fails
    const file = path.join(F_WORK, 'up100.bin')
    const p3 = Bun.spawn(['sh', '-c', `exec curl -s --limit-rate 10M -X POST -H "Expect:" --data-binary @"${file}" "${S.base}/upload?rid=uk"`])
    await Bun.sleep(1500)
    const tKill3 = Date.now()
    p3.kill(9)
    const d3 = await until(async () => { const d = await debug(S!.base, 'uk'); return d.errorAt ? d : null }, 3000, 'upload error')
    expect(d3.errorAt - tKill3).toBeLessThan(1000)
    // 4) POST with a small body and a streaming answer (like a chat turn), client killed: cancel propagates on Node
    const p4 = Bun.spawn(['curl', '-s', '--limit-rate', '1M', '-X', 'POST', '-d', 'q=hello', '-o', '/dev/null', `${S.base}/bytes?n=${1000 * MB}&rid=pk`])
    await Bun.sleep(1500)
    const tKill4 = Date.now()
    p4.kill(9)
    const d4 = await until(async () => { const d = await debug(S!.base, 'pk'); return d.cancelAt ? d : null }, 3000, 'POST stream cancel')
    expect(d4.cancelAt - tKill4).toBeLessThan(1000)
    notes.t4 = { getCancelMs: d1.cancelAt - tAbort, curlKillCancelMs: d2.cancelAt - tKill, uploadKillErrorMs: d3.errorAt - tKill3, postStreamCancelMs: d4.cancelAt - tKill4 }
  }, 60_000)

  test('t5 half-open team server (SIGSTOP): offline within the silence limit, clear errors, clean resume after SIGCONT', async () => {
    S = await startStack(PORT, { name: 'tfive', relayEnv: { RELAY_SILENCE_MS: '3000', RELAY_STALL_MS: '60000', RELAY_HOLD_MS: '300' }, teamEnv: { PING_MS: '500', DEAD_MS: '3000', BACKOFF_BASE_MS: '100' } })
    const chats = Array.from({ length: 3 }, (_, i) => chat(S!.wsBase, `t5-${i}-${Date.now()}`, 200, 50))
    await Bun.sleep(1500)
    const tStop = Date.now()
    process.kill(S.team.p.pid, 'SIGSTOP')
    await until(() => logLines(S!.relay.log).some((l) => l.ev === 'team_offline'), 8000, 'relay marks the team offline')
    const offAt = Date.parse(logLines(S.relay.log).find((l) => l.ev === 'team_offline')!.t as string)
    notes.t5 = { offlineDetectedAfterMs: offAt - tStop }
    expect(offAt - tStop).toBeLessThan(5000)
    const res = await fetch(`${S.base}/hello`, { headers: { accept: 'application/json' } })
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: { reason: string } }).error.reason).toBe('team_offline')
    const ws = new WebSocket(`${S.wsBase}/echo`)
    expect(await new Promise<number>((r) => { ws.onclose = (e) => r(e.code) })).toBe(1013)
    await Bun.sleep(1000)
    const tCont = Date.now()
    process.kill(S.team.p.pid, 'SIGCONT')
    await waitHttp(`${S.base}/hello`, 10_000)
    ;(notes.t5 as Record<string, number>).backAfterContMs = Date.now() - tCont
    expect(Date.now() - tCont).toBeLessThan(3000)
    const rs = await Promise.all(chats.map((c) => c.promise))
    expect(sum(rs, 'gaps')).toBe(0)
    expect(sum(rs, 'dups')).toBe(0)
    expect(rs.every((r) => r.done)).toBe(true)
  }, 60_000)

  test('t5b stall probe: a frozen team server is detected by PING long before the silence limit', async () => {
    S = await startStack(PORT, { name: 'tfiveb', relayEnv: { RELAY_SILENCE_MS: '45000', RELAY_STALL_MS: '1000', RELAY_PONG_TIMEOUT_MS: '1500', RELAY_HOLD_MS: '200' }, teamEnv: { PING_MS: '20000' } })
    process.kill(S.team.p.pid, 'SIGSTOP')
    const t0 = Date.now()
    const res = await fetch(`${S.base}/hello`, { headers: { accept: 'application/json' } })
    const ms = Date.now() - t0
    expect([502, 503]).toContain(res.status)
    notes.t5b = { status: res.status, answeredAfterMs: ms }
    expect(ms).toBeLessThan(6000) // not the 45 s silence limit, not the 100 s response timeout
    process.kill(S.team.p.pid, 'SIGCONT')
  }, 30_000)

  test('t6 relay restart: kill -9 then SIGTERM (GOAWAY + 1012); team server back fast, chats resume without loss or duplicates', async () => {
    S = await startStack(PORT, { name: 'tsix', teamEnv: { BACKOFF_BASE_MS: '200' } })
    const chats = Array.from({ length: 5 }, (_, i) => chat(S!.wsBase, `t6-${i}-${Date.now()}`, 240, 50))
    await Bun.sleep(1500)
    S.relay.kill('SIGKILL')
    await S.relay.p.exited
    await Bun.sleep(1000)
    const t1 = Date.now()
    await S.restartRelay()
    await waitHttp(`${S.base}/hello`, 10_000)
    const back1 = Date.now() - t1
    await Bun.sleep(2000)
    S.relay.kill('SIGTERM')
    await S.relay.p.exited
    expect(logLines(S.relay.log).some((l) => l.ev === 'relay_stopped')).toBe(true)
    await Bun.sleep(500)
    const t2 = Date.now()
    await S.restartRelay()
    await waitHttp(`${S.base}/hello`, 10_000)
    const back2 = Date.now() - t2
    const rs = await Promise.all(chats.map((c) => c.promise))
    notes.t6 = { afterKill9Ms: back1, afterSigtermMs: back2, reconnects: sum(rs, 'reconnects') }
    expect(back1).toBeLessThan(4000)
    expect(back2).toBeLessThan(4000)
    expect(sum(rs, 'gaps')).toBe(0)
    expect(sum(rs, 'dups')).toBe(0)
    expect(sum(rs, 'resets')).toBe(0) // same team-server process: the (epoch, seq) tokens stay valid
    expect(rs.every((r) => r.done)).toBe(true)
    expect(sum(rs, 'reconnects')).toBeGreaterThanOrEqual(5)
  }, 90_000)

  test('t7 auth: a wrong key backs off; a second instance with the right key wins, the first stops (no flapping); resume tokens from the old epoch reset', async () => {
    S = await startStack(PORT, { name: 'tseven', teamEnv: { INSTANCE: 'instanceA' } })
    // (a) wrong key
    const wrongKey = path.join(S.dataDir, 'wrong.pem')
    fs.writeFileSync(wrongKey, generateTeamKey().privatePem, { mode: 0o600 })
    const bad = spawnFakeTeam({ RELAY_URL: `ws://127.0.0.1:${S.port}/connect`, TEAM_ID: S.teamId, KEY_FILE: wrongKey, INSTANCE: 'badkey01', CONNS: '1', BACKOFF_BASE_MS: '100' }, `t7-bad-${Date.now()}`)
    await Bun.sleep(3000)
    bad.kill()
    const retries = logLines(bad.log).filter((l) => l.msg === 'relay disconnected').map((l) => l.code)
    notes.t7 = { wrongKeyRetries: retries.length }
    expect(retries.length).toBeGreaterThanOrEqual(3)
    expect(retries.every((c) => c === 4003)).toBe(true)
    expect(((await (await fetch(`${S.base}/hello`)).json()) as { instance: string }).instance).toBe('instanceA')
    // (b) instance B takes over
    const c1 = chat(S.wsBase, `t7-${Date.now()}`, 400, 50)
    await Bun.sleep(1500)
    const B = S.startTeam({ INSTANCE: 'instanceB' }, 'teamB')
    await until(async () => { try { return ((await (await fetch(`${S!.base}/hello`)).json()) as { instance: string }).instance === 'instanceB' } catch { return false } }, 8000, 'B serves')
    await Bun.sleep(3000)
    const aLog = logLines(S.team.log)
    expect(aLog.some((l) => l.msg === 'state' && l.state === 'replaced')).toBe(true)
    const aConnectsAfter = aLog.filter((l) => l.msg === 'relay connected').length
    expect(aConnectsAfter).toBe(2) // only its first two control connections, no reconnect after 4009
    expect(logLines(B.log).some((l) => l.msg === 'event' && l.type === 'instance_replaced')).toBe(true)
    const r = await c1.promise
    expect(r.resets).toBe(1) // the old (epoch, seq) is refused by the new process: reset, not silent confusion
    expect(r.done).toBe(true)
    B.kill()
  }, 60_000)

  test('t8 idle sockets: 1,000 idle browser WebSockets + 5 chats; small memory per socket', async () => {
    S = await startStack(PORT, { name: 'teight' })
    const rss0 = rssMb(S.relay.p.pid)
    const socks: WebSocket[] = []
    let open = 0
    for (let i = 0; i < 1000; i += 100) {
      for (let j = 0; j < 100; j++) { const ws = new WebSocket(`${S.wsBase}/idle`); ws.onopen = () => { open++ }; socks.push(ws) }
      await until(() => open >= i + 100, 10_000, 'sockets open')
    }
    const chats = Array.from({ length: 5 }, (_, i) => chat(S!.wsBase, `t8-${i}-${Date.now()}`, 60, 30))
    const rs = await Promise.all(chats.map((c) => c.promise))
    const perSocketKb = ((rssMb(S.relay.p.pid) - rss0) * 1024) / 1000
    for (const s of socks) s.close()
    notes.t8 = { open, perSocketKb: +perSocketKb.toFixed(1), chatLatencyMs: lat(rs.flatMap((r) => r.lat)) }
    expect(open).toBe(1000)
    expect(sum(rs, 'gaps') + sum(rs, 'dups')).toBe(0)
    expect(lat(rs.flatMap((r) => r.lat)).p99).toBeLessThan(250)
    expect(perSocketKb).toBeLessThan(60)
  }, 60_000)

  test('t9 browser flood: a socket that queues more than 4 MB for a stalled team server is closed with 1009', async () => {
    S = await startStack(PORT, { name: 'tnine' })
    const ws = new WebSocket(`${S.wsBase}/idle`)
    await new Promise<void>((r) => { ws.onopen = () => r() })
    const closed = new Promise<number>((r) => { ws.onclose = (e) => r(e.code) })
    process.kill(S.team.p.pid, 'SIGSTOP')
    const chunk = new Uint8Array(64 * 1024)
    for (let i = 0; i < 100; i++) ws.send(chunk) // 6.4 MB
    const code = await Promise.race([closed, Bun.sleep(5000).then(() => -1)])
    process.kill(S.team.p.pid, 'SIGCONT')
    expect(code).toBe(1009)
  }, 30_000)
})

// Conformance harness: a Node 25 relay process + fake team server processes (tests/relay/fake-team.ts), chat
// clients that resume with (epoch, seq), latency stats. Ported from spike-relay/harness.ts, scaled for CI time.
import fs from 'node:fs'
import path from 'node:path'
import { generateTeamKey } from '@mycel/shared/relay-protocol'
import { F_WORK, registerTeam, spawnFakeTeam, spawnNodeRelay, teamUrl, until, waitHttp, type Proc } from '../lib/f-relay'

export interface Stack {
  port: number
  relay: Proc
  team: Proc
  teamId: string
  keyFile: string
  base: string
  wsBase: string
  dataDir: string
  relayEnv: Record<string, string>
  restartRelay(env?: Record<string, string>): Promise<void>
  startTeam(env?: Record<string, string>, tag?: string): Proc
  stop(): void
}

let seq = 0
export async function startStack(port: number, o: { relayEnv?: Record<string, string>; teamEnv?: Record<string, string>; name?: string } = {}): Promise<Stack> {
  const tag = `${o.name ?? 'conf'}-${Date.now()}-${++seq}`
  const dataDir = path.join(F_WORK, tag)
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.mkdirSync(dataDir, { recursive: true })
  const relayEnv = { RELAY_HOLD_MS: '5000', ...o.relayEnv }
  let relay = spawnNodeRelay(port, dataDir, relayEnv, `${tag}-relay`)
  await waitHttp(`http://127.0.0.1:${port}/healthz`, 10_000)
  const name = o.name ?? 'alpha'
  const kp = generateTeamKey()
  const reg = await registerTeam(`http://127.0.0.1:${port}`, name, kp)
  const keyFile = path.join(dataDir, 'team-key.pem')
  fs.writeFileSync(keyFile, kp.privatePem, { mode: 0o600 })
  const teamEnvBase = { RELAY_URL: `ws://127.0.0.1:${port}/connect`, TEAM_ID: reg.teamId, KEY_FILE: keyFile, ...o.teamEnv }
  const startTeam = (env: Record<string, string> = {}, t = 'team') => spawnFakeTeam({ ...teamEnvBase, ...env }, `${tag}-${t}`)
  const team = startTeam()
  const base = teamUrl(port, name, '').replace(/\/$/, '')
  await waitHttp(`${base}/hello`, 10_000)
  const stack: Stack = {
    port, relay, team, teamId: reg.teamId, keyFile, base, wsBase: base.replace(/^http/, 'ws'), dataDir, relayEnv,
    async restartRelay(env = {}) {
      relay = spawnNodeRelay(port, dataDir, { ...relayEnv, ...env }, `${tag}-relay`)
      stack.relay = relay
      await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok } catch { return false } }, 10_000, 'relay up')
    },
    startTeam,
    stop() { stack.relay.kill(); stack.team.kill() },
  }
  return stack
}

export const pct = (a: number[], p: number) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] }
export const lat = (a: number[]) => ({ n: a.length, p50: pct(a, 50), p99: pct(a, 99), max: a.length ? Math.max(...a) : NaN })

export type ChatResult = { id: string; got: number; gaps: number; dups: number; lat: number[]; reconnects: number; resets: number; closes: string[]; done: boolean }

/**
 * Follows one chat; after any close it reconnects (0-1 s random, then 1, 2, 4 ... s capped at 10 s: tab 6) with
 * ?epoch=<epoch>&after=<last seq>. A reset (other epoch) means "reload from REST": here, start counting again.
 */
export function chat(wsBase: string, id: string, n = 200, iv = 50): { result: ChatResult; promise: Promise<ChatResult>; stop(): void } {
  const r: ChatResult = { id, got: 0, gaps: 0, dups: 0, lat: [], reconnects: 0, resets: 0, closes: [], done: false }
  let last = 0
  let epoch = ''
  let attempt = 0
  let stopped = false
  let cur: WebSocket | null = null
  const promise = new Promise<ChatResult>((resolve) => {
    const go = () => {
      if (stopped) return resolve(r)
      const ws = new WebSocket(`${wsBase}/chat?id=${id}&n=${n}&iv=${iv}${epoch ? `&epoch=${epoch}&after=${last}` : ''}`)
      cur = ws
      ws.onmessage = (e) => {
        const ev = JSON.parse(String(e.data)) as { type?: string; epoch: string; seq: number; ts: number; done?: boolean }
        attempt = 0
        if (ev.type === 'hello') { epoch = ev.epoch; return }
        if (ev.type === 'reset') { r.resets++; epoch = ev.epoch; last = 0; return }
        if (ev.seq <= last) { r.dups++; return }
        if (ev.seq > last + 1) r.gaps += ev.seq - last - 1
        last = ev.seq
        if (ev.done) { r.done = true; ws.close(); return }
        r.got++
        r.lat.push(Date.now() - ev.ts)
      }
      ws.onclose = (e) => {
        if (r.done || stopped) return resolve(r)
        r.closes.push(`${e.code}`)
        r.reconnects++
        const d = attempt === 0 ? Math.random() * 1000 : Math.min(10_000, 1000 * 2 ** (attempt - 1))
        attempt++
        setTimeout(go, d)
      }
    }
    go()
  })
  return { result: r, promise, stop() { stopped = true; try { cur?.close() } catch {} } }
}

export const sum = (rs: ChatResult[], k: 'gaps' | 'dups' | 'got' | 'resets' | 'reconnects') => rs.reduce((a, r) => a + r[k], 0)

export async function sh(cmd: string): Promise<string> {
  const p = Bun.spawn(['sh', '-c', cmd], { stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(p.stdout).text()
  await p.exited
  return out.trim()
}

export function expectedSha(n: number): string {
  const b = new Uint8Array(1 << 20)
  let x = 2463534242
  for (let i = 0; i < b.length; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; b[i] = x & 255 }
  const h = new Bun.CryptoHasher('sha256')
  let off = 0
  while (off < n) { const k = Math.min(b.length, n - off); h.update(b.subarray(0, k)); off += k }
  return h.digest('hex')
}

export function logLines(file: string): Record<string, unknown>[] {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l) } catch { return {} } })
}

export async function debug(base: string, rid: string): Promise<Record<string, number>> {
  return (await (await fetch(`${base}/_debug?rid=${rid}`)).json()) as Record<string, number>
}

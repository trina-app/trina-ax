// F2 sleep, relay side without processes: the wake client (signature, one call per team per 10 s with a shared answer,
// the global cap, strictly increasing timestamps, answers it does not trust), the wake settings, which requests are
// browser page loads, and the team server's time-jump detector that reconnects the relay connections after a resume.
import { afterEach, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { generateTeamKey, loadPrivateKey } from '@mycel/shared/relay-protocol'
import { WAKE_API_PATH, parseWakeAuthorizationHeader, wakeSigningString } from '@mycel/shared/cloud-protocol/relay-ops'
import { GLOBAL_PER_MIN, TEAM_GAP_MS, WakeClient, type WakeFetch } from '../../relay/src/wake.ts'
import { loadRelayConfig } from '../../relay/src/config.ts'
import { isNavigation } from '../../relay/src/relay.ts'
import { TimeJumpWatch } from '../../server/src/relay-client/time-jump'
import { RelayClient } from '../../server/src/relay-client/client'
import { WORK } from '../lib/env'

const W = path.join(WORK, `f2-relay-wake-${process.pid}`)
afterEach(() => fs.rmSync(W, { recursive: true, force: true }))
const quiet = { info() {}, warn() {}, error() {} }

function keyFile() {
  fs.mkdirSync(W, { recursive: true })
  const k = crypto.generateKeyPairSync('ed25519')
  const f = path.join(W, `wake-${Math.random().toString(36).slice(2)}.pem`)
  fs.writeFileSync(f, k.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  return { file: f, pub: k.publicKey }
}

describe('wake client', () => {
  test('signed request; one call per team per 10 s (the answer is shared); strictly increasing ts', async () => {
    const k = keyFile()
    let now = 1_000_000
    const seen: { url: string; body: string; auth: string }[] = []
    const fetch: WakeFetch = async (url, i) => { seen.push({ url, body: i.body, auth: i.headers.authorization! }); return { ok: true, status: 200, json: async () => ({ state: 'waking', retryAfterSec: 4 }) } }
    const w = new WakeClient({ url: 'https://cp.example', keyFile: k.file, keyId: 'relay-1', log: quiet, fetch, now: () => now })
    const [a, b] = await Promise.all([w.wake('T1', 'http'), w.wake('T1', 'ws')])
    expect(a).toEqual({ state: 'waking', retryAfterSec: 4 })
    expect(b).toBe(a)
    expect(seen.length).toBe(1)
    expect(seen[0]!.url).toBe('https://cp.example' + WAKE_API_PATH)
    expect(JSON.parse(seen[0]!.body)).toEqual({ teamId: 'T1', reason: 'http' })
    const h = parseWakeAuthorizationHeader(seen[0]!.auth)!
    expect(h.keyId).toBe('relay-1')
    expect(crypto.verify(null, Buffer.from(wakeSigningString(WAKE_API_PATH, h.ts, seen[0]!.body)), k.pub, Buffer.from(h.sig, 'base64'))).toBe(true)
    await w.wake('T2', 'http')
    expect(parseWakeAuthorizationHeader(seen[1]!.auth)!.ts).toBe(h.ts + 1) // same millisecond: ts + 1
    now += TEAM_GAP_MS
    await w.wake('T1', 'http')
    expect(seen.length).toBe(3)
  })

  test('global cap per minute; a bad or failed answer is an error, never trusted', async () => {
    const k = keyFile()
    let now = 5_000_000
    let answer: unknown = { state: 'awake', retryAfterSec: 0 }
    let status = 200
    let fail = false
    const fetch: WakeFetch = async () => { if (fail) throw new Error('net'); return { ok: status === 200, status, json: async () => answer } }
    const w = new WakeClient({ url: 'https://cp.example', keyFile: k.file, keyId: 'k', log: quiet, fetch, now: () => now })
    for (let i = 0; i < GLOBAL_PER_MIN; i++) expect((await w.wake(`A${i}`, 'http')).state).toBe('awake')
    expect((await w.wake('over', 'http')).state).toBe('error')
    expect(w.counters.wakeLimited).toBe(1)
    now += 60_000
    answer = { state: 'asleep-ish', retryAfterSec: 1 }
    expect((await w.wake('B1', 'http')).state).toBe('error')
    answer = { state: 'busy', retryAfterSec: 99_999 }
    expect(await w.wake('B2', 'http')).toEqual({ state: 'busy', retryAfterSec: 3600 })
    status = 401
    expect((await w.wake('B3', 'http')).state).toBe('error')
    fail = true
    expect((await w.wake('B4', 'http')).state).toBe('error')
    expect(w.counters.wakeErrors).toBe(3)
  })

  test('only an Ed25519 key', () => {
    fs.mkdirSync(W, { recursive: true })
    const f = path.join(W, 'rsa.pem')
    fs.writeFileSync(f, crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }))
    expect(() => new WakeClient({ url: 'https://cp.example', keyFile: f, keyId: 'k', log: quiet })).toThrow(/Ed25519/)
  })
})

describe('wake settings', () => {
  const base = { RELAY_DOMAIN: 'trina.app' }
  test('off without RELAY_WAKE_URL; defaults 20 s / 2.5 s; https, or http to loopback / Tailscale only', () => {
    expect(loadRelayConfig([], base).wake).toBeNull()
    const on = loadRelayConfig([], { ...base, RELAY_WAKE_URL: 'https://cp.trina.app/', RELAY_WAKE_KEY_FILE: '/k.pem', RELAY_WAKE_KEY_ID: 'relay-kr1' }).wake
    expect(on).toEqual({ url: 'https://cp.trina.app', keyFile: '/k.pem', keyId: 'relay-kr1', holdMs: 20_000, pageMs: 2500 })
    expect(loadRelayConfig([], { ...base, RELAY_WAKE_URL: 'http://100.87.15.118:8443', RELAY_WAKE_KEY_FILE: '/k', RELAY_WAKE_KEY_ID: 'k' }).wake?.url).toBe('http://100.87.15.118:8443')
    expect(() => loadRelayConfig([], { ...base, RELAY_WAKE_URL: 'http://cp.trina.app', RELAY_WAKE_KEY_FILE: '/k', RELAY_WAKE_KEY_ID: 'k' })).toThrow(/https/)
    expect(() => loadRelayConfig([], { ...base, RELAY_WAKE_URL: 'https://cp.trina.app' })).toThrow(/KEY_FILE/)
  })
})

describe('browser page loads (the waking page)', () => {
  const r = (method: string, url: string, headers: Record<string, string>) => ({ method, url, headers })
  test('GET/HEAD for HTML outside /api/, plus the two provider callbacks', () => {
    expect(isNavigation(r('GET', '/', { accept: 'text/html,*/*' }))).toBe(true)
    expect(isNavigation(r('HEAD', '/x', { 'sec-fetch-mode': 'navigate' }))).toBe(true)
    expect(isNavigation(r('GET', '/api/integrations/oauth/callback?code=1', { accept: 'text/html' }))).toBe(true)
    expect(isNavigation(r('GET', '/api/integrations/google-drive/callback?code=1', { 'sec-fetch-mode': 'navigate' }))).toBe(true)
    expect(isNavigation(r('GET', '/api/me', { accept: 'text/html' }))).toBe(false)
    expect(isNavigation(r('POST', '/', { accept: 'text/html' }))).toBe(false)
    expect(isNavigation(r('GET', '/', { accept: 'application/json' }))).toBe(false)
  })
})

describe('time-jump detector', () => {
  test('fires on a gap over the limit or a clock set back, not on normal ticks', () => {
    let now = 0
    const gaps: number[] = []
    const w = new TimeJumpWatch({ onJump: (g) => gaps.push(g), now: () => now })
    w.start(); w.stop()
    now += 2000; w.tick()
    now += 14_000; w.tick()
    expect(gaps).toEqual([])
    now += 3_600_000; w.tick()
    now -= 60_000; w.tick()
    expect(gaps).toEqual([3_600_000, -60_000])
  })

  test('the relay client drops its connections and connects again at once', async () => {
    let opens = 0, closes = 0
    const srv = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req, s) { return s.upgrade(req) ? undefined : new Response('x') }, websocket: { open() { opens++ }, close() { closes++ }, message() {} } })
    const kp = generateTeamKey()
    const c = new RelayClient({
      url: `ws://127.0.0.1:${srv.port}/connect`, teamId: 'T', key: loadPrivateKey(kp.privatePem), connections: 2,
      fetch: async () => new Response('x'), log: { debug() {}, info() {}, warn() {}, error() {} },
    })
    try {
      c.start()
      const until = async (f: () => boolean) => { for (let i = 0; i < 300 && !f(); i++) await Bun.sleep(10); return f() }
      expect(await until(() => opens === 2)).toBe(true)
      c.reconnectAll(3_600_000)
      expect(await until(() => opens === 4 && closes >= 2)).toBe(true)
      expect(c.stats.timeJumps).toBe(1)
    } finally { c.stop(); srv.stop(true) }
  })
})

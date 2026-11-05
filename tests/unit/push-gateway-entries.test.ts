// The push gateway's two entries: the Cloudflare Worker (push-gateway/src/worker.ts: BLOCKED KV + LIMITER Durable
// Object, faked here with the few members the code uses) and the Bun entry (push-gateway/src/bun.ts: APNs over
// node:http2, state in SQLite), driven end to end against a local HTTP/2 server that stands in for APNs.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import http2 from 'node:http2'
import path from 'node:path'
import { pushGatewayAuthorization, pushGatewaySigningString } from '../../shared/src/cloud-protocol/push-gateway.ts'
import { http2Fetch, serve } from '../../push-gateway/src/bun.ts'
import type { GatewayEnv, LogLine } from '../../push-gateway/src/gateway.ts'
import { createWorker, PushLimiter, type DurableObjectStorageLike, type WorkerEnv } from '../../push-gateway/src/worker.ts'

const T0 = Date.UTC(2025, 0, 6) // in the past: the Durable Object's alarm (real clock) finds these records expired
const TOKEN = 'ef'.repeat(32)

const team = (() => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const der = publicKey.export({ format: 'der', type: 'spki' })
  return { priv: privateKey, pub: der.toString('base64'), keyId: createHash('sha256').update(der).digest('hex') }
})()
const apnsKey = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const ENV: GatewayEnv = {
  APNS_KEY_ID: 'KEYID12345', APNS_TEAM_ID: 'TEAMID1234', APNS_TOPIC: 'app.example.test',
  APNS_PRIVATE_KEY: apnsKey.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
}
const body = (o: Record<string, unknown> = {}) => JSON.stringify({
  v: 1, platform: 'ios', environment: 'production', token: TOKEN, notificationId: 'n1', code: 'room.message', locale: 'en', ...o,
})
function signed(url: string, text: string, ts: number): Request {
  const sig = sign(null, Buffer.from(pushGatewaySigningString(ts, createHash('sha256').update(text).digest('hex'))), team.priv).toString('base64')
  return new Request(url, { method: 'POST', headers: { authorization: pushGatewayAuthorization(team.pub, ts, sig) }, body: text })
}

class FakeStorage implements DurableObjectStorageLike {
  map = new Map<string, unknown>()
  alarm: number | null = null
  async get<T>(k: string) { return structuredClone(this.map.get(k)) as T | undefined }
  async put(k: string, v: unknown) { this.map.set(k, structuredClone(v)) }
  async delete(k: string) { return this.map.delete(k) }
  async list() { return new Map(this.map) }
  async getAlarm() { return this.alarm }
  async setAlarm(t: number) { this.alarm = t }
}

describe('push gateway Worker: BLOCKED KV and the LIMITER Durable Object', () => {
  function worker() {
    const objects = new Map<string, { limiter: PushLimiter; storage: FakeStorage }>()
    const blocked = new Map<string, string>()
    const kvReads: { key: string; cacheTtl?: number }[] = []
    const env: WorkerEnv = {
      ...ENV,
      BLOCKED: { async get(key, o) { kvReads.push({ key, cacheTtl: o?.cacheTtl }); return blocked.get(key) ?? null } },
      LIMITER: {
        idFromName: (name: string) => name,
        get: (id: unknown) => {
          let o = objects.get(id as string)
          if (!o) {
            const storage = new FakeStorage()
            objects.set(id as string, (o = { limiter: new PushLimiter({ storage }), storage }))
          }
          const limiter = o.limiter
          return { fetch: (url: string, init?: RequestInit) => limiter.fetch(new Request(url, init)) }
        },
      },
    }
    const sent: string[] = []
    const logs: LogLine[] = []
    const clock = { t: T0 }
    const w = createWorker({ fetch: async (url) => { sent.push(url); return new Response(null, { status: 200 }) }, now: () => clock.t, log: (l) => logs.push(l) })
    const send = (text: string) => w.fetch(signed('https://push.example.test/v1/send', text, clock.t), env)
    return { w, env, objects, blocked, kvReads, sent, logs, clock, send }
  }

  test('a send goes through the KV blocklist and two Durable Objects (team key, device token); dedupe and limits hold there', async () => {
    const h = worker()
    expect((await h.send(body())).status).toBe(200)
    expect((await h.send(body())).status).toBe(200) // duplicate
    expect(h.sent).toEqual([`https://api.push.apple.com/3/device/${TOKEN}`])
    expect(h.kvReads).toEqual([{ key: team.keyId, cacheTtl: 60 }, { key: team.keyId, cacheTtl: 60 }])
    const tokenId = createHash('sha256').update(TOKEN).digest('hex')
    expect([...h.objects.keys()].sort()).toEqual([`k:${team.keyId}`, `t:${tokenId}`])
    const k = h.objects.get(`k:${team.keyId}`)!.storage
    expect(k.map.get('seen')).toEqual({ firstSeenMs: T0 })
    expect(k.map.get(`d:${tokenId}:n1`)).toEqual({ until: T0 + 600_000 })
    expect(k.alarm).not.toBeNull()
    for (let i = 2; i <= 20; i++) expect((await h.send(body({ notificationId: `n${i}` }))).status).toBe(200)
    const limited = await h.send(body({ notificationId: 'n21' }))
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
    expect(k.map.has(`d:${tokenId}:n21`)).toBe(false) // released: the token limit refused it
    expect(h.sent.length).toBe(20)
  })

  test('a key in BLOCKED is 403 and touches no Durable Object', async () => {
    const h = worker()
    h.blocked.set(team.keyId, 'abuse')
    const r = await h.send(body())
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({ ok: false, error: 'key_blocked' })
    expect(h.objects.size).toBe(0)
    expect(h.sent).toEqual([])
  })

  test('the alarm sweeps expired windows and dedupe entries, keeps the first-seen record', async () => {
    const h = worker()
    expect((await h.send(body())).status).toBe(200)
    for (const { limiter, storage } of h.objects.values()) {
      await limiter.alarm()
      expect([...storage.map.keys()]).toEqual(storage.map.has('seen') ? ['seen'] : [])
    }
    expect(h.objects.get(`k:${team.keyId}`)!.storage.map.get('seen')).toEqual({ firstSeenMs: T0 })
  })

  test('a failing Durable Object is a 500 internal, nothing is sent', async () => {
    const h = worker()
    h.env.LIMITER = { idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response('boom', { status: 500 }) }) }
    const r = await createWorker({ fetch: async (url) => { h.sent.push(url); return new Response(null) }, now: () => T0, log: () => {} })
      .fetch(signed('https://push.example.test/v1/send', body(), T0), h.env)
    expect(r.status).toBe(500)
    expect(await r.json()).toEqual({ ok: false, error: 'internal' })
    expect(h.sent).toEqual([])
  })
})

describe('push gateway Bun entry: APNs over HTTP/2, SQLite state', () => {
  const seen: { path: string; headers: http2.IncomingHttpHeaders; body: string; version: string }[] = []
  const apns = http2.createServer((req, res) => {
    let b = ''
    req.on('data', (c) => { b += c })
    req.on('end', () => {
      seen.push({ path: req.url, headers: req.headers, body: b, version: req.httpVersion })
      if (req.url.includes('dead')) {
        res.writeHead(410, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ reason: 'Unregistered', timestamp: 1 }))
      } else {
        res.writeHead(200, { 'apns-id': 'id-1' })
        res.end()
      }
    })
  })
  let h2: ReturnType<typeof http2Fetch>
  let gw: ReturnType<typeof serve>
  let base = ''
  beforeAll(async () => {
    await new Promise<void>((r) => apns.listen(0, '127.0.0.1', () => r()))
    const apnsHost = `127.0.0.1:${(apns.address() as { port: number }).port}`
    h2 = http2Fetch([apnsHost])
    gw = serve({ env: ENV, dbPath: ':memory:', port: 0, fetch: h2, endpoints: { apnsProduction: `http://${apnsHost}` }, log: () => {} })
    base = `http://127.0.0.1:${gw.server.port}`
  })
  afterAll(() => {
    gw.stop()
    h2.close()
    apns.close()
  })

  test('health, a send over HTTP/2 with the APNs headers, 410 passed on', async () => {
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true })
    const r = await fetch(signed(`${base}/v1/send`, body(), Date.now()))
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true })
    expect(seen.length).toBe(1)
    expect(seen[0]!.version).toBe('2.0')
    expect(seen[0]!.path).toBe(`/3/device/${TOKEN}`)
    expect(seen[0]!.headers['apns-topic']).toBe('app.example.test')
    expect(seen[0]!.headers['apns-push-type']).toBe('alert')
    expect(String(seen[0]!.headers.authorization)).toMatch(/^bearer /)
    expect(JSON.parse(seen[0]!.body).aps.alert).toEqual({ title: 'Trina AX', body: 'You have a new message' })
    const dead = await fetch(signed(`${base}/v1/send`, body({ token: 'dead'.repeat(16) }), Date.now()))
    expect(dead.status).toBe(410)
    expect(await dead.json()).toEqual({ ok: false, error: 'token_invalid' })
    expect(seen.length).toBe(2) // the same HTTP/2 session
  })

  test('SQLite keeps the first-seen record and dedupe; block / unblock', async () => {
    expect(gw.store.db.query('SELECT k FROM shard WHERE shard = ? ORDER BY k').all(`k:${team.keyId}`).map((r) => (r as { k: string }).k))
      .toEqual(['b:min', `d:${createHash('sha256').update(TOKEN).digest('hex')}:n1`, 'seen'])
    expect((await fetch(signed(`${base}/v1/send`, body(), Date.now()))).status).toBe(200) // duplicate
    expect(seen.length).toBe(2)
    gw.store.block(team.keyId, Date.now())
    expect((await fetch(signed(`${base}/v1/send`, body({ notificationId: 'n2' }), Date.now()))).status).toBe(403)
    gw.store.unblock(team.keyId)
    expect((await fetch(signed(`${base}/v1/send`, body({ notificationId: 'n2' }), Date.now()))).status).toBe(200)
    gw.store.sweep(Date.now() + 86_400_000)
    expect(gw.store.db.query('SELECT k FROM shard').all()).toEqual([{ k: 'seen' }])
  })

  test('key-id prints the key id of a public key', () => {
    const p = Bun.spawnSync(['bun', path.resolve(import.meta.dir, '../../push-gateway/src/bun.ts'), 'key-id', team.pub])
    expect(p.exitCode).toBe(0)
    expect(p.stdout.toString().trim()).toBe(team.keyId)
  })
})

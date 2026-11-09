// The push gateway's server (push-gateway/src/bun.ts): APNs over node:http2, state in SQLite, the client address from
// the socket or a trusted proxy header. Driven end to end against a local HTTP/2 server that stands in for APNs.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import fs from 'node:fs'
import http2 from 'node:http2'
import os from 'node:os'
import path from 'node:path'
import { pushGatewayAuthorization, pushGatewaySigningString } from '../../shared/src/cloud-protocol/push-gateway.ts'
import { clientAddress, http2Fetch, openSqlite, serve } from '../../push-gateway/src/bun.ts'
import type { GatewayEnv } from '../../push-gateway/src/gateway.ts'

const TOKEN = 'ef'.repeat(32)
const TOKEN_ID = createHash('sha256').update(TOKEN).digest('hex')

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
function signed(url: string, text: string, headers: Record<string, string> = {}): Request {
  const ts = Date.now()
  const sig = sign(null, Buffer.from(pushGatewaySigningString(ts, createHash('sha256').update(text).digest('hex'))), team.priv).toString('base64')
  return new Request(url, { method: 'POST', headers: { authorization: pushGatewayAuthorization(team.pub, ts, sig), ...headers }, body: text })
}

describe('push gateway client address', () => {
  const req = (h: Record<string, string>) => new Request('https://push.example.test/v1/send', { headers: h })
  test('the socket address unless a proxy header is trusted; then its right-most entry; an odd header falls back', () => {
    expect(clientAddress(req({ 'x-forwarded-for': '198.51.100.7' }), '127.0.0.1', null)).toBe('127.0.0.1')
    expect(clientAddress(req({ 'x-forwarded-for': '203.0.113.66, 198.51.100.7' }), '127.0.0.1', 'x-forwarded-for')).toBe('198.51.100.7')
    expect(clientAddress(req({ 'x-forwarded-for': ' 2001:db8::5 ' }), '127.0.0.1', 'x-forwarded-for')).toBe('2001:db8::5')
    expect(clientAddress(req({ 'cf-connecting-ip': '198.51.100.8' }), '127.0.0.1', 'cf-connecting-ip')).toBe('198.51.100.8')
    expect(clientAddress(req({ 'x-forwarded-for': 'evil<script>' }), '127.0.0.1', 'x-forwarded-for')).toBe('127.0.0.1')
    expect(clientAddress(req({}), '127.0.0.1', 'x-forwarded-for')).toBe('127.0.0.1')
    expect(clientAddress(req({}), undefined, null)).toBe('unknown')
  })
  test('TRUST_PROXY_HEADER must be a header name', () => {
    expect(() => serve({ env: ENV, dbPath: ':memory:', port: 0, trustProxyHeader: 'x-forwarded-for: 1' })).toThrow(/header name/)
  })
})

describe('push gateway server: APNs over HTTP/2, SQLite state', () => {
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
    gw = serve({
      env: ENV, dbPath: ':memory:', port: 0, fetch: h2, endpoints: { apnsProduction: `http://${apnsHost}` }, log: () => {},
      trustProxyHeader: 'x-forwarded-for',
    })
    base = `http://127.0.0.1:${gw.server.port}`
  })
  afterAll(() => {
    gw.stop()
    h2.close()
    apns.close()
  })

  test('health, a send over HTTP/2 with the APNs headers and payload, 410 passed on', async () => {
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true })
    const r = await fetch(signed(`${base}/v1/send`, body({ tag: 'dev-1' }), { 'x-forwarded-for': '203.0.113.9' }))
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true })
    expect(seen.length).toBe(1)
    expect(seen[0]!.version).toBe('2.0')
    expect(seen[0]!.path).toBe(`/3/device/${TOKEN}`)
    expect(seen[0]!.headers['apns-topic']).toBe('app.example.test')
    expect(seen[0]!.headers['apns-push-type']).toBe('alert')
    expect(String(seen[0]!.headers.authorization)).toMatch(/^bearer /)
    expect(JSON.parse(seen[0]!.body)).toEqual({
      // a room code: mutable for the app's notification extension, the generic alert as the fallback
      aps: { alert: { title: 'Trina AX', body: 'You have a new message' }, sound: 'default', 'mutable-content': 1 },
      body: { notificationId: 'n1', code: 'room.message', device: 'dev-1' },
    })
    const dead = await fetch(signed(`${base}/v1/send`, body({ token: 'dead'.repeat(16) })))
    expect(dead.status).toBe(410)
    expect(await dead.json()).toEqual({ ok: false, error: 'token_invalid' })
    expect(seen.length).toBe(2) // the same HTTP/2 session
    // the client limit counted the proxy header's address, and the socket address when there was none; memory only
    expect([...gw.state.clients.shards.keys()].sort()).toEqual(['c:127.0.0.1', 'c:203.0.113.9'])
    expect(gw.store.db.query("SELECT count(*) AS n FROM shard WHERE shard LIKE 'c:%'").get()).toEqual({ n: 0 })
  })

  test('SQLite keeps the confirmed first-seen record, dedupe and the (key, token) window; block / unblock', async () => {
    const keyRows = gw.store.db.query('SELECT k, until FROM shard WHERE shard = ? ORDER BY k').all(`k:${team.keyId}`) as { k: string; until: number | null }[]
    expect(keyRows.map((r) => r.k)).toEqual(['b:min', `d:${TOKEN_ID}:n1`, 'seen'])
    expect(keyRows.find((r) => r.k === 'seen')!.until).toBeNull() // delivered: kept
    const pair = createHash('sha256').update(`${team.keyId}:${TOKEN_ID}`).digest('hex')
    expect(gw.store.db.query('SELECT k FROM shard WHERE shard = ? ORDER BY k').all(`t:${pair}`)).toEqual([{ k: 'b:day' }, { k: 'b:min' }])
    expect((await fetch(signed(`${base}/v1/send`, body()))).status).toBe(200) // duplicate
    expect(seen.length).toBe(2)
    gw.store.block(team.keyId, Date.now())
    expect((await fetch(signed(`${base}/v1/send`, body({ notificationId: 'n2' })))).status).toBe(403)
    gw.store.unblock(team.keyId)
    expect((await fetch(signed(`${base}/v1/send`, body({ notificationId: 'n2' })))).status).toBe(200)
    gw.store.sweep(Date.now() + 2 * 86_400_000)
    expect(gw.store.db.query('SELECT shard, k FROM shard').all()).toEqual([{ shard: `k:${team.keyId}`, k: 'seen' }])
  })

  test('the CLI: key-id prints the key id; block and unblock write the blocklist table', () => {
    const cli = path.resolve(import.meta.dir, '../../push-gateway/src/bun.ts')
    const p = Bun.spawnSync(['bun', cli, 'key-id', team.pub])
    expect(p.exitCode).toBe(0)
    expect(p.stdout.toString().trim()).toBe(team.keyId)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-gateway-'))
    try {
      const env = { ...process.env, PUSH_GATEWAY_DB: path.join(dir, 'state.sqlite') }
      expect(Bun.spawnSync(['bun', cli, 'block', team.keyId], { env }).exitCode).toBe(0)
      const store = openSqlite(env.PUSH_GATEWAY_DB)
      expect(store.db.query('SELECT key_id FROM blocked').all()).toEqual([{ key_id: team.keyId }])
      expect(Bun.spawnSync(['bun', cli, 'unblock', team.keyId], { env }).exitCode).toBe(0)
      expect(store.db.query('SELECT key_id FROM blocked').all()).toEqual([])
      store.db.close()
      expect(Bun.spawnSync(['bun', cli, 'block', 'not-a-key-id'], { env, stderr: 'pipe' }).exitCode).not.toBe(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

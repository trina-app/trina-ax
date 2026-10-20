// The real server app behind the relay: route module "relay" starts the client from config, creates the team key
// (0600), registers the address, then relayed requests reach the Hono app with via 'relay' and the real client IP,
// and GET /api/ws as a relay stream is attached through RealtimeHub.attach (component B's hub in production;
// a stand-in here). ctx.services.relay.status() is what GET /api/admin/connection shows.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { buildApp } from '../../server/src/app'
import type { AppConfig } from '../../server/src/app-config'
import { createContext, type AppContext } from '../../server/src/context'
import { openDb } from '../../server/src/db'
import type { AppContextC } from '../../server/src/http/env'
import { silentLogger } from '../../server/src/log'
import { recentRelayEvents } from '../../server/src/relay-client/registration'
import { ROUTE_MODULES, type RouteModule } from '../../server/src/routes'
import type { RealtimeConn, RequestInfo } from '../../server/src/services'
import { F_WORK, startRelay, teamUrl, until, type InProcessRelay } from '../lib/f-relay'

const PORT = 19166
let R: InProcessRelay
let ctx: AppContext
const attached: { info: RequestInfo; url: string; protocol: string }[] = []

// after the real modules (B's chats init installs the real hub; init() runs in order) but before web's catch-all
const modules = (): RouteModule[] => [...ROUTE_MODULES.filter((m) => m.name !== 'web'), testModule, ROUTE_MODULES.find((m) => m.name === 'web')!]

const testModule: RouteModule = {
  name: 'f-test',
  owner: 'F',
  init(c) {
    c.services.realtime = {
      publish() {}, publishEach() {}, disconnectUser() {},
      async attach(conn: RealtimeConn, req: Request, info: RequestInfo) {
        attached.push({ info, url: req.url, protocol: req.headers.get('sec-websocket-protocol') ?? '' })
        conn.onMessage((d) => conn.send(`echo:${d}`))
        conn.send(JSON.stringify({ type: 'hello' }))
      },
    }
  },
  register(kit) {
    kit.raw('GET', '/api/test/whoami', (c) => {
      const info = (c as unknown as AppContextC).get('info')
      return c.json({ ip: info.ip, via: info.via, url: c.req.url })
    })
  },
}

beforeAll(async () => {
  R = await startRelay(PORT)
  const dir = path.join(F_WORK, 'app')
  fs.rmSync(dir, { recursive: true, force: true })
  const config: AppConfig = {
    mode: 'dev', configFile: null, listen: { host: '127.0.0.1', port: 0 }, tls: null, publicOrigins: [],
    teamRoot: path.join(dir, 'team'), dataDir: path.join(dir, 'data'), logDir: null, logLevel: 'error',
    engine: { authMode: 'local-login' }, relay: { url: R.ws, teamName: 'appteam' }, update: { channel: 'stable', feedUrl: null },
    validateResponses: true, setupToken: null,
  }
  fs.mkdirSync(config.dataDir, { recursive: true })
  const db = openDb(path.join(config.dataDir, 'app.db'))
  ctx = createContext({ config, db, log: silentLogger })
  await buildApp(ctx, modules())
  await until(() => ctx.services.relay?.status().state === 'connected', 10_000, 'relay connected')
})
afterAll(async () => {
  await ctx?.close()
  await R?.stop()
})

test('first start: key file 0600, address registered, recovery code saved once, status connected', () => {
  const keyFile = path.join(ctx.config.dataDir, 'relay', 'team-key.pem')
  expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600)
  expect(fs.readFileSync(keyFile, 'utf8')).toContain('PRIVATE KEY')
  const rc = path.join(ctx.config.dataDir, 'relay', 'recovery-code.txt')
  expect(fs.statSync(rc).mode & 0o777).toBe(0o600)
  expect(fs.readFileSync(rc, 'utf8')).toMatch(/Recovery code: [A-Z2-9-]{24}/)
  const st = ctx.services.relay!.status()
  expect(st).toMatchObject({ mode: 'self-relay', address: `http://appteam.localhost:${PORT}`, state: 'connected', detail: null })
  expect(st.connectedSince).toBeString()
  expect(recentRelayEvents(ctx.db).map((e) => e.kind)).toContain('registered')
  expect(R.relay.registry.teamByName('appteam')).toBeDefined()
})

test('relayed requests reach the app in-process with via relay and the real client IP', async () => {
  const res = await fetch(teamUrl(PORT, 'appteam', '/api/test/whoami'), { headers: { 'x-forwarded-for': '9.9.9.9' } })
  expect(await res.json()).toEqual({ ip: '127.0.0.1', via: 'relay', url: `http://appteam.localhost:${PORT}/api/test/whoami` })
  const health = await fetch(teamUrl(PORT, 'appteam', '/api/health'))
  expect(health.status).toBe(200)
  expect(((await health.json()) as { ok: boolean }).ok).toBe(true)
  // contract errors come back unchanged (the relay adds nothing)
  const missing = await fetch(teamUrl(PORT, 'appteam', '/api/nope'))
  expect(missing.status).toBe(404)
  expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('not_found')
})

test('GET /api/ws over the relay is attached through RealtimeHub.attach', async () => {
  const ws = new WebSocket(teamUrl(PORT, 'appteam', '/api/ws?windowId=win12345').replace('http', 'ws'), ['mycel.v1'])
  const msgs: string[] = []
  ws.onmessage = (e) => msgs.push(String(e.data))
  await new Promise<void>((r) => { ws.onopen = () => r() })
  ws.send('hi')
  await until(() => msgs.length >= 2)
  expect(msgs).toEqual(['{"type":"hello"}', 'echo:hi'])
  expect(attached.at(-1)).toEqual({ info: { ip: '127.0.0.1', via: 'relay' }, url: `http://appteam.localhost:${PORT}/api/ws?windowId=win12345`, protocol: 'mycel.v1' })
  ws.close()
})

test('a relay that forgot the team (registry reset): the server registers the address again by itself', async () => {
  const old = R.relay.registry.teamByName('appteam')!
  R.relay.registry.db.exec(`DELETE FROM teams WHERE id = '${old.id}'`)
  R.relay.invalidateNames()
  R.relay.disconnectTeam(old.id, 4003, 'test')
  await until(() => { const t = R.relay.registry.teamByName('appteam'); return t && t.id !== old.id }, 10_000, 'registered again')
  await until(() => ctx.services.relay?.status().state === 'connected', 10_000, 'connected again')
  expect((await fetch(teamUrl(PORT, 'appteam', '/api/health'))).status).toBe(200)
})

test('a second start with the same data folder reuses the registration (no new registration)', async () => {
  const before = R.relay.registry.list().length
  const db2 = openDb(path.join(ctx.config.dataDir, 'app.db'))
  const ctx2 = createContext({ config: { ...ctx.config }, db: db2, log: silentLogger })
  await buildApp(ctx2, modules())
  // same key -> the same team; the new process is a newer instance and takes over
  await until(() => ctx2.services.relay?.status().state === 'connected', 10_000, 'second instance connected')
  await until(() => ctx.services.relay?.status().state === 'replaced', 5000, 'first instance replaced')
  expect(R.relay.registry.list().length).toBe(before)
  await ctx2.close()
})

test('restore on another Mac: the copied DB has the registration but the key is new -> recovery_needed, then the recovery code moves the address', async () => {
  const dir3 = path.join(F_WORK, 'app-restored')
  fs.rmSync(dir3, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir3, 'data'), { recursive: true })
  // a DB copy (backups never hold the key: tab 6 "비밀값")
  const src = openDb(path.join(ctx.config.dataDir, 'app.db'))
  src.exec(`VACUUM INTO '${path.join(dir3, 'data', 'app.db')}'`)
  src.close()
  const db3 = openDb(path.join(dir3, 'data', 'app.db'))
  const ctx3 = createContext({ config: { ...ctx.config, dataDir: path.join(dir3, 'data'), teamRoot: path.join(dir3, 'team') }, db: db3, log: silentLogger })
  await buildApp(ctx3, modules())
  try {
    await until(() => ctx3.services.relay?.status().detail === 'recovery_needed', 10_000, 'recovery needed')
    expect(ctx3.services.relay!.status().state).toBe('not_registered')
    const before = R.relay.registry.list().length
    // a wrong code is refused and changes nothing
    await expect(ctx3.services.relay!.recover!('AAAA-BBBB-CCCC-DDDD-EEEE')).rejects.toThrow('bad recovery code')
    const code = /Recovery code: (\S+)/.exec(fs.readFileSync(path.join(ctx.config.dataDir, 'relay', 'recovery-code.txt'), 'utf8'))![1]
    await ctx3.services.relay!.recover!(code.toLowerCase())
    await until(() => ctx3.services.relay?.status().state === 'connected', 10_000, 'restored server connected')
    expect(R.relay.registry.list().length).toBe(before) // same team, new key
    expect(ctx3.services.relay!.status().address).toBe(`http://appteam.localhost:${PORT}`)
    expect(recentRelayEvents(db3).map((e) => e.kind)).toContain('recovered')
    expect((await fetch(teamUrl(PORT, 'appteam', '/api/health'))).status).toBe(200)
  } finally {
    await ctx3.close()
  }
})

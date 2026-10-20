// Integration: the whole server (real sessions from A, the realtime hub from B, every route module) behind the relay
// (F). Setup and sign-in over the team address, then GET /api/ws as a relay stream: the hub authenticates the
// relayed socket with the session cookie and Origin like a direct upgrade, sends hello and later events.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { CSRF_HEADER, WS_PROTOCOL } from '@mycel/shared/api'
import { buildApp } from '../../server/src/app'
import type { AppConfig } from '../../server/src/app-config'
import { createContext, type AppContext } from '../../server/src/context'
import { openDb } from '../../server/src/db'
import { silentLogger } from '../../server/src/log'
import { egressOf } from '../../server/src/tools/egress'
import { F_WORK, startRelay, teamUrl, until, type InProcessRelay } from '../lib/f-relay'

const PORT = 19169
const TEAM = 'itest'
const SETUP_TOKEN = 'integration-setup-token-0123456789'
const PASSWORD = 'quiet-River-glass-42'
let R: InProcessRelay
let ctx: AppContext
const origin = `http://${TEAM}.localhost:${PORT}`

beforeAll(async () => {
  R = await startRelay(PORT)
  const dir = path.join(F_WORK, 'i-relay')
  fs.rmSync(dir, { recursive: true, force: true })
  const config: AppConfig = {
    mode: 'dev', configFile: null, listen: { host: '127.0.0.1', port: 0 }, tls: null, publicOrigins: [],
    teamRoot: path.join(dir, 'team'), dataDir: path.join(dir, 'data'), logDir: null, logLevel: 'error',
    engine: { authMode: 'local-login' }, relay: { url: R.ws, teamName: TEAM }, update: { channel: 'stable', feedUrl: null },
    validateResponses: true, setupToken: SETUP_TOKEN,
  }
  fs.mkdirSync(config.dataDir, { recursive: true })
  fs.mkdirSync(config.teamRoot, { recursive: true })
  ctx = createContext({ config, db: openDb(path.join(config.dataDir, 'app.db')), log: silentLogger })
  await buildApp(ctx)
  await until(() => ctx.services.relay?.status().state === 'connected', 10_000, 'relay connected')
})
afterAll(async () => {
  await ctx?.close()
  await R?.stop()
})

const post = (p: string, body: unknown, cookie = '') => fetch(teamUrl(PORT, TEAM, p), {
  method: 'POST', body: JSON.stringify(body),
  headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1', origin, ...(cookie ? { cookie } : {}) },
})

function openWs(cookie: string, o: { origin?: string; windowId?: string } = {}) {
  const ws = new WebSocket(teamUrl(PORT, TEAM, `/api/ws?windowId=${o.windowId ?? 'win-relay-1'}`).replace('http', 'ws'), {
    headers: { cookie, origin: o.origin ?? origin }, protocols: [WS_PROTOCOL],
  } as unknown as string[])
  const frames: { type: string; data?: unknown }[] = []
  let closed: { code: number; reason: string } | null = null
  ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)))
  ws.onclose = (e) => { closed = { code: e.code, reason: e.reason } }
  return { ws, frames, closed: () => closed }
}

test('setup and sign-in over the team address; the session works over the relay', async () => {
  const setup = await post('/api/setup', { setupToken: SETUP_TOKEN, teamName: 'Integration', locale: 'en', owner: { username: 'olive', name: 'Olive Owner', password: PASSWORD } })
  expect(setup.status).toBe(201)
  const login = await post('/api/auth/login', { username: 'olive', password: PASSWORD })
  expect(login.status).toBe(200)
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  // http team address: the dev cookie name (https addresses use __Host-sid)
  expect(cookie).toStartWith('mycel-dev-sid=')
  const me = await fetch(teamUrl(PORT, TEAM, '/api/me'), { headers: { cookie } })
  expect(me.status).toBe(200)
  expect(((await me.json()) as { user: { id: string } }).user.id).toBe('olive')

  // relayed WebSocket: hello from B's hub, then the person's events (a chat created over the relay)
  const s = openWs(cookie)
  await until(() => s.frames.some((f) => f.type === 'hello'), 5000, 'hello over the relay')
  const chat = await post('/api/chats', {}, cookie)
  expect(chat.status).toBe(201)
  const id = ((await chat.json()) as { id: string }).id
  await until(() => s.frames.some((f) => f.type === 'chat.updated' && (f.data as { chatId: string }).chatId === id), 5000, 'chat.updated over the relay')
  s.ws.close()

  // another site's Origin is refused by the hub (4403), and no session at all gets 4401
  const foreign = openWs(cookie, { origin: 'http://evil.localhost:1234', windowId: 'win-relay-2' })
  await until(() => foreign.closed(), 5000, 'foreign origin closed')
  expect(foreign.closed()!.code).toBe(4403)
  const anon = openWs('', { windowId: 'win-relay-3' })
  await until(() => anon.closed(), 5000, 'anonymous closed')
  expect(anon.closed()!.code).toBe(4401)
})

test('relayConn: binary messages arrive as text, a late onClose runs at once, sends after close are dropped', async () => {
  const { relayConn } = await import('../../server/src/relay-client/realtime-conn')
  const sent: unknown[] = []
  const v = {
    protocol: WS_PROTOCOL, bufferedAmount: 7, readyState: 'open' as 'open' | 'closing' | 'closed',
    send(d: string | Uint8Array) { sent.push(d) }, close() {},
    onMessage: null as ((d: string | Uint8Array) => void) | null, onClose: null as ((code: number, reason: string) => void) | null,
  }
  const conn = relayConn(v)
  const got: string[] = []
  conn.onMessage((d) => got.push(d))
  v.onMessage!(new TextEncoder().encode('{"type":"ping"}'))
  v.onMessage!('{"type":"ping"}')
  expect(got).toEqual(['{"type":"ping"}', '{"type":"ping"}'])
  expect(conn.bufferedAmount()).toBe(7)
  conn.send('a')
  v.onClose!(1006, '')
  conn.send('b')
  expect(sent).toEqual(['a'])
  let late = 0
  conn.onClose(() => late++)
  expect(late).toBe(1)
})

test("the relay tells the team server the address it connected from; web_fetch then knows the office's exit address", () => {
  expect(egressOf(ctx)).toEqual({ known: true, ips: ['127.0.0.1'] })
})

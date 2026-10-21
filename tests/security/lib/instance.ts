// Security test instance: the whole server (every route module, the REAL session service with cookies and CSRF,
// the real realtime hub over a real WebSocket, the real launcher / gate / bridge running the scripted fake engine)
// on its own empty team folder and data folder. Nothing is seeded behind the API's back: the owner is created with
// POST /api/setup, everyone else through the admin API, and every file through the file API, so what the tests
// see is what a real team would see.
import fs from 'node:fs'
import path from 'node:path'
import { websocket } from 'hono/bun'
import { CSRF_HEADER, DEV_SESSION_COOKIE, WINDOW_HEADER, WS_PROTOCOL, type ServerFrame } from '@mycel/shared/api'
import { buildApp } from '../../../server/src/app'
import type { AppConfig } from '../../../server/src/app-config'
import { createContext, type AppContext } from '../../../server/src/context'
import { openDb } from '../../../server/src/db'
import { createLogger, silentLogger } from '../../../server/src/log'
import { ROUTE_MODULES } from '../../../server/src/routes'
import { startServer } from '../../../server/src/server'
import { configureChat, getChatRuntime } from '../../../server/src/chat/runtime'
import { StaticEngines } from '../../../server/src/chat/engines'
import { fakeEngineBin, fakeEngines } from '../../lib/b-harness'
import { WORK } from '../../lib/env'

export const SETUP_TOKEN = 'sec-matrix-setup-token-0123456789abcdef'

export interface Resp { status: number; text: string; json: any; headers: Headers }

/** One signed-in person (or nobody): keeps the session cookie like a browser. */
export class Client {
  cookie: string | null = null
  bearer: string | null = null
  constructor(readonly inst: Instance, readonly label: string, readonly o: { client?: 'web' | 'desktop'; window?: string } = {}) {}

  headers(extra: Record<string, string> = {}, method = 'GET'): Headers {
    const h = new Headers(extra)
    if (this.cookie) h.set('cookie', `${DEV_SESSION_COOKIE}=${this.cookie}`)
    if (this.bearer) h.set('authorization', `Bearer ${this.bearer}`)
    if (this.o.window) h.set(WINDOW_HEADER, this.o.window)
    if (method !== 'GET' && method !== 'HEAD' && !h.has(CSRF_HEADER)) h.set(CSRF_HEADER, '1')
    return h
  }

  async req(method: string, p: string, body?: unknown, o: { headers?: Record<string, string>; raw?: BodyInit; form?: FormData } = {}): Promise<Resp> {
    const h = this.headers(o.headers, method)
    let b: BodyInit | undefined
    if (o.form) b = o.form
    else if (o.raw !== undefined) b = o.raw
    else if (body !== undefined) { b = JSON.stringify(body); h.set('content-type', 'application/json') }
    const res = await fetch(this.inst.url + p, { method, headers: h, body: b, redirect: 'manual' })
    const buf = Buffer.from(await res.arrayBuffer())
    const text = buf.toString('utf8')
    let json: any = null
    try { json = text ? JSON.parse(text) : null } catch { json = null }
    const set = res.headers.get('set-cookie')
    if (set) {
      const m = new RegExp(`${DEV_SESSION_COOKIE}=([^;]*)`).exec(set)
      if (m) this.cookie = m[1] || null
    }
    return { status: res.status, text, json, headers: res.headers }
  }
  get = (p: string) => this.req('GET', p)
  post = (p: string, body?: unknown) => this.req('POST', p, body ?? {})
  put = (p: string, body?: unknown) => this.req('PUT', p, body ?? {})
  patch = (p: string, body?: unknown) => this.req('PATCH', p, body ?? {})
  del = (p: string) => this.req('DELETE', p)

  /** must succeed (2xx), returns the JSON body */
  async ok(method: string, p: string, body?: unknown, o: { form?: FormData; raw?: BodyInit } = {}): Promise<any> {
    const r = await this.req(method, p, body, o)
    if (r.status >= 300) throw new Error(`${this.label}: ${method} ${p} -> ${r.status} ${r.text.slice(0, 300)}`)
    return r.json
  }

  async login(username: string, password: string, client: 'web' | 'desktop' = this.o.client ?? 'web') {
    const r = await this.req('POST', '/api/auth/login', { username, password, client })
    if (r.status !== 200) throw new Error(`login ${username} -> ${r.status} ${r.text}`)
    return r.json
  }

  /** open a realtime socket with this person's cookie */
  async ws(o: { windowId?: string; origin?: string | null } = {}): Promise<Socket> {
    const q = new URLSearchParams({ windowId: o.windowId ?? 'win-' + crypto.randomUUID().slice(0, 8) })
    const h: Record<string, string> = {}
    if (this.cookie) h.cookie = `${DEV_SESSION_COOKIE}=${this.cookie}`
    if (o.origin !== null) h.origin = o.origin ?? this.inst.url
    const sock = new WebSocket(`${this.inst.url.replace('http', 'ws')}/api/ws?${q}`, { headers: h, protocols: [WS_PROTOCOL] } as unknown as string[])
    const s = new Socket(sock, this.label)
    await new Promise<void>((res) => { sock.addEventListener('open', () => res()); sock.addEventListener('close', () => res()); sock.addEventListener('error', () => res()) })
    return s
  }
}

export class Socket {
  frames: ServerFrame[] = []
  raw: string[] = []
  closed: { code: number; reason: string } | null = null
  constructor(readonly ws: WebSocket, readonly label: string) {
    ws.addEventListener('message', (e) => { const s = String(e.data); this.raw.push(s); try { this.frames.push(JSON.parse(s)) } catch {} })
    ws.addEventListener('close', (e) => { this.closed = { code: e.code, reason: e.reason } })
  }
  async next(type: string, pred: (f: any) => boolean = () => true, ms = 8000): Promise<any> {
    const end = Date.now() + ms
    for (;;) {
      const f = this.frames.find((x) => x.type === type && pred(x))
      if (f) return f
      if (this.closed) throw new Error(`${this.label}: socket closed (${this.closed.code}) waiting for ${type}`)
      if (Date.now() > end) throw new Error(`${this.label}: timeout waiting for ${type}; got ${this.frames.map((x) => x.type).join(',')}`)
      await Bun.sleep(25)
    }
  }
  async closedWith(ms = 5000) { const end = Date.now() + ms; while (!this.closed && Date.now() < end) await Bun.sleep(20); return this.closed }
  all(): string { return this.raw.join('\n') }
  close() { try { this.ws.close() } catch {} }
}

export interface Instance {
  ctx: AppContext
  url: string
  base: string
  team: string
  dataDir: string
  client(label: string, o?: { client?: 'web' | 'desktop'; window?: string }): Client
  close(): Promise<void>
}

/** Ports are taken in order from MYCEL_SEC_PORT (default 22180), one per instance, within the 22180-22199 range. */
let nextPort = Number(process.env.MYCEL_SEC_PORT ?? 22180)
export async function startInstance(name: string): Promise<Instance> {
  const base = path.join(WORK, 'security', name)
  fs.rmSync(base, { recursive: true, force: true })
  const team = path.join(base, 'team'), dataDir = path.join(base, 'data')
  for (const d of [team, dataDir]) fs.mkdirSync(d, { recursive: true, mode: 0o700 })
  const port = nextPort++
  const cfg: AppConfig = {
    mode: 'dev', configFile: null, listen: { host: '127.0.0.1', port }, tls: null, publicOrigins: [],
    teamRoot: team, dataDir, logDir: null, logLevel: 'error', engine: { authMode: 'local-login' },
    relay: { url: null, teamName: null }, update: { channel: 'stable', feedUrl: null }, validateResponses: true, setupToken: SETUP_TOKEN,
  }
  const db = openDb(path.join(dataDir, 'app.db'))
  const bin = fakeEngineBin(path.join(base, 'bin'))
  const ctx = createContext({
    config: cfg, db, log: process.env.MYCEL_TEST_LOG ? createLogger({ level: 'debug', name: 'sec' }) : silentLogger,
    startCore: (c) => startServer(c.engineConfig, { db: c.db, files: c.files, launcher: { allowCmds: [bin], sessionRoots: [] } }),
  })
  ctx.engineConfig.runDir = fs.mkdtempSync('/tmp/mycel-sec-')
  configureChat(ctx, { engines: new StaticEngines(fakeEngines(bin, dataDir)), askUserTimeoutMs: 120_000, turnTimeoutMs: 120_000 })
  // the REAL session service (no test session module): cookies, CSRF and Origin checks as in production
  const app = await buildApp(ctx, [...ROUTE_MODULES])
  const server = Bun.serve({ port, hostname: '127.0.0.1', websocket, maxRequestBodySize: 60 * 1024 * 1024, fetch: (req, s) => app.fetch(req, { ip: '127.0.0.1', via: 'direct', server: s }) })
  const url = `http://127.0.0.1:${server.port}`
  const runDir = ctx.engineConfig.runDir
  const inst: Instance = {
    ctx, url, base, team, dataDir,
    client: (label, o) => new Client(inst, label, o),
    async close() {
      server.stop(true)
      await ctx.close()
      db.close()
      fs.rmSync(runDir, { recursive: true, force: true })
    },
  }
  return inst
}

export const rt = (inst: Instance) => getChatRuntime(inst.ctx)

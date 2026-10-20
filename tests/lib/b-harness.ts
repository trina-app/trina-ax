// Component B test harness: the whole app (all route modules) on a real Bun server with WebSockets, the fixture
// team folder, a header-based test session service, and the real launcher / gate / bridge running the fake engine
// (tests/lib/b-fake-engine.ts) or the real engines.
import fs from 'node:fs'
import path from 'node:path'
import { websocket } from 'hono/bun'
import { API, ApiClient, CSRF_HEADER, WINDOW_HEADER, WS_PROTOCOL, uuidv7, type ClientKind, type ServerFrame } from '@mycel/shared/api'
import { buildApp } from '../../server/src/app'
import type { AppConfig } from '../../server/src/app-config'
import { createContext, type AppContext } from '../../server/src/context'
import { openDb } from '../../server/src/db'
import { silentLogger } from '../../server/src/log'
import { ROUTE_MODULES, type RouteModule } from '../../server/src/routes'
import { startServer } from '../../server/src/server'
import type { AuthInfo, SessionService } from '../../server/src/services'
import { configureChat, getChatRuntime, type ChatRuntimeOptions } from '../../server/src/chat/runtime'
import { StaticEngines, type EngineConfs } from '../../server/src/chat/engines'
import { makeFixture, seed } from './fixtures'
import { WORK } from './env'

export const FAKE_ENGINE_TS = path.join(import.meta.dir, 'b-fake-engine.ts')

/** An executable the launcher can run (it only starts allow-listed absolute paths). */
export function fakeEngineBin(dir: string): string {
  const bin = path.join(dir, 'fake-engine')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_ENGINE_TS}" "$@"\n`, { mode: 0o755 })
  return bin
}

export function fakeEngines(bin: string, dataDir: string): EngineConfs {
  return {
    // proxy layout (CLAUDE_CONFIG_DIR inside the chat folder) so the fake's session files stay out of ~/.claude
    claude: { bin, authMode: 'proxy', agentHome: path.join(dataDir, 'agent-home'), modelProxy: { baseUrl: 'http://127.0.0.1:9', kind: 'api-key' } },
    codex: { bin, codexHome: path.join(dataDir, 'codex-home'), agentHome: path.join(dataDir, 'codex-agent-home'), catalog: path.join(dataDir, 'catalog.json'), model: 'fake-1', auth: 'agent-own' },
    problems: {},
    codexModels: ['fake-1', 'fake-2'],
  }
}

const people: Record<string, { id: string; name: string; role: 'owner' | 'admin' | 'member'; locale: 'ko' | 'en' | 'id' }> = {
  alice: { id: 'alice', name: 'Alice Kim', role: 'member', locale: 'en' },
  bob: { id: 'bob', name: 'Bob Lee', role: 'member', locale: 'ko' },
  carol: { id: 'carol', name: 'Carol Park', role: 'admin', locale: 'ko' },
  dana: { id: 'dana', name: 'Dana Choi', role: 'owner', locale: 'ko' },
  erin: { id: 'erin', name: 'Erin Yoo', role: 'member', locale: 'id' },
}
const sessionIds = new Map<string, string>()
/** test session service: x-test-user (cookie-like, needs Origin on WebSockets) or Bearer test-<user> */
export const testSessions: SessionService = {
  async resolve(req) {
    const bearer = /^Bearer test-([a-z]+)$/.exec(req.headers.get('authorization') ?? '')?.[1]
    const who = bearer ?? req.headers.get('x-test-user') ?? ''
    const p = people[who]
    if (!p) return null
    const client = (req.headers.get('x-test-client') ?? 'web') as ClientKind
    const sid = sessionIds.get(who + client) ?? uuidv7()
    sessionIds.set(who + client, sid)
    const a: AuthInfo = { user: { id: p.id, username: p.id, name: p.name, role: p.role, locale: p.locale, mustChangePassword: false }, session: { id: sid, client }, via: bearer ? 'bearer' : 'cookie' }
    return a
  },
  async verifyPassword() { return false },
}
const sessionModule: RouteModule = { name: 'test-sessions', owner: 'A', init(ctx) { ctx.services.sessions = testSessions }, register() {} }

export interface Harness {
  ctx: AppContext
  url: string
  base: string
  team: string
  dataDir: string
  server: ReturnType<typeof Bun.serve>
  api(user: string, o?: { window?: string; client?: ClientKind }): ApiClient
  /** raw request (status checks) */
  req(user: string | null, p: string, init?: RequestInit & { window?: string; client?: ClientKind }): Promise<Response>
  ws(user: string, o?: { windowId?: string; epoch?: string; after?: number; client?: ClientKind; origin?: string | null; bearer?: boolean }): Promise<TestSocket>
  rt(): ReturnType<typeof getChatRuntime>
  close(): Promise<void>
}

export class TestSocket {
  frames: ServerFrame[] = []
  closed: { code: number; reason: string } | null = null
  private waiters: (() => void)[] = []
  constructor(readonly ws: WebSocket) {
    ws.addEventListener('message', (e) => { this.frames.push(JSON.parse(String(e.data))); this.wake() })
    ws.addEventListener('close', (e) => { this.closed = { code: e.code, reason: e.reason }; this.wake() })
  }
  private wake() { for (const w of this.waiters.splice(0)) w() }
  /** wait until a frame matches (default 5 s) */
  async next<T extends ServerFrame['type']>(type: T, pred: (f: Extract<ServerFrame, { type: T }>) => boolean = () => true, ms = 5000): Promise<Extract<ServerFrame, { type: T }>> {
    const end = Date.now() + ms
    for (;;) {
      const f = this.frames.find((x) => x.type === type && pred(x as Extract<ServerFrame, { type: T }>))
      if (f) return f as Extract<ServerFrame, { type: T }>
      if (this.closed) throw new Error(`socket closed (${this.closed.code} ${this.closed.reason}) while waiting for ${type}`)
      if (Date.now() > end) throw new Error(`timeout waiting for ${type}; got ${this.frames.map((x) => x.type).join(',')}`)
      await new Promise<void>((r) => { this.waiters.push(r); setTimeout(r, 50) })
    }
  }
  async closedWith(ms = 5000) {
    const end = Date.now() + ms
    while (!this.closed && Date.now() < end) await Bun.sleep(20)
    return this.closed
  }
  send(o: unknown) { this.ws.send(JSON.stringify(o)) }
  close() { try { this.ws.close() } catch {} }
  lastSeq() { let s = 0; for (const f of this.frames) if ('seq' in f && typeof f.seq === 'number' && f.type !== 'hello' && f.type !== 'resync' && f.type !== 'reset') s = Math.max(s, f.seq); return s }
}

export interface HarnessOptions extends ChatRuntimeOptions {
  name: string
  /** start the launcher with these extra allowed commands (real engines) */
  allowCmds?: string[]
  sessionRoots?: string[]
  /** fake engine (default) or caller-provided engines */
  realEngines?: boolean
  concurrency?: number
}

export async function startHarness(o: HarnessOptions): Promise<Harness> {
  const base = path.join(WORK, o.name)
  const fx = makeFixture(base)
  const dataDir = fx.data
  const cfg: AppConfig = {
    mode: 'dev', configFile: null, listen: { host: '127.0.0.1', port: 0 }, tls: null, publicOrigins: [],
    teamRoot: fx.team, dataDir, logDir: null, logLevel: 'error', engine: { authMode: 'local-login' },
    relay: { url: null, teamName: null }, update: { channel: 'stable', feedUrl: null }, validateResponses: true, setupToken: null,
  }
  const db = openDb(path.join(dataDir, 'app.db'))
  seed(db)
  for (const [id, p] of Object.entries(people)) db.query('UPDATE users SET locale = ? WHERE id = ?').run(p.locale, id)
  if (o.concurrency) db.query("INSERT OR REPLACE INTO settings (key, value) VALUES ('concurrency', ?)").run(JSON.stringify(o.concurrency))
  const bin = fakeEngineBin(path.join(base, 'bin'))
  const ctx = createContext({
    config: cfg, db, log: silentLogger,
    startCore: (c) => startServer(c.engineConfig, { db: c.db, files: c.files, launcher: { allowCmds: [bin, ...(o.allowCmds ?? [])], sessionRoots: o.sessionRoots ?? [] } }),
  })
  // unix socket paths must stay short (macOS: 104 bytes)
  ctx.engineConfig.runDir = fs.mkdtempSync('/tmp/mycel-b-')
  configureChat(ctx, { ...o, engines: o.realEngines ? o.engines : new StaticEngines(fakeEngines(bin, dataDir)) })
  const app = await buildApp(ctx, [sessionModule, ...ROUTE_MODULES])
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', websocket, maxRequestBodySize: 60 * 1024 * 1024, fetch: (req, s) => app.fetch(req, { ip: '127.0.0.1', via: 'test', server: s }) })
  const url = `http://127.0.0.1:${server.port}`
  const headers = (user: string | null, w?: string, client?: ClientKind) => {
    const h: Record<string, string> = {}
    if (user) h['x-test-user'] = user
    if (w) h[WINDOW_HEADER] = w
    if (client) h['x-test-client'] = client
    return h
  }
  const runDir = ctx.engineConfig.runDir
  return {
    ctx, url, base, team: fx.team, dataDir, server,
    api(user, a = {}) {
      const extra = headers(user, a.window, a.client)
      return new ApiClient({ baseUrl: url, windowId: a.window, fetch: ((u: string, init: RequestInit) => fetch(u, { ...init, headers: { ...(init.headers as Record<string, string>), ...extra } })) as unknown as typeof fetch })
    },
    req(user, p, init = {}) {
      const h = new Headers(init.headers)
      for (const [k, v] of Object.entries(headers(user, init.window, init.client))) h.set(k, v)
      if (init.method && init.method !== 'GET' && !h.has(CSRF_HEADER)) h.set(CSRF_HEADER, '1')
      return fetch(url + p, { ...init, headers: h })
    },
    async ws(user, w = {}) {
      const q = new URLSearchParams({ windowId: w.windowId ?? 'win-' + crypto.randomUUID().slice(0, 8) })
      if (w.epoch !== undefined) q.set('epoch', w.epoch)
      if (w.after !== undefined) q.set('after', String(w.after))
      const h: Record<string, string> = w.bearer ? {} : headers(user, undefined, w.client)
      if (w.origin !== null && !w.bearer) h.origin = w.origin ?? url
      if (w.client && w.bearer) h['x-test-client'] = w.client
      const protocols = [WS_PROTOCOL, ...(w.bearer ? [`mycel.bearer.test-${user}`] : [])]
      const sock = new WebSocket(`${url.replace('http', 'ws')}/api/ws?${q}`, { headers: h, protocols } as unknown as string[])
      const t = new TestSocket(sock)
      await new Promise<void>((res) => { sock.addEventListener('open', () => res()); sock.addEventListener('close', () => res()); sock.addEventListener('error', () => res()) })
      return t
    },
    rt: () => getChatRuntime(ctx),
    async close() {
      server.stop(true)
      await ctx.close()
      db.close()
      fs.rmSync(runDir, { recursive: true, force: true })
    },
  }
}

/** Send a message and wait for its message.done on the given socket. */
export async function ask(h: Harness, sock: TestSocket, user: string, chatId: string, content: string, o: { window?: string; client?: ClientKind; ms?: number } = {}) {
  const r = await h.api(user, { window: o.window, client: o.client }).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
  const done = await sock.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, o.ms ?? 20_000)
  return { started: r, done: done.data.message }
}

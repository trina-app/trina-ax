// Test harness for component C: the real HTTP app (all route modules) on the shared fixture team folder, with a
// header-based fake session service ("x-test-user: alice") and a recording realtime hub.
import fs from 'node:fs'
import path from 'node:path'
import type { Hono } from 'hono'
import { uuidv7, type Role, type ServerEventInput } from '@mycel/shared/api'
import { buildApp } from '../../server/src/app'
import type { AppConfig } from '../../server/src/app-config'
import { createContext, type AppContext } from '../../server/src/context'
import { openDb } from '../../server/src/db'
import type { AppEnv } from '../../server/src/http/env'
import { silentLogger } from '../../server/src/log'
import { ROUTE_MODULES, type RouteModule } from '../../server/src/routes'
import type { AuthInfo, RealtimeHub } from '../../server/src/services'
import { TurnFiles, type ToolCtx } from '../../server/src/files/service'
import type { Running } from '../../server/src/server'
import { WORK } from './env'
import { makeFixture, seed } from './fixtures'

export const PEOPLE = ['alice', 'bob', 'carol', 'dana', 'erin'] as const
export type Person = (typeof PEOPLE)[number]

export interface Published { userId: string; ev: ServerEventInput }

export class RecordingHub implements RealtimeHub {
  events: Published[] = []
  /** people treated as connected for publishEach */
  online: string[] = [...PEOPLE]
  publish(userId: string, ev: ServerEventInput) { this.events.push({ userId, ev }) }
  publishEach(build: (userId: string) => ServerEventInput | null) {
    for (const u of this.online) { const ev = build(u); if (ev) this.events.push({ userId: u, ev }) }
  }
  disconnectUser() {}
  of<T extends ServerEventInput['type']>(type: T, userId?: string) {
    return this.events.filter((e) => e.ev.type === type && (!userId || e.userId === userId)).map((e) => e.ev as Extract<ServerEventInput, { type: T }>)
  }
  clear() { this.events = [] }
}

export interface CApp {
  app: Hono<AppEnv>
  ctx: AppContext
  hub: RecordingHub
  team: string
  data: string
  req(p: string, init?: RequestInit & { as?: Person; csrf?: boolean }): Promise<Response>
  json<T = any>(p: string, init?: RequestInit & { as?: Person }): Promise<{ status: number; body: T; res: Response }>
  /** a chat row owned by `user` (chats are component B's; tests insert rows directly) */
  chat(user: Person): string
  /** a running turn row for tool tests */
  turn(user: Person, chatId: string): string
  toolCtx(user: Person, turnId?: string | null): ToolCtx
  close(): Promise<void>
}

export async function makeCApp(name: string, extra: RouteModule[] = [], o: { startCore?: (ctx: AppContext) => Promise<Running> } = {}): Promise<CApp> {
  const fx = makeFixture(path.join(WORK, name))
  const cfg: AppConfig = {
    mode: 'dev', configFile: null, listen: { host: '127.0.0.1', port: 0 }, tls: null, publicOrigins: [],
    teamRoot: fx.team, dataDir: fx.data, logDir: null, logLevel: 'error',
    engine: { authMode: 'local-login' }, relay: { url: null, teamName: null }, update: { channel: 'stable', feedUrl: null },
    validateResponses: true, setupToken: null,
  }
  const db = openDb(path.join(fx.data, 'app.db'))
  seed(db)
  const ctx = createContext({ config: cfg, db, log: silentLogger, ...(o.startCore ? { startCore: o.startCore } : {}) })
  const hub = new RecordingHub()
  const roles = new Map((db.query('SELECT id, role, name FROM users').all() as { id: string; role: Role; name: string }[]).map((u) => [u.id, u]))
  const sessions: RouteModule = {
    name: 'test-sessions', owner: 'A',
    init(c) {
      c.services.sessions = {
        async resolve(req) {
          const id = req.headers.get('x-test-user')
          const u = id ? roles.get(id) : undefined
          if (!u) return null
          return { user: { id: u.id, username: u.id, name: u.name, role: u.role, locale: 'en', mustChangePassword: false }, session: { id: uuidv7(), client: 'web' }, via: 'cookie' } satisfies AuthInfo
        },
        async verifyPassword() { return false },
      }
      c.services.realtime = hub
    },
    register() {},
  }
  const app = await buildApp(ctx, [sessions, ...ROUTE_MODULES.filter((m) => m.name !== 'web'), ...extra])
  const req: CApp['req'] = (p, init = {}) => {
    const h = new Headers(init.headers)
    if (init.as) h.set('x-test-user', init.as)
    if (init.csrf !== false && init.method && init.method !== 'GET' && init.method !== 'HEAD') h.set('x-mycel-csrf', '1')
    return Promise.resolve(app.fetch(new Request('http://team.localhost' + p, { ...init, headers: h }), { ip: '10.0.0.9', via: 'test' }))
  }
  return {
    app, ctx, hub, team: fx.team, data: fx.data, req,
    async json(p, init = {}) {
      const res = await req(p, init)
      const text = await res.text()
      let body: any = null
      try { body = text ? JSON.parse(text) : null } catch { body = text }
      return { status: res.status, body, res }
    },
    chat(user) {
      const id = uuidv7()
      db.query('INSERT INTO chats (id, user_id, title) VALUES (?,?,?)').run(id, user, 'test chat')
      return id
    },
    turn(user, chatId) {
      const id = uuidv7()
      db.query("INSERT INTO turns (id, chat_id, user_id, engine, status) VALUES (?,?,?, 'claude-code', 'running')").run(id, chatId, user)
      return id
    },
    toolCtx(user, turnId = null) { return { user: ctx.files.principal(user), turnId, files: new TurnFiles() } },
    async close() { await ctx.close(); db.close() },
  }
}

export const jsonBody = (b: unknown, method = 'POST'): RequestInit => ({ method, body: JSON.stringify(b), headers: { 'content-type': 'application/json' } })
export const sha256hex = (b: Uint8Array | string) => new Bun.CryptoHasher('sha256').update(b).digest('hex')
export const exists = (team: string, rel: string) => fs.existsSync(path.join(team, ...rel.split('/')))

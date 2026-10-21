// Test harness for component A: a real app (all route modules) on a temp team folder + DB, a recording realtime
// hub, a movable clock, and small HTTP clients that keep their cookie / bearer token like a browser or an app.
import fs from 'node:fs'
import path from 'node:path'
import type { Hono } from 'hono'
import type { AppConfig } from '../../server/src/app-config'
import { buildApp } from '../../server/src/app'
import { createContext, type AppContext } from '../../server/src/context'
import { openDb } from '../../server/src/db'
import type { AppEnv } from '../../server/src/http/env'
import { silentLogger } from '../../server/src/log'
import { authOf, type AuthService } from '../../server/src/auth/service'
import type { RealtimeConn, RealtimeHub } from '../../server/src/services'
import { WORK } from '../lib/env'

export const SETUP_TOKEN = 'setup-token-for-tests-0123456789'
export const OWNER_PW = 'owner horse battery 42'

export function testConfig(name: string, over: Partial<AppConfig> = {}): AppConfig {
  const dir = path.join(WORK, `a-${name}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return {
    mode: 'dev', configFile: null, listen: { host: '127.0.0.1', port: 19110 }, tls: null, publicOrigins: [],
    teamRoot: path.join(dir, 'team'), dataDir: path.join(dir, 'data'), logDir: null, logLevel: 'error',
    engine: { authMode: 'local-login' }, relay: { url: null, teamName: null }, update: { channel: 'stable', feedUrl: null },
    validateResponses: true, setupToken: SETUP_TOKEN, ...over,
  }
}

export interface RecordedEvent { kind: 'publish' | 'disconnectUser' | 'disconnectSession'; target: string; data: unknown }
export class RecordingHub implements RealtimeHub {
  events: RecordedEvent[] = []
  publish(userId: string, ev: unknown) { this.events.push({ kind: 'publish', target: userId, data: ev }) }
  /** recorded once, as sent to everyone ('*') */
  publishEach(build: (userId: string) => unknown) { const ev = build('*'); if (ev) this.events.push({ kind: 'publish', target: '*', data: ev }) }
  disconnectUser(userId: string, reason: string) { this.events.push({ kind: 'disconnectUser', target: userId, data: reason }) }
  disconnectSession(sessionId: string, reason: string) { this.events.push({ kind: 'disconnectSession', target: sessionId, data: reason }) }
  /** people whose replay buffer was dropped (access changed) */
  forgotten: string[] = []
  forgetReplay(userId: string) { this.forgotten.push(userId) }
  async attach(conn: RealtimeConn) { conn.close(1012, 'not in tests') }
}

export interface Harness {
  ctx: AppContext
  app: Hono<AppEnv>
  auth: AuthService
  hub: RecordingHub
  /** raw request through the app with a given real IP (as Bun.serve / the relay client would pass it) */
  fetch(p: string, init?: RequestInit & { ip?: string | null; via?: 'direct' | 'relay' | 'test'; base?: string }): Promise<Response>
  client(o?: { ip?: string | null; base?: string; via?: 'direct' | 'relay' | 'test' }): Client
  /** clock offset in ms added to Date.now() for the auth service */
  advance(ms: number): void
  close(): Promise<void>
}

export async function harness(name: string, over: Partial<AppConfig> = {}): Promise<Harness> {
  const cfg = testConfig(name, over)
  const db = openDb(path.join(cfg.dataDir, 'app.db'))
  const ctx = createContext({ config: cfg, db, log: silentLogger })
  ctx.onClose(() => db.close())
  const hub = new RecordingHub()
  const app = await buildApp(ctx)
  ctx.services.realtime = hub
  const auth = authOf(ctx)
  let offset = 0
  auth.now = () => Date.now() + offset
  const h: Harness = {
    ctx, app, auth, hub,
    async fetch(p, init = {}) {
      const base = init.base ?? 'http://team.localhost'
      return app.fetch(new Request(base + p, init), { ip: init.ip === undefined ? '10.0.0.7' : init.ip, via: init.via ?? 'test' })
    },
    client(o = {}) { return new Client(h, o) },
    advance(ms) { offset += ms },
    async close() { await ctx.close() },
  }
  return h
}

export class ApiFail extends Error {
  constructor(public status: number, public body: any, public headers: Headers) { super(`${status} ${JSON.stringify(body)}`) }
}

/** Keeps a session like a browser (cookie) or an app (bearer). */
export class Client {
  cookie: string | null = null
  token: string | null = null
  lastHeaders: Headers | null = null
  constructor(private h: Harness, private o: { ip?: string | null; base?: string; via?: 'direct' | 'relay' | 'test' } = {}) {}

  async raw(method: string, p: string, body?: unknown, extra: Record<string, string> = {}): Promise<Response> {
    const headers: Record<string, string> = { ...extra }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (method !== 'GET' && !('x-mycel-csrf' in extra)) headers['x-mycel-csrf'] = '1'
    if (this.cookie) headers.cookie = this.cookie
    if (this.token) headers.authorization = `Bearer ${this.token}`
    const res = await this.h.fetch(p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), ip: this.o.ip, base: this.o.base, via: this.o.via })
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';')
      const [k, v] = pair!.split('=')
      if (k === '__Host-sid' || k === 'mycel-dev-sid') this.cookie = v ? `${k}=${v}` : null
    }
    this.lastHeaders = res.headers
    return res
  }

  async call(method: string, p: string, body?: unknown, extra?: Record<string, string>): Promise<any> {
    const res = await this.raw(method, p, body, extra)
    const text = await res.text()
    const json = text ? JSON.parse(text) : undefined
    if (!res.ok) throw new ApiFail(res.status, json, res.headers)
    if (json && typeof json === 'object' && 'token' in json && typeof json.token === 'string' && json.me) this.token = json.token
    return json
  }

  /** status + body, never throws */
  async try(method: string, p: string, body?: unknown, extra?: Record<string, string>): Promise<{ status: number; body: any; headers: Headers }> {
    const res = await this.raw(method, p, body, extra)
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers }
  }

  login(username: string, password: string, mode: 'cookie' | 'bearer' = 'cookie') {
    return this.call('POST', '/api/auth/login', { username, password, tokenMode: mode })
  }
}

/** Set up the team (owner signed in) and return the owner client. */
export async function withOwner(h: Harness, username = 'olga'): Promise<Client> {
  const c = h.client()
  await c.call('POST', '/api/setup', { setupToken: SETUP_TOKEN, teamName: 'Acme', locale: 'ko', owner: { username, name: 'Olga Owner', password: OWNER_PW } })
  return c
}

/** Admin creates a member; the member signs in and replaces the temporary password. */
export async function addMember(h: Harness, by: Client, o: { username: string; role?: 'member' | 'admin'; groupIds?: string[]; password?: string; ip?: string }): Promise<{ client: Client; id: string; password: string }> {
  const r = await by.call('POST', '/api/admin/users', { username: o.username, name: o.username.toUpperCase(), role: o.role ?? 'member', groupIds: o.groupIds ?? [] })
  const c = h.client({ ip: o.ip ?? '10.0.0.7' })
  await c.login(o.username, r.temporaryPassword)
  const password = o.password ?? 'river stone lamp 7'
  await c.call('POST', '/api/auth/password', { currentPassword: r.temporaryPassword, newPassword: password })
  return { client: c, id: r.user.id, password }
}

// Start the MOCK services (server.ts) behind a cloudflared quick tunnel, and connect them for the fixture's people as
// their own MCP connections through the public API (kind mcp, a bearer key, "ask before changing"; the browser app
// "Always allow", as people set an app on their computer they let drive the browser: a card on every click and key
// would measure the cards, not the work). Everything this
// starts is recorded by pid in <home>/mocks.json and stopped by `down` (those pids only).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { API, ApiClient, ApiError } from '../../../shared/src/api'
import { PASSWORD } from '../fixture/seed'
import { initialState, SERVICES } from './server'

export interface Mocks { url: string; key: string; state: string; port: number; pids: number[]; connected: Record<string, string[]> }
const file = (home: string) => path.join(home, 'mocks.json')
export const readMocks = (home: string): Mocks | null => { try { return JSON.parse(fs.readFileSync(file(home), 'utf8')) } catch { return null } }

const alive = (p: number) => { try { process.kill(p, 0); return true } catch { return false } }

/** the people who get the mock connections (members, an admin and the owner; never the guest) */
export const MOCK_PEOPLE = ['jiwoo', 'minho', 'sora', 'daniel', 'hana']

export async function mocksUp(o: { home: string; base: string; port?: number; log: (s: string) => void }): Promise<Mocks> {
  const old = readMocks(o.home)
  if (old && old.pids.every(alive)) return old
  // a free port each time: a mock server left over from an interrupted run keeps its port and its old key, and a new
  // tunnel to that port answers 401 to every call (2026-11-16)
  const port = o.port ?? await freePort()
  const key = crypto.randomBytes(24).toString('base64url')
  const state = path.join(o.home, 'mock-state.json')
  fs.writeFileSync(state, JSON.stringify(initialState(), null, 1))
  const log = fs.openSync(path.join(o.home, 'mocks.log'), 'a')
  const srv = Bun.spawn(['bun', path.join(import.meta.dir, 'server.ts'), '--port', String(port), '--state', state, '--key', key], { stdout: log, stderr: log, stdin: 'ignore' })
  srv.unref()
  const tlog = path.join(o.home, 'tunnel.log')
  fs.writeFileSync(tlog, '')
  const tun = Bun.spawn(['cloudflared', 'tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdout: fs.openSync(tlog, 'a'), stderr: fs.openSync(tlog, 'a'), stdin: 'ignore' })
  tun.unref()
  let url = ''
  for (let i = 0; i < 60 && !url; i++) { await Bun.sleep(1000); url = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(fs.readFileSync(tlog, 'utf8'))?.[0] ?? '' }
  if (!url) throw new Error(`no quick tunnel address in ${tlog}`)
  // the tunnel takes a moment to answer; it must answer THIS server's key
  let ok = false
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${url}/notion/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) }); if (r.ok) { ok = true; break } } catch {}
    await Bun.sleep(2000)
  }
  if (!ok) { for (const p of [srv.pid, tun.pid]) try { process.kill(p, 'SIGTERM') } catch {} ; throw new Error(`the mock services do not answer with their key through ${url}`) }
  const m: Mocks = { url, key, state, port, pids: [srv.pid, tun.pid], connected: {} }
  fs.writeFileSync(file(o.home), JSON.stringify(m, null, 1))
  o.log(`mock services on ${url} (mocked: ${Object.values(SERVICES).map((s) => s.title).join(', ')})`)
  for (const u of MOCK_PEOPLE) {
    const r = await new ApiClient({ baseUrl: o.base }).call(API.login, { body: { username: u, password: PASSWORD, client: 'web', tokenMode: 'bearer' } })
    const api = new ApiClient({ baseUrl: o.base, token: r.token! })
    const mine = (await api.call(API.listIntegrations)).items as unknown as { id: string; name: string }[]
    for (const [svc, def] of Object.entries(SERVICES)) {
      const name = def.title.replace(' (mock)', '')
      for (const x of mine.filter((i) => i.name === name)) await api.call(API.deleteIntegration, { params: { id: x.id } }).catch(() => {})
      try {
        const made = await api.call(API.createIntegration, { body: { kind: 'mcp', name, url: `${url}/${svc}/mcp`, auth: 'bearer', secret: key, writePolicy: svc === 'browser' ? 'allow' : 'ask', notes: 'Test connection to a mock service (AI scenarios).' } })
        await api.call(API.refreshIntegration, { params: { id: made.id }, body: {} }).catch((e) => o.log(`refresh ${u}/${svc}: ${e instanceof Error ? e.message : e}`))
        ;(m.connected[u] ??= []).push(svc)
      } catch (e) { o.log(`connect ${u}/${svc}: ${e instanceof ApiError ? `${e.status} ${e.message}` : e}`) }
    }
  }
  fs.writeFileSync(file(o.home), JSON.stringify(m, null, 1))
  o.log(`connected: ${Object.entries(m.connected).map(([u, l]) => `${u} (${l.length})`).join(', ')}`)
  return m
}

async function freePort(): Promise<number> {
  for (let p = 19875; p < 19975; p++) {
    try { const s = Bun.serve({ port: p, hostname: '127.0.0.1', fetch: () => new Response('') }); s.stop(true); return p } catch {}
  }
  throw new Error('no free port for the mock services')
}

export function mocksDown(home: string, log: (s: string) => void) {
  const m = readMocks(home)
  if (!m) return
  for (const p of m.pids) if (alive(p)) { process.kill(p, 'SIGTERM'); log(`stopped ${p}`) }
  fs.rmSync(file(home), { force: true })
}

/** put the mock services' data back as it started (between flows) */
export function mocksReset(home: string) {
  const m = readMocks(home)
  if (m) fs.writeFileSync(m.state, JSON.stringify(initialState(), null, 1))
}

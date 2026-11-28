// Helpers for the MCP browser tests (tests/unit/remote-mcp-browser.test.ts, tests/security/remote-mcp-browser.test.ts):
// a fake extension on the Chrome WebSocket, linking a profile, a signed-in session, an MCP connection.
import { expect } from 'bun:test'
import crypto from 'node:crypto'
import { API, CHROME_WS_PATH, CHROME_WS_PROTOCOL, type BrowserCall, type ChromeServerFrame } from '@mycel/shared/api'
import type { Harness } from './b-harness'
import type { RemoteOAuth } from '../../server/src/connectors/remote-mcp/oauth'
import { challenge } from '../../server/src/connectors/remote-mcp/policy'
import type { AuthInfo } from '../../server/src/services'

const secret = () => crypto.randomBytes(32).toString('base64url')
const challengeOf = (v: string) => crypto.createHash('sha256').update(v).digest('base64url')
const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'

export function mcpBrowserKit(hh: () => Harness, oo: () => RemoteOAuth) {
class Ext {
  frames: ChromeServerFrame[] = []
  closed: { code: number } | null = null
  constructor(readonly ws: WebSocket) {
    ws.addEventListener('message', (e) => this.frames.push(JSON.parse(String(e.data))))
    ws.addEventListener('close', (e) => { this.closed = { code: e.code } })
  }
  send(f: unknown) { this.ws.send(JSON.stringify(f)) }
  calls(): BrowserCall[] { return this.frames.filter((f) => f.type === 'browser.call').map((f) => (f as { call: BrowserCall }).call) }
  async hello() { const end = Date.now() + 5000; while (!this.frames.some((f) => f.type === 'hello')) { if (Date.now() > end) throw new Error('no hello'); await Bun.sleep(20) } }
}
async function ext(token: string): Promise<Ext> {
  const ws = new WebSocket(`${hh().url.replace('http', 'ws')}${CHROME_WS_PATH}`, { headers: { origin: EXT }, protocols: [CHROME_WS_PROTOCOL] } as unknown as string[])
  const e = new Ext(ws)
  await new Promise<void>((res) => { ws.addEventListener('open', () => res()); ws.addEventListener('close', () => res()) })
  e.send({ type: 'auth', token, version: '0.1.0' })
  await e.hello()
  return e
}
async function link(user: string, label: string): Promise<{ token: string; linkId: string }> {
  hh().ctx.db.query('DELETE FROM login_attempts').run()
  const verifier = secret()
  const { code } = await hh().api(user).call(API.chromePair, { body: { challenge: challengeOf(verifier) } })
  const r = await hh().req(null, API.chromeRedeem.path, { method: 'POST', headers: { 'content-type': 'application/json', origin: EXT }, body: JSON.stringify({ code, verifier, label, version: '0.1.0' }) })
  expect(r.status).toBe(200)
  return await r.json() as { token: string; linkId: string }
}
/** a profile that answers every call; `answer` decides the result */
function serve(e: Ext, answer: (c: BrowserCall) => Record<string, unknown> = () => ({})) {
  const done = new Set<string>()
  const timer = setInterval(() => {
    for (const c of e.calls()) {
      if (done.has(c.callId)) continue
      done.add(c.callId)
      e.send({ type: 'browser.ack', callId: c.callId })
      e.send({ type: 'browser.result', result: { callId: c.callId, ok: true, content: [{ type: 'text', text: 'page text' }], ...answer(c) } })
    }
  }, 15)
  return () => clearInterval(timer)
}
/** a signed-in browser session of `user` (the consent page and Settings need a real one) */
const authOf = (user: string): AuthInfo => {
  const id = `sess-${user}-${crypto.randomUUID()}`, now = new Date().toISOString(), end = new Date(Date.now() + 86_400_000).toISOString()
  hh().ctx.db.query("INSERT INTO sessions (id, user_id, token_hash, client, user_agent, created_at, last_seen_at, expires_at, temp_login, connector) VALUES (?, ?, ?, 'web', 'test', ?, ?, ?, 0, 0)").run(id, user, 'test:' + id, now, now, end)
  return { user: { id: user, username: user, name: user, role: 'member', locale: 'en', mustChangePassword: false }, session: { id, client: 'web' }, via: 'cookie' } as unknown as AuthInfo
}
/** an MCP connection of `user`, with or without the browser box ticked */
function connect(user: string, browser: boolean, clientName = 'Claude Code'): { token: string; grantId: string } {
  const redirect = 'http://127.0.0.1/callback', verifier = 'v'.repeat(43)
  const c = oo().register({ redirect_uris: [redirect], client_name: clientName })
  const auth = authOf(user)
  const id = new URL(oo().authorize({ client_id: c.client_id, redirect_uri: redirect, resource: oo().resource(), response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge(verifier), scope: 'mcp:read offline_access' }, null)).searchParams.get('id')!
  oo().consent(id, auth)
  const code = new URL(oo().decide(id, auth, true, { browser }).redirectUrl).searchParams.get('code')!
  const token = oo().token({ client_id: c.client_id, code, grant_type: 'authorization_code', code_verifier: verifier, redirect_uri: redirect, resource: oo().resource() }).access_token
  return { token, grantId: oo().authenticate(token).id }
}
  return { Ext, ext, link, serve, authOf, connect }
}

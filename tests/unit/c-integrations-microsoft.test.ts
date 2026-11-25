// Microsoft 365 through the server's Microsoft (Entra) app (docs/decisions/20261125-m365-connector.md;
// server/src/integrations/microsoft/: app.ts, graph.ts, mcp-server.ts; connections/service.ts serverApp, authorize,
// client). Checked here: without the app the list says not ready and Connect refuses before anything is sent; the web
// signs in at Microsoft's fixed v2.0 addresses with PKCE, the fixed scopes (offline_access included) and no resource
// indicator, coming back to the team's address; the desktop app (Windows, Mac) comes back to its one-time 127.0.0.1
// address whatever the team's address is; the tenant of the app file names the authority; tokens go only to Graph and
// the secret only to the token address; a refresh uses the app's current secret and keeps Microsoft's rotated refresh
// token; a Graph 401 refreshes once; each tool calls the Graph request it should; Graph's other errors are the tool's
// error and leave the connection connected. Microsoft is faked in this process (connections/net.ts `answer`).
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { harness, OWNER_PW, withOwner, type Client, type Harness } from './a-lib'
import { integrationsOf, type Integrations } from '../../server/src/integrations/connections/service'
import { getRow } from '../../server/src/integrations/connections/store'
import type { NetOptions, NetRequest } from '../../server/src/integrations/connections/net'
import { MICROSOFT_SCOPE, microsoftAppFile, microsoftAppOf, readMicrosoftApp } from '../../server/src/integrations/microsoft/app'
import { MICROSOFT_TOOLS, plainText } from '../../server/src/integrations/microsoft/mcp-server'
import { say } from '../../server/src/integrations/connections/text'
import { officialService, serverAppAt, SERVICE_CATALOG } from '../../shared/src/service-catalog'
import { createLogger } from '../../server/src/log'

setDefaultTimeout(30_000)

const MCP = 'https://microsoft-365.invalid/mcp'
const LOGIN = 'https://login.microsoftonline.com'
const CLIENT_ID = '11111111-2222-4333-8444-555555555555'
const TENANT = '99999999-8888-4777-8666-555555555555'
const SECRET = 'CANARY-ms-client-secret-Q7w2'
const SECRET2 = 'CANARY-ms-client-secret-rotated-9Kp'
const TEAM = 'https://team.example.com'
const PUBLIC = { origin: TEAM }
const WEB_REDIRECT = `${TEAM}/api/integrations/oauth/callback`
const PORT = 51234
const DOWNLOAD = 'https://contoso-my.sharepoint.com/personal/download.aspx?tempauth=CANARY-dl'

interface Seen { url: string; method: string; body: string; auth: string | null; headers: [string, string][] }

/** A small Microsoft: the token address of any tenant (codes, refresh tokens that work once), Graph (only the access
 * token handed out last), and a pre-signed download address. */
class FakeMicrosoft {
  now = Date.now()
  seen: Seen[] = []
  codes = new Map<string, { challenge: string; redirect: string; scope: string }>()
  access = ''; refresh = ''; n = 0
  secrets = new Set([SECRET])
  /** answer the next token request with this OAuth error */
  failNext: string | null = null
  /** Graph answers 401 to the next call (an access token Microsoft ended early) */
  reject401 = false
  /** Graph answers this to every call whose path starts with the key */
  errors = new Map<string, { status: number; code: string; message: string }>()

  code(challenge: string, redirect: string, scope: string) { const c = `code-${++this.n}`; this.codes.set(c, { challenge, redirect, scope }); return c }
  graph(path: string) { return this.seen.filter((s) => s.url.startsWith('https://graph.microsoft.com/v1.0' + path)) }

  net(): NetOptions {
    return {
      answer: async (url: string, r: NetRequest) => {
        const body = r.body?.toString('utf8') ?? ''
        const auth = r.headers.find(([k]) => k.toLowerCase() === 'authorization')?.[1] ?? null
        this.seen.push({ url, method: r.method, body, auth, headers: r.headers })
        const json = (status: number, j: unknown) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(j) })
        const u = new URL(url)
        if (u.origin === LOGIN && /\/oauth2\/v2\.0\/token$/.test(u.pathname) && r.method === 'POST') {
          const t = this.token(new URLSearchParams(body))
          return json('error' in t ? 400 : 200, t)
        }
        if (url === DOWNLOAD) return { status: 200, body: 'Quarterly plan\nShip the connector.' }
        if (u.origin === 'https://graph.microsoft.com') {
          if (this.reject401 || auth !== `Bearer ${this.access}` || !this.access) {
            this.reject401 = false
            return json(401, { error: { code: 'InvalidAuthenticationToken', message: 'Access token has expired or is not yet valid.' } })
          }
          const p = u.pathname.replace('/v1.0', '')
          for (const [k, e] of this.errors) if (p.startsWith(k)) return json(e.status, { error: { code: e.code, message: e.message } })
          return this.graphAnswer(r.method, p, u, body)
        }
        return { status: 404, body: 'not here' }
      },
    }
  }

  private graphAnswer(method: string, p: string, u: URL, body: string) {
    const json = (status: number, j: unknown) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(j) })
    if (p === '/me') return json(200, { id: 'me-1' })
    if (p === '/me/messages' && method === 'GET') return json(200, { value: [{ id: 'm1', subject: 'Plan', from: { emailAddress: { name: 'Ann', address: 'ann@contoso.example' } }, toRecipients: [], receivedDateTime: '2026-11-24T09:00:00Z', bodyPreview: 'hi', isRead: false, hasAttachments: false, webLink: 'https://outlook.office.com/m1' }] })
    if (p === '/me/messages/m1' && method === 'GET') return json(200, { id: 'm1', subject: 'Plan', from: { emailAddress: { address: 'ann@contoso.example' } }, body: { contentType: 'text', content: 'The whole mail' }, hasAttachments: true, ccRecipients: [] })
    if (p === '/me/messages/m1/attachments') return json(200, { value: [{ name: 'plan.pdf', size: 1234, contentType: 'application/pdf' }] })
    if (p === '/me/messages' && method === 'POST') return json(201, { id: 'd1', subject: JSON.parse(body).subject, toRecipients: JSON.parse(body).toRecipients, webLink: 'https://outlook.office.com/d1' })
    if (p === '/me/sendMail' && method === 'POST') return { status: 202, body: '' }
    if (p === '/me/calendarView') return json(200, { value: [{ id: 'e1', subject: 'Standup', start: { dateTime: '2026-11-26T09:00:00', timeZone: 'Asia/Seoul' }, end: { dateTime: '2026-11-26T09:15:00', timeZone: 'Asia/Seoul' } }] })
    if (p === '/me/events' && method === 'POST') return json(201, { id: 'e2', ...JSON.parse(body) })
    if (p === '/search/query' && method === 'POST') return json(200, { value: [{ hitsContainers: [{ hits: [{ summary: '<c0>plan</c0>', resource: { id: 'f1', name: 'plan.txt', size: 30, parentReference: { driveId: 'drv1' }, webUrl: 'https://contoso-my.sharepoint.com/plan.txt' } }] }] }] })
    if (p === '/drives/drv1/items/f1') return json(200, { id: 'f1', name: 'plan.txt', size: 30, file: {}, parentReference: { driveId: 'drv1' }, '@microsoft.graph.downloadUrl': DOWNLOAD })
    if (p.startsWith('/me/drive/root:/') && method === 'PUT') return json(201, { id: 'f2', name: decodeURIComponent(/\/([^/]+):\/content$/.exec(p)![1]!), size: Buffer.byteLength(body), parentReference: { driveId: 'drv1' } })
    if (p === '/me/chats') return json(200, { value: [{ id: '19:chat1@thread.v2', chatType: 'group', topic: 'Launch', members: [{ displayName: 'Ann' }], lastMessagePreview: { createdDateTime: '2026-11-24T10:00:00Z', from: { user: { displayName: 'Ann' } }, body: { content: '<p>See you</p>' } } }] })
    if (p.startsWith('/me/chats/') && p.endsWith('/messages')) return json(200, { value: [{ messageType: 'message', from: { user: { displayName: 'Ann' } }, createdDateTime: '2026-11-24T10:00:00Z', body: { content: 'Hello <b>team</b>&amp;co' } }] })
    if (p.startsWith('/chats/') && p.endsWith('/messages') && method === 'POST') return json(201, { id: 'msg9', createdDateTime: '2026-11-25T01:00:00Z' })
    return json(404, { error: { code: 'itemNotFound', message: `nothing at ${p}` } })
  }

  private token(q: URLSearchParams): Record<string, unknown> {
    if (this.failNext) { const error = this.failNext; this.failNext = null; return { error, error_description: 'AADSTS70000: refused' } }
    if (q.get('client_id') !== CLIENT_ID || !this.secrets.has(q.get('client_secret') ?? '')) return { error: 'invalid_client' }
    if (q.has('resource')) return { error: 'invalid_request', error_description: "AADSTS901002: The 'resource' request parameter is not supported." }
    if (q.get('grant_type') === 'authorization_code') {
      const c = this.codes.get(q.get('code') ?? '')
      this.codes.delete(q.get('code') ?? '')
      if (!c || c.redirect !== q.get('redirect_uri')) return { error: 'invalid_grant' }
      const challenge = new Bun.CryptoHasher('sha256').update(q.get('code_verifier') ?? '').digest('base64url')
      if (challenge !== c.challenge) return { error: 'invalid_grant' }
    } else if (q.get('grant_type') === 'refresh_token') {
      if (!this.refresh || q.get('refresh_token') !== this.refresh) return { error: 'invalid_grant' }
    } else return { error: 'unsupported_grant_type' }
    this.access = `eyJ0CANARY-access-${++this.n}`
    this.refresh = `0.AXCANARY-refresh-${this.n}`
    return { token_type: 'Bearer', scope: 'Mail.ReadWrite Mail.Send Calendars.ReadWrite Files.ReadWrite.All Sites.Read.All Chat.ReadWrite User.Read profile openid email', expires_in: 3599, ext_expires_in: 3599, access_token: this.access, refresh_token: this.refresh, id_token: 'eyJhbGciOiJub25lIn0.e30.' }
  }
}

let h: Harness, olga: Client, desk: Client, ms: FakeMicrosoft, svc: Integrations
let logs: string[] = []
let seq = 0
beforeEach(async () => {
  logs = []
  h = await harness('int-microsoft-' + ++seq, { publicOrigins: [TEAM] }, { log: createLogger({ level: 'debug', sink: (l) => logs.push(l) }) })
  olga = await withOwner(h)
  // the same person in the desktop app (Windows or Mac): its session says so at sign-in
  desk = h.client()
  await desk.call('POST', '/api/auth/login', { username: 'olga', password: OWNER_PW, client: 'desktop' })
  ms = new FakeMicrosoft()
  svc = integrationsOf(h.ctx, { net: ms.net(), now: () => ms.now })
})
afterEach(async () => { await h?.close() })

function putApp(app: Record<string, unknown> = { clientId: CLIENT_ID, clientSecret: SECRET }, mode = 0o600) {
  const file = microsoftAppFile(h.ctx)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, JSON.stringify(app), { mode })
  fs.chmodSync(file, mode)
  return file
}
const m365 = (over: Record<string, unknown> = {}) => ({ kind: 'mcp', name: 'Microsoft 365', url: MCP, auth: 'oauth', ...over })
const callback = (q: Record<string, string>) => '/api/integrations/oauth/callback?' + new URLSearchParams(q)
const tokenCalls = () => ms.seen.filter((s) => s.url.startsWith(LOGIN)).map((s) => Object.fromEntries(new URLSearchParams(s.body)))
const everything = () => ['integrations', 'integration_oauth_flows', 'audit_log', 'tool_events']
  .map((t) => JSON.stringify(h.ctx.db.query(`SELECT * FROM ${t}`).all())).join('\n') + logs.join('\n')

/** Connect from `who`: the sign-in address the browser opens, and Microsoft sending the browser back with a code */
async function signIn(who: Client, id: string, body: Record<string, unknown> = {}, o: { expect?: number } = {}) {
  const f = await who.call('POST', `/api/integrations/${id}/authorize`, body, PUBLIC)
  const u = new URL(f.authorizationUrl)
  const code = ms.code(u.searchParams.get('code_challenge')!, u.searchParams.get('redirect_uri')!, u.searchParams.get('scope') ?? '')
  // the browser comes back to the team's return page (from the desktop app's 127.0.0.1 address, which forwards it)
  const res = await olga.raw('GET', callback({ state: u.searchParams.get('state')!, code }), undefined, PUBLIC)
  expect(res.status).toBe(o.expect ?? 200)
  return { u, answer: f }
}
const call = async (id: string, tool: string, args: Record<string, unknown>) => {
  const r = await svc.callTool(getRow(h.ctx.db, id)!, tool, args)
  return { r, text: (r.content?.[0]?.text ?? '') as string, json: (() => { try { return JSON.parse(r.content?.[0]?.text ?? '') } catch { return null } })() }
}

describe('the catalog and the app file', () => {
  test('one listed service at a reserved address that never resolves, signing in through the server\'s Microsoft app', () => {
    const c = SERVICE_CATALOG.find((x) => x.id === 'microsoft365')!
    expect(c).toMatchObject({ name: 'Microsoft 365', url: MCP, serverApp: 'microsoft' })
    expect(new URL(c.url).hostname.endsWith('.invalid')).toBe(true)
    expect(serverAppAt(MCP)).toBe('microsoft')
    expect(officialService(MCP)?.id).toBe('microsoft365')
    for (const u of ['https://microsoft-365.invalid/mcp/x', 'http://microsoft-365.invalid/mcp', 'https://graph.microsoft.com/mcp']) expect(serverAppAt(u), u).toBeNull()
    expect(MICROSOFT_SCOPE.split(' ')).toContain('offline_access')
    expect(MICROSOFT_TOOLS.filter((t) => t.readOnly).map((t) => t.name)).toEqual(['mail_search', 'mail_read', 'calendar_events', 'files_search', 'files_read', 'teams_chats', 'teams_read_chat'])
  })

  test('the app file: private, the right fields, a GUID client; the environment names another file', () => {
    const file = putApp({ clientId: CLIENT_ID, clientSecret: SECRET, tenant: TENANT })
    expect(microsoftAppOf(h.ctx)).toEqual({ clientId: CLIENT_ID, clientSecret: SECRET, tenant: TENANT })
    putApp(undefined, 0o644)
    expect(readMicrosoftApp(file, h.ctx.config.teamRoot)).toBeNull()
    putApp({ clientId: 'not-a-guid', clientSecret: SECRET })
    expect(microsoftAppOf(h.ctx)).toBeNull()
    putApp({ clientId: CLIENT_ID, clientSecret: SECRET, redirectUris: [] })
    expect(microsoftAppOf(h.ctx)).toBeNull()
    putApp()
    expect(microsoftAppOf(h.ctx, { MYCEL_MICROSOFT_APP_FILE: path.join(h.ctx.config.teamRoot, 'nope.json') })).toBeNull()
    expect(microsoftAppOf(h.ctx, { MYCEL_MICROSOFT_APP_FILE: file })?.clientId).toBe(CLIENT_ID)
  })

  test('without the app: the lists say not ready and Connect refuses in plain words, before anything is sent', async () => {
    expect((await olga.call('GET', '/api/integrations')).microsoft).toEqual({ ready: false })
    expect((await olga.call('GET', '/api/admin/integrations')).microsoft).toEqual({ ready: false })
    const c = await olga.call('POST', '/api/integrations', m365(), PUBLIC)
    const no = await olga.try('POST', `/api/integrations/${c.id}/authorize`, {}, PUBLIC)
    expect(no.status).toBe(400)
    expect(no.body.error.message).toBe(say('microsoftNotSetUp', 'ko'))
    expect(ms.seen).toEqual([])
    putApp()
    expect((await olga.call('GET', '/api/integrations')).microsoft).toEqual({ ready: true })
  })
})

describe('signing in on each kind of install', () => {
  test('the web (hosted team, Linux server or office Mac on its https address): Microsoft\'s v2.0 address, PKCE, the scopes, no resource; the team\'s return address', async () => {
    putApp()
    const c = await olga.call('POST', '/api/integrations', m365(), PUBLIC)
    const { u, answer } = await signIn(olga, c.id)
    expect(u.origin + u.pathname).toBe(`${LOGIN}/common/oauth2/v2.0/authorize`)
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: CLIENT_ID, redirect_uri: WEB_REDIRECT, response_type: 'code', code_challenge_method: 'S256', scope: MICROSOFT_SCOPE })
    expect(u.searchParams.has('resource')).toBe(false)
    expect(answer.loopback).toBeUndefined()
    expect(u.toString()).not.toContain(SECRET)
    expect(tokenCalls()).toHaveLength(1)
    expect(tokenCalls()[0]).toMatchObject({ grant_type: 'authorization_code', client_id: CLIENT_ID, client_secret: SECRET, redirect_uri: WEB_REDIRECT })
    expect(tokenCalls()[0]!.resource).toBeUndefined()
    // checked after the sign-in: Graph asked who it is, the tools saved with reads and changes marked
    const after = (await olga.call('GET', '/api/integrations')).items.find((i: any) => i.id === c.id)
    expect(after).toMatchObject({ status: 'connected', hasSecret: true })
    expect(after.tools.map((t: any) => [t.name, t.readOnly])).toEqual(MICROSOFT_TOOLS.map((t) => [t.name, t.readOnly]))
    // the token reached Graph only, the secret the token address only; nothing secret stored or logged in clear
    expect(ms.seen.filter((s) => s.auth?.startsWith('Bearer ')).every((s) => s.url.startsWith('https://graph.microsoft.com/v1.0/'))).toBe(true)
    expect(ms.seen.filter((s) => !s.url.startsWith(LOGIN)).some((s) => JSON.stringify(s).includes(SECRET))).toBe(false)
    expect(everything()).not.toContain(SECRET)
    expect(everything()).not.toContain('CANARY-access-')
    expect(everything()).not.toContain('CANARY-refresh-')
  })

  test('the desktop app (Windows, Mac): its one-time 127.0.0.1 return address, whatever the team\'s address is', async () => {
    putApp()
    const c = await olga.call('POST', '/api/integrations', m365(), PUBLIC)
    const { u, answer } = await signIn(desk, c.id, { loopbackPort: PORT })
    expect(u.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${PORT}/callback`)
    expect(answer.loopback).toBe(true)
    expect(tokenCalls()[0]).toMatchObject({ redirect_uri: `http://127.0.0.1:${PORT}/callback`, client_secret: SECRET })
    expect(getRow(h.ctx.db, c.id)).toMatchObject({ status: 'connected' })
    // a desktop app from before the return address (no port): the team's address, as on the web
    const again = await desk.call('POST', `/api/integrations/${c.id}/authorize`, {}, PUBLIC)
    expect(new URL(again.authorizationUrl).searchParams.get('redirect_uri')).toBe(WEB_REDIRECT)
    // a port from a web session is not used
    const web = await olga.call('POST', `/api/integrations/${c.id}/authorize`, { loopbackPort: PORT }, PUBLIC)
    expect(new URL(web.authorizationUrl).searchParams.get('redirect_uri')).toBe(WEB_REDIRECT)
  })

  test('a server opened on this computer (office Mac, a dev server at http://127.0.0.1:<port>): that address, which Entra matches as a loopback one', async () => {
    const LOCAL = 'http://127.0.0.1:8787'
    const l = await harness('int-microsoft-local-' + ++seq, { publicOrigins: [LOCAL] })
    try {
      integrationsOf(l.ctx, { net: ms.net(), now: () => ms.now })
      const file = microsoftAppFile(l.ctx)
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      fs.writeFileSync(file, JSON.stringify({ clientId: CLIENT_ID, clientSecret: SECRET }), { mode: 0o600 })
      const owner = await withOwner(l)
      const c = await owner.call('POST', '/api/integrations', m365(), { origin: LOCAL })
      const f = await owner.call('POST', `/api/integrations/${c.id}/authorize`, {}, { origin: LOCAL })
      expect(new URL(f.authorizationUrl).searchParams.get('redirect_uri')).toBe(`${LOCAL}/api/integrations/oauth/callback`)
    } finally { await l.close() }
  })

  test('a company\'s own tenant in the app file names the authority; a team connection signs in the same way', async () => {
    putApp({ clientId: CLIENT_ID, clientSecret: SECRET, tenant: TENANT })
    const team = await olga.call('POST', '/api/admin/integrations', { ...m365(), access: { everyone: true, groups: [], users: [] } }, PUBLIC)
    const { u } = await signIn(olga, team.id)
    expect(u.origin + u.pathname).toBe(`${LOGIN}/${TENANT}/oauth2/v2.0/authorize`)
    expect(ms.seen.find((s) => s.url.startsWith(LOGIN))!.url).toBe(`${LOGIN}/${TENANT}/oauth2/v2.0/token`)
    expect(getRow(h.ctx.db, team.id)).toMatchObject({ status: 'connected' })
  })
})

test('a company\'s own Entra app on the connection (ID and secret only) signs in at Microsoft\'s addresses with the scopes, without the server\'s app', async () => {
  const c = await olga.call('POST', '/api/integrations', m365({ oauthClient: { clientId: CLIENT_ID, clientSecret: SECRET } }), PUBLIC)
  const { u } = await signIn(olga, c.id)
  expect(u.origin + u.pathname).toBe(`${LOGIN}/common/oauth2/v2.0/authorize`)
  expect(u.searchParams.get('scope')).toBe(MICROSOFT_SCOPE)
  expect(u.searchParams.has('resource')).toBe(false)
  expect(tokenCalls()[0]).toMatchObject({ client_id: CLIENT_ID, client_secret: SECRET, redirect_uri: WEB_REDIRECT })
  expect(getRow(h.ctx.db, c.id)).toMatchObject({ status: 'connected' })
})

describe('tokens', () => {
  test('an hour\'s token is refreshed with the app\'s current secret, the rotated refresh token is kept; a refused one asks to sign in again', async () => {
    putApp()
    const c = await olga.call('POST', '/api/integrations', m365(), PUBLIC)
    await signIn(olga, c.id)
    const firstRefresh = ms.refresh
    ms.secrets.add(SECRET2)
    putApp({ clientId: CLIENT_ID, clientSecret: SECRET2 })
    ms.secrets.delete(SECRET)
    ms.now += 3_600_000
    expect((await call(c.id, 'teams_chats', {})).json.chats[0].topic).toBe('Launch')
    expect(tokenCalls().at(-1)).toMatchObject({ grant_type: 'refresh_token', client_id: CLIENT_ID, client_secret: SECRET2, refresh_token: firstRefresh })
    expect(tokenCalls().at(-1)!.resource).toBeUndefined()
    ms.now += 3_600_000
    await call(c.id, 'teams_chats', {})
    expect(tokenCalls().at(-1)!.refresh_token).not.toBe(firstRefresh)
    // Graph ends an access token early: one refresh, the call goes through
    const before = tokenCalls().length
    ms.reject401 = true
    expect((await call(c.id, 'calendar_events', { start: '2026-11-26', end: '2026-11-27' })).json.events[0].subject).toBe('Standup')
    expect(tokenCalls().length).toBe(before + 1)
    // the refresh token is refused (revoked, password changed): sign in again
    ms.now += 3_600_000
    ms.failNext = 'invalid_grant'
    await expect(svc.callTool(getRow(h.ctx.db, c.id)!, 'teams_chats', {})).rejects.toBeTruthy()
    expect(getRow(h.ctx.db, c.id)).toMatchObject({ status: 'needs_auth', last_error: 'sign_in' })
    expect(everything()).not.toContain(SECRET2)
  })

  test('the app replaced by another client ID: the new secret never goes with the old sign-in; once Microsoft refuses the old one, sign in again', async () => {
    putApp()
    const c = await olga.call('POST', '/api/integrations', m365(), PUBLIC)
    await signIn(olga, c.id)
    putApp({ clientId: '22222222-2222-4333-8444-555555555555', clientSecret: SECRET2 })
    ms.secrets.clear()
    ms.now += 3_600_000
    await expect(svc.callTool(getRow(h.ctx.db, c.id)!, 'teams_chats', {})).rejects.toBeTruthy()
    expect(tokenCalls().at(-1)).toMatchObject({ client_id: CLIENT_ID, client_secret: SECRET })
    expect(tokenCalls().some((t) => t.client_secret === SECRET2)).toBe(false)
    expect(getRow(h.ctx.db, c.id)).toMatchObject({ status: 'needs_auth' })
  })
})

describe('the tools call Graph', () => {
  let id = ''
  beforeEach(async () => {
    putApp()
    id = (await olga.call('POST', '/api/integrations', m365(), PUBLIC)).id
    await signIn(olga, id)
    ms.seen.length = 0
  })

  test('mail: search, read (body as text, attachments listed), draft, send', async () => {
    const s = await call(id, 'mail_search', { query: 'from:ann "plan"' })
    expect(s.json.messages[0]).toMatchObject({ id: 'm1', from: 'Ann <ann@contoso.example>', unread: true })
    const q = new URL(ms.graph('/me/messages')[0]!.url).searchParams
    expect(q.get('$search')).toBe('"from:ann  plan "')
    await call(id, 'mail_search', {})
    expect(ms.graph('/me/mailFolders/inbox/messages')).toHaveLength(1)
    const r = await call(id, 'mail_read', { id: 'm1' })
    expect(r.json).toMatchObject({ body: 'The whole mail', attachments: [{ name: 'plan.pdf', size: 1234 }] })
    expect(ms.graph('/me/messages/m1')[0]!.headers).toContainEqual(['Prefer', 'outlook.body-content-type="text"'])
    const d = await call(id, 'mail_draft', { to: ['bob@contoso.example'], subject: 'Hi', body: 'Draft text' })
    expect(d.json.draft).toMatchObject({ id: 'd1', to: ['bob@contoso.example'] })
    expect(JSON.parse(ms.graph('/me/messages').at(-1)!.body)).toMatchObject({ subject: 'Hi', body: { contentType: 'Text', content: 'Draft text' }, toRecipients: [{ emailAddress: { address: 'bob@contoso.example' } }] })
    const sent = await call(id, 'mail_send', { to: 'Bob <bob@contoso.example>, cy@contoso.example', subject: 'Hi', body: 'Sent text' })
    expect(sent.json).toMatchObject({ sent: true, to: ['bob@contoso.example', 'cy@contoso.example'] })
    expect(JSON.parse(ms.graph('/me/sendMail')[0]!.body)).toMatchObject({ saveToSentItems: true, message: { subject: 'Hi' } })
    // a bad address is refused before anything is sent
    const bad = await call(id, 'mail_send', { to: ['not an address'], subject: 'x' })
    expect(bad.r.isError).toBe(true)
    expect(bad.text).toContain('not an e-mail address')
    expect(ms.graph('/me/sendMail')).toHaveLength(1)
  })

  test('calendar: events in a time zone; a new event with attendees and a Teams meeting', async () => {
    const e = await call(id, 'calendar_events', { start: '2026-11-26T00:00:00', end: '2026-11-27T00:00:00', time_zone: 'Asia/Seoul' })
    expect(e.json.events[0].subject).toBe('Standup')
    const req = ms.graph('/me/calendarView')[0]!
    expect(req.headers).toContainEqual(['Prefer', 'outlook.timezone="Asia/Seoul"'])
    expect(new URL(req.url).searchParams.get('startDateTime')).toBe('2026-11-26T00:00:00')
    const n = await call(id, 'calendar_create_event', { subject: 'Review', start: '2026-11-26T14:00:00', end: '2026-11-26T15:00:00', time_zone: 'Asia/Seoul', attendees: ['ann@contoso.example'], teams_meeting: true })
    expect(n.json.event.id).toBe('e2')
    expect(JSON.parse(ms.graph('/me/events')[0]!.body)).toMatchObject({ start: { dateTime: '2026-11-26T14:00:00', timeZone: 'Asia/Seoul' }, attendees: [{ emailAddress: { address: 'ann@contoso.example' }, type: 'required' }], isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' })
    expect((await call(id, 'calendar_create_event', { subject: 'x', start: 'tomorrow', end: 'later' })).r.isError).toBe(true)
  })

  test('files: search OneDrive and SharePoint, read a file\'s text from its download address (without the token), upload text', async () => {
    const s = await call(id, 'files_search', { query: 'plan' })
    expect(s.json.files[0]).toMatchObject({ id: 'f1', driveId: 'drv1', name: 'plan.txt', match: 'plan' })
    const r = await call(id, 'files_read', { id: 'f1', drive_id: 'drv1' })
    expect(r.json.text).toBe('Quarterly plan\nShip the connector.')
    const dl = ms.seen.find((x) => x.url === DOWNLOAD)!
    expect(dl.auth).toBeNull()
    const u = await call(id, 'files_upload', { folder: 'Documents/Reports', name: 'summary 1.md', content: '# Summary' })
    expect(u.json.file.name).toBe('summary 1.md')
    const put = ms.seen.find((x) => x.method === 'PUT')!
    expect(new URL(put.url).pathname).toBe('/v1.0/me/drive/root:/Documents/Reports/summary%201.md:/content')
    expect(new URL(put.url).searchParams.get('@microsoft.graph.conflictBehavior')).toBe('rename')
    expect(put.body).toBe('# Summary')
    for (const bad of [{ name: '../x', content: 'a' }, { name: 'x.md', folder: 'a/../b', content: 'a' }]) expect((await call(id, 'files_upload', bad)).r.isError).toBe(true)
  })

  test('Teams: chats, a chat\'s messages as plain text, a message sent', async () => {
    const c = await call(id, 'teams_chats', {})
    expect(c.json.chats[0]).toMatchObject({ id: '19:chat1@thread.v2', members: ['Ann'], last: { text: 'See you' } })
    const m = await call(id, 'teams_read_chat', { chat_id: '19:chat1@thread.v2' })
    expect(m.json.messages[0].text).toBe('Hello team&co')
    const s = await call(id, 'teams_send', { chat_id: '19:chat1@thread.v2', text: 'On it' })
    expect(s.json).toMatchObject({ sent: true, id: 'msg9' })
    const post = ms.seen.find((x) => x.method === 'POST' && x.url.includes('/chats/'))!
    expect(new URL(post.url).pathname).toBe('/v1.0/chats/19%3Achat1%40thread.v2/messages')
    expect(JSON.parse(post.body)).toEqual({ body: { contentType: 'text', content: 'On it' } })
  })

  test('Graph refuses one thing (403, no mailbox): the tool\'s error in Microsoft\'s words; the connection stays connected', async () => {
    ms.errors.set('/me/chats', { status: 403, code: 'Forbidden', message: 'Missing scope permissions on the request.' })
    const r = await call(id, 'teams_chats', {})
    expect(r.r.isError).toBe(true)
    expect(r.text).toContain('Microsoft 365 answered 403 (Forbidden: Missing scope permissions on the request.)')
    ms.errors.set('/me/messages', { status: 404, code: 'MailboxNotEnabledForRESTAPI', message: 'The mailbox is either inactive, soft-deleted, or is hosted on-premise.' })
    expect((await call(id, 'mail_search', { query: 'x' })).text).toContain('MailboxNotEnabledForRESTAPI')
    expect(getRow(h.ctx.db, id)).toMatchObject({ status: 'connected' })
    expect((await call(id, 'no_such_tool', {})).r.isError).toBe(true)
  })
})

test('Teams\' HTML bodies read as plain text', () => {
  expect(plainText('<p>a<br>b</p><div>c &amp; d &lt;e&gt;</div>')).toBe('a\nb\nc & d <e>')
})

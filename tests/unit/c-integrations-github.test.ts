// GitHub through the server's GitHub App (docs/INTEGRATIONS.md "GitHub"; server/src/integrations/github/app.ts,
// connections/service.ts serverApp / currentClient, oauth.ts tokenRequest): GitHub's remote MCP server registers no apps,
// so a connection at its exact official address signs in with the app the server holds. Checked here: without the app
// the page says it is not set up and a sign-in fails as before (no registration); with it the sign-in goes to GitHub's
// fixed addresses with PKCE and no scope, the secret goes only to GitHub's token address and never shows, the token is
// sent to the MCP server only, an 8-hour token is refreshed with the app's CURRENT secret and GitHub's rotated refresh
// token is kept, GitHub's HTTP-200 errors are read as refusals, another address (or an own app) never gets the server's
// app, a team connection and a template's members sign in through it too, and the app file is read only when private.
// GitHub is faked in this process (connections/net.ts `answer`): nothing here reaches github.com.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { integrationsOf, type Integrations } from '../../server/src/integrations/connections/service'
import { getRow } from '../../server/src/integrations/connections/store'
import type { NetOptions, NetRequest } from '../../server/src/integrations/connections/net'
import { githubAppFile, githubAppOf, readGitHubApp } from '../../server/src/integrations/github/app'
import { answerMcp, text, type FakeTool } from '../../server/src/demo/fakes/mcp'
import { serverAppAt } from '../../shared/src/service-catalog'
import { createLogger } from '../../server/src/log'

setDefaultTimeout(30_000)

const MCP = 'https://api.githubcopilot.com/mcp/'
const TOKEN = 'https://github.com/login/oauth/access_token'
const AUTHORIZE = 'https://github.com/login/oauth/authorize'
const CLIENT_ID = 'Iv23liTestClient01'
const SECRET = 'CANARY-gh-client-secret-Q7w2'
const SECRET2 = 'CANARY-gh-client-secret-rotated-9Kp'
const REDIRECT = 'http://team.localhost/api/integrations/oauth/callback'

/** A small GitHub: its token address (codes, refresh tokens that work once, HTTP-200 errors), the MCP server's
 * metadata, and the MCP server, which takes only the access token handed out last. */
class FakeGitHub {
  now = Date.now()
  seen: { url: string; method: string; body: string; auth: string | null }[] = []
  codes = new Map<string, { verifier: string; redirect: string }>()
  access = '' ; refresh = ''; n = 0
  revoked: { auth: string | null; token: string }[] = []
  /** the client secrets GitHub accepts now */
  secrets = new Set([SECRET])
  /** answer the next token request with this GitHub error (HTTP 200) */
  failNext: string | null = null
  tools: FakeTool[] = [
    { name: 'get_me', title: 'Get me', description: 'The signed-in user', readOnly: true, inputSchema: { type: 'object', properties: {} }, call: () => text('{"login":"octo"}') },
    { name: 'issue_write', title: 'Write issue', description: 'Create or update an issue', readOnly: false, inputSchema: { type: 'object', properties: { title: { type: 'string' } } }, call: () => text('{"number":1}') },
  ]

  code(verifier: string, redirect = REDIRECT) { const c = `code-${++this.n}`; this.codes.set(c, { verifier, redirect }); return c }

  net(): NetOptions {
    return {
      answer: async (url: string, r: NetRequest) => {
        const body = r.body?.toString('utf8') ?? ''
        const auth = r.headers.find(([k]) => k.toLowerCase() === 'authorization')?.[1] ?? null
        this.seen.push({ url, method: r.method, body, auth })
        const json = (status: number, j: unknown, headers: Record<string, string> = {}) => ({ status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(j) })
        if (url === TOKEN && r.method === 'POST') return json(200, this.token(new URLSearchParams(body)))
        if (url === `https://api.github.com/applications/${CLIENT_ID}/token` && r.method === 'DELETE') {
          this.revoked.push({ auth, token: JSON.parse(body).access_token })
          return { status: 204, body: '' }
        }
        if (url === 'https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/') return json(200, { resource: MCP, authorization_servers: ['https://github.com/login/oauth'], scopes_supported: ['repo', 'read:org'] })
        if (url === 'https://github.com/.well-known/oauth-authorization-server/login/oauth') {
          return json(200, { issuer: 'https://github.com/login/oauth', authorization_endpoint: AUTHORIZE, token_endpoint: TOKEN, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] })
        }
        if (url === MCP) {
          if (auth !== `Bearer ${this.access}` || !this.access) {
            return json(401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer error="invalid_request", resource_metadata="https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/"` })
          }
          const a = await answerMcp('github', this.tools, r)
          return { status: a.status, headers: a.headers, body: a.body }
        }
        return { status: 404, body: 'not here' }
      },
    }
  }

  private token(q: URLSearchParams): Record<string, unknown> {
    if (this.failNext) { const error = this.failNext; this.failNext = null; return { error, error_description: 'refused' } }
    if (q.get('client_id') !== CLIENT_ID || !this.secrets.has(q.get('client_secret') ?? '')) return { error: 'incorrect_client_credentials' }
    if (q.get('grant_type') === 'authorization_code') {
      const c = this.codes.get(q.get('code') ?? '')
      this.codes.delete(q.get('code') ?? '')
      if (!c || c.redirect !== q.get('redirect_uri')) return { error: 'bad_verification_code' }
      const challenge = new Bun.CryptoHasher('sha256').update(q.get('code_verifier') ?? '').digest('base64url')
      if (challenge !== c.verifier) return { error: 'bad_verification_code' }
    } else if (q.get('grant_type') === 'refresh_token') {
      // a refresh token works once (GitHub rotates it)
      if (!this.refresh || q.get('refresh_token') !== this.refresh) return { error: 'bad_refresh_token' }
    } else return { error: 'unsupported_grant_type' }
    this.access = `ghu_CANARY-access-${++this.n}`
    this.refresh = `ghr_CANARY-refresh-${this.n}`
    return { access_token: this.access, expires_in: 28800, refresh_token: this.refresh, refresh_token_expires_in: 15897600, scope: '', token_type: 'bearer' }
  }
}

let h: Harness, olga: Client, bob: Client, bobId: string, gh: FakeGitHub, svc: Integrations
let logs: string[] = []
let seq = 0
beforeEach(async () => {
  logs = []
  h = await harness('int-github-' + ++seq, {}, { log: createLogger({ level: 'debug', sink: (l) => logs.push(l) }) })
  olga = await withOwner(h)
  const b = await addMember(h, olga, { username: 'bob', role: 'member' })
  bob = b.client; bobId = b.id
  gh = new FakeGitHub()
  svc = integrationsOf(h.ctx, { net: gh.net(), now: () => gh.now })
})
afterEach(async () => { await h?.close() })

/** the server's GitHub App, where the server reads it (mode 0600 in private folders) */
function putApp(app: Record<string, unknown> = { clientId: CLIENT_ID, clientSecret: SECRET, slug: 'trina-test' }, mode = 0o600) {
  const file = githubAppFile(h.ctx)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, JSON.stringify(app), { mode })
  fs.chmodSync(file, mode)
  return file
}
const callback = (q: Record<string, string>) => '/api/integrations/oauth/callback?' + new URLSearchParams(q)
const everything = () => ['integrations', 'integration_templates', 'integration_oauth_flows', 'audit_log', 'tool_events']
  .map((t) => JSON.stringify(h.ctx.db.query(`SELECT * FROM ${t}`).all())).join('\n') + logs.join('\n')
const tokenCalls = () => gh.seen.filter((s) => s.url === TOKEN).map((s) => Object.fromEntries(new URLSearchParams(s.body)))
const github = (over: Record<string, unknown> = {}) => ({ kind: 'mcp', name: 'GitHub', url: MCP, auth: 'oauth', ...over })

/** Connect: the sign-in address the browser opens, and GitHub sending the browser back with a code for it */
async function signIn(who: Client, id: string, o: { expect?: number } = {}) {
  const f = await who.call('POST', `/api/integrations/${id}/authorize`, {})
  const u = new URL(f.authorizationUrl)
  const code = gh.code(u.searchParams.get('code_challenge')!, u.searchParams.get('redirect_uri')!)
  const res = await who.raw('GET', callback({ state: u.searchParams.get('state')!, code, iss: 'https://github.com/login/oauth' }))
  expect(res.status).toBe(o.expect ?? 200)
  return u
}

test('without a GitHub App on the server: the list says not ready, and signing in fails as for any service without registration', async () => {
  expect((await olga.call('GET', '/api/integrations')).github).toEqual({ ready: false, installUrl: null })
  expect((await olga.call('GET', '/api/admin/integrations')).github).toEqual({ ready: false, installUrl: null })
  const c = await olga.call('POST', '/api/integrations', github())
  const no = await olga.try('POST', `/api/integrations/${c.id}/authorize`, {})
  expect(no.status).toBe(400)
  // GitHub's metadata was read (it lists no registration address), and nothing went to its token address
  expect(gh.seen.some((s) => s.url.includes('oauth-authorization-server'))).toBe(true)
  expect(tokenCalls()).toEqual([])
})

test('with the app: Connect goes to GitHub with the app, PKCE and no scope; the secret only reaches the token address and never shows', async () => {
  putApp()
  expect((await bob.call('GET', '/api/integrations')).github).toEqual({ ready: true, installUrl: 'https://github.com/apps/trina-test/installations/new' })
  const c = await bob.call('POST', '/api/integrations', github())
  expect(c).toMatchObject({ status: 'needs_auth', oauthClient: null })
  const u = await signIn(bob, c.id)
  // GitHub's own sign-in address, nothing discovered or registered
  expect(u.origin + u.pathname).toBe(AUTHORIZE)
  expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: 'code', code_challenge_method: 'S256' })
  expect(u.searchParams.has('scope')).toBe(false)
  expect(u.toString()).not.toContain(SECRET)
  expect(gh.seen.some((s) => s.url.includes('.well-known'))).toBe(false)
  // the code exchanged with the app's secret and the verifier
  expect(tokenCalls()).toHaveLength(1)
  expect(tokenCalls()[0]).toMatchObject({ grant_type: 'authorization_code', client_id: CLIENT_ID, client_secret: SECRET, redirect_uri: REDIRECT })
  // checked after the sign-in: its tools saved, the changing one marked as a change
  const after = (await bob.call('GET', '/api/integrations')).items.find((i: any) => i.id === c.id)
  expect(after).toMatchObject({ status: 'connected', hasSecret: true, oauthClient: null })
  expect(after.tools.map((t: any) => [t.name, t.readOnly])).toEqual([['get_me', true], ['issue_write', false]])
  // the token went to the MCP server only, the secret to the token address only
  expect(gh.seen.filter((s) => s.auth?.startsWith('Bearer ghu_')).every((s) => s.url === MCP)).toBe(true)
  expect(gh.seen.filter((s) => s.url !== TOKEN).some((s) => JSON.stringify(s).includes(SECRET))).toBe(false)
  expect(everything()).not.toContain(SECRET)
  expect(everything()).not.toContain('CANARY-access-')
  expect(everything()).not.toContain('CANARY-refresh-')
  // nobody else's page shows it: the owner lists only their own
  expect((await olga.call('GET', '/api/integrations')).items.some((i: any) => i.id === c.id)).toBe(false)
})

test('an 8-hour token is refreshed with the app\'s current secret, GitHub\'s new refresh token is kept, a refused one asks to sign in again', async () => {
  putApp()
  const c = await bob.call('POST', '/api/integrations', github())
  await signIn(bob, c.id)
  const firstRefresh = gh.refresh
  // the operator rotated the app's secret (GitHub keeps both for a while, then drops the old one)
  gh.secrets.add(SECRET2)
  putApp({ clientId: CLIENT_ID, clientSecret: SECRET2, slug: 'trina-test' })
  gh.secrets.delete(SECRET)
  gh.now += 28_800_000 + 1
  const r = await svc.callTool(getRow(h.ctx.db, c.id)!, 'get_me', {})
  expect(JSON.stringify(r)).toContain('octo')
  expect(tokenCalls().at(-1)).toMatchObject({ grant_type: 'refresh_token', client_id: CLIENT_ID, client_secret: SECRET2, refresh_token: firstRefresh })
  // the rotated refresh token is the one used next time
  gh.now += 28_800_000 + 1
  await svc.callTool(getRow(h.ctx.db, c.id)!, 'get_me', {})
  expect(tokenCalls().at(-1)!.refresh_token).not.toBe(firstRefresh)
  expect(everything()).not.toContain(SECRET2)
  // GitHub refuses the refresh token with HTTP 200 and its own error name: sign in again
  gh.now += 28_800_000 + 1
  gh.failNext = 'bad_refresh_token'
  await expect(svc.callTool(getRow(h.ctx.db, c.id)!, 'get_me', {})).rejects.toBeTruthy()
  expect(getRow(h.ctx.db, c.id)).toMatchObject({ status: 'needs_auth', last_error: 'sign_in' })
})

test('GitHub\'s HTTP-200 refusals of a code, and a refused app, end the sign-in without keeping anything', async () => {
  putApp()
  const c = await bob.call('POST', '/api/integrations', github())
  gh.failNext = 'bad_verification_code'
  await signIn(bob, c.id, { expect: 400 })
  expect(getRow(h.ctx.db, c.id)).toMatchObject({ secret_enc: null })
  // the app's secret no longer works at GitHub: the sign-in fails (it is the server's app: nothing for the person to fix)
  gh.secrets.clear()
  await signIn(bob, c.id, { expect: 400 })
  const flows = h.ctx.db.query('SELECT reason FROM integration_oauth_flows WHERE integration_id = ? ORDER BY created_at').all(c.id) as { reason: string }[]
  expect(flows.map((f) => f.reason)).toEqual(['exchange', 'exchange'])
})

test('only GitHub\'s exact official address gets the server\'s app; an own app wins; an unsafe app file is not read', async () => {
  putApp()
  for (const u of ['https://api.githubcopilot.com/mcp', 'https://api.githubcopilot.com/mcp/']) expect(serverAppAt(u), u).toBe('github')
  for (const u of ['https://api.githubcopilot.com/mcp/x/all', 'https://api.githubcopilot.com/mcp/?x=1', 'https://api.githubcopilot.com:8443/mcp/', 'http://api.githubcopilot.com/mcp/', 'https://evil.example/mcp/', 'https://mcp.notion.com/mcp'])
    expect(serverAppAt(u), u).toBeNull()
  const other = await bob.call('POST', '/api/integrations', github({ name: 'Look-alike', url: 'https://api.githubcopilot.com/mcp/x/all' }))
  expect(svc.appOf(getRow(h.ctx.db, other.id)!)).toBeNull()
  const official = await bob.call('POST', '/api/integrations', github())
  expect(svc.appOf(getRow(h.ctx.db, official.id)!)).toMatchObject({ clientId: CLIENT_ID, serverApp: 'github', tokenUrl: TOKEN })
  // a person's own GitHub App on the connection is theirs, never mixed with the server's
  const own = await olga.call('POST', '/api/integrations', github({ oauthClient: { clientId: 'Iv23-own', clientSecret: 'CANARY-own-secret-1' } }))
  expect(svc.appOf(getRow(h.ctx.db, own.id)!)).toMatchObject({ clientId: 'Iv23-own' })
  expect(svc.appOf(getRow(h.ctx.db, own.id)!)?.serverApp).toBeUndefined()
  // the file: readable by others, or with fields it should not have: not used
  const file = putApp(undefined, 0o644)
  expect(readGitHubApp(file, h.ctx.config.teamRoot)).toBeNull()
  expect((await bob.call('GET', '/api/integrations')).github.ready).toBe(false)
  putApp({ clientId: CLIENT_ID, clientSecret: SECRET, privateKey: 'x' })
  expect(githubAppOf(h.ctx)).toBeNull()
  // MYCEL_GITHUB_APP_FILE names the file; set but unusable means none (never the default file instead)
  putApp()
  expect(githubAppOf(h.ctx, { MYCEL_GITHUB_APP_FILE: path.join(h.ctx.config.teamRoot, 'nope.json') })).toBeNull()
  expect(githubAppOf(h.ctx, { MYCEL_GITHUB_APP_FILE: file })?.clientId).toBe(CLIENT_ID)
})

test('a team connection (an admin signs in) and a template\'s members (each their own account) sign in through the same app', async () => {
  putApp()
  const team = await olga.call('POST', '/api/admin/integrations', { ...github(), access: { everyone: true, groups: [], users: [] } })
  await signIn(olga, team.id)
  expect(getRow(h.ctx.db, team.id)).toMatchObject({ status: 'connected' })
  expect(tokenCalls().at(-1)).toMatchObject({ client_id: CLIENT_ID, client_secret: SECRET })
  const t = await olga.call('POST', '/api/admin/integration-templates', { kind: 'mcp', name: 'GitHub', url: MCP, auth: 'oauth', access: { everyone: false, groups: [], users: [bobId] } })
  const shared = (await bob.call('GET', '/api/integration-templates')).items
  const mine = await bob.call('POST', `/api/integration-templates/${t.id}/connect`, { version: shared[0].version })
  await signIn(bob, mine.id)
  expect(getRow(h.ctx.db, mine.id)).toMatchObject({ status: 'connected' })
  expect(everything()).not.toContain(SECRET)
})

test('Disconnect ends the token at GitHub with the app as it is now (the person\'s authorization of the app stays on GitHub)', async () => {
  putApp()
  const c = await bob.call('POST', '/api/integrations', github())
  await signIn(bob, c.id)
  const token = gh.access
  // the secret was rotated since the sign-in: the revocation uses the current one
  gh.secrets.add(SECRET2)
  putApp({ clientId: CLIENT_ID, clientSecret: SECRET2, slug: 'trina-test' })
  expect((await bob.raw('DELETE', `/api/integrations/${c.id}`)).status).toBe(204)
  expect(getRow(h.ctx.db, c.id)).toBeNull()
  expect(gh.revoked).toEqual([{ auth: 'Basic ' + Buffer.from(`${CLIENT_ID}:${SECRET2}`).toString('base64'), token }])
  // signing in again ends the earlier token too
  const c2 = await bob.call('POST', '/api/integrations', github())
  await signIn(bob, c2.id)
  const first = gh.access
  await signIn(bob, c2.id)
  for (let i = 0; i < 100 && gh.revoked.at(-1)!.token !== first; i++) await Bun.sleep(20)
  expect(gh.revoked.at(-1)!.token).toBe(first)
  expect(everything()).not.toContain(SECRET2)
})

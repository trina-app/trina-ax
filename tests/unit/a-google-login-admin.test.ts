// Component A: Sign in with Google, part A2 (docs/AGENTS/plan/20261122-0616-google-login-admin.md). The team switch in
// Admin › Team settings (off: no button, no connect, no start, a return on its way refused; connections kept and working
// again when it is back on), the admin read that shows the row, Admin › Members' "Google" and its disconnect with the
// people rules, the Inbox notice when a Google account is connected (never the account or its address), and login_hint
// on the person's own Google Drive sign-in.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { googleDriveOf } from '../../server/src/integrations/google-drive/oauth'
import { OWNER_PW, addMember, harness, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(30_000)

const CLIENT_ID = 'test-client.apps.googleusercontent.com'
const CALLBACK = '/api/integrations/google-drive/callback'
const GSI = 'mycel-dev-gsi'

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.c2ln`

let nextAccount: { sub: string; email: string } = { sub: '100', email: 'olga@acme.test' }
const nonces = new Map<string, string>()
const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  const body = new URLSearchParams(String(init?.body ?? ''))
  const nonce = nonces.get(body.get('code') ?? '') ?? ''
  const id_token = jwt({ iss: 'https://accounts.google.com', aud: CLIENT_ID, azp: CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 600, nonce, sub: nextAccount.sub, email: nextAccount.email, email_verified: true })
  return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600, token_type: 'Bearer', id_token }), { status: 200, headers: { 'content-type': 'application/json' } })
}) as unknown as typeof fetch

describe('Sign in with Google: the team side', () => {
  let h: Harness
  let owner: Client
  let admin: { id: string; client: Client; password: string }
  beforeAll(async () => {
    h = await harness('google-login-admin')
    owner = await withOwner(h)
    admin = await addMember(h, owner, { username: 'adam', role: 'admin' })
    googleDriveOf(h.ctx, { config: { clientId: CLIENT_ID, clientSecret: 'secret', redirectUri: `http://team.localhost${CALLBACK}` }, fetch: fakeFetch, broker: null })
  })
  afterAll(() => h.close())

  const started = (res: Response, body: { url: string }) => {
    const u = new URL(body.url)
    const state = u.searchParams.get('state')!
    const gsi = res.headers.getSetCookie().find((c) => c.startsWith(`${GSI}=`))!.split(';')[0]!
    const code = `code-${state.slice(0, 8)}`
    nonces.set(code, u.searchParams.get('nonce')!)
    return { state, gsi, code }
  }
  const back = (state: string, cookie: string) => h.fetch(`${CALLBACK}?${new URLSearchParams({ state, code: `code-${state.slice(0, 8)}` })}`, { headers: cookie ? { cookie } : {} })
  const connect = async (c: Client, password: string) => {
    const res = await c.raw('POST', '/api/me/google/connect', { password })
    expect(res.status).toBe(200)
    const s = started(res, await res.json() as { url: string })
    return (await back(s.state, `${c.cookie}; ${s.gsi}`)).headers.get('location')
  }
  const signInStart = async () => {
    const c = h.client()
    const res = await c.raw('POST', '/api/auth/google/start', {})
    return { res, s: res.status === 200 ? started(res, await res.json() as { url: string }) : null }
  }
  const setSwitch = (on: boolean, by: Client = owner) => by.call('PATCH', '/api/admin/settings', { googleSignIn: on })
  const google = async (c: Client) => (await c.call('GET', '/api/notifications')).items.filter((x: any) => x.code === 'account.google_connected')

  test('the switch is on by default, and the row shows where there is a Google client', async () => {
    expect((await owner.call('GET', '/api/admin/settings')).googleSignIn).toBe(true)
    expect(await owner.call('GET', '/api/admin/google-login')).toEqual({ client: true })
    expect(await admin.client.call('GET', '/api/admin/google-login')).toEqual({ client: true })
    const m = await addMember(h, owner, { username: 'max' })
    expect((await m.client.try('GET', '/api/admin/google-login')).status).toBe(403)
    // no client: the page says how to add one instead of the row
    const drive = googleDriveOf(h.ctx)
    const cfg = drive.config
    ;(drive as any).cfg = null
    try { expect(await owner.call('GET', '/api/admin/google-login')).toEqual({ client: false }) } finally { (drive as any).cfg = cfg }
  })

  test('off: no button, no connect, no start, a return on its way refused; the connection stays and works again when on', async () => {
    nextAccount = { sub: '100', email: 'olga@acme.test' }
    expect(await connect(owner, OWNER_PW)).toBe('/settings/security?google=connected')
    // a sign-in started before an admin turns it off
    const early = await signInStart()
    expect(early.res.status).toBe(200)

    await setSwitch(false, admin.client)
    expect((await owner.call('GET', '/api/admin/settings')).googleSignIn).toBe(false)
    // the settings change is audited like any other
    expect(h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'settings.update' ORDER BY rowid DESC LIMIT 1").get()).toEqual({ detail: JSON.stringify({ googleSignIn: false }) })
    expect((await h.client().call('GET', '/api/setup')).googleSignIn).toBeUndefined()
    expect((await signInStart()).res.status).toBe(503)
    expect((await owner.try('POST', '/api/me/google/connect', { password: OWNER_PW })).status).toBe(503)
    // the connected account is still listed, with Disconnect, and nothing new can be connected here
    const mine = await owner.call('GET', '/api/me/google')
    expect(mine.available).toBe(false)
    expect(mine.account.email).toBe('olga@acme.test')
    // the return of the early start neither signs in nor spends anything else
    const r = await back(early.s!.state, early.s!.gsi)
    expect(r.headers.get('location')).toBe('/login?google=failed')
    expect(r.headers.getSetCookie().some((x) => x.startsWith('mycel-dev-sid=') && !x.startsWith('mycel-dev-sid=;'))).toBe(false)
    expect(h.ctx.db.query("SELECT 1 FROM login_identities WHERE user_id = 'olga'").get()).toBeTruthy()

    await setSwitch(true)
    expect((await h.client().call('GET', '/api/setup')).googleSignIn).toBe(true)
    const again = await signInStart()
    expect(again.res.status).toBe(200)
    expect((await back(again.s!.state, again.s!.gsi)).headers.get('location')).toBe('/')
  })

  test('the Inbox tells the person when a Google account is connected, never which one', async () => {
    const m = await addMember(h, owner, { username: 'nora' })
    expect(await google(m.client)).toHaveLength(0)
    nextAccount = { sub: '200', email: 'nora@acme.test' }
    expect(await connect(m.client, m.password)).toBe('/settings/security?google=connected')
    let n = await google(m.client)
    expect(n).toHaveLength(1)
    expect(n[0]).toMatchObject({ eventType: 'account.google_connected', readAt: null, link: null, googleConnected: { connected: true } })
    expect(JSON.stringify(n)).not.toContain('nora@acme.test')
    expect(JSON.stringify(h.ctx.db.query("SELECT * FROM google_connect_notices WHERE user_id = ?").all(m.id))).not.toContain('acme.test')
    // connecting the same Google account again adds no way in, and no notice
    expect(await connect(m.client, m.password)).toBe('/settings/security?google=connected')
    expect(await google(m.client)).toHaveLength(1)
    // disconnected: the row no longer says to disconnect it
    await m.client.raw('DELETE', '/api/me/google')
    n = await google(m.client)
    expect(n[0].googleConnected).toEqual({ connected: false })
    // a new connection is a new notice; the old one keeps saying it is gone
    nextAccount = { sub: '201', email: 'nora.other@acme.test' }
    expect(await connect(m.client, m.password)).toBe('/settings/security?google=connected')
    n = await google(m.client)
    expect(n.map((x: any) => x.googleConnected.connected).sort()).toEqual([false, true])
    // nobody else is told
    expect((await google(admin.client)).length).toBe(0)
  })

  test('Admin › Members: who connected one, and the disconnect with the people rules', async () => {
    const m = await addMember(h, owner, { username: 'otto' })
    nextAccount = { sub: '300', email: 'otto@acme.test' }
    await connect(m.client, m.password)
    nextAccount = { sub: '301', email: 'adam@acme.test' }
    await connect(admin.client, admin.password)
    const list = await admin.client.call('GET', '/api/admin/users')
    expect(list.google).toEqual(expect.arrayContaining(['olga', m.id, admin.id]))
    expect(JSON.stringify(list)).not.toContain('otto@acme.test')

    const del = (by: Client, id: string) => by.try('DELETE', `/api/admin/users/${id}/google`)
    // nobody acts on the owner, an admin not on another admin, nobody on themselves here, a member not at all
    expect((await del(admin.client, 'olga')).status).toBe(403)
    const other = await addMember(h, owner, { username: 'alma', role: 'admin' })
    expect((await del(other.client, admin.id)).status).toBe(403)
    expect((await del(admin.client, admin.id)).status).toBe(403)
    expect((await del(owner, 'olga')).status).toBe(403)
    const plain = await addMember(h, owner, { username: 'pete' })
    expect((await del(plain.client, m.id)).status).toBe(403)
    expect((await del(admin.client, 'nobody-here')).status).toBe(404)
    expect(h.ctx.db.query("SELECT COUNT(*) AS n FROM login_identities WHERE user_id IN ('olga', ?, ?)").get(m.id, admin.id)).toEqual({ n: 3 })

    // an admin on a member; the owner on an admin
    expect((await del(admin.client, m.id)).status).toBe(204)
    expect((await del(owner, admin.id)).status).toBe(204)
    expect(h.ctx.db.query('SELECT 1 FROM login_identities WHERE user_id IN (?, ?)').get(m.id, admin.id)).toBeNull()
    // their sessions ended: one made with that Google account must not outlive it
    expect((await m.client.try('GET', '/api/me')).status).toBe(401)
    expect((await admin.client.try('GET', '/api/me')).status).toBe(401)
    expect((await owner.call('GET', '/api/admin/users')).google).not.toContain(m.id)
    // the owners and admins are told, and the person (never the Google account)
    const told = h.ctx.db.query("SELECT user_id, subject FROM credential_change_notices WHERE action = 'signin_google_disconnected'").all() as { user_id: string; subject: string }[]
    expect(told.map((r) => r.user_id)).toEqual(expect.arrayContaining(['olga', m.id, other.id]))
    expect(JSON.stringify(told)).not.toContain('acme.test')
    // audited with who did it to whom, never the Google account
    const rows = h.ctx.db.query("SELECT actor_id, target, detail FROM audit_log WHERE action = 'user.google_disconnected' ORDER BY rowid").all() as { actor_id: string; target: string; detail: string | null }[]
    expect(rows.map((r) => [r.actor_id, r.target])).toEqual([[admin.id, m.id], ['olga', admin.id]])
    expect(JSON.stringify(rows)).not.toContain('acme.test')
    // again: nothing to remove, nothing audited
    expect((await del(owner, m.id)).status).toBe(204)
    expect((h.ctx.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'user.google_disconnected'").get() as { n: number }).n).toBe(2)
  })

  test("login_hint: the person's own Google Drive picks the Google account they sign in with", async () => {
    const m = await addMember(h, owner, { username: 'quin' })
    const hintOf = async (c: Client) => new URL((await c.call('POST', '/api/integrations/google-drive/authorize', {})).authorizationUrl).searchParams.get('login_hint')
    expect(await hintOf(m.client)).toBeNull()
    nextAccount = { sub: '400', email: 'quin@acme.test' }
    await connect(m.client, m.password)
    expect(await hintOf(m.client)).toBe('quin@acme.test')
    // a Drive shared with the team is often another account: no hint
    const share = await owner.call('POST', '/api/admin/google-drive/shares/authorize', {})
    expect(new URL(share.authorizationUrl).searchParams.get('login_hint')).toBeNull()
    // and a hint that is not a plain address is left out
    h.ctx.db.query("UPDATE login_identities SET email = 'not an address' WHERE user_id = ?").run(m.id)
    expect(await hintOf(m.client)).toBeNull()
  })
})

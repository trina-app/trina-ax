// Component A: the desktop app's one-time sign-in code ("Continue in the Mac app" after setup, server/src/auth/app-signin.ts;
// docs/decisions/20261116-desktop-first-onboarding.md): made by a cookie session, spent once within 3 minutes by the app's
// /app-signin page, one live code per person, gone with a password change, a disabled account or a sign-out.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { DEFAULT_LIMITS } from '../../server/src/auth/rate-limit'
import { APP_SIGNIN_TTL_MS } from '../../server/src/auth/app-signin'
import { sweep } from '../../server/src/auth/sweeper'
import { OWNER_PW, addMember, harness, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(30_000)

const MINT = '/api/auth/app-signin'
const REDEEM = '/api/auth/app-signin/redeem'

describe('app sign-in codes', () => {
  let h: Harness
  let owner: Client
  beforeAll(async () => { h = await harness('app-signin'); owner = await withOwner(h) })
  afterAll(() => h.close())

  const mint = async (c: Client = owner): Promise<string> => (await c.call('POST', MINT)).code

  test('a code from the browser signs the app in as the same person, with a cookie, once', async () => {
    const r = await owner.call('POST', MINT)
    expect(r.code).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const ttl = Date.parse(r.expiresAt) - Date.now()
    expect(ttl).toBeGreaterThan(APP_SIGNIN_TTL_MS - 10_000)
    expect(ttl).toBeLessThanOrEqual(APP_SIGNIN_TTL_MS)
    // only the hash is kept
    const rows = h.ctx.db.query('SELECT token_hash FROM app_signin_codes').all() as { token_hash: string }[]
    expect(rows.some((x) => x.token_hash === r.code)).toBe(false)
    expect(rows.every((x) => /^[0-9a-f]{64}$/.test(x.token_hash))).toBe(true)
    const app = h.client()
    const res = await app.raw('POST', REDEEM, { code: r.code })
    expect(res.status).toBe(200)
    expect(res.headers.getSetCookie()[0]).toMatch(/^mycel-dev-sid=[A-Za-z0-9_-]{40,}; Path=\/; HttpOnly; SameSite=Lax/)
    const body = (await res.json()) as any
    expect(body.token).toBeUndefined()
    expect(body.me.user.id).toBe('olga')
    expect(body.me.session.client).toBe('desktop')
    expect((await app.call('GET', '/api/me')).user.id).toBe('olga')
    // used: a second redeem (the same link opened again) is gone
    const again = await h.client().try('POST', REDEEM, { code: r.code })
    expect(again.status).toBe(410)
    expect(again.body.error.message).toContain('만료')
    // audit rows carry the person, never the code
    const audits = h.ctx.db.query("SELECT action, detail FROM audit_log WHERE action LIKE 'auth.app_signin%'").all() as { action: string; detail: string }[]
    expect(audits.map((a) => a.action).sort()).toEqual(['auth.app_signin', 'auth.app_signin_code'])
    expect(audits.some((a) => (a.detail ?? '').includes(r.code))).toBe(false)
  })

  test('an expired code is gone', async () => {
    const code = await mint()
    h.advance(APP_SIGNIN_TTL_MS + 1000)
    try {
      expect((await h.client().try('POST', REDEEM, { code })).status).toBe(410)
    } finally { h.advance(-(APP_SIGNIN_TTL_MS + 1000)) }
  })

  test('unknown and malformed codes are gone and count against the IP', async () => {
    const c = h.client({ ip: '10.9.9.9' })
    expect((await c.try('POST', REDEEM, { code: 'B'.repeat(43) })).status).toBe(410)
    expect((await c.try('POST', REDEEM, { code: 'short' })).status).toBe(410)
    const n = (h.ctx.db.query("SELECT COUNT(*) AS n FROM login_attempts WHERE key = 'token-ip:10.9.9.9'").get() as { n: number }).n
    expect(n).toBe(2)
  })

  test('one live code per person: a new press voids the earlier one', async () => {
    const first = await mint()
    const second = await mint()
    expect((await h.client().try('POST', REDEEM, { code: first })).status).toBe(410)
    expect((await h.client().try('POST', REDEEM, { code: second })).status).toBe(200)
  })

  test('only a cookie session makes a code: a bearer token is refused', async () => {
    const app = h.client()
    await app.login('olga', OWNER_PW, 'bearer')
    expect((await app.try('POST', MINT)).status).toBe(403)
    // signed out: no code
    expect((await h.client().try('POST', MINT)).status).toBe(401)
  })

  test('redeem only by POST; a GET does not exist; CSRF header required', async () => {
    const code = await mint()
    expect((await h.client().try('GET', `${REDEEM}?code=${code}`)).status).toBe(404)
    expect((await h.client().try('POST', REDEEM, { code }, { 'x-mycel-csrf': '' })).status).toBe(403)
    expect((await owner.try('POST', MINT, undefined, { 'x-mycel-csrf': '' })).status).toBe(403)
    // still unused after those
    expect((await h.client().try('POST', REDEEM, { code })).status).toBe(200)
  })

  test('making codes is rate-limited per person', async () => {
    const before = h.auth.limiter.limits
    h.auth.limiter.limits = { ...DEFAULT_LIMITS, perAppCode: 2 }
    try {
      const c = h.client()
      await c.login('olga', OWNER_PW)
      // the earlier tests made codes for olga within the window: clear her counter first
      h.ctx.db.query("DELETE FROM login_attempts WHERE key = 'app-code:olga'").run()
      expect((await c.try('POST', MINT)).status).toBe(200)
      expect((await c.try('POST', MINT)).status).toBe(200)
      const third = await c.try('POST', MINT)
      expect(third.status).toBe(429)
    } finally {
      h.auth.limiter.limits = before
      h.ctx.db.query("DELETE FROM login_attempts WHERE key = 'app-code:olga'").run()
    }
  })

  test('a password change voids the person\'s open code', async () => {
    const m = await addMember(h, owner, { username: 'mira' })
    const code = await mint(m.client)
    await m.client.call('POST', '/api/auth/password', { currentPassword: m.password, newPassword: 'quiet harbor lamp 19' })
    expect((await h.client().try('POST', REDEEM, { code })).status).toBe(410)
  })

  test('an admin\'s temporary password and signing out void it too', async () => {
    const m = await addMember(h, owner, { username: 'tara' })
    const code = await mint(m.client)
    await owner.call('POST', `/api/admin/users/${m.id}/reset-password`, {})
    expect((await h.client().try('POST', REDEEM, { code })).status).toBe(410)
    const n = await addMember(h, owner, { username: 'noor' })
    const code2 = await mint(n.client)
    await n.client.call('POST', '/api/auth/logout')
    expect((await h.client().try('POST', REDEEM, { code: code2 })).status).toBe(410)
  })

  test('a disabled account signs nobody in, whatever code it made', async () => {
    const m = await addMember(h, owner, { username: 'dana' })
    const code = await mint(m.client)
    await owner.call('PATCH', `/api/admin/users/${m.id}`, { status: 'disabled' })
    expect((await h.client().try('POST', REDEEM, { code })).status).toBe(410)
    // a code that survived the voiding (made straight in the DB) is still refused by the account check
    await owner.call('PATCH', `/api/admin/users/${m.id}`, { status: 'active' })
    const back = h.client()
    await back.login('dana', m.password)
    const code2 = await mint(back)
    h.ctx.db.query("UPDATE users SET status = 'disabled' WHERE id = ?").run(m.id)
    try {
      expect((await h.client().try('POST', REDEEM, { code: code2 })).status).toBe(410)
    } finally { h.ctx.db.query("UPDATE users SET status = 'active' WHERE id = ?").run(m.id) }
  })

  test('a code never replaces another person\'s sign-in: refused, the code left unspent, that session kept', async () => {
    // login CSRF: a member sends their own code to the owner, whose app is signed in to the same team
    const m = await addMember(h, owner, { username: 'lena' })
    const code = await mint(m.client)
    const ownersApp = h.client()
    await ownersApp.login('olga', OWNER_PW)
    const r = await ownersApp.try('POST', REDEEM, { code })
    expect(r.status).toBe(409)
    expect(r.body.error.params?.reason).toBe('signed_in_as_other')
    expect((await ownersApp.call('GET', '/api/me')).user.id).toBe('olga')
    // a bearer sign-in of someone else counts the same
    const bearer = h.client()
    await bearer.login('olga', OWNER_PW, 'bearer')
    expect((await bearer.try('POST', REDEEM, { code })).status).toBe(409)
    // unspent: the app of the person it is for (signed out here) still uses it
    const fresh = h.client()
    expect((await fresh.call('POST', REDEEM, { code })).me.user.id).toBe('lena')
  })

  test('the same person signed in already: the code signs the app in again as them', async () => {
    const m = await addMember(h, owner, { username: 'sana' })
    const code = await mint(m.client)
    const app = h.client()
    await app.login('sana', m.password)
    expect((await app.call('POST', REDEEM, { code })).me.user.id).toBe('sana')
  })

  test('a code belongs to the browser sign-in that made it: signed out from another device, it is gone', async () => {
    const m = await addMember(h, owner, { username: 'ines' })
    const code = await mint(m.client)
    const sid = (await m.client.call('GET', '/api/me')).session.id
    const phone = h.client()
    await phone.login('ines', m.password, 'bearer')
    const res = await phone.raw('DELETE', `/api/me/sessions/${sid}`)
    expect(res.status).toBe(204)
    expect((h.ctx.db.query('SELECT COUNT(*) AS n FROM app_signin_codes WHERE user_id = ?').get(m.id) as { n: number }).n).toBe(0)
    expect((await h.client().try('POST', REDEEM, { code })).status).toBe(410)
  })

  test('a code whose browser sign-in expired signs nobody in', async () => {
    const m = await addMember(h, owner, { username: 'odin' })
    const code = await mint(m.client)
    h.ctx.db.query("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ?").run(m.id)
    expect((await h.client().try('POST', REDEEM, { code })).status).toBe(410)
  })

  test('the session it makes is always a desktop one', async () => {
    const code = await mint()
    expect((await h.client().try('POST', REDEEM, { code, client: 'web' })).status).toBe(400)
    expect((await h.client().try('POST', REDEEM, { code, client: 'mobile' })).status).toBe(400)
    expect((await h.client().call('POST', REDEEM, { code, client: 'desktop' })).me.session.client).toBe('desktop')
  })

  test('the sweeper removes spent and expired codes', async () => {
    await mint()
    h.advance(APP_SIGNIN_TTL_MS + 1000)
    try {
      sweep(h.ctx)
      expect((h.ctx.db.query('SELECT COUNT(*) AS n FROM app_signin_codes').get() as { n: number }).n).toBe(0)
    } finally { h.advance(-(APP_SIGNIN_TTL_MS + 1000)) }
  })
})

// Component A: sign in with the e-mail address as well as the username (server/src/auth/accounts.ts login,
// users.ts signInUser). Live QA of 0.20.0: an owner made from the desktop app (username from the e-mail) could sign in
// on the web only with a username they never chose. Covers: the e-mail, exact and any case; the username first (a
// username written like an address wins); an e-mail two accounts share is refused with its own words; a wrong
// password by e-mail counts on the account's counter like by username; deleted accounts never match.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { bootstrapOwner } from '../../server/src/auth/accounts'
import { signInUser } from '../../server/src/auth/users'
import { harness, type Harness } from './a-lib'

const PW = 'owner horse battery 42'

describe('sign in with the e-mail', () => {
  let h: Harness
  beforeAll(async () => {
    h = await harness('login-email')
    await bootstrapOwner(h.ctx, { email: 'Alex.Kim+create1@example.com', name: 'Alex', teamName: 'Acme', locale: 'en', credential: { password: PW } })
  })
  afterAll(() => h.close())

  const login = (username: string, password = PW) => h.client().try('POST', '/api/auth/login', { username, password })

  test('the username, and the e-mail in any case, sign the same person in', async () => {
    const id = (h.ctx.db.query('SELECT id, username FROM users').get() as { id: string; username: string })
    expect(id.username).toBe('alex.kim')
    for (const name of ['alex.kim', 'ALEX.KIM', 'Alex.Kim+create1@example.com', 'alex.kim+create1@EXAMPLE.com']) {
      const r = await login(name)
      expect([name, r.status]).toEqual([name, 200])
      expect(r.body.me.user.id).toBe(id.id)
    }
    // not a part of it, not another address
    expect((await login('alex.kim@example.com')).status).toBe(401)
    expect((await login('create1@example.com')).status).toBe(401)
  })

  test('a username written like an address wins over an e-mail', () => {
    h.ctx.db.query("INSERT INTO users (id, username, name, email, role, status, password_hash) SELECT 'u_other', 'sam@example.com', 'Sam', 'sam2@example.com', 'member', 'active', password_hash FROM users WHERE username = 'alex.kim'").run()
    h.ctx.db.query("INSERT INTO users (id, username, name, email, role, status, password_hash) SELECT 'u_third', 'third', 'Third', 'sam@example.com', 'member', 'active', password_hash FROM users WHERE username = 'alex.kim'").run()
    expect(signInUser(h.ctx.db, 'sam@example.com').user?.id).toBe('u_other')
  })

  test('an e-mail two accounts share is refused with its own words; the username still works', async () => {
    h.ctx.db.query("UPDATE users SET email = 'shared@example.com' WHERE id IN ('u_other', 'u_third')").run()
    const r = await login('Shared@example.com')
    expect(r.status).toBe(401)
    expect(r.body.error.message).toContain('username')
    expect(r.body.error.params?.reason).toBe('email_shared')
    expect((await login('third')).status).toBe(200)
  })

  test('a deleted account never matches its e-mail', async () => {
    h.ctx.db.query("UPDATE users SET email = 'gone@example.com', deleted_at = '2026-11-01T00:00:00Z' WHERE id = 'u_third'").run()
    expect(signInUser(h.ctx.db, 'gone@example.com')).toEqual({ user: null, shared: false })
  })

  test('wrong passwords by e-mail count on the account, like by username', async () => {
    const c = h.client({ ip: '10.3.3.3' })
    for (let i = 0; i < 12; i++) await c.try('POST', '/api/auth/login', { username: 'alex.kim+create1@example.com', password: 'wrong password 1' })
    const r = await h.client({ ip: '10.4.4.4' }).try('POST', '/api/auth/login', { username: 'alex.kim', password: 'wrong password 1' })
    expect([401, 429]).toContain(r.status)
    const n = (h.ctx.db.query("SELECT COUNT(*) AS n FROM login_attempts WHERE key LIKE '%alex.kim%'").get() as { n: number }).n
    expect(n).toBeGreaterThan(0)
  })
})

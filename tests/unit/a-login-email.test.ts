// Component A: sign in with the e-mail address as well as the username (server/src/auth/accounts.ts login,
// users.ts signInUser, emailTakenByOther). Live QA of 0.20.0: an owner made from the desktop app (username from the
// e-mail) could sign in on the web only with a username they never chose. Covers: the e-mail of exactly one active
// account signs it in (any case, trimmed); an address no account or several accounts use answers exactly like an
// unknown name; once an e-mail names an account, everything is that account's own (the per-account lock answers 429
// on its username too, and wrong tries void its temporary password); a username written like another account's e-mail
// is that account's username, and no new username may be an e-mail; no new or changed e-mail may be one another account
// has (Settings › Profile, Admin › Members, a new member), with the plain words.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { TEMP_PASSWORD_MAX_FAILURES } from '@mycel/shared'
import { bootstrapOwner } from '../../server/src/auth/accounts'
import { DEFAULT_LIMITS } from '../../server/src/auth/rate-limit'
import { emailTakenByOther, signInUser, usernameTaken } from '../../server/src/auth/users'
import { addMember, harness, type Client, type Harness } from './a-lib'

const PW = 'owner horse battery 42'

describe('sign in with the e-mail', () => {
  let h: Harness
  let owner: Client
  beforeAll(async () => {
    h = await harness('login-email')
    await bootstrapOwner(h.ctx, { email: 'Alex.Kim+create1@example.com', name: 'Alex', teamName: 'Acme', locale: 'en', credential: { password: PW } })
    owner = h.client()
    await owner.login('alex.kim', PW)
  })
  afterAll(() => h.close())

  const login = (username: string, password = PW, ip?: string) => h.client(ip ? { ip } : {}).try('POST', '/api/auth/login', { username, password })
  /** an account written straight to the database (also the shared e-mails that exist from before this rule) */
  const addUser = async (id: string, username: string, email: string | null, password = PW, status = 'active') => {
    const hash = await Bun.password.hash(password, { algorithm: 'argon2id', memoryCost: 4096, timeCost: 1 })
    h.ctx.db.query('INSERT INTO users (id, username, name, email, role, status, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, username, username, email, 'member', status, hash)
  }

  test('the e-mail of one account, in any case and with spaces around, signs that account in', async () => {
    const me = h.ctx.db.query('SELECT id, username FROM users').get() as { id: string; username: string }
    expect(me.username).toBe('alex.kim')
    for (const name of ['alex.kim', 'ALEX.KIM', ' alex.kim ', 'Alex.Kim+create1@example.com', ' alex.kim+create1@EXAMPLE.com ']) {
      const r = await login(name)
      expect([name, r.status]).toEqual([name, 200])
      expect(r.body.me.user.id).toBe(me.id)
    }
    expect((await login('alex.kim@example.com')).status).toBe(401)
  })

  test('an address several accounts use (from before) answers exactly like an unknown name; their usernames work', async () => {
    await addUser('u_a', 'ann', 'team@example.com', PW)
    await addUser('u_b', 'bob', 'team@example.com', PW)
    expect(signInUser(h.ctx.db, 'team@example.com')).toBeNull()
    const shared = await login('team@example.com', PW)
    const unknown = await login('nobody@example.com', PW)
    expect(shared.status).toBe(401)
    expect(shared.body.error.message).toBe(unknown.body.error.message)
    expect(shared.body.error.params).toEqual(unknown.body.error.params)
    expect((await login('ann', PW)).status).toBe(200)
    // a switched-off account does not count: the address is then one active account's
    await addUser('u_c', 'cat', 'solo@example.com', PW)
    await addUser('u_d', 'dan', 'solo@example.com', PW, 'disabled')
    expect((await login('solo@example.com', PW)).body.me.user.username).toBe('cat')
  })

  test('wrong tries by e-mail count against the account: its username is locked too (429)', async () => {
    await addUser('u_i', 'ivy', 'ivy@example.com', PW)
    let last = 0
    for (let i = 0; i < DEFAULT_LIMITS.perAccount + 2; i++) last = (await login('ivy@example.com', 'wrong password 1', `10.3.3.${i + 1}`)).status
    expect(last).toBe(429)
    expect((await login('ivy', PW, '10.4.4.4')).status).toBe(429)
    expect((await login(' IVY ', PW, '10.4.4.5')).status).toBe(429)
    h.advance(16 * 60_000)
  })

  test(`${TEMP_PASSWORD_MAX_FAILURES} wrong tries by e-mail void the account's temporary password`, async () => {
    const made = await owner.call('POST', '/api/admin/users', { username: 'yuri', name: 'Yuri', role: 'member', email: 'yuri@example.com', temporaryPassword: 'walnut234' })
    expect(made.user.username).toBe('yuri')
    for (let i = 0; i < TEMP_PASSWORD_MAX_FAILURES; i++) {
      if (i > 0 && i % (DEFAULT_LIMITS.perAccount - 1) === 0) h.advance(16 * 60_000)
      expect((await login('yuri@example.com', `walnut${300 + i}`, `10.9.0.${i + 1}`)).status).toBe(401)
    }
    h.advance(16 * 60_000)
    expect((await login('yuri', 'walnut234', '10.9.9.9')).status).toBe(401)
    expect(h.ctx.db.query("SELECT action FROM audit_log WHERE action = 'auth.temp_password_voided'").all().length).toBe(1)
  })

  test('a username written like another account\'s e-mail is that account\'s username; no new username may be an e-mail', async () => {
    await addUser('u_e', 'eve@example.com', null, PW)
    await addUser('u_f', 'fay', 'eve@example.com', PW)
    expect(signInUser(h.ctx.db, 'eve@example.com')?.id).toBe('u_e')
    expect(usernameTaken(h.ctx.db, 'Fay')).toBe(true)
    expect(usernameTaken(h.ctx.db, 'IVY@example.com')).toBe(true)
    expect(usernameTaken(h.ctx.db, 'free@example.com')).toBe(false)
    const r = await owner.try('POST', '/api/admin/users', { username: 'ivy@example.com', name: 'X', role: 'member' })
    expect(r.status).toBe(409)
  })

  test('no new or changed e-mail may be one another account has, with the plain words', async () => {
    expect(emailTakenByOther(h.ctx.db, ' IVY@example.com ', null)).toBe(true)
    expect(emailTakenByOther(h.ctx.db, 'ivy@example.com', 'u_i')).toBe(false)
    // Settings › Profile
    const mine = await owner.try('PATCH', '/api/me', { email: 'ivy@example.com' })
    expect(mine.status).toBe(409)
    expect(mine.body.error.message).toBe('Another account already uses this email.')
    // keeping its own e-mail is fine; a free one too
    expect((await owner.try('PATCH', '/api/me', { email: 'Alex.Kim+create1@example.com' })).status).toBe(200)
    // a new member
    const made = await owner.try('POST', '/api/admin/users', { username: 'zed', name: 'Zed', role: 'member', email: 'IVY@example.com' })
    expect(made.status).toBe(409)
    expect(made.body.error.message).toBe('Another account already uses this email.')
    // Admin › Members edit
    const yuri = (await owner.call('GET', '/api/admin/users')).items.find((u: { username: string }) => u.username === 'yuri')
    const edit = await owner.try('PATCH', `/api/admin/users/${yuri.id}`, { email: 'ivy@example.com' })
    expect(edit.status).toBe(409)
    expect((await owner.try('PATCH', `/api/admin/users/${yuri.id}`, { email: 'yuri2@example.com' })).status).toBe(200)
    // an e-mail equal to another account's username
    expect((await owner.try('PATCH', '/api/me', { email: 'eve@example.com' })).status).toBe(409)
  })

  test('two members made at once with one new e-mail: one is made, the other refused (checked inside the write)', async () => {
    const make = (username: string) => owner.try('POST', '/api/admin/users', { username, name: username, role: 'member', email: 'race@example.com' })
    const [a, b] = await Promise.all([make('race1'), make('race2')])
    expect([a.status, b.status].sort()).toEqual([201, 409])
    const refused = a.status === 409 ? a : b
    expect(refused.body.error.params?.reason).toBe('email_in_use')
    expect((h.ctx.db.query("SELECT COUNT(*) AS n FROM users WHERE lower(email) = 'race@example.com'").get() as { n: number }).n).toBe(1)
  })

  test('a switched-off account\'s e-mail is taken for a write (turning it back on never makes two), not for sign-in', async () => {
    await addUser('u_off', 'olly', 'off@example.com', PW, 'disabled')
    expect(emailTakenByOther(h.ctx.db, 'OFF@example.com', null)).toBe(true)
    expect(signInUser(h.ctx.db, 'off@example.com')).toBeNull()
    const r = await owner.try('PATCH', '/api/me', { email: 'off@example.com' })
    expect(r.status).toBe(409)
    expect((await owner.try('POST', '/api/admin/users', { username: 'olly2', name: 'Olly', role: 'member', email: 'off@example.com' })).status).toBe(409)
  })

  test('Settings › Profile: at most a few new e-mails an hour for everyone, so the 409 cannot probe who is in the team', async () => {
    const m = await addMember(h, owner, { username: 'probe', ip: '10.6.6.6' })
    let last = 0
    for (let i = 0; i < 12; i++) {
      const r = await m.client.try('PATCH', '/api/me', { email: `guess${i}@example.com` })
      last = r.status
      if (r.status === 429) { expect(r.body.error.params?.reason).toBe('email_tries'); break }
    }
    expect(last).toBe(429)
  })
})

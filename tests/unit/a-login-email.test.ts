// Component A: sign in with the e-mail address as well as the username (server/src/auth/accounts.ts login,
// users.ts signInCandidates). Live QA of 0.20.0: an owner made from the desktop app (username from the e-mail) could
// sign in on the web only with a username they never chose. Covers: the e-mail, exact and any case; an address several
// accounts use: the password decides (one match signs that one in, none is the usual wrong password, and "use your
// username" only when the password matches two), with the same number of password checks whatever the count, so
// neither the words nor the time say how many accounts use it; a username written like an address never shadows the
// e-mail's owner, and no new username may be someone's e-mail; switched-off and deleted accounts are never counted;
// wrong passwords by e-mail lock the account's username too.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { bootstrapOwner } from '../../server/src/auth/accounts'
import * as passwords from '../../server/src/auth/passwords'
import { signInCandidates, SIGN_IN_CANDIDATES_MAX, usernameTaken } from '../../server/src/auth/users'
import { harness, type Harness } from './a-lib'

const PW = 'owner horse battery 42'
const OTHER_PW = 'another long secret 77'

describe('sign in with the e-mail', () => {
  let h: Harness
  beforeAll(async () => {
    h = await harness('login-email')
    await bootstrapOwner(h.ctx, { email: 'Alex.Kim+create1@example.com', name: 'Alex', teamName: 'Acme', locale: 'en', credential: { password: PW } })
  })
  afterAll(() => h.close())

  const login = (username: string, password = PW, ip?: string) => h.client(ip ? { ip } : {}).try('POST', '/api/auth/login', { username, password })
  /** a second account: its password hash copied from the owner (PW) or a fresh one */
  const addUser = async (id: string, username: string, email: string | null, password = PW, status = 'active') => {
    const hash = await Bun.password.hash(password, { algorithm: 'argon2id', memoryCost: 4096, timeCost: 1 })
    h.ctx.db.query('INSERT INTO users (id, username, name, email, role, status, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, username, username, email, 'member', status, hash)
  }

  test('the username, and the e-mail in any case, sign the same person in', async () => {
    const id = (h.ctx.db.query('SELECT id, username FROM users').get() as { id: string; username: string })
    expect(id.username).toBe('alex.kim')
    for (const name of ['alex.kim', 'ALEX.KIM', 'Alex.Kim+create1@example.com', 'alex.kim+create1@EXAMPLE.com']) {
      const r = await login(name)
      expect([name, r.status]).toEqual([name, 200])
      expect(r.body.me.user.id).toBe(id.id)
    }
    expect((await login('alex.kim@example.com')).status).toBe(401)
    expect((await login('create1@example.com')).status).toBe(401)
  })

  test('an address two accounts use: the password decides; a wrong one is the usual answer; always the same number of checks', async () => {
    await addUser('u_a', 'ann', 'team@example.com', PW)
    await addUser('u_b', 'bob', 'team@example.com', OTHER_PW)
    const spy = spyOn(passwords, 'verifyPassword')
    try {
      // bob's password: bob is signed in
      const r = await login('team@example.com', OTHER_PW)
      expect(r.status).toBe(200)
      expect(r.body.me.user.username).toBe('bob')
      expect(spy).toHaveBeenCalledTimes(SIGN_IN_CANDIDATES_MAX)
      spy.mockClear()
      // a wrong password: the plain wrong-password answer, nothing about two accounts
      const wrong = await login('team@example.com', 'not the password 1')
      expect(wrong.status).toBe(401)
      expect(wrong.body.error.params?.reason).toBeUndefined()
      expect(wrong.body.error.message).not.toContain('More than one')
      expect(spy).toHaveBeenCalledTimes(SIGN_IN_CANDIDATES_MAX)
      spy.mockClear()
      // an address of one account, and an unknown address: as many checks
      await login('alex.kim+create1@example.com', 'not the password 1')
      expect(spy).toHaveBeenCalledTimes(SIGN_IN_CANDIDATES_MAX)
      spy.mockClear()
      await login('nobody@example.com', 'not the password 1')
      expect(spy).toHaveBeenCalledTimes(SIGN_IN_CANDIDATES_MAX)
    } finally {
      spy.mockRestore()
    }
  })

  test('only a password that opens two of them says to use the username', async () => {
    await addUser('u_c', 'cat', 'pair@example.com', PW)
    await addUser('u_d', 'dan', 'pair@example.com', PW)
    const r = await login('pair@example.com', PW)
    expect(r.status).toBe(401)
    expect(r.body.error.params?.reason).toBe('email_shared')
    expect(r.body.error.message).toContain('username')
    expect((await login('dan', PW)).status).toBe(200)
  })

  test('a username written like someone else\'s e-mail never takes that sign-in; no new username may be an e-mail', async () => {
    await addUser('u_e', 'eve@example.com', null, OTHER_PW)
    await addUser('u_f', 'fay', 'eve@example.com', PW)
    // fay's password signs fay in, eve's signs eve in
    expect((await login('eve@example.com', PW)).body.me.user.username).toBe('fay')
    expect((await login('eve@example.com', OTHER_PW)).body.me.user.username).toBe('eve@example.com')
    expect(signInCandidates(h.ctx.db, 'EVE@example.com').map((u) => u.id)).toEqual(['u_e', 'u_f'])
    // nobody can now pick an e-mail an account has as a username
    expect(usernameTaken(h.ctx.db, 'Team@Example.com')).toBe(true)
    expect(usernameTaken(h.ctx.db, 'free@example.com')).toBe(false)
  })

  test('switched-off and deleted accounts are never counted for an e-mail', async () => {
    await addUser('u_g', 'gus', 'solo@example.com', PW)
    await addUser('u_h', 'hal', 'solo@example.com', PW, 'disabled')
    expect(signInCandidates(h.ctx.db, 'solo@example.com').map((u) => u.id)).toEqual(['u_g'])
    expect((await login('solo@example.com', PW)).body.me.user.username).toBe('gus')
    h.ctx.db.query("UPDATE users SET deleted_at = '2026-11-01T00:00:00Z' WHERE id = 'u_g'").run()
    expect(signInCandidates(h.ctx.db, 'solo@example.com')).toEqual([])
  })

  test('wrong passwords by e-mail lock the account: the username is refused with 429 too', async () => {
    await addUser('u_i', 'ivy', 'ivy@example.com', PW)
    let last = 0
    for (let i = 0; i < 12; i++) last = (await login('ivy@example.com', 'wrong password 1', `10.3.3.${i + 1}`)).status
    expect(last).toBe(429)
    const r = await login('ivy', PW, '10.4.4.4')
    expect(r.status).toBe(429)
  })
})

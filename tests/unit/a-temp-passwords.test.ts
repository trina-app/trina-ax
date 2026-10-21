// Component A: memorable temporary passwords (owner decision 2026-10-21, clinic pilot). The generator's format and
// entropy, an admin-chosen temporary password, the forced change that asks only for the new password (only in the
// session that just signed in with the temporary one), its limits (one hour, 7 days, 20 wrong tries), and that a
// normal change still needs the current password.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { MEMORABLE_PASSWORD_BITS, TEMP_PASSWORD_MAX_FAILURES, TEMP_WORDS, memorablePassword } from '@mycel/shared'
import { WsClose } from '@mycel/shared/api'
import { DEFAULT_LIMITS } from '../../server/src/auth/rate-limit'
import { passwordProblem } from '../../server/src/auth/passwords'
import { Hub } from '../../server/src/realtime/hub'
import type { RealtimeConn } from '../../server/src/services'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

describe('memorable temporary password generator', () => {
  test('word list: at least 2000 distinct lower-case words of 4-7 letters, none that fails the password rule', () => {
    expect(TEMP_WORDS.length).toBeGreaterThanOrEqual(2000)
    expect(new Set(TEMP_WORDS).size).toBe(TEMP_WORDS.length)
    for (const w of TEMP_WORDS) {
      expect(w, w).toMatch(/^[a-z]{4,7}$/)
      // the shortest password made from it
      expect(passwordProblem(w + (w.length === 4 ? '2222' : '222')), w).toBeNull()
    }
    for (const bad of ['kill', 'abuse', 'bomb', 'drug', 'naked', 'sexy', 'stupid', 'idiot', 'hate', 'satoshi']) expect(TEMP_WORDS).not.toContain(bad)
  })
  test('format: a word then 3 digits 2-9 (4 after a 4-letter word), 8-10 characters', () => {
    for (let i = 0; i < 500; i++) {
      const pw = memorablePassword((n) => Math.floor(Math.random() * n))
      const m = /^([a-z]{4,7})([2-9]{3,4})$/.exec(pw)
      expect(m, pw).not.toBeNull()
      expect(TEMP_WORDS).toContain(m![1]!)
      expect(m![2]!.length).toBe(m![1]!.length === 4 ? 4 : 3)
      expect(pw.length).toBeGreaterThanOrEqual(8)
      expect(pw.length).toBeLessThanOrEqual(10)
    }
  })
  test('entropy: about 20 bits (word list x 8^3), each word and digit position reachable', () => {
    expect(MEMORABLE_PASSWORD_BITS).toBeCloseTo(Math.log2(TEMP_WORDS.length) + 9, 6)
    expect(MEMORABLE_PASSWORD_BITS).toBeGreaterThanOrEqual(20)
    // the first and the last word and every digit come out of a deterministic "random" source
    const seq = (vals: number[]) => { let i = 0; return (n: number) => vals[i++]! % n }
    expect(memorablePassword(seq([0, 0, 0, 0, 0]))).toMatch(new RegExp(`^${TEMP_WORDS[0]}2{3,4}$`))
    expect(memorablePassword(seq([TEMP_WORDS.length - 1, 7, 7, 7, 7]))).toMatch(new RegExp(`^${TEMP_WORDS.at(-1)}9{3,4}$`))
  })
})

describe('temporary passwords end to end', () => {
  let h: Harness
  let owner: Client
  beforeAll(async () => { h = await harness('temp-passwords'); owner = await withOwner(h) })
  afterAll(() => h.close())

  test('admin may set the temporary password; it must meet the 8+ rule; none given = a memorable one', async () => {
    const short = await owner.try('POST', '/api/admin/users', { username: 'sam', name: 'Sam', role: 'member', temporaryPassword: 'abc1234' })
    expect(short.status).toBe(400)
    const asName = await owner.try('POST', '/api/admin/users', { username: 'samsung1', name: 'Sam', role: 'member', temporaryPassword: 'Samsung1' })
    expect(asName.status).toBe(400)
    expect(asName.body.error.fields['body.temporaryPassword']).toBeTruthy()
    const common = await owner.try('POST', '/api/admin/users', { username: 'sam', name: 'Sam', role: 'member', temporaryPassword: '12345678' })
    expect(common.status).toBe(400)
    expect(common.body.error.message).toContain('흔한')
    const r = await owner.call('POST', '/api/admin/users', { username: 'sam', name: 'Sam', role: 'member', temporaryPassword: 'exampleteam2026' })
    expect(r.temporaryPassword).toBe('exampleteam2026')
    expect(r.user.mustChangePassword).toBe(true)
    const auto = await owner.call('POST', '/api/admin/users', { username: 'sue', name: 'Sue', role: 'member' })
    expect(auto.temporaryPassword).toMatch(/^[a-z]{4,7}[2-9]{3,4}$/)
    // a reset may give one too
    const m = await addMember(h, owner, { username: 'rob' })
    const reset = await owner.call('POST', `/api/admin/users/${m.id}/reset-password`, { temporaryPassword: 'maple2468' })
    expect(reset.temporaryPassword).toBe('maple2468')
    expect((await owner.try('POST', `/api/admin/users/${m.id}/reset-password`, { temporaryPassword: 'rob' })).status).toBe(400)
    const resetAuto = await owner.call('POST', `/api/admin/users/${m.id}/reset-password`)
    expect(resetAuto.temporaryPassword).toMatch(/^[a-z]{4,7}[2-9]{3,4}$/)
    const c = h.client()
    expect((await c.login('rob', resetAuto.temporaryPassword)).me.session.tempLogin).toBe(true)
  })

  test('first sign-in: the new password alone; the session then becomes a normal one and needs the current password again', async () => {
    await owner.call('POST', '/api/admin/users', { username: 'tina', name: 'Tina', role: 'member', temporaryPassword: 'tiger427' })
    const c = h.client()
    const login = await c.login('tina', 'tiger427')
    expect(login.me.user.mustChangePassword).toBe(true)
    expect(login.me.session.tempLogin).toBe(true)
    // a temporary sign-in lives an hour, not 30 days
    expect(Date.parse(login.me.session.expiresAt) - h.auth.now()).toBeLessThanOrEqual(3600_000)
    // nothing else is reachable meanwhile
    for (const [m, p] of [['GET', '/api/chats'], ['GET', '/api/files/tree?path='], ['PATCH', '/api/me'], ['GET', '/api/me/sessions']] as const) {
      const r = await c.try(m, p, m === 'PATCH' ? { name: 'T' } : undefined)
      expect(r.status, `${m} ${p}`).toBe(403)
      expect(r.body.error.code).toBe('password_change_required')
    }
    const weak = await c.try('POST', '/api/auth/password', { newPassword: 'tina' })
    expect(weak.status).toBe(400)
    await c.call('POST', '/api/auth/password', { newPassword: 'my own garden 5' })
    const me = await c.call('GET', '/api/me')
    expect(me.user.mustChangePassword).toBe(false)
    expect(me.session.tempLogin).toBe(false)
    expect(Date.parse(me.session.expiresAt) - h.auth.now()).toBeGreaterThan(29 * 24 * 3600_000)
    expect((await c.try('GET', '/api/chats')).status).toBe(200)
    // the temporary password no longer works; the new one does
    expect((await h.client().try('POST', '/api/auth/login', { username: 'tina', password: 'tiger427' })).status).toBe(401)
    // the same session, now normal, must give the current password for another change
    const again = await c.try('POST', '/api/auth/password', { newPassword: 'another garden 6' })
    expect(again.status).toBe(400)
    expect(again.body.error.fields['body.currentPassword']).toBe('required')
    const wrong = await c.try('POST', '/api/auth/password', { currentPassword: 'tiger427', newPassword: 'another garden 6' })
    expect(wrong.status).toBe(403)
    await c.call('POST', '/api/auth/password', { currentPassword: 'my own garden 5', newPassword: 'another garden 6' })
    await h.client().login('tina', 'another garden 6')
  })

  test('the temporary one also works as the current password (older clients); without CSRF header the change is refused', async () => {
    await owner.call('POST', '/api/admin/users', { username: 'uma', name: 'Uma', role: 'member', temporaryPassword: 'lemon5823' })
    const c = h.client()
    await c.login('uma', 'lemon5823')
    const csrf = await c.try('POST', '/api/auth/password', { newPassword: 'my own garden 5' }, { 'x-mycel-csrf': '' })
    expect(csrf.status).toBe(403)
    expect(csrf.body.error.code).toBe('csrf')
    const cross = await c.try('POST', '/api/auth/password', { newPassword: 'my own garden 5' }, { 'sec-fetch-site': 'cross-site' })
    expect(cross.status).toBe(403)
    await c.call('POST', '/api/auth/password', { currentPassword: 'lemon5823', newPassword: 'my own garden 5' })
  })

  test('only the session that signed in with the temporary password skips it; an older must-change session does not', async () => {
    await owner.call('POST', '/api/admin/users', { username: 'vic', name: 'Vic', role: 'member', temporaryPassword: 'ocean2345' })
    const c = h.client()
    const login = await c.login('vic', 'ocean2345')
    // as if this session had been made before the change (migration 103 leaves temp_login = 0)
    h.ctx.db.query('UPDATE sessions SET temp_login = 0 WHERE id = ?').run(login.me.session.id)
    expect((await c.call('GET', '/api/me')).session.tempLogin).toBe(false)
    const r = await c.try('POST', '/api/auth/password', { newPassword: 'my own garden 5' })
    expect(r.status).toBe(400)
    expect(r.body.error.fields['body.currentPassword']).toBe('required')
    await c.call('POST', '/api/auth/password', { currentPassword: 'ocean2345', newPassword: 'my own garden 5' })
  })

  test('a temporary sign-in ends after an hour; signing in again with the temporary password works', async () => {
    await owner.call('POST', '/api/admin/users', { username: 'wes', name: 'Wes', role: 'member', temporaryPassword: 'cedar2345' })
    const c = h.client()
    await c.login('wes', 'cedar2345')
    h.advance(61 * 60_000)
    expect((await c.try('POST', '/api/auth/password', { newPassword: 'my own garden 5' })).status).toBe(401)
    await c.login('wes', 'cedar2345')
    await c.call('POST', '/api/auth/password', { newPassword: 'my own garden 5' })
    // a normal session lasts on past the hour
    h.advance(2 * 3600_000)
    expect((await c.try('GET', '/api/me')).status).toBe(200)
  })

  test('a temporary password stops working after 7 days (the right one then says so; a wrong one does not)', async () => {
    await owner.call('POST', '/api/admin/users', { username: 'xena', name: 'Xena', role: 'member', temporaryPassword: 'harbor234' })
    h.advance(7 * 24 * 3600_000 + 60_000)
    const right = await h.client().try('POST', '/api/auth/login', { username: 'xena', password: 'harbor234' })
    expect(right.status).toBe(401)
    expect(right.body.error.message).toContain('임시 비밀번호')
    const wrong = await h.client().try('POST', '/api/auth/login', { username: 'xena', password: 'harbor235' })
    expect(wrong.status).toBe(401)
    expect(wrong.body.error.message).toContain('아이디 또는 비밀번호')
    // a new temporary password from the admin works again
    const id = (await owner.call('GET', '/api/admin/users')).items.find((u: { username: string }) => u.username === 'xena').id
    await owner.call('POST', `/api/admin/users/${id}/reset-password`, { temporaryPassword: 'harbor567' })
    expect((await h.client().login('xena', 'harbor567')).me.session.tempLogin).toBe(true)
  })

  test(`${TEMP_PASSWORD_MAX_FAILURES} wrong tries void a temporary password (on top of the per-account rate limit)`, async () => {
    await owner.call('POST', '/api/admin/users', { username: 'yuri', name: 'Yuri', role: 'member', temporaryPassword: 'walnut234' })
    for (let i = 0; i < TEMP_PASSWORD_MAX_FAILURES; i++) {
      // step past the 15-minute account window so the rate limit does not hide the count
      if (i > 0 && i % (DEFAULT_LIMITS.perAccount - 1) === 0) h.advance(16 * 60_000)
      expect((await h.client({ ip: `10.9.0.${i + 1}` }).try('POST', '/api/auth/login', { username: 'yuri', password: `walnut${300 + i}` })).status).toBe(401)
    }
    h.advance(16 * 60_000)
    const right = await h.client().try('POST', '/api/auth/login', { username: 'yuri', password: 'walnut234' })
    expect(right.status).toBe(401)
    expect(right.body.error.message).toContain('임시 비밀번호')
    const audit = h.ctx.db.query("SELECT action FROM audit_log WHERE action = 'auth.temp_password_voided'").all()
    expect(audit.length).toBe(1)
  })

  test('the per-account sign-in limit still applies to temporary passwords', async () => {
    await owner.call('POST', '/api/admin/users', { username: 'zoe', name: 'Zoe', role: 'member', temporaryPassword: 'violin234' })
    for (let i = 0; i < DEFAULT_LIMITS.perAccount; i++) await h.client({ ip: `10.8.0.${i + 1}` }).try('POST', '/api/auth/login', { username: 'zoe', password: 'violin999' })
    expect((await h.client({ ip: '10.8.1.1' }).try('POST', '/api/auth/login', { username: 'zoe', password: 'violin234' })).status).toBe(429)
  })

  test('a must-change session gets no realtime socket', async () => {
    await owner.call('POST', '/api/admin/users', { username: 'amos', name: 'Amos', role: 'member', temporaryPassword: 'sparrow2345' })
    const c = h.client()
    await c.login('amos', 'sparrow2345')
    const hub = new Hub(h.ctx)
    try {
      let closed = null as number | null
      const conn: RealtimeConn = {
        send() {}, close(code) { closed = code }, bufferedAmount: () => 0, ping() {}, onMessage() {}, onClose() {},
      }
      await hub.attach(conn, new Request('http://team.localhost/api/ws?windowId=win-amos-0001', { headers: { cookie: c.cookie!, origin: 'http://team.localhost' } }), { ip: null, via: 'test' })
      expect(closed).toBe(WsClose.unauthorized)
      // after the change the same session connects
      await c.call('POST', '/api/auth/password', { newPassword: 'my own garden 5' })
      closed = null
      await hub.attach(conn, new Request('http://team.localhost/api/ws?windowId=win-amos-0002', { headers: { cookie: c.cookie!, origin: 'http://team.localhost' } }), { ip: null, via: 'test' })
      expect(closed).toBeNull()
    } finally { hub.close() }
  })
})

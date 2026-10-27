// Component A: memorable temporary passwords (owner decision 2026-10-21, first office pilot). The generator's format and
// entropy, an admin-chosen temporary password, the forced change that asks only for the new password (only in the
// session that just signed in with the temporary one), its limits (one hour, 7 days, 50 wrong tries), and that a
// normal change still needs the current password.
import crypto from 'node:crypto'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { MEMORABLE_PASSWORD_BITS, TEMP_PASSWORD_MAX_FAILURES, TEMP_WORDS, memorablePassword } from '@mycel/shared'
import { WsClose } from '@mycel/shared/api'
import { DEFAULT_LIMITS } from '../../server/src/auth/rate-limit'
import { passwordProblem } from '../../server/src/auth/passwords'
import { Hub } from '../../server/src/realtime/hub'
import type { RealtimeConn } from '../../server/src/services'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

// dozens of argon2id checks per case (64 MiB each): about 2 s alone, more on a busy machine
setDefaultTimeout(30_000)

/** Damerau-Levenshtein distance <= 1: one letter changed, added, dropped, or two neighbours swapped. */
function lookAlike(a: string, b: string): boolean {
  if (a.length === b.length) {
    const d: number[] = []
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d.push(i)
    return d.length === 1 || (d.length === 2 && d[1] === d[0]! + 1 && a[d[0]!] === b[d[1]!] && a[d[1]!] === b[d[0]!])
  }
  if (Math.abs(a.length - b.length) !== 1) return false
  const [s, l] = a.length < b.length ? [a, b] : [b, a]
  for (let i = 0; i < l.length; i++) if (l.slice(0, i) + l.slice(i + 1) === s) return true
  return false
}

describe('memorable temporary password generator', () => {
  test('word list: about 1000 distinct lower-case words of 4-7 letters, none that fails the password rule', () => {
    expect(TEMP_WORDS.length).toBeGreaterThanOrEqual(1000)
    expect(new Set(TEMP_WORDS).size).toBe(TEMP_WORDS.length)
    for (const w of TEMP_WORDS) {
      expect(w, w).toMatch(/^[a-z]{4,7}$/)
      // the shortest password made from it
      expect(passwordProblem(w + '0000'), w).toBeNull()
    }
  })
  test('word list: nothing unpleasant, hard to spell or silent-lettered (security review, UX review of the first office pilot)', () => {
    const bad = [
      'kill', 'abuse', 'bomb', 'drug', 'naked', 'sexy', 'stupid', 'idiot', 'hate', 'satoshi',
      'knife', 'needle', 'drill', 'horror', 'ghost', 'whip', 'wine', 'master', 'snake', 'infant', 'blood', 'virus', 'grave',
      'rhythm', 'yacht', 'fjord', 'khaki', 'llama', 'okapi', 'guava', 'savanna', 'heron', 'aerobic', 'acquire', 'analyst', 'clarify', 'inherit',
      'knee', 'knot', 'climb', 'island', 'castle', 'write', 'that', 'defy',
    ]
    for (const w of bad) expect(TEMP_WORDS, w).not.toContain(w)
  })
  test('word list: no two words look or sound alike when read out (bean/bear, star/start, quiet/quite, peace/piece)', () => {
    const near: string[] = []
    for (let i = 0; i < TEMP_WORDS.length; i++) for (let j = i + 1; j < TEMP_WORDS.length; j++) if (lookAlike(TEMP_WORDS[i]!, TEMP_WORDS[j]!)) near.push(`${TEMP_WORDS[i]}/${TEMP_WORDS[j]}`)
    expect(near).toEqual([])
    for (const [x, y] of [['peace', 'piece'], ['medal', 'metal'], ['plane', 'plain'], ['desert', 'dessert'], ['right', 'write'], ['flower', 'flour']]) expect(TEMP_WORDS.includes(x!) && TEMP_WORDS.includes(y!), `${x}/${y}`).toBe(false)
  })
  test('format: a word then 4 digits 0-9, 8-11 characters', () => {
    for (let i = 0; i < 500; i++) {
      const pw = memorablePassword(crypto.randomInt)
      const m = /^([a-z]{4,7})([0-9]{4})$/.exec(pw)
      expect(m, pw).not.toBeNull()
      expect(TEMP_WORDS).toContain(m![1]!)
      expect(pw.length).toBeGreaterThanOrEqual(8)
      expect(pw.length).toBeLessThanOrEqual(11)
    }
  })
  test('entropy: about 23 bits (word list x 10^4), each word and digit reachable', () => {
    expect(MEMORABLE_PASSWORD_BITS).toBeCloseTo(Math.log2(TEMP_WORDS.length) + 4 * Math.log2(10), 6)
    expect(MEMORABLE_PASSWORD_BITS).toBeGreaterThanOrEqual(23)
    // the first and the last word and every digit come out of a deterministic "random" source
    const seq = (vals: number[]) => { let i = 0; return (n: number) => vals[i++]! % n }
    expect(memorablePassword(seq([0, 0, 0, 0, 0]))).toBe(`${TEMP_WORDS[0]}0000`)
    expect(memorablePassword(seq([TEMP_WORDS.length - 1, 9, 9, 9, 9]))).toBe(`${TEMP_WORDS.at(-1)}9999`)
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
    const r = await owner.call('POST', '/api/admin/users', { username: 'sam', name: 'Sam', role: 'member', temporaryPassword: 'maple2026' })
    expect(r.temporaryPassword).toBe('maple2026')
    expect(r.user.mustChangePassword).toBe(true)
    const auto = await owner.call('POST', '/api/admin/users', { username: 'sue', name: 'Sue', role: 'member' })
    expect(auto.temporaryPassword).toMatch(/^[a-z]{4,7}[0-9]{4}$/)
    expect(auto.expiresAt).toBe(auto.user.tempPassword.expiresAt)
    expect(Math.abs(Date.parse(auto.expiresAt) - h.auth.now() - 7 * 24 * 3600_000)).toBeLessThan(5_000)
    expect(auto.signInUrl).toMatch(/^https?:\/\//)
    expect(auto.user.tempPassword.voided).toBe(false)
    // a reset may give one too
    const m = await addMember(h, owner, { username: 'rob' })
    const reset = await owner.call('POST', `/api/admin/users/${m.id}/reset-password`, { temporaryPassword: 'maple2468' })
    expect(reset.temporaryPassword).toBe('maple2468')
    expect((await owner.try('POST', `/api/admin/users/${m.id}/reset-password`, { temporaryPassword: 'rob' })).status).toBe(400)
    const resetAuto = await owner.call('POST', `/api/admin/users/${m.id}/reset-password`)
    expect(resetAuto.temporaryPassword).toMatch(/^[a-z]{4,7}[0-9]{4}$/)
    expect(Math.abs(Date.parse(resetAuto.expiresAt) - h.auth.now() - 7 * 24 * 3600_000)).toBeLessThan(5_000)
    expect(resetAuto.signInUrl).toMatch(/^https?:\/\//)
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
    // security review #2: after a void the right password gets the same answer as a wrong one, so a guesser who
    // caused the void (and is no longer counted) cannot learn when a guess is right
    const right = await h.client().try('POST', '/api/auth/login', { username: 'yuri', password: 'walnut234' })
    expect(right.status).toBe(401)
    const wrong = await h.client().try('POST', '/api/auth/login', { username: 'yuri', password: 'walnut999' })
    expect(wrong.status).toBe(401)
    expect(right.body.error.message).toBe(wrong.body.error.message)
    expect(right.body.error.message).toContain('아이디 또는 비밀번호')
    const audit = h.ctx.db.query("SELECT action FROM audit_log WHERE action = 'auth.temp_password_voided'").all()
    expect(audit.length).toBe(1)
    // security review #1: Admin > Members shows why the member cannot get in
    const row = (await owner.call('GET', '/api/admin/users')).items.find((u: { username: string }) => u.username === 'yuri')
    expect(row.tempPassword.voided).toBe(true)
    // a reset gives a working one again
    await owner.call('POST', `/api/admin/users/${row.id}/reset-password`, { temporaryPassword: 'walnut5678' })
    expect((await owner.call('GET', '/api/admin/users')).items.find((u: { username: string }) => u.username === 'yuri').tempPassword.voided).toBe(false)
    expect((await h.client().login('yuri', 'walnut5678')).me.session.tempLogin).toBe(true)
  }, 30_000) // 50+ password hashes: about 3 s alone, over bun's default 5 s on a busy Mac

  test(`fewer than ${TEMP_PASSWORD_MAX_FAILURES} wrong tries (a stranger trying a desk username for a while) leave the temporary password working`, async () => {
    expect(TEMP_PASSWORD_MAX_FAILURES).toBeGreaterThanOrEqual(50)
    await owner.call('POST', '/api/admin/users', { username: 'desk7', name: 'Desk 7', role: 'member', temporaryPassword: 'pepper2468' })
    for (let i = 0; i < 20; i++) {
      if (i > 0 && i % (DEFAULT_LIMITS.perAccount - 1) === 0) h.advance(16 * 60_000)
      await h.client({ ip: `10.7.0.${i + 1}` }).try('POST', '/api/auth/login', { username: 'desk7', password: `pepper${3000 + i}` })
    }
    h.advance(16 * 60_000)
    expect((await h.client().login('desk7', 'pepper2468')).me.session.tempLogin).toBe(true)
  })

  test('security review #5: a temporary sign-in cannot skip the current password once the temporary one expired or was voided', async () => {
    await owner.call('POST', '/api/admin/users', { username: 'ivy', name: 'Ivy', role: 'member', temporaryPassword: 'orange2468' })
    const c = h.client()
    await c.login('ivy', 'orange2468')
    // voided meanwhile (e.g. wrong tries from elsewhere set it to expire now)
    h.ctx.db.query("UPDATE users SET temp_password_expires_at = ? WHERE username = 'ivy'").run(new Date(h.auth.now() - 1000).toISOString())
    const r = await c.try('POST', '/api/auth/password', { newPassword: 'my own garden 5' })
    expect(r.status).toBe(400)
    expect(r.body.error.fields['body.currentPassword']).toBe('required')
    expect((await h.client().try('POST', '/api/auth/login', { username: 'ivy', password: 'my own garden 5' })).status).toBe(401)
  })

  test('UX review #1/#2: an admin-set temporary password with spaces or Hangul is refused (the member could not type it)', async () => {
    for (const bad of ['  tiger427 ', 'tiger 4271', '노ㅑㅜㄷ1234', 'tigér4271']) {
      const r = await owner.try('POST', '/api/admin/users', { username: 'kim', name: 'Kim', role: 'member', temporaryPassword: bad })
      expect(r.status, bad).toBe(400)
      expect(r.body.error.fields['body.temporaryPassword'], bad).toBeTruthy()
      expect(r.body.error.message, bad).toContain('한/영')
    }
    const m = await addMember(h, owner, { username: 'lee' })
    expect((await owner.try('POST', `/api/admin/users/${m.id}/reset-password`, { temporaryPassword: '노ㅑㅜㄷ1234' })).status).toBe(400)
    // symbols are fine
    expect((await owner.call('POST', `/api/admin/users/${m.id}/reset-password`, { temporaryPassword: 'Maple#2026' })).temporaryPassword).toBe('Maple#2026')
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

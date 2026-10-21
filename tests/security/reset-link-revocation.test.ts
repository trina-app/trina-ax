// Security regression, area auth-admin (round 1): a password reset link an admin made must stop working once that
// admin can no longer make it (disabled, demoted, deleted), and once the person it is for is out of the admin's
// reach (promoted to admin, made owner). Before the fix an ex-admin kept the link and took over the member's
// account with it: the link signs its holder in as the member.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createResetLink } from '../../server/src/auth/accounts'
import { OWNER_PW, addMember, harness, withOwner, type Client, type Harness } from '../unit/a-lib'

const NEW_PW = 'attacker chosen pw 99'

describe('admin-made reset links die with the admin\'s privilege', () => {
  let h: Harness
  let owner: Client
  let n = 0
  beforeAll(async () => {
    h = await harness('sec-reset-links')
    owner = await withOwner(h, 'olga')
  })
  afterAll(() => h.close())

  /** Admin A and member M; A (still an admin) makes a reset link for M and keeps the token. */
  async function setup() {
    n++
    const A = await addMember(h, owner, { username: `adanna${n}`, role: 'admin', ip: `10.0.1.${n}` })
    const M = await addMember(h, owner, { username: `victim${n}`, role: 'member', ip: `10.0.2.${n}` })
    const link = await A.client.call('POST', `/api/admin/users/${M.id}/reset-link`)
    expect(typeof link.token).toBe('string')
    return { A, M, token: link.token as string, victim: `victim${n}` }
  }

  /** The stale link is refused, says nothing about the victim, and the victim's own password still works. */
  async function expectDead(token: string, M: { id: string; password: string }, victim: string) {
    const attacker = h.client({ ip: '10.0.9.9' })
    const info = await attacker.try('GET', `/api/password-resets/${token}`)
    expect(info.status).toBe(200)
    expect(info.body).toEqual({ valid: false, username: null, name: null, expiresAt: null })
    const used = await attacker.try('POST', `/api/password-resets/${token}`, { newPassword: NEW_PW, tokenMode: 'bearer' })
    expect(used.status).toBe(410)
    expect(used.body.token).toBeUndefined()
    // the victim was not touched
    const me = await h.client().login(victim, M.password)
    expect(me.me.user.id).toBe(M.id)
    expect((await h.client().try('POST', '/api/auth/login', { username: victim, password: NEW_PW })).status).toBe(401)
  }

  test('control: a link from an admin who still is one works (sharing access must keep working)', async () => {
    const { M, token, victim } = await setup()
    const used = await h.client().call('POST', `/api/password-resets/${token}`, { newPassword: NEW_PW, tokenMode: 'bearer' })
    expect(used.me.user.id).toBe(M.id)
    await h.client().login(victim, NEW_PW)
  })

  test('admin disabled → their reset link is dead', async () => {
    const { A, M, token, victim } = await setup()
    await owner.call('PATCH', `/api/admin/users/${A.id}`, { status: 'disabled' })
    await expectDead(token, M, victim)
  })

  test('admin demoted to member → their reset link is dead', async () => {
    const { A, M, token, victim } = await setup()
    await owner.call('PATCH', `/api/admin/users/${A.id}`, { role: 'member' })
    await expectDead(token, M, victim)
  })

  test('admin deleted → their reset link is dead', async () => {
    const { A, M, token, victim } = await setup()
    expect((await owner.try('DELETE', `/api/admin/users/${A.id}?personalFolder=delete`)).status).toBeLessThan(300)
    await expectDead(token, M, victim)
  })

  test('re-enabling the admin does not bring the revoked link back', async () => {
    const { A, M, token, victim } = await setup()
    await owner.call('PATCH', `/api/admin/users/${A.id}`, { status: 'disabled' })
    await owner.call('PATCH', `/api/admin/users/${A.id}`, { status: 'active' })
    await expectDead(token, M, victim)
  })

  test('target promoted to admin → a (non-owner) admin\'s link for them is dead (admins cannot act on admins)', async () => {
    const { M, token, victim } = await setup()
    await owner.call('PATCH', `/api/admin/users/${M.id}`, { role: 'admin' })
    await expectDead(token, M, victim)
  })

  test('defense in depth: a link whose maker lost the role is refused even if the revocation was missed', async () => {
    const { A, M, token, victim } = await setup()
    // simulate a de-privilege that bypassed updateUser (e.g. an older build, a restore)
    h.ctx.db.query("UPDATE users SET role = 'member' WHERE id = ?").run(A.id)
    await expectDead(token, M, victim)
  })

  test('the owner\'s server-Mac recovery link (made by nobody) keeps working', async () => {
    n++
    const M = await addMember(h, owner, { username: `recover${n}`, role: 'member' })
    const { token } = createResetLink(h.ctx, M.id, null, 'http://x')
    const used = await h.client().call('POST', `/api/password-resets/${token}`, { newPassword: NEW_PW, tokenMode: 'bearer' })
    expect(used.me.user.id).toBe(M.id)
  })

  test('an owner-made link survives an unrelated admin being disabled', async () => {
    const { A } = await setup()
    n++
    const M2 = await addMember(h, owner, { username: `keep${n}`, role: 'member' })
    const link = await owner.call('POST', `/api/admin/users/${M2.id}/reset-link`)
    await owner.call('PATCH', `/api/admin/users/${A.id}`, { status: 'disabled' })
    const used = await h.client().call('POST', `/api/password-resets/${link.token}`, { newPassword: NEW_PW, tokenMode: 'bearer' })
    expect(used.me.user.id).toBe(M2.id)
  })
})

describe('ownership moves to the person an admin made a link for', () => {
  let h: Harness
  afterAll(() => h.close())
  test('the admin\'s link for the new owner is dead', async () => {
    h = await harness('sec-reset-owner')
    const owner = await withOwner(h, 'olga')
    const A = await addMember(h, owner, { username: 'adanna', role: 'admin' })
    const M = await addMember(h, owner, { username: 'victim', role: 'member' })
    const { token } = await A.client.call('POST', `/api/admin/users/${M.id}/reset-link`)
    await owner.call('POST', '/api/admin/transfer-ownership', { userId: M.id, password: OWNER_PW })
    const attacker = h.client({ ip: '10.0.9.9' })
    expect((await attacker.call('GET', `/api/password-resets/${token}`)).valid).toBe(false)
    expect((await attacker.try('POST', `/api/password-resets/${token}`, { newPassword: NEW_PW, tokenMode: 'bearer' })).status).toBe(410)
    await h.client().login('victim', M.password)
  })
})

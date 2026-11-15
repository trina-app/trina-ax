// Security regression, area auth-admin (round 1), changed by QA TC-2582 (2026-11-15): a switched-off account with its
// RIGHT password is now told the truth (401, reason account_off, who to ask), because people kept retrying a right
// password. Only someone who already has the password learns it; it opens nothing. What stays: a wrong password and an
// unknown username answer exactly alike (no username oracle), and every attempt keeps counting toward the limit.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { addMember, harness, withOwner, type Client, type Harness } from '../unit/a-lib'

describe('sign-in does not confirm the password of a disabled account', () => {
  let h: Harness
  let owner: Client
  beforeAll(async () => {
    h = await harness('sec-login-disabled')
    owner = await withOwner(h, 'olga')
  })
  afterAll(() => h.close())

  test('a wrong password for a disabled account answers exactly like an unknown username; the right one is told it is off, with no session', async () => {
    const m = await addMember(h, owner, { username: 'dora' })
    await owner.call('PATCH', `/api/admin/users/${m.id}`, { status: 'disabled' })
    const right = await h.client().try('POST', '/api/auth/login', { username: 'dora', password: m.password })
    const wrong = await h.client().try('POST', '/api/auth/login', { username: 'dora', password: 'not the password 77' })
    const nobody = await h.client().try('POST', '/api/auth/login', { username: 'nobody-here', password: 'not the password 77' })
    // the request id is per request; everything else must be identical
    const answer = (r: { status: number; body: any }) => ({ status: r.status, error: { ...r.body.error, requestId: undefined } })
    expect(right.status).toBe(401)
    expect(right.body.error.params).toEqual({ reason: 'account_off' })
    expect(answer(wrong)).toEqual(answer(nobody))
    expect(wrong.body.error.params).toBeUndefined()
    expect(right.body.token).toBeUndefined()
    expect(right.headers.get('set-cookie')).toBeNull()
  })

  test('attempts on a disabled account keep counting toward the account limit', async () => {
    const m = await addMember(h, owner, { username: 'dina' })
    await owner.call('PATCH', `/api/admin/users/${m.id}`, { status: 'disabled' })
    let last = 0
    for (let i = 0; i < 11; i++) last = (await h.client({ ip: `10.7.0.${i + 1}` }).try('POST', '/api/auth/login', { username: 'dina', password: m.password })).status
    expect(last).toBe(429)
  })
})

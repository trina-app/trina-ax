// Security regression, area auth-admin (round 1): sign-in must not tell an unauthenticated caller that a password
// is right for a disabled account (before: right password → 403 "account disabled", wrong → 401 "bad login"), and
// such attempts must keep counting toward the per-account limit.
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

  test('right and wrong password for a disabled account get the same 401 answer', async () => {
    const m = await addMember(h, owner, { username: 'dora' })
    await owner.call('PATCH', `/api/admin/users/${m.id}`, { status: 'disabled' })
    const right = await h.client().try('POST', '/api/auth/login', { username: 'dora', password: m.password })
    const wrong = await h.client().try('POST', '/api/auth/login', { username: 'dora', password: 'not the password 77' })
    const nobody = await h.client().try('POST', '/api/auth/login', { username: 'nobody-here', password: 'not the password 77' })
    // the request id is per request; everything else must be identical
    const answer = (r: { status: number; body: any }) => ({ status: r.status, error: { ...r.body.error, requestId: undefined } })
    expect(right.status).toBe(401)
    expect(answer(right)).toEqual(answer(wrong))
    expect(answer(right)).toEqual(answer(nobody))
    expect(right.body.token).toBeUndefined()
  })

  test('attempts on a disabled account keep counting toward the account limit', async () => {
    const m = await addMember(h, owner, { username: 'dina' })
    await owner.call('PATCH', `/api/admin/users/${m.id}`, { status: 'disabled' })
    let last = 0
    for (let i = 0; i < 11; i++) last = (await h.client({ ip: `10.7.0.${i + 1}` }).try('POST', '/api/auth/login', { username: 'dina', password: m.password })).status
    expect(last).toBe(429)
  })
})

// TC-1974: a removed member's open window is told why it was signed out. The 401 for a sign-in that ended with the
// removal of its account carries reason 'account_removed' (server/src/auth/account-removal.ts noteRemovedSignIns), only
// for that sign-in's own token: no token, someone else's ended sign-in or a plain sign-out get the plain 401.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { addMember, harness, OWNER_PW, withOwner, type Client, type Harness } from './a-lib'
import { authOf } from '../../server/src/auth/service'

setDefaultTimeout(30_000)

let h: Harness, owner: Client
beforeAll(async () => {
  h = await harness('removed-sign-in')
  owner = await withOwner(h)
})
afterAll(async () => { await h?.close() })

describe('the 401 after an account was removed', () => {
  test('the removed person\'s own sign-in (cookie or app token) hears account_removed; nobody else does', async () => {
    const m = await addMember(h, owner, { username: 'remy' })
    const app = h.client()
    await app.login('remy', m.password, 'bearer')
    const other = await addMember(h, owner, { username: 'sasha' })
    expect((await owner.try('DELETE', `/api/admin/users/${m.id}`, { password: OWNER_PW })).status).toBe(204)

    for (const c of [m.client, app]) {
      const r = await c.try('GET', '/api/me')
      expect(r.status).toBe(401)
      expect(r.body.error.code).toBe('unauthorized')
      expect(r.body.error.params).toEqual({ reason: 'account_removed' })
      // any signed-in endpoint, not only /api/me
      expect((await c.try('GET', '/api/chats')).body.error.params).toEqual({ reason: 'account_removed' })
    }
    // no sign-in, or a token nobody had: the plain answer
    expect((await h.client().try('GET', '/api/me')).body.error.params).toBeUndefined()
    const made = h.client(); made.cookie = 'mycel-dev-sid=' + 'x'.repeat(43)
    expect((await made.try('GET', '/api/me')).body.error.params).toBeUndefined()
    // another member who signed out normally is not told anything about an account
    const kept = other.client.cookie
    await other.client.call('POST', '/api/auth/logout')
    other.client.cookie = kept // a window that still sends the ended sign-in
    const out = await other.client.try('GET', '/api/me')
    expect(out.status).toBe(401)
    expect(out.body.error.params).toBeUndefined()
  })

  test('the note is short-lived: after a day the plain 401 comes back', async () => {
    const m = await addMember(h, owner, { username: 'tove' })
    expect((await owner.try('DELETE', `/api/admin/users/${m.id}`, { password: OWNER_PW })).status).toBe(204)
    expect((await m.client.try('GET', '/api/me')).body.error.params).toEqual({ reason: 'account_removed' })
    const a = authOf(h.ctx)
    const real = a.now
    a.now = () => real.call(a) + 25 * 60 * 60 * 1000
    try {
      expect((await m.client.try('GET', '/api/me')).body.error.params).toBeUndefined()
    } finally { a.now = real }
  })
})

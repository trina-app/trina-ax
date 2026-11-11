// QA TC-202: a password reset link made for someone (on the server with mycel-account / mycel-ctl reset-link, or by an
// owner or admin) used to leave only an audit line. The person it is for now gets an Activity notice: who made it, and
// while the link still works, that changing the password stops it. Never the token.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createResetLink } from '../../server/src/auth/accounts'
import { addMember, harness, withOwner, OWNER_PW, type Client, type Harness } from './a-lib'

describe('reset link notice', () => {
  let h: Harness
  let owner: Client
  let admin: Client
  beforeAll(async () => {
    h = await harness('reset-link-notice')
    owner = await withOwner(h)
    admin = (await addMember(h, owner, { username: 'adam', role: 'admin' })).client
  })
  afterAll(() => h.close())

  const notices = async (c: Client) => {
    const r = await c.call('GET', '/api/notifications')
    return { unread: r.unreadCount as number, items: (r.items as any[]).filter((x) => x.code === 'account.reset_link') }
  }

  test('a link made on the server for the owner: one unread notice, "on the server", open until the password changes', async () => {
    const before = await notices(owner)
    expect(before.items).toHaveLength(0)
    // what mycel-account reset-link and mycel-ctl reset-link do (no maker)
    const link = createResetLink(h.ctx, 'olga', null, 'http://team.localhost')
    const after = await notices(owner)
    expect(after.items).toHaveLength(1)
    expect(after.unread).toBe(before.unread + 1)
    const n = after.items[0]
    expect(n).toMatchObject({ eventType: 'account.reset_link', readAt: null, link: null, resetLink: { server: true, by: null, open: true } })
    expect(JSON.stringify(n)).not.toContain(link.token)
    // changing the password ends the link: the notice no longer says to change it
    await owner.call('POST', '/api/auth/password', { currentPassword: OWNER_PW, newPassword: 'brand new owner phrase 42' })
    const signedIn = h.client()
    await signedIn.login('olga', 'brand new owner phrase 42')
    expect((await notices(signedIn)).items[0].resetLink).toEqual({ server: true, by: null, open: false })
  })

  test("an admin's link for a member: the member is told who made it; it closes when it expires", async () => {
    const m = await addMember(h, owner, { username: 'mia' })
    await admin.call('POST', `/api/admin/users/${m.id}/reset-link`)
    const n = (await notices(m.client)).items
    expect(n).toHaveLength(1)
    expect(n[0].resetLink).toEqual({ server: false, by: 'ADAM', open: true })
    // the maker is not told about their own link
    expect((await notices(admin)).items).toHaveLength(0)
    // a day later the link has expired (the Inbox reads the wall clock, not the auth test clock)
    h.ctx.db.query('UPDATE password_resets SET expires_at = ? WHERE user_id = ?').run(new Date(Date.now() - 1000).toISOString(), m.id)
    expect((await notices(m.client)).items[0].resetLink.open).toBe(false)
  })
})

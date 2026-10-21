// Security regression, area auth-admin (round 2): an open invite carries the authority of the person who made it,
// so it must stop working once that person could no longer make it. Before the fix an owner minted an admin invite,
// handed ownership to someone else (becoming a mere admin, who may not make admin invites) and the invite still
// created a brand-new ADMIN account the new owner never approved: transferOwnership was the one demotion that did
// not revoke the old owner's invites, and accepting an invite never looked at its maker again.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { OWNER_PW, addMember, harness, withOwner, type Client, type Harness } from '../unit/a-lib'

const NEW_PW = 'Str0ng-pass-9!x lamp'

function helpers(get: () => Harness) {
  let n = 0
  const roleOf = (id: string) => (get().ctx.db.query('SELECT role FROM users WHERE id = ?').get(id) as { role: string } | null)?.role
  const userByName = (u: string) => get().ctx.db.query('SELECT id, role FROM users WHERE username = ?').get(u) as { id: string; role: string } | null
  const accept = (token: string, username: string) =>
    get().client({ ip: `10.0.8.${++n}` }).try('POST', `/api/invites/${token}/accept`, { username, name: 'Mallory', password: NEW_PW, client: 'web', tokenMode: 'bearer' })
  /** The invite shows as invalid, is refused (410, no session) and created nobody. */
  async function expectDead(token: string, username: string) {
    const info = await get().client({ ip: `10.0.8.${++n}` }).call('GET', `/api/invites/${token}`)
    expect(info.valid).toBe(false)
    const res = await accept(token, username)
    expect(res.status).toBe(410)
    expect(res.body.token).toBeUndefined()
    expect(userByName(username)).toBeNull()
  }
  async function expectWorks(token: string, username: string, role: 'admin' | 'member') {
    const res = await accept(token, username)
    expect(res.status).toBe(201)
    expect(userByName(username)?.role).toBe(role)
  }
  return { roleOf, userByName, accept, expectDead, expectWorks }
}

describe('ownership transfer: the ex-owner\'s admin invite no longer makes an admin', () => {
  let h: Harness
  const t = helpers(() => h)
  afterAll(() => h.close())

  test('repro: owner mints an admin invite, hands ownership away, the invite is dead', async () => {
    h = await harness('sec-invite-transfer')
    const owner = await withOwner(h, 'olga')
    const olgaId = (await owner.call('GET', '/api/me')).user.id
    const heir = await addMember(h, owner, { username: 'heir', role: 'member', ip: '10.0.1.1' })
    const adminInv = await owner.call('POST', '/api/admin/invites', { role: 'admin', groupIds: [], expiresInHours: 720 })
    const memberInv = await owner.call('POST', '/api/admin/invites', { role: 'member', groupIds: [], expiresInHours: 720 })
    await owner.call('POST', '/api/admin/transfer-ownership', { userId: heir.id, password: OWNER_PW })
    expect(t.roleOf(olgaId)).toBe('admin')
    expect(t.roleOf(heir.id)).toBe('owner')
    // the ex-owner cannot mint a new admin invite ...
    expect((await owner.try('POST', '/api/admin/invites', { role: 'admin', groupIds: [], expiresInHours: 720 })).status).toBe(403)
    // ... and the one made while owner is gone too: no longer listed as open to the new owner, refused when used
    const open = await heir.client.call('GET', '/api/admin/invites')
    expect(open.items.some((i: { id: string }) => i.id === adminInv.invite.id)).toBe(false)
    await t.expectDead(adminInv.token, 'mallory')
    // sharing keeps working: a member invite is still within an admin's reach, so it survives and works
    expect(open.items.some((i: { id: string }) => i.id === memberInv.invite.id)).toBe(true)
    await t.expectWorks(memberInv.token, 'newbie', 'member')
    // the new owner's own admin invites work
    const fresh = await heir.client.call('POST', '/api/admin/invites', { role: 'admin', groupIds: [], expiresInHours: 24 })
    await t.expectWorks(fresh.token, 'newadmin', 'admin')
  })
})

describe('accepting an invite re-checks its maker (defense in depth, any demotion path)', () => {
  let h: Harness
  let owner: Client
  let n = 0
  const t = helpers(() => h)
  beforeAll(async () => {
    h = await harness('sec-invite-live')
    owner = await withOwner(h, 'olga')
  })
  afterAll(() => h.close())

  const newAdmin = async () => addMember(h, owner, { username: `adanna${++n}`, role: 'admin', ip: `10.0.1.${n}` })
  const setRole = (id: string, role: string) => h.ctx.db.query('UPDATE users SET role = ? WHERE id = ?').run(role, id)
  const setStatus = (id: string, status: string) => h.ctx.db.query('UPDATE users SET status = ? WHERE id = ?').run(status, id)

  test('control: an admin\'s member invite works while they are admin', async () => {
    const A = await newAdmin()
    const inv = await A.client.call('POST', '/api/admin/invites', { role: 'member', groupIds: [], expiresInHours: 24 })
    await t.expectWorks(inv.token, `ok${n}`, 'member')
  })

  test('owner\'s admin invite is refused once the maker is no longer owner (revocation bypassed)', async () => {
    const olgaId = (await owner.call('GET', '/api/me')).user.id
    const inv = await owner.call('POST', '/api/admin/invites', { role: 'admin', groupIds: [], expiresInHours: 24 })
    // a demotion that skipped transferOwnership/updateUser (older build, restore, a future path)
    setRole(olgaId, 'admin')
    try { await t.expectDead(inv.token, 'sneaky1') } finally { setRole(olgaId, 'owner') }
  })

  test('admin\'s member invite is refused once the maker is a member (revocation bypassed)', async () => {
    const A = await newAdmin()
    const inv = await A.client.call('POST', '/api/admin/invites', { role: 'member', groupIds: [], expiresInHours: 24 })
    setRole(A.id, 'member')
    await t.expectDead(inv.token, 'sneaky2')
  })

  test('admin\'s invite is refused once the maker is disabled (revocation bypassed)', async () => {
    const A = await newAdmin()
    const inv = await A.client.call('POST', '/api/admin/invites', { role: 'member', groupIds: [], expiresInHours: 24 })
    setStatus(A.id, 'disabled')
    await t.expectDead(inv.token, 'sneaky3')
  })

  test('an invite made by nobody (no maker on record) is refused', async () => {
    const inv = await owner.call('POST', '/api/admin/invites', { role: 'admin', groupIds: [], expiresInHours: 24 })
    h.ctx.db.query('UPDATE invites SET created_by = NULL WHERE id = ?').run(inv.invite.id)
    await t.expectDead(inv.token, 'sneaky4')
  })
})

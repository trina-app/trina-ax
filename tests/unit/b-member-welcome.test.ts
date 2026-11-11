// The welcome for invited people (docs/DECISIONS.md "A welcome for invited people"; server/src/onboarding/
// member-welcome.ts, shared/src/api/member-welcome.ts): every way of joining (team link, single-use invite, "Add
// directly") gets dev's "{name} joined the team" line in the everyone room and the team.joined notice (docs/DECISIONS.md
// "A new member is told to the team"; "Add directly" is the case this branch adds); the join pages name the inviter; no
// connection template notice at join; the welcome card's state, for the caller only.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { ALL_SET_MS } from '../../server/src/onboarding/member-welcome'

const PW = 'tulip meadow 2026'
const cm = () => 'cm-' + crypto.randomUUID()
let h: Harness
let owner: Client
let adam: Client
let adamId: string
let ip = 0
const guest = () => h.client({ ip: `10.7.0.${++ip}` })

const everyone = async (c: Client) => ((await c.call('GET', '/api/rooms')).items as any[]).find((r) => r.kind === 'all')
const lines = async (c: Client) => {
  const room = await everyone(c)
  return ((await c.call('GET', `/api/rooms/${room.id}/messages`)).items as any[]).filter((m) => m.event)
}
const joinedNotices = async (c: Client) => ((await c.call('GET', '/api/notifications')).items as any[]).filter((x) => x.code === 'team.joined')
const welcome = async (c: Client) => (await c.call('GET', '/api/me/welcome')).welcome

beforeAll(async () => {
  h = await harness('member-welcome')
  owner = await withOwner(h)
  const a = await addMember(h, owner, { username: 'adam', role: 'admin' })
  adam = a.client
  adamId = a.id
})
afterAll(async () => { await h.close() })

describe('every way of joining', () => {
  test('team link: the join page names the link\'s maker; "joined" in the everyone room; the owners and the maker are told; the card names the inviter', async () => {
    const { link } = await adam.call('POST', '/api/admin/team-link', {})
    const token = new URL(link.url).hash.replace(/^#t=/, '')
    expect(await guest().call('POST', '/api/team-link/info', { token })).toMatchObject({ valid: true, inviterName: 'ADAM' })
    const before = await owner.call('GET', '/api/rooms')
    const unreadBefore = before.items.find((r: any) => r.kind === 'all').unreadCount
    expect(typeof unreadBefore).toBe('number')
    const c = guest()
    const r = await c.call('POST', '/api/team-link/join', { token, username: 'lina', name: 'Lina Park', password: PW })
    const id = r.me.user.id
    // the line: an event of the new person, seen by them and the others
    const mine = await lines(c)
    expect(mine.at(-1)).toMatchObject({ event: { type: 'joined' }, author: { id } })
    expect((await lines(owner)).at(-1)).toMatchObject({ event: { type: 'joined' }, author: { id, name: 'Lina Park' } })
    // it counts nowhere: no unread, no room notice
    expect((await everyone(owner)).unreadCount).toBe(unreadBefore)
    expect(((await owner.call('GET', '/api/notifications')).items as any[]).some((x) => x.code?.startsWith('room.'))).toBe(false)
    // told: the owner and the link's maker, each once; never the person themselves
    expect((await joinedNotices(owner)).filter((x) => x.sourceId === id)).toHaveLength(1)
    expect((await joinedNotices(adam)).filter((x) => x.sourceId === id)).toHaveLength(1)
    expect(await joinedNotices(c)).toEqual([])
    // the card
    const w = await welcome(c)
    expect(w).toMatchObject({ team: 'Acme', inviter: { id: adamId, name: 'ADAM' }, steps: { rooms: true, hi: false, photo: false, asked: false }, allSet: false })
    expect(w.people).toBe(3)
    expect(w.rooms[0]).toMatchObject({ kind: 'all' })
    expect(w.owner).toMatchObject({ name: expect.any(String) })
  })

  test('single-use invite: the page names its maker; the line and the notices too, once each', async () => {
    const inv = await adam.call('POST', '/api/admin/invites', {})
    expect(await guest().call('GET', `/api/invites/${inv.token}`)).toMatchObject({ valid: true, inviterName: 'ADAM' })
    const c = guest()
    const r = await c.call('POST', `/api/invites/${inv.token}/accept`, { username: 'ivo', name: 'Ivo', password: PW })
    const id = r.me.user.id
    expect((await lines(owner)).at(-1)).toMatchObject({ event: { type: 'joined' }, author: { id } })
    expect((await joinedNotices(owner)).filter((x) => x.sourceId === id)).toHaveLength(1)
    expect((await joinedNotices(adam)).filter((x) => x.sourceId === id)).toHaveLength(1)
    expect((await welcome(c)).inviter).toMatchObject({ id: adamId })
    // a used invite names nobody
    expect((await guest().call('GET', `/api/invites/${inv.token}`)).inviterName).toBeNull()
  })

  test('Add directly: nothing at creation; the line and the owner\'s notice at the first sign-in, once; not the admin who added them; the card has no inviter', async () => {
    const created = await adam.call('POST', '/api/admin/users', { username: 'dora', name: 'DORA', role: 'member', groupIds: [] })
    const id = created.user.id
    // made, not joined yet: no line, nobody told
    expect((await lines(owner)).some((m) => m.author?.id === id)).toBe(false)
    expect((await joinedNotices(owner)).filter((x) => x.sourceId === id)).toHaveLength(0)
    // the first sign-in: the line (written as them) and the owner's notice; the admin who added them is not told
    const c = guest()
    await c.login('dora', created.temporaryPassword)
    expect((await lines(owner)).at(-1)).toMatchObject({ event: { type: 'joined' }, author: { id } })
    expect((await joinedNotices(owner)).filter((x) => x.sourceId === id)).toHaveLength(1)
    expect((await joinedNotices(adam)).filter((x) => x.sourceId === id)).toHaveLength(0)
    // a new password and a second sign-in say nothing again
    await c.call('POST', '/api/auth/password', { currentPassword: created.temporaryPassword, newPassword: PW })
    await guest().login('dora', PW)
    expect((await lines(owner)).filter((m) => m.event?.type === 'joined' && m.author?.id === id)).toHaveLength(1)
    expect((await joinedNotices(owner)).filter((x) => x.sourceId === id)).toHaveLength(1)
    expect((await welcome(c)).inviter).toBeNull()
    // the owner adding someone is not told about their own action
    const n = await addMember(h, owner, { username: 'nils' })
    expect((await joinedNotices(owner)).filter((x) => x.sourceId === n.id)).toHaveLength(0)
    expect((await lines(owner)).at(-1)).toMatchObject({ event: { type: 'joined' }, author: { id: n.id } })
  })

  test('Add directly, disabled or deleted before the first sign-in: never announced', async () => {
    const { firstSignIn } = await import('../../server/src/onboarding/member-welcome')
    for (const [username, gone] of [['gwen', "status = 'disabled'"], ['gus', "deleted_at = '2026-01-01T00:00:00.000Z'"]] as const) {
      const created = await adam.call('POST', '/api/admin/users', { username, name: username.toUpperCase(), role: 'member', groupIds: [] })
      h.ctx.db.query(`UPDATE users SET ${gone} WHERE id = ?`).run(created.user.id)
      firstSignIn(h.ctx, created.user.id)
      expect((await lines(owner)).some((m) => m.author?.id === created.user.id)).toBe(false)
      expect((await joinedNotices(owner)).filter((x) => x.sourceId === created.user.id)).toHaveLength(0)
    }
  })

  test('no connection template notice at join', async () => {
    await owner.call('POST', '/api/admin/integration-templates', { kind: 'mcp', name: 'Team Wiki', url: 'https://wiki.example.com/mcp', auth: 'bearer', access: { everyone: true, groups: [], users: [] } })
    const m = await addMember(h, owner, { username: 'tara' })
    const { notificationsOf } = await import('../../server/src/notifications/service')
    notificationsOf(h.ctx).reconcile()
    expect(((await m.client.call('GET', '/api/notifications')).items as any[]).filter((x) => x.code === 'integration.template')).toEqual([])
  })
})

describe('the card', () => {
  test('the team\'s creator gets none; neither does someone who joined before it existed', async () => {
    expect(await welcome(owner)).toBeNull()
    h.ctx.db.query('DELETE FROM member_welcome WHERE user_id = ?').run(adamId)
    expect(await welcome(adam)).toBeNull()
  })

  test('rows: hi after any room message, photo, asked; all set for a while, then gone for good', async () => {
    const m = await addMember(h, owner, { username: 'rhea' })
    const room = await everyone(m.client)
    await m.client.call('POST', `/api/rooms/${room.id}/messages`, { body: '👋 Hi, I\'m Rhea', clientMessageId: cm() })
    expect((await welcome(m.client)).steps).toMatchObject({ hi: true, photo: false, asked: false })
    h.ctx.db.query('INSERT INTO user_profiles (user_id, avatar_version) VALUES (?, 1) ON CONFLICT(user_id) DO UPDATE SET avatar_version = 1').run(m.id)
    expect((await welcome(m.client)).steps.photo).toBe(true)
    const done = (await m.client.call('PATCH', '/api/me/welcome', { asked: true })).welcome
    expect(done).toMatchObject({ steps: { hi: true, asked: true }, allSet: true })
    expect((await welcome(m.client)).allSet).toBe(true)
    h.ctx.db.query('UPDATE member_welcome SET done_at = ? WHERE user_id = ?').run(new Date(Date.now() - ALL_SET_MS - 1000).toISOString(), m.id)
    expect(await welcome(m.client)).toBeNull()
  })

  test('the photo is optional: hi and asked are enough', async () => {
    const m = await addMember(h, owner, { username: 'otto' })
    const room = await everyone(m.client)
    await m.client.call('POST', `/api/rooms/${room.id}/messages`, { body: 'hello', clientMessageId: cm() })
    expect((await m.client.call('PATCH', '/api/me/welcome', { asked: true })).welcome).toMatchObject({ steps: { photo: false }, allSet: true })
  })

  test('Hide is for good; the days run out; only the caller\'s own card', async () => {
    const a = await addMember(h, owner, { username: 'hana' })
    const b = await addMember(h, owner, { username: 'hugo' })
    expect((await a.client.call('PATCH', '/api/me/welcome', { hide: true })).welcome).toBeNull()
    expect(await welcome(a.client)).toBeNull()
    // the other person's card is untouched, and the body cannot name anyone
    expect(await welcome(b.client)).not.toBeNull()
    expect((await a.client.try('PATCH', '/api/me/welcome', { hide: true, userId: b.id })).status).toBe(400)
    expect((await a.client.try('PATCH', '/api/me/welcome', {})).status).toBe(400)
    expect(await welcome(b.client)).not.toBeNull()
    expect((await h.client().try('GET', '/api/me/welcome')).status).toBe(401)
    h.ctx.db.query("UPDATE member_welcome SET joined_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ?").run(b.id)
    expect(await welcome(b.client)).toBeNull()
  })
})

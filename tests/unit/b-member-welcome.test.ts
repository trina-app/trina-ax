// The welcome for invited people (docs/DECISIONS.md "A welcome for invited people"; server/src/onboarding/
// member-welcome.ts, shared/src/api/member-welcome.ts): every way of joining (team link, single-use invite, "Add
// directly") gets dev's "{name} joined the team" line in the everyone room and the team.joined notice (docs/DECISIONS.md
// "A new member is told to the team"; "Add directly" is the case this branch adds); the join pages name the inviter; no
// connection template notice at join; the welcome card's state, for the caller only; the owner's own card ("My
// setup", docs/decisions/20261120-my-setup-card.md), made on the owner's first read while the setup is open and
// restarted when it ends (docs/decisions/20261128-owner-personal-onboarding.md; the late-card rule in full:
// b-owner-late-card.test.ts).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { FROM_COMPUTER_DIR } from '@mycel/shared'
import { addMember, harness, OWNER_PW, withOwner, type Client, type Harness } from './a-lib'
import { ALL_SET_MS } from '../../server/src/onboarding/member-welcome'
import { Plan, seatsUsed, setPlanForTests } from '../../server/src/system/limits'

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
/** the person's own Google Drive, connected (the tools row: a connection of their own) */
const connectDrive = (userId: string) => {
  const at = new Date().toISOString()
  h.ctx.db.query(`INSERT INTO drive_connections (id, user_id, config_key, account, scopes, secret_enc, key_version, status, expires_at, created_at, updated_at)
    VALUES (?, ?, 'k', '{}', '[]', 'x', 1, 'connected', ?, ?, ?)`).run(crypto.randomUUID(), userId, at, at, at)
}

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
    expect(w).toMatchObject({ kind: 'member', team: 'Acme', inviter: { id: adamId, name: 'ADAM' }, steps: { rooms: true, hi: false, photo: false, asked: false, tools: false }, allSet: false })
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

  test('Add directly, first sign-in weeks later: the 14 days start then (the card shows, template notices still held)', async () => {
    const { notificationsOf } = await import('../../server/src/notifications/service')
    await owner.call('POST', '/api/admin/integration-templates', { kind: 'mcp', name: 'Team Desk', url: 'https://desk.example.com/mcp', auth: 'bearer', access: { everyone: true, groups: [], users: [] } })
    const created = await owner.call('POST', '/api/admin/users', { username: 'lars', name: 'LARS', role: 'member', groupIds: [] })
    const id = created.user.id
    // made 20 days ago, never signed in
    h.ctx.db.query("UPDATE member_welcome SET joined_at = ? WHERE user_id = ?").run(new Date(Date.now() - 20 * 86_400_000).toISOString(), id)
    const c = guest()
    await c.login('lars', created.temporaryPassword)
    await c.call('POST', '/api/auth/password', { currentPassword: created.temporaryPassword, newPassword: PW })
    expect(await welcome(c)).not.toBeNull()
    const notices = async () => ((await c.call('GET', '/api/notifications')).items as any[]).filter((x) => x.code === 'integration.template')
    notificationsOf(h.ctx).reconcile()
    expect(await notices()).toEqual([])
    // 14 days after the sign-in (not after the account was made) they are told
    h.ctx.db.query("UPDATE member_welcome SET joined_at = ? WHERE user_id = ?").run(new Date(Date.now() - 15 * 86_400_000).toISOString(), id)
    notificationsOf(h.ctx).reconcile()
    expect((await notices()).length).toBeGreaterThan(0)
  })
})

// The owner's decision (2026-11-12, docs/DECISIONS.md "The invite pages name who invited you"): anyone holding a team
// link or an invite sees its maker's display name before signing in, like Slack's "X invited you". Nothing else about
// them, and only while the link works.
describe('the join pages name the inviter', () => {
  const tokenOf = (url: string) => new URL(url).hash.replace(/^#t=/, '')
  const linkInfo = (token: string) => guest().try('POST', '/api/team-link/info', { token })
  const inviteInfo = (token: string) => guest().try('GET', `/api/invites/${token}`)
  /** an admin with a display name, an email and a photo */
  async function maker(username: string, name: string) {
    const m = await addMember(h, owner, { username, role: 'admin' })
    h.ctx.db.query('UPDATE users SET name = ?, email = ? WHERE id = ?').run(name, `${username}@acme.example`, m.id)
    h.ctx.db.query('INSERT INTO user_profiles (user_id, avatar_version) VALUES (?, 1) ON CONFLICT(user_id) DO UPDATE SET avatar_version = 1').run(m.id)
    return m
  }

  test('the display name only: never their id, username, email, role or photo', async () => {
    const v = await maker('vera', 'Vera Lim')
    const { link } = await v.client.call('POST', '/api/admin/team-link', {})
    const inv = await v.client.call('POST', '/api/admin/invites', {})
    const answers = [
      [['expiresAt', 'inviterName', 'problem', 'skillName', 'skillTitle', 'teamName', 'valid'], (await linkInfo(tokenOf(link.url))).body],
      [['expiresAt', 'full', 'inviterName', 'role', 'teamName', 'valid'], (await inviteInfo(inv.token)).body],
    ] as const
    for (const [keys, body] of answers) {
      expect(Object.keys(body).sort()).toEqual([...keys])
      const { inviterName, ...rest } = body
      expect({ valid: rest.valid, inviterName }).toEqual({ valid: true, inviterName: 'Vera Lim' })
      const others = JSON.stringify(rest).toLowerCase()
      for (const s of [v.id, 'vera', 'acme.example', 'admin', 'avatar', 'photo']) expect({ s, in: others.includes(s) }).toEqual({ s, in: false })
    }
  })

  test('a link or invite that does not work names nobody: revoked, expired, used, every seat taken, its maker disabled, demoted or deleted, a wrong token', async () => {
    const w = await maker('wes', 'Wes Park')
    const none = { valid: false, inviterName: null }
    // revoked
    let link = (await w.client.call('POST', '/api/admin/team-link', {})).link
    let inv = await w.client.call('POST', '/api/admin/invites', {})
    await w.client.call('DELETE', '/api/admin/team-link')
    await w.client.call('DELETE', `/api/admin/invites/${inv.invite.id}`)
    expect((await linkInfo(tokenOf(link.url))).body).toMatchObject({ ...none, problem: 'revoked' })
    expect((await inviteInfo(inv.token)).body).toMatchObject(none)
    // expired (the link after 7 days, the invite after its 7 days)
    link = (await w.client.call('POST', '/api/admin/team-link', { expiresInDays: 7 })).link
    inv = await w.client.call('POST', '/api/admin/invites', {})
    h.advance(8 * 86_400_000)
    try {
      expect((await linkInfo(tokenOf(link.url))).body).toMatchObject({ ...none, problem: 'expired' })
      expect((await inviteInfo(inv.token)).body).toMatchObject(none)
    } finally { h.advance(-8 * 86_400_000) }
    // used up
    link = (await w.client.call('POST', '/api/admin/team-link', { maxUses: 1 })).link
    expect((await guest().try('POST', '/api/team-link/join', { token: tokenOf(link.url), username: 'uma', name: 'Uma', password: PW })).status).toBe(201)
    expect((await linkInfo(tokenOf(link.url))).body).toMatchObject({ ...none, problem: 'used_up' })
    inv = await w.client.call('POST', '/api/admin/invites', {})
    expect((await guest().try('POST', `/api/invites/${inv.token}/accept`, { username: 'ugo', name: 'Ugo', password: PW })).status).toBe(201)
    expect((await inviteInfo(inv.token)).body).toMatchObject(none)
    // every seat taken (a plan's member limit): joining is refused, so the page names nobody; the invite keeps
    // valid: true (its page does not say "expired or used"), the team link says "full"
    link = (await w.client.call('POST', '/api/admin/team-link', {})).link
    inv = await w.client.call('POST', '/api/admin/invites', {})
    setPlanForTests(Plan.parse({ format: 1, plan: 'team', maxConcurrency: 3, memoryMiB: 4096, cpuCores: 2, diskGiB: 50, maxActiveMembers: seatsUsed(h.ctx.db) }))
    try {
      expect((await linkInfo(tokenOf(link.url))).body).toMatchObject({ ...none, problem: 'full' })
      expect((await inviteInfo(inv.token)).body).toMatchObject({ valid: true, inviterName: null })
    } finally { setPlanForTests(undefined) }
    expect((await inviteInfo(inv.token)).body).toMatchObject({ valid: true, inviterName: 'Wes Park' })
    // the maker disabled (their link and invites end with it), demoted or deleted by a change the admin screens never
    // make (the check at every use)
    for (const [username, change] of [['wren', null], ['wynn', "role = 'member'"], ['wade', "deleted_at = '2026-01-01T00:00:00.000Z'"]] as const) {
      const m = await maker(username, `${username.toUpperCase()} Maker`)
      const l = (await m.client.call('POST', '/api/admin/team-link', {})).link
      const i = await m.client.call('POST', '/api/admin/invites', {})
      expect((await linkInfo(tokenOf(l.url))).body.inviterName).toBe(`${username.toUpperCase()} Maker`)
      if (change) h.ctx.db.query(`UPDATE users SET ${change} WHERE id = ?`).run(m.id)
      else await owner.call('PATCH', `/api/admin/users/${m.id}`, { status: 'disabled' })
      expect({ username, ...(await linkInfo(tokenOf(l.url))).body }).toMatchObject({ username, ...none })
      expect({ username, ...(await inviteInfo(i.token)).body }).toMatchObject({ username, ...none })
    }
    // a wrong token: 404, nothing about anyone
    for (const r of [await linkInfo('x'.repeat(43)), await inviteInfo('y'.repeat(43))]) {
      expect(r.status).toBe(404)
      expect(JSON.stringify(r.body)).not.toMatch(/Maker|Wes Park|Acme/)
    }
  })
})

describe('the card', () => {
  test('the team\'s creator gets the owner card on the first read, the setup still open; someone here longer than 30 days without a row gets none', async () => {
    expect(await welcome(owner)).toMatchObject({ kind: 'owner', inviter: null, setupOpen: true, allSet: false })
    const ownerId = (h.ctx.db.query("SELECT id FROM users WHERE role = 'owner' LIMIT 1").get() as { id: string }).id
    // made by that read: the owner's card, holding no connection template notices
    const r = h.ctx.db.query('SELECT setup, apps_seen_at FROM member_welcome WHERE user_id = ?').get(ownerId) as { setup: number; apps_seen_at: string | null }
    expect(r.setup).toBe(1)
    expect(r.apps_seen_at).not.toBeNull()
    h.ctx.db.query('DELETE FROM member_welcome WHERE user_id = ?').run(adamId)
    h.ctx.db.query("UPDATE users SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(adamId)
    expect(await welcome(adam)).toBeNull()
    expect(h.ctx.db.query('SELECT 1 FROM member_welcome WHERE user_id = ?').get(adamId)).toBeNull()
  })

  test('rows: hi after any room message, photo, asked, tools; all set for a while, then gone for good', async () => {
    const m = await addMember(h, owner, { username: 'rhea' })
    const room = await everyone(m.client)
    await m.client.call('POST', `/api/rooms/${room.id}/messages`, { body: '👋 Hi, I\'m Rhea', clientMessageId: cm() })
    expect((await welcome(m.client)).steps).toMatchObject({ hi: true, photo: false, asked: false, tools: false })
    h.ctx.db.query('INSERT INTO user_profiles (user_id, avatar_version) VALUES (?, 1) ON CONFLICT(user_id) DO UPDATE SET avatar_version = 1').run(m.id)
    expect((await welcome(m.client)).steps.photo).toBe(true)
    // hi and asked, but no tool of their own yet: not all set
    expect((await m.client.call('PATCH', '/api/me/welcome', { asked: true })).welcome).toMatchObject({ steps: { hi: true, asked: true, tools: false }, allSet: false })
    connectDrive(m.id)
    const done = await welcome(m.client)
    expect(done).toMatchObject({ steps: { hi: true, asked: true, tools: true }, allSet: true })
    expect((await welcome(m.client)).allSet).toBe(true)
    h.ctx.db.query('UPDATE member_welcome SET done_at = ? WHERE user_id = ?').run(new Date(Date.now() - ALL_SET_MS - 1000).toISOString(), m.id)
    expect(await welcome(m.client)).toBeNull()
  })

  test('the photo is optional: hi, asked and tools are enough', async () => {
    const m = await addMember(h, owner, { username: 'otto' })
    connectDrive(m.id)
    const room = await everyone(m.client)
    await m.client.call('POST', `/api/rooms/${room.id}/messages`, { body: 'hello', clientMessageId: cm() })
    expect((await m.client.call('PATCH', '/api/me/welcome', { asked: true })).welcome).toMatchObject({ steps: { photo: false }, allSet: true })
  })

  test('the optional files row: done while a file is in My files › From this computer; never counted, never holds back all set', async () => {
    const m = await addMember(h, owner, { username: 'fern' })
    expect((await welcome(m.client)).steps.files).toBe(false)
    const base = path.join(h.ctx.files.fx.root, 'users', m.id, FROM_COMPUTER_DIR)
    // folders alone, a hidden file (an upload's temp name), a symbolic link: not a file there
    fs.mkdirSync(path.join(base, 'Documents', 'Clients'), { recursive: true })
    fs.writeFileSync(path.join(base, 'Documents', '.part-1'), 'x')
    fs.symlinkSync('/etc/hosts', path.join(base, 'Documents', 'hosts'))
    expect((await welcome(m.client)).steps.files).toBe(false)
    fs.writeFileSync(path.join(base, 'Documents', 'Clients', 'Quote.xlsx'), 'q')
    expect((await welcome(m.client)).steps.files).toBe(true)
    // Undo takes the files back through the file route (to the trash, outside the folder): not done again
    await m.client.call('DELETE', `/api/files?path=${encodeURIComponent(`users/${m.id}/${FROM_COMPUTER_DIR}/Documents/Clients/Quote.xlsx`)}`)
    expect(fs.existsSync(path.join(base, 'Documents', 'Clients', 'Quote.xlsx'))).toBe(false)
    expect((await welcome(m.client)).steps.files).toBe(false)
    // From this computer itself a link to a folder with files: not followed
    const elsewhere = fs.mkdtempSync(path.join(h.ctx.files.fx.root, '..', 'elsewhere-'))
    fs.writeFileSync(path.join(elsewhere, 'other.txt'), 'x')
    fs.rmSync(base, { recursive: true, force: true })
    fs.symlinkSync(elsewhere, base)
    expect((await welcome(m.client)).steps.files).toBe(false)
    fs.rmSync(base)
    // all set without it
    connectDrive(m.id)
    const room = await everyone(m.client)
    await m.client.call('POST', `/api/rooms/${room.id}/messages`, { body: 'hello', clientMessageId: cm() })
    expect((await m.client.call('PATCH', '/api/me/welcome', { asked: true })).welcome).toMatchObject({ steps: { files: false }, allSet: true })
  })

  test('Hide is for good; the days run out; only the caller\'s own card', async () => {
    const a = await addMember(h, owner, { username: 'hana' })
    const b = await addMember(h, owner, { username: 'hugo' })
    expect(await a.client.call('PATCH', '/api/me/welcome', { hide: true })).toEqual({ welcome: null, hidden: true })
    expect(await welcome(a.client)).toBeNull()
    // Settings › Profile shows it again while its days last
    expect((await a.client.call('PATCH', '/api/me/welcome', { show: true })).welcome).toMatchObject({ kind: 'member' })
    expect(await a.client.call('PATCH', '/api/me/welcome', { hide: true })).toEqual({ welcome: null, hidden: true })
    // the other person's card is untouched, and the body cannot name anyone
    expect(await welcome(b.client)).not.toBeNull()
    expect((await a.client.try('PATCH', '/api/me/welcome', { hide: true, userId: b.id })).status).toBe(400)
    expect((await a.client.try('PATCH', '/api/me/welcome', {})).status).toBe(400)
    expect(await welcome(b.client)).not.toBeNull()
    expect((await h.client().try('GET', '/api/me/welcome')).status).toBe(401)
    h.ctx.db.query("UPDATE member_welcome SET joined_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ?").run(b.id)
    expect(await welcome(b.client)).toBeNull()
    // a hidden card whose days are over is not offered again
    h.ctx.db.query("UPDATE member_welcome SET joined_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ?").run(a.id)
    expect(await a.client.call('GET', '/api/me/welcome')).toEqual({ welcome: null })
  })

  test('a team where nobody may connect their own: the tools row holds nothing back', async () => {
    const m = await addMember(h, owner, { username: 'pia' })
    expect((await welcome(m.client)).steps.tools).toBe(false)
    await owner.call('PATCH', '/api/admin/settings', { personalIntegrations: false })
    try { expect((await welcome(m.client)).steps.tools).toBe(true) } finally { await owner.call('PATCH', '/api/admin/settings', { personalIntegrations: true }) }
  })
})

describe('the owner\'s own card ("My setup")', () => {
  test('tools and asked count; an open setup holds "all set"; the end restarts its days; Hide and show again', async () => {
    const ownerId = (h.ctx.db.query("SELECT id FROM users WHERE role = 'owner' LIMIT 1").get() as { id: string }).id
    // the card from the first read (above), 10 days into its 14, the setup still open
    await owner.call('PATCH', '/api/onboarding/welcome', {})
    h.ctx.db.query('UPDATE member_welcome SET joined_at = ? WHERE user_id = ?').run(new Date(Date.now() - 10 * 86_400_000).toISOString(), ownerId)
    expect(await welcome(owner)).toMatchObject({ kind: 'owner', setupOpen: true, steps: { tools: false, asked: false }, allSet: false })
    // Hide and show again
    expect(await owner.call('PATCH', '/api/me/welcome', { hide: true })).toMatchObject({ welcome: null, hidden: true })
    expect((await owner.call('PATCH', '/api/me/welcome', { show: true })).welcome).toMatchObject({ kind: 'owner' })
    // both personal rows done (hi is never the owner's): still not all set while the setup is open
    expect((await owner.call('PATCH', '/api/me/welcome', { asked: true })).welcome).toMatchObject({ steps: { asked: true, tools: false }, allSet: false })
    connectDrive(ownerId)
    expect(await welcome(owner)).toMatchObject({ steps: { tools: true, asked: true, hi: false }, setupOpen: true, allSet: false })
    // the end screen ("자료 없이 해 볼게요" ends the steps too): the setup is over, the days restart from the end
    await owner.call('PATCH', '/api/onboarding/welcome', { finish: true })
    const row = h.ctx.db.query('SELECT setup, via, invited_by, joined_at FROM member_welcome WHERE user_id = ?').get(ownerId) as { setup: number; via: string; invited_by: string | null; joined_at: string }
    expect(row).toMatchObject({ setup: 1, via: 'invite', invited_by: null })
    expect(Date.now() - Date.parse(row.joined_at)).toBeLessThan(60_000)
    const w = await welcome(owner)
    expect(w).toMatchObject({ kind: 'owner', allSet: true })
    expect(w.setupOpen).toBeUndefined()
    // a second end keeps the row as it is
    await owner.call('PATCH', '/api/onboarding/welcome', { finish: true })
    expect((h.ctx.db.query('SELECT joined_at FROM member_welcome WHERE user_id = ?').get(ownerId) as { joined_at: string }).joined_at).toBe(row.joined_at)
    // the days count from the setup's end
    h.ctx.db.query("UPDATE member_welcome SET done_at = NULL, joined_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ?").run(ownerId)
    expect(await welcome(owner)).toBeNull()
  })
})

describe('a new owner', () => {
  test('an invited person handed the team: their member card is over; new here and with no connection of their own, a fresh owner card at the handover', async () => {
    const inv = await owner.call('POST', '/api/admin/invites', {})
    const c = guest()
    const r = await c.call('POST', `/api/invites/${inv.token}/accept`, { username: 'leah', name: 'Leah Lead', password: PW })
    const id = r.me.user.id
    expect(await welcome(c)).not.toBeNull()
    await c.call('GET', '/api/me')
    await owner.call('POST', '/api/admin/transfer-ownership', { userId: id, password: OWNER_PW })
    // the hidden member row became the owner's card at the handover (ensureOwnCard), its days from then
    expect(h.ctx.db.query('SELECT setup, hidden_at, invited_by FROM member_welcome WHERE user_id = ?').get(id)).toMatchObject({ setup: 1, hidden_at: null, invited_by: null })
    expect(await welcome(c)).toMatchObject({ kind: 'owner', inviter: null })
    // an owner never gets a member's card, even with a row that is not hidden (only the setup's own card, setup = 1)
    h.ctx.db.query('UPDATE member_welcome SET setup = 0, hidden_at = NULL WHERE user_id = ?').run(id)
    expect(await welcome(c)).toBeNull()
  })
})

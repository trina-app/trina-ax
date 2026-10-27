// Component A: invites, members, role guards, password resets, deletion, owner transfer, and "admins can't read
// other people's chats".
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, listEndpoints, uuidv7 } from '@mycel/shared/api'
import { sweep } from '../../server/src/auth/sweeper'
import { OWNER_PW, addMember, harness, withOwner, type Client, type Harness } from './a-lib'

// deleting a member removes the personal folder and re-checks access across the team: seconds on a busy machine
setDefaultTimeout(30_000)

describe('invites', () => {
  let h: Harness
  let owner: Client
  let admin: Client
  let groupId: string
  beforeAll(async () => {
    h = await harness('invites')
    owner = await withOwner(h)
    admin = (await addMember(h, owner, { username: 'adam', role: 'admin' })).client
    groupId = (await owner.call('POST', '/api/admin/groups', { name: 'Marketing' })).id
  })
  afterAll(() => h.close())

  test('admin creates a member invite (link to copy, 7 days by default); only the owner invites admins', async () => {
    const r = await admin.call('POST', '/api/admin/invites', { groupIds: [groupId] })
    expect(r.url).toBe(`http://team.localhost/invite/${r.token}`)
    expect(r.invite).toMatchObject({ role: 'member', groupIds: [groupId], createdBy: { id: 'adam' }, usedAt: null })
    expect(Date.parse(r.invite.expiresAt) - Date.parse(r.invite.createdAt)).toBe(7 * 86_400_000)
    expect((await admin.try('POST', '/api/admin/invites', { role: 'admin' })).status).toBe(403)
    expect((await owner.try('POST', '/api/admin/invites', { role: 'admin', expiresInHours: 1 })).status).toBe(201)
    expect((await admin.try('POST', '/api/admin/invites', { groupIds: [uuidv7()] })).status).toBe(400)
    // the link uses the caller's origin when it is one of ours
    const viaOrigin = await admin.call('POST', '/api/admin/invites', {}, { origin: 'http://team.localhost' })
    expect(viaOrigin.url.startsWith('http://team.localhost/invite/')).toBe(true)
  })
  test('info -> accept: account with the invite\'s role and groups, personal folder, signed in; one use only', async () => {
    const { token } = await admin.call('POST', '/api/admin/invites', { groupIds: [groupId] })
    const guest = h.client()
    expect(await guest.call('GET', `/api/invites/${token}`)).toMatchObject({ teamName: 'Acme', role: 'member', valid: true })
    const weak = await guest.try('POST', `/api/invites/${token}/accept`, { username: 'ivy', name: 'Ivy', password: 'qwerty123' })
    expect(weak.status).toBe(400)
    const r = await guest.call('POST', `/api/invites/${token}/accept`, { username: 'ivy', name: 'Ivy', password: 'tulip meadow 2026' })
    expect(r.me.user).toMatchObject({ id: 'ivy', role: 'member', mustChangePassword: false })
    expect(r.me.groups).toEqual([{ id: groupId, name: 'Marketing' }])
    expect(fs.statSync(path.join(h.ctx.files.fx.root, 'users', 'ivy')).isDirectory()).toBe(true)
    const again = await h.client().try('POST', `/api/invites/${token}/accept`, { username: 'ivy2', name: 'Ivy 2', password: 'tulip meadow 2026' })
    expect(again.status).toBe(410)
    expect((await h.client().call('GET', `/api/invites/${token}`)).valid).toBe(false)
    const list = await admin.call('GET', '/api/admin/invites')
    expect(list.items.find((i: any) => i.usedBy?.id === 'ivy')).toBeTruthy()
  })
  test('taken usernames, revoked and expired invites, unknown tokens', async () => {
    const a = await admin.call('POST', '/api/admin/invites', {})
    expect((await h.client().try('POST', `/api/invites/${a.token}/accept`, { username: 'IVY', name: 'x', password: 'tulip meadow 2026' })).status).toBe(409)
    await admin.call('DELETE', `/api/admin/invites/${a.invite.id}`)
    expect((await h.client().call('GET', `/api/invites/${a.token}`)).valid).toBe(false)
    expect((await h.client().try('POST', `/api/invites/${a.token}/accept`, { username: 'zed', name: 'Zed', password: 'tulip meadow 2026' })).status).toBe(410)
    expect((await admin.call('GET', '/api/admin/invites')).items.some((i: any) => i.id === a.invite.id)).toBe(false)
    const b = await admin.call('POST', '/api/admin/invites', { expiresInHours: 1 })
    h.advance(3600_000 + 1)
    expect((await h.client().call('GET', `/api/invites/${b.token}`)).valid).toBe(false)
    expect((await h.client().try('POST', `/api/invites/${b.token}/accept`, { username: 'zed', name: 'Zed', password: 'tulip meadow 2026' })).status).toBe(410)
    expect((await h.client().try('GET', `/api/invites/${'x'.repeat(43)}`)).status).toBe(404)
    // a used invite cannot be revoked
    const used = (await admin.call('GET', '/api/admin/invites')).items.find((i: any) => i.usedAt)
    expect((await admin.try('DELETE', `/api/admin/invites/${used.id}`)).status).toBe(409)
  })
})

describe('members and role guards', () => {
  let h: Harness
  let owner: Client
  let admin: Client
  beforeAll(async () => {
    h = await harness('members')
    owner = await withOwner(h)
    admin = (await addMember(h, owner, { username: 'adam', role: 'admin' })).client
  })
  afterAll(() => h.close())

  test('admins add members but not admins; nobody edits the owner or their own role here', async () => {
    const m = await admin.call('POST', '/api/admin/users', { username: 'Kim.Lee', name: 'Kim Lee', role: 'member' })
    expect(m.user.id).toBe('kim-lee')
    expect((await admin.try('POST', '/api/admin/users', { username: 'kim.lee', name: 'Dup', role: 'member' })).status).toBe(409)
    expect((await admin.try('POST', '/api/admin/users', { username: 'boss', name: 'Boss', role: 'admin' })).status).toBe(403)
    expect((await admin.try('POST', '/api/admin/users', { username: 'boss', name: 'Boss', role: 'owner' })).status).toBe(400)
    expect((await admin.try('PATCH', '/api/admin/users/olga', { role: 'member' })).status).toBe(403)
    expect((await owner.try('PATCH', '/api/admin/users/olga', { status: 'disabled' })).status).toBe(403)
    expect((await admin.try('PATCH', '/api/admin/users/adam', { role: 'member' })).status).toBe(403)
    expect((await admin.try('PATCH', `/api/admin/users/${m.user.id}`, { role: 'admin' })).status).toBe(403)
    expect((await owner.call('PATCH', `/api/admin/users/${m.user.id}`, { role: 'admin' })).role).toBe('admin')
    expect((await admin.try('PATCH', `/api/admin/users/${m.user.id}`, { name: 'x' })).status).toBe(403)
    const list = await admin.call('GET', '/api/admin/users')
    expect(list.items.map((u: any) => u.id)).toEqual(['olga', 'adam', 'kim-lee'])
    expect(JSON.stringify(list)).not.toContain('password')
  })
  test('members cannot reach admin endpoints', async () => {
    const m = await addMember(h, owner, { username: 'mo' })
    for (const p of ['/api/admin/users', '/api/admin/folders', '/api/admin/audit', '/api/admin/usage', '/api/admin/settings']) expect((await m.client.try('GET', p)).status).toBe(403)
  })
  test('temporary password reset: sessions end, must change, audited, shown to the person', async () => {
    const m = await addMember(h, owner, { username: 'rita' })
    h.hub.events = []
    const r = await admin.call('POST', `/api/admin/users/${m.id}/reset-password`)
    expect(h.hub.events).toContainEqual({ kind: 'disconnectUser', target: m.id, data: 'password_changed' })
    expect((await m.client.try('GET', '/api/me')).status).toBe(401)
    const c = h.client()
    const me = (await c.login('rita', r.temporaryPassword)).me
    expect(me.user.mustChangePassword).toBe(true)
    expect(me.passwordReset).toMatchObject({ by: { id: 'adam' } })
    expect((await admin.try('POST', '/api/admin/users/olga/reset-password')).status).toBe(403)
    expect((await admin.try('POST', '/api/admin/users/adam/reset-password')).status).toBe(403)
    const a = await owner.call('GET', '/api/admin/audit?source=admin')
    expect(a.items.some((e: any) => e.action === 'user.reset_password' && e.target === m.id && e.actor.id === 'adam')).toBe(true)
  })
  test('one-time reset link: info, set a new password (signs in, ends old sessions), single use, 24 h', async () => {
    const m = await addMember(h, owner, { username: 'lena' })
    const link = await admin.call('POST', `/api/admin/users/${m.id}/reset-link`)
    expect(link.url).toBe(`http://team.localhost/reset-password/${link.token}`)
    const g = h.client()
    expect(await g.call('GET', `/api/password-resets/${link.token}`)).toMatchObject({ valid: true, username: 'lena' })
    const r = await g.call('POST', `/api/password-resets/${link.token}`, { newPassword: 'sunset harbor 77' })
    expect(r.me.user.id).toBe(m.id)
    expect(r.me.passwordReset.by.id).toBe('adam')
    expect((await m.client.try('GET', '/api/me')).status).toBe(401)
    expect((await g.try('POST', `/api/password-resets/${link.token}`, { newPassword: 'another harbor 78' })).status).toBe(410)
    expect((await g.call('GET', `/api/password-resets/${link.token}`)).valid).toBe(false)
    const l2 = await admin.call('POST', `/api/admin/users/${m.id}/reset-link`)
    const l3 = await admin.call('POST', `/api/admin/users/${m.id}/reset-link`)
    expect((await g.call('GET', `/api/password-resets/${l2.token}`)).valid).toBe(false) // only the newest works
    h.advance(24 * 3600_000 + 1)
    expect((await g.try('POST', `/api/password-resets/${l3.token}`, { newPassword: 'another harbor 78' })).status).toBe(410)
    expect((await g.try('GET', `/api/password-resets/${'y'.repeat(43)}`)).status).toBe(404)
  })
  test('owner transfer needs the password again; the old owner becomes admin', async () => {
    const t = await addMember(h, owner, { username: 'tom' })
    const wrong = await owner.try('POST', '/api/admin/transfer-ownership', { userId: t.id, password: 'wrong' })
    expect(wrong.status).toBe(403)
    // the owner mistyped the password: say that, not "you do not have permission" (ko is the owner's language)
    expect(wrong.body.error.message).toBe('비밀번호가 맞지 않습니다. 다시 입력해 주세요.')
    expect((await admin.try('POST', '/api/admin/transfer-ownership', { userId: t.id, password: OWNER_PW })).status).toBe(403)
    await owner.call('POST', '/api/admin/transfer-ownership', { userId: t.id, password: OWNER_PW })
    expect((await t.client.call('GET', '/api/me')).user.role).toBe('owner')
    expect((await owner.call('GET', '/api/me')).user.role).toBe('admin')
    // transfer back so later tests keep olga as owner
    await t.client.call('POST', '/api/admin/transfer-ownership', { userId: 'olga', password: 'river stone lamp 7' })
  })
})

describe('deleting a member', () => {
  let h: Harness
  let owner: Client
  beforeAll(async () => { h = await harness('delete'); owner = await withOwner(h) })
  afterAll(() => h.close())

  const seedChat = (userId: string, text: string) => {
    const chatId = uuidv7()
    h.ctx.db.query("INSERT INTO chats (id, user_id, title, engine_session_id) VALUES (?, ?, 'secret plans', 'sess-1')").run(chatId, userId)
    h.ctx.db.query("INSERT INTO messages (id, chat_id, role, content) VALUES (?, ?, 'user', ?)").run(uuidv7(), chatId, text)
    h.ctx.db.query('INSERT INTO memories (id, user_id, text) VALUES (?, ?, ?)').run(uuidv7(), userId, text)
    fs.mkdirSync(path.join(h.ctx.config.dataDir, 'sessions', chatId), { recursive: true })
    return chatId
  }

  test('transfer: sessions end, username is free again, the personal folder moves into the owner\'s folder (no attachments)', async () => {
    const m = await addMember(h, owner, { username: 'sam' })
    const root = h.ctx.files.fx.root
    fs.writeFileSync(path.join(root, 'users', m.id, 'report.md'), 'keep me')
    fs.mkdirSync(path.join(root, 'users', m.id, '.attachments', 'c1'), { recursive: true })
    fs.writeFileSync(path.join(root, 'users', m.id, '.attachments', 'c1', 'a.png'), 'x')
    const chatId = seedChat(m.id, 'SAM-PRIVATE-TEXT')
    await owner.call('DELETE', `/api/admin/users/${m.id}`)
    expect((await m.client.try('GET', '/api/me')).status).toBe(401)
    expect((await h.client().try('POST', '/api/auth/login', { username: 'sam', password: 'river stone lamp 7' })).status).toBe(401)
    expect(fs.existsSync(path.join(root, 'users', m.id))).toBe(false)
    const moved = path.join(root, 'users', 'olga', '보관된 계정', m.id)
    expect(fs.readFileSync(path.join(moved, 'report.md'), 'utf8')).toBe('keep me')
    expect(fs.existsSync(path.join(moved, '.attachments'))).toBe(false)
    expect((await owner.call('GET', '/api/admin/users')).items.some((u: any) => u.id === m.id)).toBe(false)
    // engine session reset at once; chats and memories stay until the retention period passes
    expect(h.ctx.db.query('SELECT engine_session_id FROM chats WHERE id = ?').get(chatId)).toEqual({ engine_session_id: null })
    expect(fs.existsSync(path.join(h.ctx.config.dataDir, 'sessions', chatId))).toBe(false)
    // the engine's working folder of the chat (what the engine left there: tmp files, its own state)
    const agentDir = path.join(h.ctx.engineConfig.agentRoot, chatId)
    fs.mkdirSync(path.join(agentDir, '.tmp'), { recursive: true })
    fs.writeFileSync(path.join(agentDir, '.tmp', 'scratch.txt'), 'SAM-PRIVATE-TEXT')
    expect(sweep(h.ctx).purgedUsers).toBe(0)
    h.advance(8 * 86_400_000)
    expect(sweep(h.ctx).purgedUsers).toBe(1)
    expect(h.ctx.db.query('SELECT COUNT(*) AS n FROM chats WHERE user_id = ?').get(m.id)).toEqual({ n: 0 })
    expect(fs.existsSync(agentDir)).toBe(false)
    expect(h.ctx.db.query('SELECT COUNT(*) AS n FROM memories WHERE user_id = ?').get(m.id)).toEqual({ n: 0 })
    // the id is never reused, the username is
    const again = await owner.call('POST', '/api/admin/users', { username: 'sam', name: 'Sam 2', role: 'member' })
    expect(again.user.id).toBe('sam-2')
  })
  test('delete: the personal folder goes with the account; guards', async () => {
    const m = await addMember(h, owner, { username: 'dan' })
    fs.writeFileSync(path.join(h.ctx.files.fx.root, 'users', m.id, 'x.md'), 'x')
    await owner.call('DELETE', `/api/admin/users/${m.id}?personalFolder=delete`)
    expect(fs.existsSync(path.join(h.ctx.files.fx.root, 'users', m.id))).toBe(false)
    expect((await owner.try('DELETE', '/api/admin/users/olga')).status).toBe(403)
    expect((await owner.try('DELETE', `/api/admin/users/${m.id}`)).status).toBe(404)
    const adm = await addMember(h, owner, { username: 'ada', role: 'admin' })
    const adm2 = await addMember(h, owner, { username: 'abe', role: 'admin' })
    expect((await adm.client.try('DELETE', `/api/admin/users/${adm2.id}`)).status).toBe(403)
    expect((await adm.client.try('DELETE', `/api/admin/users/${adm.id}`)).status).toBe(403)
  })
})

describe('admins never see other people\'s chats or memories', () => {
  let h: Harness
  beforeAll(async () => { h = await harness('privacy') })
  afterAll(() => h.close())

  test('no admin endpoint returns chat titles, message text or memories', async () => {
    const owner = await withOwner(h)
    const m = await addMember(h, owner, { username: 'pia' })
    const chatId = uuidv7()
    const SECRET = 'PIA-SECRET-CANARY-5521'
    h.ctx.db.query('INSERT INTO chats (id, user_id, title) VALUES (?, ?, ?)').run(chatId, m.id, SECRET)
    h.ctx.db.query("INSERT INTO messages (id, chat_id, role, content) VALUES (?, ?, 'user', ?)").run(uuidv7(), chatId, SECRET)
    h.ctx.db.query('INSERT INTO memories (id, user_id, text) VALUES (?, ?, ?)').run(uuidv7(), m.id, SECRET)
    h.ctx.db.query("INSERT INTO turns (id, chat_id, user_id, engine, status, input_tokens, output_tokens) VALUES (?, ?, ?, 'claude-code', 'done', 10, 20)").run(uuidv7(), chatId, m.id)
    for (const { name, ep } of listEndpoints()) {
      if (ep.owner !== 'A' || ep.method !== 'GET' || ep.path.includes(':')) continue
      const r = await owner.try('GET', ep.path)
      expect(r.status, name).toBeLessThan(500)
      expect(JSON.stringify(r.body), name).not.toContain(SECRET)
    }
    for (const g of ['user', 'engine', 'model', 'day', 'group']) expect(JSON.stringify(await owner.call('GET', `/api/admin/usage?groupBy=${g}`))).not.toContain(SECRET)
    expect(Object.keys(API).filter((k) => /impersonat|signInAs|loginAs/i.test(k))).toEqual([])
  })
})

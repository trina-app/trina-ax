// Regressions found in the component A review: parallel password guessing, session fixation through the dev cookie
// name, lost admin role not treated as lost access (H7), a new group inheriting an old group's folder, audit list
// showing inside other people's personal folders, races on user ids, invites outliving their creator's rights,
// unbounded audit rows / password hashing under a flood.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { uuidv7 } from '@mycel/shared/api'
import { DEFAULT_LIMITS } from '../../server/src/auth/rate-limit'
import { HASH_SLOTS, hashLoad, hashPassword, verifyPassword } from '../../server/src/auth/passwords'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

describe('sign-in under parallel load', () => {
  let h: Harness
  let owner: Client
  beforeAll(async () => { h = await harness('review-signin'); owner = await withOwner(h) })
  afterAll(() => h.close())

  test('parallel wrong passwords cannot get past the account limit (each attempt counts before the check)', async () => {
    await addMember(h, owner, { username: 'victim' })
    const res = await Promise.all(Array.from({ length: 40 }, (_, i) =>
      h.client({ ip: `10.1.0.${i}` }).try('POST', '/api/auth/login', { username: 'victim', password: `wrong-guess-${i}` })))
    expect(res.filter((r) => r.status === 401)).toHaveLength(DEFAULT_LIMITS.perAccount)
    expect(res.filter((r) => r.status === 429)).toHaveLength(40 - DEFAULT_LIMITS.perAccount)
    // the flood of refused attempts leaves one audit row per account / IP and minute, not one per request
    const rl = h.ctx.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.rate_limited'").get() as { n: number }
    expect(rl.n).toBe(30) // 30 different IPs, one row each
    for (let i = 0; i < 5; i++) await h.client({ ip: '10.1.0.0' }).try('POST', '/api/auth/login', { username: 'victim', password: 'x' })
    expect((h.ctx.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.rate_limited'").get() as { n: number }).n).toBe(31)
  })

  test('a successful sign-in does not count against the IP', async () => {
    const m = await addMember(h, owner, { username: 'often', ip: '10.2.0.1' })
    h.auth.limiter.limits = { ...DEFAULT_LIMITS, perIp: 3 }
    try {
      for (let i = 0; i < 5; i++) expect((await h.client({ ip: '10.2.0.9' }).try('POST', '/api/auth/login', { username: 'often', password: m.password })).status).toBe(200)
    } finally { h.auth.limiter.limits = DEFAULT_LIMITS }
  })

  test('parallel wrong re-entered passwords are limited too', async () => {
    const res = await Promise.all(Array.from({ length: 12 }, () => owner.try('POST', '/api/admin/transfer-ownership', { userId: 'victim', password: 'not the password' })))
    expect(res.filter((r) => r.status === 403)).toHaveLength(DEFAULT_LIMITS.perReauth)
    expect(res.filter((r) => r.status === 429)).toHaveLength(12 - DEFAULT_LIMITS.perReauth)
  })

  test('password hashing runs at most HASH_SLOTS at a time', async () => {
    const hash = await hashPassword('some long password 1')
    let peak = 0
    const timer = setInterval(() => { peak = Math.max(peak, hashLoad().active) }, 1)
    await Promise.all(Array.from({ length: 12 }, () => verifyPassword('some long password 1', hash)))
    clearInterval(timer)
    expect(peak).toBeLessThanOrEqual(HASH_SLOTS)
    expect(hashLoad()).toEqual({ active: 0, waiting: 0 })
  })
})

describe('session cookie names per scheme', () => {
  let h: Harness
  let owner: Client
  beforeAll(async () => { h = await harness('review-cookie'); owner = await withOwner(h) })
  afterAll(() => h.close())

  test('https accepts only __Host-sid: a dev-named cookie planted by a sibling *.treesoop.com site is ignored', async () => {
    const sid = owner.cookie!.split('=')[1]!
    const https = 'https://team.treesoop.com'
    expect((await h.fetch('/api/me', { headers: { cookie: `mycel-dev-sid=${sid}` }, base: https })).status).toBe(401)
    expect((await h.fetch('/api/me', { headers: { cookie: `__Host-sid=${sid}` }, base: https })).status).toBe(200)
    // a planted dev cookie in front does not shadow the real one either
    expect((await h.fetch('/api/me', { headers: { cookie: `mycel-dev-sid=AAAAAAAAAAAAAAAAAAAAAAAA; __Host-sid=${sid}` }, base: https })).status).toBe(200)
    // plain http (dev) uses only the dev name
    expect((await h.fetch('/api/me', { headers: { cookie: `__Host-sid=${sid}` } })).status).toBe(401)
    expect((await h.fetch('/api/me', { headers: { cookie: `mycel-dev-sid=${sid}` } })).status).toBe(200)
  })
})

describe('admin side', () => {
  let h: Harness
  let owner: Client
  beforeAll(async () => { h = await harness('review-admin'); owner = await withOwner(h) })
  afterAll(() => h.close())
  const root = () => h.ctx.files.fx.root

  test('losing the admin role is lost access (H7): folders without rules were readable before', async () => {
    const a = await addMember(h, owner, { username: 'adminx', role: 'admin' })
    const chat = uuidv7()
    h.ctx.db.query("INSERT INTO chats (id, user_id, engine_session_id) VALUES (?, ?, 'sess-1')").run(chat, a.id)
    fs.mkdirSync(path.join(h.ctx.config.dataDir, 'sessions', chat), { recursive: true })
    fs.mkdirSync(path.join(root(), 'projects', 'secret'), { recursive: true })
    h.hub.events = []
    await owner.call('PATCH', `/api/admin/users/${a.id}`, { role: 'member' })
    expect(h.ctx.db.query('SELECT engine_session_id FROM chats WHERE id = ?').get(chat)).toEqual({ engine_session_id: null })
    expect(fs.existsSync(path.join(h.ctx.config.dataDir, 'sessions', chat))).toBe(false)
    expect(h.hub.events.some((e) => e.kind === 'publish' && e.target === a.id && (e.data as any).data.code === 'access_changed')).toBe(true)
    // audited like a rule change (top-most lost folder: the team root)
    const lost = (await owner.call('GET', '/api/admin/audit?source=admin')).items.find((e: any) => e.action === 'folder.access_lost' && e.target === a.id)
    expect(lost.detail.losing).toEqual([{ userId: a.id, paths: [''], chatsReset: 1 }])
    // and the preview of a role-free rule change still reports nothing for people whose access stays
    const p = await owner.call('POST', '/api/admin/folder-rules/preview', { changes: [{ path: 'shared', rules: [{ subjectType: 'everyone', subjectId: null, access: 'write' }] }] })
    expect(p.losing).toEqual([])
  })

  test('a new group never takes over the folder of an older group', async () => {
    const m = await addMember(h, owner, { username: 'member1' })
    const old = await owner.call('POST', '/api/admin/groups', { name: 'Sales' })
    fs.writeFileSync(path.join(root(), 'groups', 'Sales', 'pipeline.md'), 'old deals')
    await owner.call('PATCH', `/api/admin/groups/${old.id}`, { name: 'Sales (old)' })
    const neu = await owner.call('POST', '/api/admin/groups', { name: 'sales', memberIds: [m.id] })
    const folders = (await owner.call('GET', '/api/admin/folders')).items
    const mine = folders.find((f: any) => f.rules.some((r: any) => r.subjectId === neu.id))
    expect(mine.path).not.toBe('groups/Sales')
    expect(mine.path.toLowerCase()).toBe('groups/sales-2')
    expect(h.ctx.files.rules().access(h.ctx.files.principal(m.id), ['groups', 'Sales', 'pipeline.md'])).toBe('none')
  })

  test('nobody writes into users/ itself (not even the owner): only into their own personal folder', async () => {
    expect(() => h.ctx.files.humanSave('olga', 'users/notes.md', Buffer.from('x'), null)).toThrow()
    expect(() => h.ctx.files.humanSave('olga', 'users/future-member/plant.md', Buffer.from('x'), null)).toThrow()
    expect(h.ctx.files.humanSave('olga', 'users/olga/mine.md', Buffer.from('x'), null).isError).toBeFalsy()
  })

  test('rules on a folder row that now lies inside users/ cannot be edited', async () => {
    const id = uuidv7()
    h.ctx.db.query("INSERT INTO folders (id, path, created_at) VALUES (?, 'users/olga/moved', '2026-01-01')").run(id)
    expect((await owner.try('PUT', `/api/admin/folders/${id}/rules`, { rules: [] })).status).toBe(400)
  })

  test('audit list never shows what is inside other people\'s personal folders', async () => {
    const b = await addMember(h, owner, { username: 'bobby' })
    const ev = h.ctx.db.query('INSERT INTO file_events (user_id, path, action, size, sha256, detail) VALUES (?, ?, ?, ?, ?, ?)')
    ev.run(b.id, `users/${b.id}/이직 이력서.docx`, 'create', 1234, 'ab'.repeat(32), JSON.stringify({ tool: 'write' }))
    ev.run(b.id, 'shared/copy.md', 'create', 5, 'cd'.repeat(32), JSON.stringify({ conflictCopyOf: `users/${b.id}/plan b.md` }))
    ev.run('olga', 'users/olga/own.md', 'create', 1, 'ef'.repeat(32), null)
    h.ctx.db.query('INSERT INTO tool_events (user_id, tool, summary, ok) VALUES (?, ?, ?, 1)').run(b.id, 'read', `read users/${b.id}/이직 이력서.docx -> 3 lines`)
    h.ctx.db.query('INSERT INTO tool_events (user_id, tool, summary, ok) VALUES (?, ?, ?, 0)').run(b.id, 'read', "read Users/OLGA/x -> denied: not found or no access: 'Users/OLGA/x'")
    const all = JSON.stringify((await owner.call('GET', '/api/admin/audit?limit=200')).items)
    expect(all).not.toContain('이력서')
    expect(all).not.toContain('plan b')
    expect(all).not.toContain('ab'.repeat(32))
    expect(all).toContain(`users/${b.id}/…`)
    expect(all).toContain('users/olga/own.md') // the viewer's own folder stays visible
    const items = (await owner.call('GET', '/api/admin/audit?source=file')).items
    expect(items.find((e: any) => e.target === `users/${b.id}/…`).detail).toBeNull()
    // filtering by a path inside someone else's folder tells nothing
    expect((await owner.call('GET', `/api/admin/audit?path=${encodeURIComponent(`users/${b.id}`)}`)).items).toEqual([])
    expect((await owner.call('GET', `/api/admin/audit?path=${encodeURIComponent(`users/${b.id}/이직 이력서.docx`)}`)).items).toEqual([])
    expect((await owner.call('GET', '/api/admin/audit?path=users%2Folga')).items.map((e: any) => e.target)).toContain('users/olga/own.md')
  })

  test('concurrent member creation: same username -> one 409, never a 500; similar usernames get different ids', async () => {
    const same = await Promise.all([0, 1].map(() => owner.try('POST', '/api/admin/users', { username: 'twin', name: 'Twin', role: 'member' })))
    expect(same.map((r) => r.status).sort()).toEqual([201, 409])
    const near = await Promise.all(['a.b', 'a-b', 'A_b'].map((u) => owner.try('POST', '/api/admin/users', { username: u, name: u, role: 'member' })))
    expect(near.map((r) => r.status)).toEqual([201, 201, 201])
    expect(new Set(near.map((r) => r.body.user.id)).size).toBe(3)
  })

  test('open invites stop working when their creator is demoted, disabled or deleted', async () => {
    const a1 = await addMember(h, owner, { username: 'inviter1', role: 'admin' })
    const a2 = await addMember(h, owner, { username: 'inviter2', role: 'admin' })
    const a3 = await addMember(h, owner, { username: 'inviter3', role: 'admin' })
    const inv = await Promise.all([a1, a2, a3].map((a) => a.client.call('POST', '/api/admin/invites', {})))
    await owner.call('PATCH', `/api/admin/users/${a1.id}`, { role: 'member' })
    await owner.call('PATCH', `/api/admin/users/${a2.id}`, { status: 'disabled' })
    await owner.call('DELETE', `/api/admin/users/${a3.id}`)
    for (const i of inv) {
      const info = await h.client().call('GET', `/api/invites/${i.token}`)
      expect(info.valid).toBe(false)
      expect((await h.client().try('POST', `/api/invites/${i.token}/accept`, { username: `x${i.invite.id.slice(-6)}`, name: 'X', password: 'a fine long password 9' })).status).toBe(410)
    }
  })
})

describe('logs', () => {
  test('invite and reset tokens in the path are not logged', async () => {
    const { loggablePath } = await import('../../server/src/http/middleware')
    expect(loggablePath('/api/invites/abcDEF123_-xyz/accept')).toBe('/api/invites/***/accept')
    expect(loggablePath('/api/password-resets/abcDEF123_-xyz')).toBe('/api/password-resets/***')
    // the web pages the links open are logged too (debug level, the default in dev)
    expect(loggablePath('/invite/abcDEF123_-xyz')).toBe('/invite/***')
    expect(loggablePath('/reset-password/abcDEF123_-xyz')).toBe('/reset-password/***')
    expect(loggablePath('/api/connectors/remote/requests/abcDEF123_-xyz')).toBe('/api/connectors/remote/requests/***')
    expect(loggablePath('/files/view')).toBe('/files/view')
    expect(loggablePath('/api/admin/invites/0199-id')).toBe('/api/admin/invites/0199-id')
  })
})

// File sharing P2, PR 4: a phone push when someone asks to open a file, and Settings › Notifications "File sharing"
// (docs/decisions/20261116-file-share-push-gaps.md; migration 358; server/src/files/share-push.ts). Covered: a request is
// pushed to whoever answers it, ids and the code only, the tap opens the request (/activity/<notice id>); answered,
// the right to answer lost, quiet hours or the switch off: no push; a new request after an answer pushes again; a team
// file with no owner known pushes the owner and the admins, and once one answers nobody else gets it; the switch covers
// the file-shared push too, cancels what waits, keeps the Activity rows and defaults to on.
// Fixture: olga = owner, adam = admin; alice, bob, carl members.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { PushService } from '../../server/src/notifications/push-service'
import type { NativeSend } from '../../server/src/notifications/push-native'
import { pushPathOf } from '../../server/src/notifications/push-events'
import { fileSharePushWanted } from '../../server/src/files/share-push'
import { savePreferences } from '../../server/src/notifications/preferences'
import { updateTeamSettings } from '../../server/src/admin/settings'
import { pushMessages } from '../../server/src/notifications/text'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

let h: Harness
let owner: Client, admin: Client, alice: Client, bob: Client, carl: Client
let ids: Record<'olga' | 'adam' | 'alice' | 'bob' | 'carl', string>
const put = (c: Client, p: string, content = 'x') => c.call('PUT', '/api/files/content', { path: p, content, baseSha256: null })
const link = async (c: Client, p: string) => (await c.call('POST', '/api/files/link', { path: p })) as { id: string }
const ask = (c: Client, id: string, message?: string) => c.call('POST', `/api/files/shared/${id}/request`, message ? { message } : {})
const answer = (c: Client, requestId: string, a: 'approve' | 'decline') => c.call('POST', `/api/files/requests/${requestId}`, { answer: a })
const prefs = (c: Client, body: Record<string, unknown>) => c.call('PATCH', '/api/notification-preferences', body)
const noticeOf = (userId: string, shareId: string, asker: string) => h.ctx.db.query("SELECT id, read_at FROM file_share_notices WHERE user_id = ? AND event_type = 'file.access_requested' AND source_id = ?").get(userId, `${shareId}:${asker}`) as { id: string; read_at: string | null } | null
const sessionOf = (userId: string) => (h.ctx.db.query('SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(userId) as { id: string }).id

/** A push service with a phone of each of `users` through a fake gateway (`status`: what the gateway answers). */
function phones(users: string[], status = 200) {
  const sent: NativeSend[] = []
  let now = Date.now()
  const p = new PushService(h.ctx, { config: () => null, native: () => ({ url: 'https://push.example.test' }), transport: async () => { throw new Error('no web push here') },
    nativeTransport: async (i) => { sent.push(i); return { statusCode: status } }, now: () => now, phoneDecision: () => ({ kind: 'send' }) })
  for (const u of users) p.registerDevice(u, sessionOf(u), { consent: true, platform: 'android', environment: 'production', token: crypto.randomBytes(40).toString('base64url') })
  const tick = async () => { now = Math.max(now + 5, Date.now()); await p.tick() }
  return { p, sent, tick }
}
const asks = (sent: NativeSend[]) => sent.filter((s) => s.payload.code === 'file.access_requested')
// a delivery is queued only for a notice made after the device was registered
const later = () => new Promise((r) => setTimeout(r, 5))

beforeAll(async () => {
  h = await harness('c-file-share-push-gaps')
  owner = await withOwner(h)
  const a = await addMember(h, owner, { username: 'adam', role: 'admin' })
  admin = a.client
  const al = await addMember(h, owner, { username: 'alice' })
  const b = await addMember(h, owner, { username: 'bob' })
  const c = await addMember(h, owner, { username: 'carl' })
  alice = al.client; bob = b.client; carl = c.client
  const olga = (h.ctx.db.query("SELECT id FROM users WHERE username = 'olga'").get() as { id: string }).id
  ids = { olga, adam: a.id, alice: al.id, bob: b.id, carl: c.id }
  const sales = (await admin.call('POST', '/api/admin/groups', { name: 'Sales' })).id
  await admin.call('POST', '/api/admin/folders', { path: 'sales', limited: true, rules: [{ subjectType: 'group', subjectId: sales, access: 'write' }] })
}, 60_000)
afterAll(() => h.close())
afterEach(() => {
  savePreferences(h.ctx.db, ids.alice, { fileShares: true, quietHours: { on: false, start: '22:00', end: '08:00', weekends: false } })
  updateTeamSettings(h.ctx.db, { memberFileShares: true })
})

describe('a request to open my file', () => {
  test('pushed to the owner once: the code and ids only, the tap opens the request; answered: no more, the tap opens nothing', async () => {
    const p = `users/${ids.alice}/SECRET-plan.txt`
    await put(alice, p, 'plan')
    const { id } = await link(alice, p)
    const ph = phones([ids.alice])
    try {
      await later()
      expect((await ask(bob, id, 'SECRET NOTE')).status).toBe('sent')
      const n = noticeOf(ids.alice, id, ids.bob)!
      expect(fileSharePushWanted(h.ctx, n.id)).toBe(true)
      await ph.tick()
      expect(asks(ph.sent)).toHaveLength(1)
      const payload = asks(ph.sent)[0]!.payload
      expect(payload).toMatchObject({ code: 'file.access_requested', notificationId: n.id, path: `/activity/${n.id}` })
      expect(Object.keys(payload).sort()).toEqual(['code', 'locale', 'notificationId', 'path', 'tag'])
      expect(JSON.stringify(payload)).not.toMatch(/SECRET|plan|BOB|bob/i)
      // the generic line the server and the gateway use for it
      expect(pushMessages('en').bodies['file.access_requested']).toBe('Someone asked to open a file.')
      expect(pushMessages('ko').bodies['file.access_requested']).toBe('누군가 파일을 열게 해 달라고 요청했어요.')
      // the same request is never pushed twice
      await ph.tick()
      expect(asks(ph.sent)).toHaveLength(1)
      // alice answers: no longer wanted, and an old notification's tap opens nothing of it
      const requestId = (h.ctx.db.query("SELECT id FROM file_access_requests WHERE share_id = ? AND requester_id = ? AND state = 'pending'").get(id, ids.bob) as { id: string }).id
      await answer(alice, requestId, 'decline')
      expect(fileSharePushWanted(h.ctx, n.id)).toBe(false)
      expect(pushPathOf(h.ctx, 'file.access_requested', n.id)).toBeUndefined()
    } finally { await ph.p.stop() }
  })

  test('a new request after the answer pushes again (the limits bound it); the requester gets no push of their own', async () => {
    const p = `users/${ids.alice}/again.txt`
    await put(alice, p, 'again')
    const { id } = await link(alice, p)
    const ph = phones([ids.alice, ids.carl])
    try {
      await later()
      await ask(carl, id)
      await ph.tick()
      expect(asks(ph.sent)).toHaveLength(1)
      const requestId = (h.ctx.db.query("SELECT id FROM file_access_requests WHERE share_id = ? AND requester_id = ? AND state = 'pending'").get(id, ids.carl) as { id: string }).id
      await answer(alice, requestId, 'decline')
      // carl's decline is Activity only (file.access_answered is no push)
      await ph.tick()
      expect(ph.sent.filter((s) => s.payload.code !== 'file.access_requested')).toHaveLength(0)
      await ask(carl, id)
      await ph.tick()
      expect(asks(ph.sent)).toHaveLength(2)
      expect(new Set(asks(ph.sent).map((s) => s.payload.notificationId)).size).toBe(1)
    } finally { await ph.p.stop() }
  })

  test('the owner may no longer answer it (members may not share files): no push', async () => {
    const p = `users/${ids.alice}/off.txt`
    await put(alice, p, 'off')
    const { id } = await link(alice, p)
    await ask(bob, id)
    const n = noticeOf(ids.alice, id, ids.bob)!
    expect(fileSharePushWanted(h.ctx, n.id)).toBe(true)
    updateTeamSettings(h.ctx.db, { memberFileShares: false })
    expect(fileSharePushWanted(h.ctx, n.id)).toBe(false)
  })

  test('quiet hours: not wanted; read: not wanted', async () => {
    const p = `users/${ids.alice}/quiet.txt`
    await put(alice, p, 'quiet')
    const { id } = await link(alice, p)
    await ask(carl, id)
    const n = noticeOf(ids.alice, id, ids.carl)!
    savePreferences(h.ctx.db, ids.alice, { quietHours: { on: true, start: '00:00', end: '23:59', weekends: true } })
    expect(fileSharePushWanted(h.ctx, n.id, Date.parse('2026-11-11T12:00:00Z'))).toBe(false)
    savePreferences(h.ctx.db, ids.alice, { quietHours: { on: false, start: '22:00', end: '08:00', weekends: false } })
    expect(fileSharePushWanted(h.ctx, n.id)).toBe(true)
    h.ctx.db.query('UPDATE file_share_notices SET read_at = ? WHERE id = ?').run(new Date().toISOString(), n.id)
    expect(fileSharePushWanted(h.ctx, n.id)).toBe(false)
  })

  test('a team file with no owner known: the owner and the admins are pushed; once one answers, nobody else is', async () => {
    // the sales folder is the Sales group's alone (beforeAll): bob cannot open a file there
    fs.writeFileSync(path.join(h.ctx.files.fx.root, 'sales', 'nobody-push.txt'), 'no owner')
    const { id } = await link(admin, 'sales/nobody-push.txt')
    const ph = phones([ids.olga, ids.adam], 503)
    try {
      await later()
      expect((await ask(bob, id)).status).toBe('sent')
      await ph.tick()
      const olgaN = noticeOf(ids.olga, id, ids.bob)!, adamN = noticeOf(ids.adam, id, ids.bob)!
      expect(fileSharePushWanted(h.ctx, olgaN.id)).toBe(true)
      expect(fileSharePushWanted(h.ctx, adamN.id)).toBe(true)
      const requestId = (h.ctx.db.query("SELECT id FROM file_access_requests WHERE share_id = ? AND state = 'pending'").get(id) as { id: string }).id
      await answer(owner, requestId, 'approve')
      expect(fileSharePushWanted(h.ctx, adamN.id)).toBe(false)
    } finally { await ph.p.stop() }
  })
})

describe('Settings › Notifications "File sharing"', () => {
  test('on by default; off: neither the request nor the share by name is pushed, a waiting push is cancelled, the Activity rows stay', async () => {
    expect((await alice.call('GET', '/api/notification-preferences')).fileShares).toBe(true)
    const p = `users/${ids.alice}/switch.txt`
    await put(alice, p, 'switch')
    const { id } = await link(alice, p)
    // a push that waits (the gateway refused once) is cancelled by switching it off
    const failing = phones([ids.alice], 503)
    try {
      await later()
      await ask(bob, id)
      await failing.tick()
    } finally { await failing.p.stop() }
    const n = noticeOf(ids.alice, id, ids.bob)!
    expect(h.ctx.db.query('SELECT state FROM file_share_push_deliveries WHERE notification_id = ?').all(n.id)).toContainEqual({ state: 'pending' })
    expect((await prefs(alice, { fileShares: false })).fileShares).toBe(false)
    expect(h.ctx.db.query("SELECT state FROM file_share_push_deliveries WHERE notification_id = ? AND state IN ('pending','sending')").all(n.id)).toEqual([])
    expect(fileSharePushWanted(h.ctx, n.id)).toBe(false)
    // the Activity row stays, with Share / Decline
    const items = (await alice.call('GET', '/api/notifications?limit=100')).items as any[]
    expect(items.find((x) => x.id === n.id)?.fileShare).toMatchObject({ state: 'pending', canAnswer: true })
    // a file shared with alice by name: no push while off either
    const q = `users/${ids.carl}/for-alice.txt`
    await put(carl, q, 'for alice')
    const ph = phones([ids.alice])
    try {
      await later()
      await carl.call('PUT', '/api/files/shares', { path: q, add: [{ subjectType: 'user', subjectId: ids.alice }], remove: [] })
      await ph.tick()
      expect(ph.sent).toHaveLength(0)
      const shared = h.ctx.db.query("SELECT id FROM file_share_notices WHERE user_id = ? AND event_type = 'file.shared' ORDER BY created_at DESC LIMIT 1").get(ids.alice) as { id: string }
      expect(fileSharePushWanted(h.ctx, shared.id)).toBe(false)
      // on again: the share by name is wanted again (still unread)
      await prefs(alice, { fileShares: true })
      expect(fileSharePushWanted(h.ctx, shared.id)).toBe(true)
      // the other switches are untouched by it
      expect((await alice.call('GET', '/api/notification-preferences')).chatShares).toBe(true)
    } finally { await ph.p.stop() }
  })

  test('migration 358: one additive column, default on, reader 1', () => {
    const sql = fs.readFileSync(path.join(import.meta.dir, '../../server/migrations/358_c_file_share_push_setting.sql'), 'utf8')
    expect(sql.split('\n')[0]).toBe('-- min_compatible_reader: 1')
    expect(sql).toContain('ALTER TABLE notification_preferences ADD COLUMN file_shares INTEGER NOT NULL DEFAULT 1;')
    const col = (h.ctx.db.query('PRAGMA table_info(notification_preferences)').all() as { name: string; dflt_value: string }[]).find((c) => c.name === 'file_shares')
    expect(col?.dflt_value).toBe('1')
  })
})

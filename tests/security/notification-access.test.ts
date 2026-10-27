// In-process HTTP, actual sessions/CSRF/permissions. No engine or external notification is started.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { addMember, harness, withOwner, type Client, type Harness } from '../unit/a-lib'
import { notificationsOf } from '../../server/src/notifications/service'
let h: Harness, owner: Client, alice: Client, bob: Client, aliceId: string, bobId: string
beforeAll(async () => {
  h = await harness('notification-access'); owner = await withOwner(h)
  const a = await addMember(h, owner, { username: 'alice' }), b = await addMember(h, owner, { username: 'bob' })
  alice = a.client; aliceId = a.id; bob = b.client; bobId = b.id
})
afterAll(async () => { await h?.close() })

test('inbox/preferences/read stay personal even for owner; signals contain no sensitive payload', async () => {
  const n = notificationsOf(h.ctx)
  n.connectionReconnect(aliceId, 'private-episode')
  const mine = await alice.call('GET', '/api/notifications')
  expect(mine.items).toHaveLength(1); const id = mine.items[0].id
  for (const c of [bob, owner]) {
    expect((await c.call('GET', '/api/notifications')).items).toHaveLength(0)
    expect((await c.raw('POST', `/api/notifications/${id}/read`)).status).toBe(404)
  }
  await alice.call('PATCH', '/api/notification-preferences', { connectionReconnect: false })
  expect((await bob.call('GET', '/api/notification-preferences')).connectionReconnect).toBe(true)
  n.connectionReconnect(aliceId, 'muted-episode')
  expect((await alice.call('GET', '/api/notifications')).items).toHaveLength(1)
  const signals = h.hub.events.filter(e => (e.data as any)?.data?.code === 'notifications.changed')
  expect(signals.length).toBeGreaterThan(0)
  expect(signals.every(e => e.target === aliceId && JSON.stringify(e.data) === JSON.stringify({ type: 'notice', data: { level: 'info', code: 'notifications.changed', message: '' } }))).toBe(true)
  expect((await alice.call('POST', `/api/notifications/${id}/read`)).readAt).toBeTruthy()
  expect((await alice.call('GET', '/api/notifications')).unreadCount).toBe(0)
})
test('template HTTP is explicit, idempotent per user, private, and input validated', async () => {
  const initial = await alice.call('GET', '/api/schedule-templates')
  expect(initial.items).toHaveLength(2)
  expect((await alice.call('GET', '/api/schedules')).items).toHaveLength(0)
  const requestId = crypto.randomUUID()
  const input = { requestId, templateId: 'weekly-summary', version: 1, sourcePath: `users/${aliceId}`, outputPath: `users/${aliceId}/reports`, time: '09:00', weekday: 1 }
  const [first, second] = await Promise.all([alice.call('POST', '/api/schedule-templates', input), alice.call('POST', '/api/schedule-templates', input)])
  expect(first.id).toBe(second.id); expect(first.templateId).toBe('weekly-summary')
  expect((await bob.call('GET', '/api/schedules')).items).toHaveLength(0)
  expect((await bob.raw('PATCH', `/api/schedules/${first.id}`, { enabled: false })).status).toBe(404)
  expect((await bob.raw('POST', '/api/schedule-templates', input)).status).toBe(404)
  expect((await alice.raw('POST', '/api/schedule-templates', { ...input, requestId: crypto.randomUUID(), prompt: 'untrusted replacement' })).status).toBe(400)
  expect((await alice.raw('POST', '/api/schedule-templates', { ...input, requestId: crypto.randomUUID(), weekday: undefined })).status).toBe(400)
  const bobs = await bob.call('POST', '/api/schedule-templates', { ...input, sourcePath: `users/${bobId}`, outputPath: `users/${bobId}/reports` })
  expect(bobs.id).not.toBe(first.id)
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM turns').get()).toEqual({ n: 0 })
})
test('deleted/revoked sources remove notification deep links and stale logout session cannot fetch', async () => {
  const folder = 'shared/notification-source'
  fs.mkdirSync(path.join(h.ctx.config.teamRoot, folder), { recursive: true })
  h.ctx.db.query("INSERT INTO folders(id,path) VALUES('notif-src',?)").run(folder)
  h.ctx.db.query("INSERT INTO folder_rules(id,folder_id,subject_type,subject_id,access) VALUES('notif-rule','notif-src','user',?,'read')").run(aliceId)
  h.ctx.db.query('INSERT INTO chats(id,user_id) VALUES(?,?)').run('own-result',aliceId)
  h.ctx.db.query("INSERT INTO turns(id,chat_id,user_id,engine,status,schedule_id,ended_at,template_source_path,template_output_path) VALUES('source-result','own-result',?,'claude-code','done','s',?,?,?)")
    .run(aliceId,new Date().toISOString(),folder,`users/${aliceId}/reports`)
  notificationsOf(h.ctx).reconcile()
  expect((await alice.call('GET','/api/notifications')).items.find((x: any) => x.sourceId === 'source-result').chatId).toBe('own-result')
  h.ctx.db.query("UPDATE folder_rules SET access='none' WHERE id='notif-rule'").run()
  expect((await alice.call('GET','/api/notifications')).items.find((x: any) => x.sourceId === 'source-result')).toMatchObject({ chatId: null, link: null })
  const oldCookie = alice.cookie!
  await alice.call('POST', '/api/auth/logout')
  expect((await h.fetch('/api/notifications', { headers: { cookie: oldCookie } })).status).toBe(401)
  expect((await h.fetch('/api/notification-preferences', { headers: { cookie: oldCookie } })).status).toBe(401)
})

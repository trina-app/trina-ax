// The push for an app's "paused" notice (docs/DECISIONS.md "Apps posting in rooms", "Paused push"; migration 351
// room_app_push_deliveries; server/src/rooms/apps/notice.ts roomAppPushWanted / roomAppPushPath): a paused app makes a
// delivery for the person told, with push on, through the normal pipeline; the push carries ids and the code only and
// opens the app's room; once the app is resumed or removed it is no longer wanted and nothing is sent.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { ROOM_APP_DAILY_CAP } from '@mycel/shared/api'
import { teamDay } from '../../server/src/rooms/apps/service'
import { roomAppPushPath, roomAppPushWanted } from '../../server/src/rooms/apps/notice'
import { PushService } from '../../server/src/notifications/push-service'
import type { NativeSend } from '../../server/src/notifications/push-native'
import { pushPathOf } from '../../server/src/notifications/push-events'
import { harness, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { await h?.close() })
const settle = () => new Promise((r) => setTimeout(r, 5))

async function setup() {
  h = await harness('b-room-app-push', { publicOrigins: ['https://team.acme-corp.com'] })
  const owner = await withOwner(h)
  const ownerId = (h.ctx.db.query("SELECT id FROM users WHERE username = 'olga'").get() as { id: string }).id
  const all = ((await owner.call('GET', '/api/rooms')).items as any[]).find((r) => r.kind === 'all')!.id as string
  return { owner, ownerId, all }
}

/** A push service with a phone of the person (an iPhone, through a fake gateway). */
function phone(userId: string) {
  const sent: NativeSend[] = []
  const p = new PushService(h.ctx, { config: () => null, native: () => ({ url: 'https://push.example.test' }), transport: async () => { throw new Error('no web push here') },
    nativeTransport: async (i) => { sent.push(i); return { statusCode: 200 } }, now: () => Date.now(),
    // the person's window may be open here: "at Trina" would cancel the phone push (its own tests in b-push-away)
    phoneDecision: () => ({ kind: 'send' }) })
  const sid = (h.ctx.db.query('SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(userId) as { id: string }).id
  p.registerDevice(userId, sid, { consent: true, platform: 'ios', environment: 'production', token: crypto.randomUUID().replace(/-/g, '').repeat(2) })
  return { p, sent }
}

/** Adds an app to the room and makes it reach the day's cap: it pauses and its managers get the notice. */
async function pausedApp(owner: Client, roomId: string, ownerId: string) {
  const r = await owner.call('POST', `/api/rooms/${roomId}/apps`, { kind: 'other', name: 'Backups' })
  const app = r.app as { id: string }, token = (r.address as string).split('/in/')[1]!
  h.ctx.db.query('INSERT INTO room_app_days (app_id, day, shown) VALUES (?, ?, ?)').run(app.id, teamDay(h.ctx.db, Date.now()).day, ROOM_APP_DAILY_CAP)
  await settle()
  const res = await h.fetch(`/in/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'one too many' }) })
  expect(res.status).toBe(429)
  const notice = h.ctx.db.query("SELECT id, source_id FROM room_app_notices WHERE user_id = ? AND source_id LIKE ?").get(ownerId, `${app.id}.%`) as { id: string; source_id: string }
  expect(notice).toBeTruthy()
  return { app, notice }
}

test('a paused app: one push for the person told, ids and the code only, opening the app\'s room; never twice', async () => {
  const { owner, ownerId, all } = await setup()
  const ph = phone(ownerId)
  try {
    await settle()
    const { notice } = await pausedApp(owner, all, ownerId)
    expect(roomAppPushWanted(h.ctx, notice.id)).toBe(true)
    expect(roomAppPushPath(h.ctx, notice.id)).toBe(`/rooms/${all}`)
    await ph.p.tick()
    expect(ph.sent).toHaveLength(1)
    expect(ph.sent[0]!.payload).toMatchObject({ code: 'room_app.paused', notificationId: notice.id, path: `/rooms/${all}` })
    expect(Object.keys(ph.sent[0]!.payload).sort()).toEqual(['badge', 'code', 'locale', 'notificationId', 'path', 'tag'])
    expect(JSON.stringify(ph.sent[0]!.payload)).not.toContain('Backups')
    const rows = h.ctx.db.query('SELECT state FROM room_app_push_deliveries WHERE notification_id = ?').all(notice.id) as { state: string }[]
    expect(rows.map((d) => d.state)).toEqual(['sent'])
    await ph.p.tick()
    expect(ph.sent).toHaveLength(1)
  } finally { await ph.p.stop() }
})

const states = (id: string) => (h.ctx.db.query('SELECT state FROM room_app_push_deliveries WHERE notification_id = ?').all(id) as { state: string }[]).map((d) => d.state)

test('resumed before it went: no longer wanted (Resume now also settles the notice), nothing is pushed', async () => {
  const { owner, ownerId, all } = await setup()
  const ph = phone(ownerId)
  try {
    await settle()
    const { app, notice } = await pausedApp(owner, all, ownerId)
    await owner.call('POST', `/api/rooms/${all}/apps/${app.id}/resume`)
    expect(roomAppPushWanted(h.ctx, notice.id)).toBe(false)
    await ph.p.tick()
    expect(ph.sent).toHaveLength(0)
    expect(states(notice.id)).not.toContain('sent')
  } finally { await ph.p.stop() }
})

test('the pause ran out (the team\'s midnight passed) while the notice is unread: its delivery is cancelled, nothing is pushed', async () => {
  const { owner, ownerId, all } = await setup()
  const ph = phone(ownerId)
  try {
    await settle()
    const { app, notice } = await pausedApp(owner, all, ownerId)
    h.ctx.db.query('UPDATE room_apps SET paused_until = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), app.id)
    expect(roomAppPushWanted(h.ctx, notice.id)).toBe(false)
    // still the room to open: the path does not depend on the pause
    expect(roomAppPushPath(h.ctx, notice.id)).toBe(`/rooms/${all}`)
    await ph.p.tick()
    expect(ph.sent).toHaveLength(0)
    expect(states(notice.id)).toEqual(['cancelled'])
  } finally { await ph.p.stop() }
})

test('out of the room: no longer wanted, no path', async () => {
  const { owner, ownerId, all } = await setup()
  const ph = phone(ownerId)
  try {
    await settle()
    const { notice } = await pausedApp(owner, all, ownerId)
    h.ctx.db.query('DELETE FROM room_members WHERE room_id = ? AND user_id = ?').run(all, ownerId)
    expect(roomAppPushWanted(h.ctx, notice.id)).toBe(false)
    expect(roomAppPushPath(h.ctx, notice.id)).toBeNull()
    await ph.p.tick()
    expect(ph.sent).toHaveLength(0)
  } finally { await ph.p.stop() }
})

test('a removed app: its notice goes with it; no longer wanted, no path, nothing is pushed', async () => {
  const { owner, ownerId, all } = await setup()
  const ph = phone(ownerId)
  try {
    await settle()
    const { app, notice } = await pausedApp(owner, all, ownerId)
    await owner.call('DELETE', `/api/rooms/${all}/apps/${app.id}`)
    expect(roomAppPushWanted(h.ctx, notice.id)).toBe(false)
    expect(roomAppPushPath(h.ctx, notice.id)).toBeNull()
    expect(pushPathOf(h.ctx, 'room_app.paused', notice.id)).toBeUndefined()
    await ph.p.tick()
    expect(ph.sent).toHaveLength(0)
  } finally { await ph.p.stop() }
})

test('a read notice is not pushed', async () => {
  const { owner, ownerId, all } = await setup()
  const ph = phone(ownerId)
  try {
    await settle()
    const { notice } = await pausedApp(owner, all, ownerId)
    h.ctx.db.query('UPDATE room_app_notices SET read_at = ? WHERE id = ?').run(new Date().toISOString(), notice.id)
    await ph.p.tick()
    expect(ph.sent).toHaveLength(0)
  } finally { await ph.p.stop() }
})
